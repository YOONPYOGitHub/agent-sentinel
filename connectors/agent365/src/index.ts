import type { TokenCredential } from '@azure/core-auth'
import { ClientAssertionCredential, ManagedIdentityCredential } from '@azure/identity'
import { z } from 'zod'

import { aggregateLiveSources, composeConnectorHealthReport } from '@agent-sentinel/connector-sdk'
import type {
  AgentConnector,
  ApprovalContext,
  ConnectionTestResult,
  ConnectorCapability,
  ConnectorDescriptor,
  ConnectorHealthReport,
  ConnectorOperationRequest,
  ConnectorReadiness,
  ConnectorSourceProvenance,
  LiveSourceDataState,
  OperationAwareAgentConnector,
} from '@agent-sentinel/connector-sdk'
import type { EstateSnapshot, Evidence, Remediation } from '@agent-sentinel/domain'

import {
  Agent365ConnectorError,
  Agent365GraphClient,
  type Agent365Collection,
  type Agent365ClientOptions,
  type Agent365ResponseByteBudget,
} from './client.js'
import {
  mapAgent365PackagesToSnapshot,
  mergeAgent365Snapshots,
  type Agent365SourceSnapshot,
} from './normalize.js'
import {
  AGENT365_API_VERSION,
  AGENT365_GRAPH_ORIGIN,
  AGENT365_PACKAGES_PATH,
  agent365ConfigSchema,
  agent365LimitsSchema,
  type Agent365Config,
  type Agent365Limits,
  type Agent365SourceConfig,
} from './schemas.js'

export type Agent365CredentialFactory = (source: Agent365SourceConfig) => TokenCredential

export function createAgent365SourceCredential(source: Agent365SourceConfig): TokenCredential {
  if (source.credential?.mode === 'managed-identity') {
    return new ManagedIdentityCredential({
      clientId: source.credential.managedIdentityClientId,
    })
  }
  if (source.credential?.mode === 'federated-app') {
    const assertionCredential = new ManagedIdentityCredential({
      clientId: source.credential.managedIdentityClientId,
    })
    return new ClientAssertionCredential(source.tenantId, source.credential.clientId, async () => {
      const assertion = await assertionCredential.getToken('api://AzureADTokenExchange/.default')
      if (assertion === null) {
        throw new Agent365ConnectorError(
          'authentication',
          'Managed identity did not return a workload identity federation assertion.',
        )
      }
      return assertion.token
    })
  }
  throw new Agent365ConnectorError(
    'authentication',
    'Agent 365 sources require an explicit user-assigned managed identity client ID.',
  )
}

function envBoolean(environment: NodeJS.ProcessEnv, name: string): boolean {
  const value = environment[name]?.trim().toLowerCase()
  if (value === undefined || value === '') return false
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false.`)
  return value === 'true'
}

function envNumber(environment: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = environment[name]?.trim()
  if (value === undefined || value === '') return undefined
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${name} must be a number.`)
  return number
}

function limitsFromEnvironment(environment: NodeJS.ProcessEnv): Agent365Limits {
  return agent365LimitsSchema.parse({
    maxPages: envNumber(environment, 'AGENT365_MAX_PAGES'),
    maxItems: envNumber(environment, 'AGENT365_MAX_ITEMS'),
    requestTimeoutMs: envNumber(environment, 'AGENT365_REQUEST_TIMEOUT_MS'),
    maxRetries: envNumber(environment, 'AGENT365_MAX_RETRIES'),
    maxRetryAfterMs: envNumber(environment, 'AGENT365_MAX_RETRY_AFTER_MS'),
    maxResponseBytes: envNumber(environment, 'AGENT365_MAX_RESPONSE_BYTES'),
  })
}

export function parseAgent365Config(environment: NodeJS.ProcessEnv = process.env): Agent365Config {
  let sources: unknown
  const sourcesJson = environment['AGENT365_SOURCES_JSON']?.trim()
  if (sourcesJson !== undefined && sourcesJson !== '') {
    try {
      sources = JSON.parse(sourcesJson)
    } catch {
      throw new Error('AGENT365_SOURCES_JSON must be valid JSON.')
    }
  } else {
    const tenantId = environment['AGENT365_TENANT_ID']?.trim()
    const sourceEnvironment = environment['AGENT365_ENVIRONMENT']?.trim()
    const managedIdentityClientId = environment['AGENT365_MANAGED_IDENTITY_CLIENT_ID']?.trim()
    if (!tenantId || !sourceEnvironment) {
      throw new Error(
        'AGENT365_TENANT_ID and AGENT365_ENVIRONMENT are required when no source JSON is supplied.',
      )
    }
    sources = [
      {
        id: 'primary',
        name: 'Primary Microsoft Agent 365 tenant',
        tenantId,
        environment: sourceEnvironment,
        ...(managedIdentityClientId
          ? {
              credential: {
                mode: 'managed-identity',
                managedIdentityClientId,
              },
            }
          : {}),
      },
    ]
  }
  const graphBaseUrl = environment['AGENT365_GRAPH_BASE_URL']?.trim() || AGENT365_GRAPH_ORIGIN
  const limits = limitsFromEnvironment(environment)
  const resolvedSources = Array.isArray(sources)
    ? sources.map((source: unknown): unknown => {
        if (typeof source !== 'object' || source === null || Array.isArray(source)) return source
        const record = source as Record<string, unknown>
        return {
          ...record,
          graphBaseUrl: record['graphBaseUrl'] ?? graphBaseUrl,
          limits: record['limits'] ?? limits,
        }
      })
    : sources
  return agent365ConfigSchema.parse({
    graphBaseUrl,
    limits,
    aggregation: {
      maxConcurrency: envNumber(environment, 'AGENT365_MAX_CONCURRENCY'),
      maxDurationMs: envNumber(environment, 'AGENT365_MAX_DURATION_MS'),
    },
    sources: resolvedSources,
  })
}

export function safeAgent365FailureReason(error: unknown): string {
  if (error instanceof Agent365ConnectorError) {
    return error.code === 'request-failed' && error.status !== undefined
      ? `request-failed:${error.status}`
      : error.code
  }
  if (error instanceof z.ZodError) return 'malformed-response'
  return 'request-failed'
}

function readinessForFailure(reason: string | undefined): ConnectorReadiness {
  if (reason === 'authorization' || reason === 'license-required') {
    return 'authorization-required'
  }
  return 'unavailable'
}

export class Agent365InventoryConnector implements OperationAwareAgentConnector {
  readonly descriptor: ConnectorDescriptor = {
    id: 'agent365-package-catalog',
    name: 'Microsoft Agent 365 package catalog',
    apiVersion: AGENT365_API_VERSION,
    releaseStatus: 'ga',
    capabilities: ['discovery', 'evidence'],
    requiredPermissions: [
      'Microsoft Agent 365 license',
      'Microsoft Graph application permission CopilotPackages.Read.All with tenant-admin consent',
    ],
    blindSpots: [
      'List-only inventory does not read package detail, principals, element definitions, or package content.',
      'Package catalog metadata does not prove runtime behavior, trust, tools, identity, entitlements, or effective access.',
    ],
  }
  private readonly client: Agent365GraphClient
  private evidenceById = new Map<string, Evidence>()
  private failureReason: string | undefined = 'not-queried'
  private lastMeasurement: Pick<Agent365Collection, 'pages' | 'records' | 'truncated'> = {
    pages: 0,
    records: 0,
    truncated: false,
  }

  constructor(
    private readonly source: Agent365SourceConfig,
    credential: TokenCredential,
    options: Agent365ClientOptions = {},
  ) {
    this.client = new Agent365GraphClient(source.limits, credential, source.tenantId, options)
  }

  async testConnection(
    request: ConnectorOperationRequest = {},
    aggregateByteBudget?: Agent365ResponseByteBudget,
  ): Promise<ConnectionTestResult> {
    const checkedAt = new Date().toISOString()
    try {
      await this.client.probe(request.signal, aggregateByteBudget)
      this.failureReason = undefined
      return { ok: true, checkedAt, message: 'Agent 365 package catalog is reachable.' }
    } catch (error) {
      this.failureReason = safeAgent365FailureReason(error)
      return { ok: false, checkedAt, message: 'Agent 365 package catalog is unavailable.' }
    }
  }

  async discover(
    request: ConnectorOperationRequest = {},
    aggregateByteBudget?: Agent365ResponseByteBudget,
  ): Promise<EstateSnapshot> {
    try {
      const maximumRecords =
        request.maxRecords === undefined
          ? undefined
          : Math.min(request.maxRecords, this.source.limits.maxItems)
      const maximumPages =
        request.maxPages === undefined
          ? undefined
          : Math.min(request.maxPages, this.source.limits.maxPages)
      const collection = await this.client.collectMeasured(
        maximumRecords,
        request.signal,
        maximumPages,
        aggregateByteBudget,
      )
      const snapshot = mapAgent365PackagesToSnapshot(
        collection.packages,
        this.source,
        new Date().toISOString(),
      )
      this.lastMeasurement = {
        pages: collection.pages,
        records: collection.records,
        truncated: collection.truncated,
      }
      this.failureReason = undefined
      this.evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
      return snapshot
    } catch (error) {
      this.failureReason = safeAgent365FailureReason(error)
      throw error
    }
  }

  getFailureReason(): string | undefined {
    return this.failureReason
  }

  getLastMeasurement(): Pick<Agent365Collection, 'pages' | 'records' | 'truncated'> {
    return { ...this.lastMeasurement }
  }

  getEvidence(id: string): Promise<Evidence> {
    const item = this.evidenceById.get(id)
    if (item === undefined) {
      throw new Agent365ConnectorError('request-failed', 'Agent 365 evidence was not found.')
    }
    return Promise.resolve(structuredClone(item))
  }

  execute(): Promise<{ remediation: Remediation; snapshot: EstateSnapshot }> {
    return Promise.reject(new Error('Microsoft Agent 365 package connector is read-only.'))
  }
}

interface Agent365SourceState {
  id: string
  source: Agent365SourceConfig
  connector: Agent365InventoryConnector | undefined
  readiness: ConnectorReadiness
  dataState: LiveSourceDataState | undefined
  pages: number | undefined
  records: number | undefined
  checkedAt: string | undefined
  reason: string | undefined
  provenance: ConnectorSourceProvenance | undefined
}

export interface Agent365CompositionOptions {
  credentialFactory?: Agent365CredentialFactory
  clientFactory?: (source: Agent365SourceConfig) => Agent365ClientOptions
}

function responseByteBudget(maximumBytes: number): Agent365ResponseByteBudget {
  let remaining = maximumBytes
  return {
    tryConsume(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > remaining) {
        remaining = 0
        return false
      }
      remaining -= bytes
      return true
    },
  }
}

function allocateRecordBudgets(
  sources: readonly Agent365SourceState[],
  maximum: number,
): ReadonlyMap<string, number> {
  const budgets = new Map<string, number>()
  let remaining = maximum
  for (const [index, state] of sources.entries()) {
    const remainingSources = sources.length - index
    const fairShare = remaining === 0 ? 0 : Math.ceil(remaining / remainingSources)
    const budget = Math.min(fairShare, state.source.limits.maxItems)
    budgets.set(state.id, budget)
    remaining -= budget
  }
  return budgets
}

export class Agent365CompositionConnector implements OperationAwareAgentConnector {
  readonly descriptor: ConnectorDescriptor
  private readonly sources: Agent365SourceState[]
  private evidenceById = new Map<string, Evidence>()
  private baseHealth: ConnectionTestResult = {
    ok: false,
    checkedAt: new Date(0).toISOString(),
    message: 'Base connector has not been tested.',
  }

  constructor(
    private readonly base: AgentConnector,
    private readonly config: Agent365Config | undefined,
    options: Agent365CompositionOptions = {},
  ) {
    const credentialFactory = options.credentialFactory ?? createAgent365SourceCredential
    this.sources = (config?.sources ?? []).map((source) => {
      try {
        return {
          id: source.id,
          source,
          connector: new Agent365InventoryConnector(
            source,
            credentialFactory(source),
            options.clientFactory?.(source),
          ),
          readiness: 'degraded' as const,
          dataState: undefined,
          pages: undefined,
          records: undefined,
          checkedAt: undefined,
          reason: 'not-queried',
          provenance: undefined,
        }
      } catch (error) {
        return {
          id: source.id,
          source,
          connector: undefined,
          readiness: 'unavailable' as const,
          dataState: 'failed' as const,
          pages: 0,
          records: 0,
          checkedAt: undefined,
          reason: safeAgent365FailureReason(error),
          provenance: undefined,
        }
      }
    })
    this.descriptor = {
      ...base.descriptor,
      capabilities: [
        ...new Set<ConnectorCapability>([...base.descriptor.capabilities, 'discovery', 'evidence']),
      ],
      requiredPermissions: [
        ...new Set([
          ...base.descriptor.requiredPermissions,
          'Microsoft Agent 365 license',
          'Microsoft Graph application permission CopilotPackages.Read.All with tenant-admin consent',
        ]),
      ],
      blindSpots: [
        ...base.descriptor.blindSpots,
        'Agent 365 catalog list metadata does not prove runtime behavior, trust, tools, identity, entitlements, or effective access.',
      ],
    }
  }

  async testConnection(request: ConnectorOperationRequest = {}): Promise<ConnectionTestResult> {
    if (this.config === undefined || this.sources.length === 0) {
      const base = await (this.base as OperationAwareAgentConnector).testConnection(request)
      this.baseHealth = base
      return base
    }
    const executable = this.sources.filter(
      (
        state,
      ): state is Agent365SourceState & {
        connector: Agent365InventoryConnector
      } => state.connector !== undefined,
    )
    const aggregateByteBudget = responseByteBudget(this.config.limits.maxResponseBytes)
    const tasks = [
      { id: 'base', kind: 'base' as const },
      ...executable.map((state) => ({
        id: `agent365:${state.id}`,
        kind: 'agent365' as const,
        state,
      })),
    ]
    const aggregation = await aggregateLiveSources({
      sources: tasks,
      limits: {
        maxSources: 51,
        maxConcurrency: this.config.aggregation.maxConcurrency,
        maxDurationMs: this.config.aggregation.maxDurationMs,
        maxPagesPerSource: 1,
        maxRecordsPerSource: 1,
      },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      execute: async (task, context) => {
        const result =
          task.kind === 'base'
            ? await (this.base as OperationAwareAgentConnector).testConnection({
                signal: context.signal,
              })
            : await task.state.connector.testConnection(
                { signal: context.signal },
                aggregateByteBudget,
              )
        const reason =
          result.ok || task.kind === 'base' ? undefined : task.state.connector.getFailureReason()
        return {
          state: result.ok ? ('complete' as const) : ('partial' as const),
          value: result,
          pages: 0,
          records: 0,
          evidenceIds: [],
          ...(reason === undefined ? {} : { reason }),
        }
      },
      failureReason: safeAgent365FailureReason,
    })
    const baseOutcome = aggregation.outcomes[0]!
    const baseResult = baseOutcome.value
    this.baseHealth = baseResult ?? {
      ok: false,
      checkedAt: new Date().toISOString(),
      message: 'Primary discovery source connection test did not complete.',
    }
    for (const outcome of aggregation.outcomes.slice(1)) {
      if (outcome.source.kind !== 'agent365') continue
      const state = outcome.source.state
      const result = outcome.value
      state.checkedAt = result?.checkedAt ?? new Date().toISOString()
      if (outcome.state === 'complete' && result?.ok === true) {
        state.reason = undefined
        state.readiness = 'ready'
        continue
      }
      state.reason = outcome.reason ?? state.connector.getFailureReason() ?? 'request-failed'
      state.readiness = readinessForFailure(state.reason)
      state.dataState =
        state.dataState === 'complete' || state.dataState === 'empty'
          ? 'stale'
          : outcome.state === 'cancelled'
            ? 'cancelled'
            : 'failed'
    }
    const checkedAt = new Date().toISOString()
    for (const state of this.sources) {
      if (state.connector !== undefined) continue
      state.checkedAt = checkedAt
    }
    const ok = aggregation.complete && this.sources.every((state) => state.connector !== undefined)
    return {
      ok,
      checkedAt,
      message: ok
        ? 'The base connector and all enabled Agent 365 sources are reachable.'
        : 'The base connector or one or more enabled Agent 365 sources are unavailable.',
    }
  }

  async discover(request: ConnectorOperationRequest = {}): Promise<EstateSnapshot> {
    const base = await (this.base as OperationAwareAgentConnector).discover(request)
    this.baseHealth = {
      ok: true,
      checkedAt: new Date().toISOString(),
      message: 'Primary discovery completed.',
    }
    if (this.config === undefined) {
      this.evidenceById = new Map(base.evidence.map((item) => [item.id, item]))
      return base
    }
    const executable = this.sources.filter(
      (
        state,
      ): state is Agent365SourceState & {
        connector: Agent365InventoryConnector
      } => state.connector !== undefined,
    )
    const configuredMaxPages = Math.max(
      ...this.config.sources.map((source) => source.limits.maxPages),
    )
    const configuredMaxRecords = Math.max(
      ...this.config.sources.map((source) => source.limits.maxItems),
    )
    const recordBudgets = allocateRecordBudgets(executable, this.config.limits.maxItems)
    const aggregateByteBudget = responseByteBudget(this.config.limits.maxResponseBytes)
    const aggregation = await aggregateLiveSources({
      sources: executable,
      limits: {
        maxSources: 50,
        maxConcurrency: this.config.aggregation.maxConcurrency,
        maxDurationMs: this.config.aggregation.maxDurationMs,
        maxPagesPerSource: Math.min(request.maxPages ?? configuredMaxPages, configuredMaxPages),
        maxRecordsPerSource: Math.min(
          request.maxRecords ?? configuredMaxRecords,
          configuredMaxRecords,
        ),
      },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      execute: async (state, context) => {
        const recordBudget = recordBudgets.get(state.id) ?? 0
        if (recordBudget === 0) {
          throw new Agent365ConnectorError(
            'bounds',
            'Agent 365 aggregation reached the configured item limit.',
          )
        }
        const discovered = await state.connector.discover(
          {
            signal: context.signal,
            maxPages: Math.min(context.maxPages, state.source.limits.maxPages),
            maxRecords: Math.min(context.maxRecords, recordBudget),
          },
          aggregateByteBudget,
        )
        if (
          discovered.tenantId.toLowerCase() !== state.source.tenantId.toLowerCase() ||
          discovered.environment !== state.source.environment
        ) {
          throw new Agent365ConnectorError(
            'malformed-response',
            'Agent 365 discovery did not match its configured source boundary.',
          )
        }
        const measurement = state.connector.getLastMeasurement()
        return {
          state: measurement.truncated
            ? ('partial' as const)
            : measurement.records === 0
              ? ('empty' as const)
              : ('complete' as const),
          value: discovered,
          pages: measurement.pages,
          records: measurement.records,
          evidenceIds: discovered.evidence.map((item) => item.id),
          ...(measurement.truncated
            ? { reason: 'bounds' }
            : measurement.records === 0
              ? { reason: 'empty' }
              : {}),
        }
      },
      failureReason: safeAgent365FailureReason,
    })
    const additions: Agent365SourceSnapshot[] = []
    let remainingItems = this.config.limits.maxItems
    for (const outcome of aggregation.outcomes) {
      const state = outcome.source
      state.checkedAt = new Date().toISOString()
      state.dataState = outcome.state
      state.pages = outcome.pages
      state.records = outcome.records
      state.reason = outcome.reason
      state.provenance = {
        estateTenantId: base.tenantId,
        estateEnvironment: base.environment,
        sourceConnectorId: state.source.id,
        sourceTenantId: state.source.tenantId,
        sourceEnvironment: state.source.environment,
        provider: 'microsoft-graph-agent365-package-catalog',
        providerObjectId: AGENT365_PACKAGES_PATH,
      }
      if (outcome.state === 'complete') {
        state.readiness = 'ready'
      } else if (outcome.state === 'empty') {
        state.readiness = 'degraded'
      } else if (outcome.state === 'partial' && outcome.reason === 'bounds') {
        state.readiness = 'degraded'
      } else {
        state.readiness = readinessForFailure(outcome.reason)
      }
      if (outcome.value === undefined) continue
      if (outcome.value.nodes.length > remainingItems) {
        state.readiness = 'unavailable'
        state.dataState = 'partial'
        state.reason = 'bounds'
        continue
      }
      additions.push({ source: state.source, snapshot: outcome.value })
      remainingItems -= outcome.value.nodes.length
    }
    let snapshot = base
    try {
      snapshot = mergeAgent365Snapshots(base, additions)
    } catch {
      for (const state of this.sources.filter((item) => item.readiness === 'ready')) {
        state.readiness = 'unavailable'
        state.dataState = 'failed'
        state.reason = 'malformed-response'
      }
    }
    this.evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
    return snapshot
  }

  getConnectorHealth(): ConnectorHealthReport {
    const baseHealth = this.base.getConnectorHealth?.()
    const baseReady =
      baseHealth !== undefined ? baseHealth.overall !== 'unavailable' : this.baseHealth.ok
    const basePartial = baseHealth?.partial === true
    const complete =
      this.config !== undefined &&
      this.sources.length > 0 &&
      this.sources.every(
        (source) => source.dataState === 'complete' && source.readiness === 'ready',
      )
    const configurationSource =
      this.config === undefined
        ? [
            {
              id: 'agent365:configuration',
              name: 'Microsoft Agent 365 package catalog configuration',
              role: 'discovery' as const,
              enabled: true,
              configured: false,
              readiness: 'authorization-required' as const,
              reason: 'invalid-configuration',
            },
          ]
        : []
    return composeConnectorHealthReport(baseHealth, {
      overall: !baseReady ? 'unavailable' : basePartial || !complete ? 'degraded' : 'ready',
      partial: baseReady && (basePartial || !complete),
      sources: [
        ...(baseHealth?.sources ?? [
          {
            id: this.base.descriptor.id,
            name: this.base.descriptor.name,
            role: 'discovery' as const,
            enabled: true,
            configured: true,
            readiness: baseReady ? ('ready' as const) : ('unavailable' as const),
            checkedAt: this.baseHealth.checkedAt,
          },
        ]),
        ...configurationSource,
        ...this.sources.map((state) => ({
          id: `agent365:${state.source.id}`,
          name: state.source.name,
          role: 'discovery' as const,
          enabled: true,
          configured: true,
          readiness: state.readiness,
          ...(state.dataState === undefined ? {} : { dataState: state.dataState }),
          ...(state.pages === undefined ? {} : { pages: state.pages }),
          ...(state.records === undefined ? {} : { records: state.records }),
          ...(state.checkedAt !== undefined ? { checkedAt: state.checkedAt } : {}),
          ...(state.reason !== undefined ? { reason: state.reason } : {}),
          ...(state.provenance === undefined ? {} : { provenance: state.provenance }),
        })),
      ],
    })
  }

  getEvidence(id: string): Promise<Evidence> {
    const item = this.evidenceById.get(id)
    if (item === undefined) throw new Error(`Composite evidence was not found: ${id}`)
    return Promise.resolve(structuredClone(item))
  }

  execute(
    remediation: Remediation,
    approval: ApprovalContext,
  ): Promise<{ remediation: Remediation; snapshot: EstateSnapshot }> {
    if (this.base.execute === undefined) {
      return Promise.reject(new Error('Base connector does not support remediation execution.'))
    }
    return this.base.execute(remediation, approval)
  }
}

export interface OptionalAgent365Options extends Agent365CompositionOptions {
  credential?: TokenCredential
  client?: Agent365ClientOptions
}

export function createOptionalAgent365Connector(
  base: AgentConnector,
  environment: NodeJS.ProcessEnv = process.env,
  options: OptionalAgent365Options = {},
): OperationAwareAgentConnector {
  let enabled: boolean
  try {
    enabled = envBoolean(environment, 'AGENT365_CONNECTOR_ENABLED')
  } catch {
    return new Agent365CompositionConnector(base, undefined, options)
  }
  if (!enabled) return base
  let config: Agent365Config
  try {
    config = parseAgent365Config(environment)
  } catch {
    return new Agent365CompositionConnector(base, undefined, options)
  }
  return new Agent365CompositionConnector(base, config, {
    ...(options.credentialFactory !== undefined
      ? { credentialFactory: options.credentialFactory }
      : options.credential !== undefined
        ? { credentialFactory: () => options.credential! }
        : {}),
    ...(options.clientFactory !== undefined
      ? { clientFactory: options.clientFactory }
      : options.client !== undefined
        ? { clientFactory: () => options.client! }
        : {}),
  })
}

export { Agent365ConnectorError, Agent365GraphClient, AGENT365_TOKEN_SCOPE } from './client.js'
export {
  AGENT365_API_VERSION,
  AGENT365_DETAIL_CAPABILITY_ENABLED,
  AGENT365_GRAPH_ORIGIN,
  AGENT365_PACKAGES_PATH,
  agent365ConfigSchema,
  agent365LimitsSchema,
  agent365SourceConfigSchema,
  agent365SourcesConfigSchema,
  copilotPackageCollectionSchema,
  copilotPackageSchema,
  sanitizeAgent365GraphBaseUrl,
} from './schemas.js'
export {
  classifyAgent365Package,
  isAgentPackage,
  mapAgent365PackagesToSnapshot,
  mergeAgent365Snapshots,
} from './normalize.js'
export type { Agent365PackageClassification } from './normalize.js'
export type {
  Agent365ClientOptions,
  Agent365Collection,
  Agent365ErrorCode,
  Agent365ResponseByteBudget,
} from './client.js'
export type {
  Agent365Config,
  Agent365Limits,
  Agent365SourceConfig,
  CopilotPackage,
  CopilotPackageCollection,
} from './schemas.js'
