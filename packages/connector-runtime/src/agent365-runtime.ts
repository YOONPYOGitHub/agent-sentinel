import { createHash } from 'node:crypto'

import {
  AGENT365_GRAPH_ORIGIN,
  AGENT365_PACKAGES_PATH,
  Agent365CompositionConnector,
  agent365ConfigSchema,
  type Agent365Config,
  type Agent365CompositionOptions,
  type Agent365SourceConfig,
} from '@agent-sentinel/agent365-connector'
import {
  composeConnectorHealthReport,
  type AgentConnector,
  type ApprovalContext,
  type ConnectorHealthReport,
  type ConnectorHealthMeasurement,
  type ConnectorOperationRequest,
  type ConnectorSourceHealth,
  type OperationAwareAgentConnector,
} from '@agent-sentinel/connector-sdk'
import {
  agent365AggregationSchema,
  connectorSourceDefinitionSchema,
  connectorSourceReadModelSchema,
  isConnectorSourceMigrationRequired,
  type ConnectorSourceDefinition,
  type ConnectorSourceRepository,
  type EstateContext,
  type EstateSnapshot,
  type Evidence,
  type Remediation,
} from '@agent-sentinel/domain'

export type Agent365RuntimeInactiveReason =
  'source-disabled' | 'dedicated-workload-identity-required' | 'duplicate-tenant-boundary'

export interface Agent365RuntimeBinding {
  readonly estateId: string
  readonly tenantId: string
  readonly environment: string
  readonly sourceId: string
  readonly displayName: string
  readonly origin: 'deployment' | 'user'
  readonly sourceVersion: number
  readonly sourceEtag: string
  readonly activation:
    | { readonly status: 'active' }
    | {
        readonly status: 'inactive'
        readonly reason: Agent365RuntimeInactiveReason
      }
}

export interface ResolvedAgent365Runtime {
  readonly config: Agent365Config | undefined
  readonly bindings: readonly Agent365RuntimeBinding[]
  readonly sourceSetFingerprint: string
}

export interface ResolveAgent365RuntimeOptions {
  readonly pageSize?: number
  readonly maxSources?: number
}

export const AGENT365_HEALTH_MAX_AGE_MS = 24 * 60 * 60 * 1_000

function inactiveHealth(
  reason: Agent365RuntimeInactiveReason,
): Pick<ConnectorSourceHealth, 'enabled' | 'configured' | 'readiness' | 'dataState' | 'reason'> {
  switch (reason) {
    case 'source-disabled':
      return {
        enabled: false,
        configured: true,
        readiness: 'disabled',
        dataState: 'unsupported',
        reason,
      }
    case 'dedicated-workload-identity-required':
      return {
        enabled: true,
        configured: false,
        readiness: 'authorization-required',
        dataState: 'unsupported',
        reason,
      }
    case 'duplicate-tenant-boundary':
      return {
        enabled: true,
        configured: false,
        readiness: 'degraded',
        dataState: 'unsupported',
        reason,
      }
  }
}

export function agent365SourceSetFingerprint(bindings: readonly Agent365RuntimeBinding[]): string {
  const canonical = bindings
    .map((binding) => ({
      estateId: binding.estateId,
      tenantId: binding.tenantId,
      environment: binding.environment,
      sourceId: binding.sourceId,
      origin: binding.origin,
      sourceVersion: binding.sourceVersion,
      sourceEtag: binding.sourceEtag,
    }))
    .toSorted((left, right) => left.sourceId.localeCompare(right.sourceId))
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')
}

function staleAgent365Source(
  source: ConnectorHealthReport['sources'][number],
  reason: 'source-set-changed' | 'measurement-expired',
): ConnectorHealthReport['sources'][number] {
  if (!source.enabled || (reason === 'source-set-changed' && !source.id.startsWith('agent365:'))) {
    return source
  }
  return {
    ...source,
    readiness: 'degraded',
    dataState: 'stale',
    reason,
  }
}

export function reconcileAgent365PersistedHealth(
  measurement: ConnectorHealthMeasurement,
  bindings: readonly Agent365RuntimeBinding[],
  now = new Date(),
  maxAgeMs = AGENT365_HEALTH_MAX_AGE_MS,
): ConnectorHealthReport {
  const currentFingerprint = agent365SourceSetFingerprint(bindings)
  const measuredFingerprint =
    measurement.sourceSetFingerprint ?? measurement.health.sourceSetFingerprint
  const hasAgent365Measurement = measurement.health.sources.some((source) =>
    source.id.startsWith('agent365:'),
  )
  const reason =
    (hasAgent365Measurement || bindings.length > 0) && measuredFingerprint !== currentFingerprint
      ? ('source-set-changed' as const)
      : now.getTime() - Date.parse(measurement.measuredAt) > maxAgeMs
        ? ('measurement-expired' as const)
        : undefined
  if (reason === undefined) return measurement.health

  const sources = measurement.health.sources.map((source) => staleAgent365Source(source, reason))
  const existingIds = new Set(sources.map((source) => source.id))
  for (const binding of bindings) {
    const id = `agent365:${binding.sourceId}`
    if (existingIds.has(id)) continue
    const status =
      binding.activation.status === 'active'
        ? {
            enabled: true,
            configured: true,
            readiness: 'degraded' as const,
            dataState: 'stale' as const,
            reason,
          }
        : inactiveHealth(binding.activation.reason)
    sources.push({
      id,
      name: binding.displayName,
      role: 'discovery',
      ...status,
      checkedAt: measurement.measuredAt,
      provenance: {
        estateTenantId: binding.tenantId,
        estateEnvironment: binding.environment,
        sourceConnectorId: binding.sourceId,
        sourceTenantId: binding.tenantId,
        sourceEnvironment: binding.environment,
        provider: 'microsoft-graph-agent365-package-catalog',
        providerObjectId: AGENT365_PACKAGES_PATH,
      },
    })
  }
  return {
    ...measurement.health,
    overall: measurement.health.overall === 'unavailable' ? 'unavailable' : 'degraded',
    partial: true,
    sources,
  }
}

export function synthesizeAgent365UnmeasuredHealth(
  runtime: ResolvedAgent365Runtime,
): ConnectorHealthReport {
  const sources: ConnectorSourceHealth[] = runtime.bindings.map((binding) => ({
    id: `agent365:${binding.sourceId}`,
    name: binding.displayName,
    role: 'discovery',
    ...(binding.activation.status === 'active'
      ? {
          enabled: true,
          configured: true,
          readiness: 'unavailable' as const,
          reason: 'not-measured',
        }
      : inactiveHealth(binding.activation.reason)),
    provenance: {
      estateTenantId: binding.tenantId,
      estateEnvironment: binding.environment,
      sourceConnectorId: binding.sourceId,
      sourceTenantId: binding.tenantId,
      sourceEnvironment: binding.environment,
      provider: 'microsoft-graph-agent365-package-catalog',
      providerObjectId: AGENT365_PACKAGES_PATH,
    },
  }))
  return {
    overall: 'unavailable',
    partial: sources.some((source) => source.enabled && source.readiness !== 'disabled'),
    sourceSetFingerprint: runtime.sourceSetFingerprint,
    sources,
  }
}

class Agent365RuntimeConnector implements OperationAwareAgentConnector {
  readonly descriptor

  constructor(
    private readonly inner: AgentConnector,
    private readonly bindings: readonly Agent365RuntimeBinding[],
    private readonly sourceSetFingerprint: string,
  ) {
    this.descriptor = inner.descriptor
  }

  async testConnection(
    request: ConnectorOperationRequest = {},
  ): Promise<Awaited<ReturnType<OperationAwareAgentConnector['testConnection']>>> {
    const result = await (this.inner as OperationAwareAgentConnector).testConnection(request)
    const hasEnabledInactiveSource = this.bindings.some(
      (binding) =>
        binding.activation.status === 'inactive' && binding.activation.reason !== 'source-disabled',
    )
    if (!hasEnabledInactiveSource) return result
    return {
      ok: false,
      checkedAt: result.checkedAt,
      message: 'One or more enabled Agent 365 sources are inactive or unavailable.',
    }
  }

  discover(request: ConnectorOperationRequest = {}): Promise<EstateSnapshot> {
    return (this.inner as OperationAwareAgentConnector).discover(request)
  }

  getEvidence(evidenceId: string): Promise<Evidence> {
    return this.inner.getEvidence(evidenceId)
  }

  getConnectorHealth(): ConnectorHealthReport {
    const health = this.inner.getConnectorHealth?.() ?? {
      overall: 'unavailable' as const,
      partial: false,
      sources: [],
    }
    const inactive = this.bindings
      .filter(
        (
          binding,
        ): binding is Agent365RuntimeBinding & {
          activation: {
            status: 'inactive'
            reason: Agent365RuntimeInactiveReason
          }
        } => binding.activation.status === 'inactive',
      )
      .map((binding) => ({
        id: `agent365:${binding.sourceId}`,
        name: binding.displayName,
        role: 'discovery' as const,
        ...inactiveHealth(binding.activation.reason),
        provenance: {
          estateTenantId: binding.tenantId,
          estateEnvironment: binding.environment,
          sourceConnectorId: binding.sourceId,
          sourceTenantId: binding.tenantId,
          sourceEnvironment: binding.environment,
          provider: 'microsoft-graph-agent365-package-catalog',
          providerObjectId: AGENT365_PACKAGES_PATH,
        },
      }))
    const enabledInactive = inactive.some((source) => source.enabled)
    return composeConnectorHealthReport(health, {
      sourceSetFingerprint: this.sourceSetFingerprint,
      overall:
        health.overall === 'unavailable'
          ? 'unavailable'
          : health.partial || enabledInactive
            ? 'degraded'
            : health.overall,
      partial: health.partial || enabledInactive,
      sources: [...health.sources, ...inactive],
    })
  }

  execute(
    remediation: Remediation,
    approval: ApprovalContext,
  ): Promise<{ remediation: Remediation; snapshot: EstateSnapshot }> {
    if (this.inner.execute === undefined) {
      return Promise.reject(new Error('Base connector does not support remediation execution.'))
    }
    return this.inner.execute(remediation, approval)
  }
}

export function createAgent365RuntimeConnector(
  base: AgentConnector,
  runtime: ResolvedAgent365Runtime,
  options: Agent365CompositionOptions = {},
): OperationAwareAgentConnector {
  const inner =
    runtime.config === undefined
      ? base
      : new Agent365CompositionConnector(base, runtime.config, options)
  return new Agent365RuntimeConnector(inner, runtime.bindings, runtime.sourceSetFingerprint)
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`)
  }
  return value
}

function activationFor(source: ConnectorSourceDefinition): Agent365RuntimeBinding['activation'] {
  if (!source.enabled) return { status: 'inactive', reason: 'source-disabled' }
  if (source.credential.mode !== 'managed-identity' && source.credential.mode !== 'federated-app') {
    return {
      status: 'inactive',
      reason: 'dedicated-workload-identity-required',
    }
  }
  return { status: 'active' }
}

function sourceConfig(source: ConnectorSourceDefinition): Agent365SourceConfig {
  if (source.configuration.type !== 'agent365') {
    throw new Error(`Connector source ${source.sourceId} is not an Agent 365 source.`)
  }
  const credential =
    source.credential.mode === 'managed-identity'
      ? {
          mode: 'managed-identity' as const,
          managedIdentityClientId: source.credential.managedIdentityClientId,
        }
      : source.credential.mode === 'federated-app'
        ? {
            mode: 'federated-app' as const,
            clientId: source.credential.clientId,
            managedIdentityClientId: source.credential.managedIdentityClientId,
          }
        : undefined
  if (credential === undefined) {
    throw new Error(`Connector source ${source.sourceId} has no runtime workload identity.`)
  }
  return {
    id: source.sourceId,
    name: source.displayName,
    tenantId: source.tenantId,
    environment: source.environment,
    graphBaseUrl: source.configuration.graphBaseUrl,
    limits: source.configuration.limits,
    credential,
  }
}

export async function resolveAgent365Runtime(
  repository: ConnectorSourceRepository,
  estate: EstateContext,
  options: ResolveAgent365RuntimeOptions = {},
): Promise<ResolvedAgent365Runtime> {
  const pageSize = positiveInteger(options.pageSize ?? 100, 'pageSize', 1_000)
  const maxSources = positiveInteger(options.maxSources ?? 1_000, 'maxSources', 1_000)
  const sources: ConnectorSourceDefinition[] = []
  const seen = new Set<string>()
  let sourceCount = 0
  let cursor: string | undefined

  for (;;) {
    const remaining = maxSources - sourceCount
    const limit = Math.min(pageSize, remaining + 1)
    const page = await repository.list(estate, limit, cursor)
    if (page.length === 0) break
    const nextCursor = page.at(-1)!.sourceId
    if (cursor !== undefined && nextCursor <= cursor) {
      throw new Error('Connector source pagination did not advance.')
    }

    for (const value of page) {
      const readModel = connectorSourceReadModelSchema.parse(value)
      if (
        readModel.estateId !== estate.id ||
        readModel.tenantId !== estate.tenantId ||
        readModel.environment !== estate.environment
      ) {
        throw new Error(
          `Connector source ${readModel.sourceId} does not match the requested estate boundary.`,
        )
      }
      if (seen.has(readModel.sourceId)) {
        throw new Error(`Duplicate connector source identity: ${readModel.sourceId}`)
      }
      seen.add(readModel.sourceId)
      sourceCount += 1
      if (sourceCount > maxSources) {
        throw new Error(`Connector source count exceeds the runtime maximum of ${maxSources}.`)
      }
      if (isConnectorSourceMigrationRequired(readModel)) continue
      sources.push(connectorSourceDefinitionSchema.parse(readModel))
    }

    cursor = nextCursor
    if (page.length < limit) break
  }

  const agent365Sources = sources
    .filter((source) => source.connectorType === 'agent365')
    .toSorted(
      (left, right) =>
        Number(right.origin === 'deployment') - Number(left.origin === 'deployment') ||
        left.sourceId.localeCompare(right.sourceId),
    )
  const deploymentTenants = new Set(
    agent365Sources
      .filter((source) => source.origin === 'deployment')
      .map((source) => source.tenantId.toLowerCase()),
  )
  const activeTenants = new Set<string>()
  const resolvedSources = agent365Sources.map((source) => {
    let activation = activationFor(source)
    const tenantId = source.tenantId.toLowerCase()
    if (activation.status === 'active') {
      if (
        activeTenants.has(tenantId) ||
        (source.origin === 'user' && deploymentTenants.has(tenantId))
      ) {
        activation = { status: 'inactive', reason: 'duplicate-tenant-boundary' }
      } else {
        activeTenants.add(tenantId)
      }
    }
    return { source, activation }
  })
  const bindings = resolvedSources.map(({ source, activation }): Agent365RuntimeBinding => ({
    estateId: source.estateId,
    tenantId: source.tenantId,
    environment: source.environment,
    sourceId: source.sourceId,
    displayName: source.displayName,
    origin: source.origin,
    sourceVersion: source.version,
    sourceEtag: source.etag,
    activation,
  }))
  const activeResolvedSources = resolvedSources.filter(
    (
      value,
    ): value is typeof value & {
      activation: { status: 'active' }
    } => value.activation.status === 'active',
  )
  const activeSources = activeResolvedSources.map(({ source }) => sourceConfig(source))
  const sourceSetFingerprint = agent365SourceSetFingerprint(bindings)
  if (activeSources.length === 0) {
    return { config: undefined, bindings, sourceSetFingerprint }
  }
  const first = activeSources[0]!
  const aggregationSource = activeResolvedSources[0]!.source
  if (aggregationSource.configuration.type !== 'agent365') {
    throw new Error(`Connector source ${aggregationSource.sourceId} is not an Agent 365 source.`)
  }
  return {
    config: agent365ConfigSchema.parse({
      graphBaseUrl: first.graphBaseUrl ?? AGENT365_GRAPH_ORIGIN,
      limits: first.limits,
      aggregation: agent365AggregationSchema.parse(aggregationSource.configuration.aggregation),
      sources: activeSources,
    }),
    bindings,
    sourceSetFingerprint,
  }
}
