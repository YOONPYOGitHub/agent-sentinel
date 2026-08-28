import type { TokenCredential } from '@azure/core-auth'
import {
  ClientAssertionCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity'
import { z } from 'zod'

import type {
  AgentConnector,
  ApprovalContext,
  ConnectionTestResult,
  ConnectorCapability,
  ConnectorDescriptor,
  ConnectorHealthReport,
  ConnectorReadiness,
} from '@agent-sentinel/connector-sdk'
import type { EstateSnapshot, Evidence, Remediation } from '@agent-sentinel/domain'

import {
  Agent365ConnectorError,
  Agent365GraphClient,
  type Agent365ClientOptions,
} from './client.js'
import {
  mapAgent365PackagesToSnapshot,
  mergeAgent365Snapshots,
  type Agent365SourceSnapshot,
} from './normalize.js'
import {
  AGENT365_API_VERSION,
  AGENT365_GRAPH_ORIGIN,
  agent365ConfigSchema,
  agent365LimitsSchema,
  type Agent365Config,
  type Agent365Limits,
  type Agent365SourceConfig,
} from './schemas.js'

export type Agent365CredentialFactory = (source: Agent365SourceConfig) => TokenCredential

export function createAgent365SourceCredential(source: Agent365SourceConfig): TokenCredential {
  if (source.credential?.mode === 'federated-app') {
    const managedIdentityClientId =
      source.credential.managedIdentityClientId ?? process.env['AZURE_CLIENT_ID']?.trim()
    if (!managedIdentityClientId) {
      throw new Agent365ConnectorError(
        'authentication',
        'Cross-tenant Agent 365 federation requires a user-assigned managed identity.',
      )
    }
    const assertionCredential = new ManagedIdentityCredential({
      clientId: managedIdentityClientId,
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
  return new DefaultAzureCredential({
    tenantId: source.tenantId,
    ...(source.credential?.managedIdentityClientId !== undefined
      ? { managedIdentityClientId: source.credential.managedIdentityClientId }
      : {}),
  })
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
      },
    ]
  }
  return agent365ConfigSchema.parse({
    graphBaseUrl: environment['AGENT365_GRAPH_BASE_URL']?.trim() || AGENT365_GRAPH_ORIGIN,
    limits: limitsFromEnvironment(environment),
    sources,
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

export class Agent365InventoryConnector implements AgentConnector {
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

  constructor(
    private readonly source: Agent365SourceConfig,
    limits: Agent365Limits,
    credential: TokenCredential,
    options: Agent365ClientOptions = {},
  ) {
    this.client = new Agent365GraphClient(limits, credential, source.tenantId, options)
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const checkedAt = new Date().toISOString()
    try {
      await this.client.probe()
      this.failureReason = undefined
      return { ok: true, checkedAt, message: 'Agent 365 package catalog is reachable.' }
    } catch (error) {
      this.failureReason = safeAgent365FailureReason(error)
      return { ok: false, checkedAt, message: 'Agent 365 package catalog is unavailable.' }
    }
  }

  async discover(): Promise<EstateSnapshot> {
    try {
      const snapshot = mapAgent365PackagesToSnapshot(await this.client.collect(), this.source)
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
  source: Agent365SourceConfig
  connector: Agent365InventoryConnector | undefined
  readiness: ConnectorReadiness
  checkedAt: string | undefined
  reason: string | undefined
}

export interface Agent365CompositionOptions {
  credentialFactory?: Agent365CredentialFactory
  clientFactory?: (source: Agent365SourceConfig) => Agent365ClientOptions
}

export class Agent365CompositionConnector implements AgentConnector {
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
          source,
          connector: new Agent365InventoryConnector(
            source,
            config!.limits,
            credentialFactory(source),
            options.clientFactory?.(source),
          ),
          readiness: 'degraded' as const,
          checkedAt: undefined,
          reason: 'not-queried',
        }
      } catch (error) {
        return {
          source,
          connector: undefined,
          readiness: 'unavailable' as const,
          checkedAt: undefined,
          reason: safeAgent365FailureReason(error),
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

  async testConnection(): Promise<ConnectionTestResult> {
    const [base, ...results] = await Promise.all([
      this.base.testConnection(),
      ...this.sources.map((state) => state.connector?.testConnection()),
    ])
    this.baseHealth = base
    for (const [index, result] of results.entries()) {
      const state = this.sources[index]!
      if (result === undefined || state.connector === undefined) continue
      state.checkedAt = result.checkedAt
      state.reason = result.ok ? undefined : state.connector.getFailureReason()
      state.readiness = result.ok ? 'ready' : readinessForFailure(state.reason)
    }
    return {
      ok: base.ok,
      checkedAt: new Date().toISOString(),
      message: base.ok
        ? 'Primary discovery source is reachable.'
        : 'Primary discovery source is unavailable.',
    }
  }

  async discover(): Promise<EstateSnapshot> {
    const base = await this.base.discover()
    this.baseHealth = {
      ok: true,
      checkedAt: new Date().toISOString(),
      message: 'Primary discovery completed.',
    }
    if (this.config === undefined) {
      this.evidenceById = new Map(base.evidence.map((item) => [item.id, item]))
      return base
    }
    const additions: Agent365SourceSnapshot[] = []
    let remainingItems = this.config.limits.maxItems
    for (const state of this.sources) {
      state.checkedAt = new Date().toISOString()
      if (state.connector === undefined) continue
      if (remainingItems === 0) {
        state.reason = 'bounds'
        state.readiness = readinessForFailure(state.reason)
        continue
      }
      let discovered: EstateSnapshot
      try {
        discovered = await state.connector.discover()
      } catch (error) {
        state.reason = state.connector.getFailureReason() ?? safeAgent365FailureReason(error)
        state.readiness = readinessForFailure(state.reason)
        continue
      }
      if (
        discovered.tenantId.toLowerCase() !== state.source.tenantId.toLowerCase() ||
        discovered.environment !== state.source.environment
      ) {
        state.readiness = 'unavailable'
        state.reason = 'malformed-response'
        continue
      }
      if (discovered.nodes.length > remainingItems) {
        state.readiness = 'unavailable'
        state.reason = 'bounds'
        continue
      }
      additions.push({ source: state.source, snapshot: discovered })
      remainingItems -= discovered.nodes.length
      state.readiness = 'ready'
      state.reason = undefined
    }
    let snapshot = base
    try {
      snapshot = mergeAgent365Snapshots(base, additions)
    } catch {
      for (const state of this.sources.filter((item) => item.readiness === 'ready')) {
        state.readiness = 'unavailable'
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
      this.sources.every((source) => source.readiness === 'ready')
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
    return {
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
          ...(state.checkedAt !== undefined ? { checkedAt: state.checkedAt } : {}),
          ...(state.reason !== undefined ? { reason: state.reason } : {}),
        })),
      ],
    }
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
): AgentConnector {
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
  isAgentPackage,
  mapAgent365PackagesToSnapshot,
  mergeAgent365Snapshots,
} from './normalize.js'
export type { Agent365ClientOptions, Agent365ErrorCode } from './client.js'
export type {
  Agent365Config,
  Agent365Limits,
  Agent365SourceConfig,
  CopilotPackage,
  CopilotPackageCollection,
} from './schemas.js'
