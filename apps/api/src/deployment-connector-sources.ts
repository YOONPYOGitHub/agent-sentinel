import { createHash } from 'node:crypto'

import { parseAgent365Config } from '@agent-sentinel/agent365-connector'
import { parseAzureResourceGraphConfig } from '@agent-sentinel/azure-resource-graph-connector'
import {
  resolveAzureMonitorOtelRuntimeActivation,
  type AzureMonitorOtelRuntimeMode,
} from '@agent-sentinel/azure-monitor-otel-connector'
import { parseDefenderCloudAppsConfig } from '@agent-sentinel/defender-cloud-apps-connector'
import {
  connectorSourceDefinitionSchema,
  type ConnectorCredentialMetadata,
  type ConnectorSourceAuditCursor,
  type ConnectorSourceAuditRecord,
  type ConnectorSourceCreateInput,
  type ConnectorSourceDefinition,
  type ConnectorSourceMutationContext,
  type ConnectorSourceRepository,
  type ConnectorSourceUpdateInput,
  type ConnectorSourceWriteResult,
  type ConnectorType,
  type EstateContext,
} from '@agent-sentinel/domain'
import { parseEntraSourcesConfig } from '@agent-sentinel/entra-identity-connector'
import { parseFoundryPortfolioConfig } from '@agent-sentinel/foundry-connector'
import { parsePowerPlatformConfig } from '@agent-sentinel/power-platform-connector'
import { parsePurviewConfig } from '@agent-sentinel/purview-connector'
import { parseTeamsDistributionConfig } from '@agent-sentinel/teams-distribution-connector'

import type { EstateRegistry } from './estate-config.js'

const DEPLOYMENT_TIMESTAMP = '1970-01-01T00:00:00.000Z'
const DEPLOYMENT_ACTOR = { type: 'deployment' as const, id: 'deployment-json' }

interface ProjectableSource {
  id: string
  name: string
  tenantId: string
  environment: string
  credential?:
    | {
        mode: 'default'
        managedIdentityClientId?: string | undefined
      }
    | {
        mode: 'federated-app'
        managedIdentityClientId?: string | undefined
        clientId: string
      }
    | undefined
}

interface CommonLimits {
  maxPages: number
  maxItems: number
  requestTimeoutMs: number
  maxRetries: number
  maxRetryAfterMs: number
  maxResponseBytes?: number
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function configured(environment: NodeJS.ProcessEnv, name: string): boolean {
  return (environment[name]?.trim().length ?? 0) > 0
}

function enabled(environment: NodeJS.ProcessEnv, name: string): boolean {
  const value = environment[name]?.trim().toLowerCase()
  if (value === undefined || value === '') return false
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false.`)
  return value === 'true'
}

function sourceId(type: ConnectorType, configuredId: string): string {
  const candidate = `${type}-${configuredId}`
  if (candidate.length <= 63) return candidate
  return `${type.slice(0, 45)}-${digest([type, configuredId]).slice(0, 16)}`
}

function credentialMetadata(
  credential: ProjectableSource['credential'],
  environment: NodeJS.ProcessEnv,
): ConnectorCredentialMetadata {
  if (credential === undefined) return { mode: 'default' }
  if (credential.mode === 'default') {
    return credential.managedIdentityClientId === undefined
      ? { mode: 'default' }
      : {
          mode: 'managed-identity',
          managedIdentityClientId: credential.managedIdentityClientId,
        }
  }
  const managedIdentityClientId =
    credential.managedIdentityClientId ?? environment['AZURE_CLIENT_ID']?.trim()
  if (credential.clientId === undefined || !managedIdentityClientId) {
    throw new Error(
      'Deployment connector source federation requires clientId and managedIdentityClientId metadata.',
    )
  }
  return {
    mode: 'federated-app',
    clientId: credential.clientId,
    managedIdentityClientId,
  }
}

function connectorLimits(limits: CommonLimits) {
  return {
    maxPages: limits.maxPages,
    maxItems: limits.maxItems,
    requestTimeoutMs: limits.requestTimeoutMs,
    maxRetries: limits.maxRetries,
    maxRetryAfterMs: limits.maxRetryAfterMs,
    ...(limits.maxResponseBytes === undefined ? {} : { maxResponseBytes: limits.maxResponseBytes }),
  }
}

function projectSource(
  registry: EstateRegistry,
  environment: NodeJS.ProcessEnv,
  type: ConnectorType,
  isEnabled: boolean,
  source: ProjectableSource,
  configuration: unknown,
): ConnectorSourceDefinition | undefined {
  const estate = registry.estates.find(
    (candidate) =>
      candidate.tenantId === source.tenantId && candidate.environment === source.environment,
  )
  if (estate === undefined) return undefined
  const id = sourceId(type, source.id)
  const core = {
    estateId: estate.id,
    tenantId: estate.tenantId,
    environment: estate.environment,
    sourceId: id,
    connectorType: type,
    displayName: source.name,
    enabled: isEnabled,
    origin: 'deployment' as const,
    configuration,
    credential: credentialMetadata(source.credential, environment),
    testStatus: { status: 'not-tested' as const },
  }
  return connectorSourceDefinitionSchema.parse({
    ...core,
    version: 1,
    etag: `deployment-${digest(core).slice(0, 32)}`,
    createdBy: DEPLOYMENT_ACTOR,
    updatedBy: DEPLOYMENT_ACTOR,
    createdAt: DEPLOYMENT_TIMESTAMP,
    updatedAt: DEPLOYMENT_TIMESTAMP,
  })
}

export function buildDeploymentConnectorSources(
  environment: NodeJS.ProcessEnv,
  registry: EstateRegistry,
  dataMode: AzureMonitorOtelRuntimeMode,
): ConnectorSourceDefinition[] {
  const definitions: ConnectorSourceDefinition[] = []
  const add = <T extends ProjectableSource>(
    type: ConnectorType,
    isEnabled: boolean,
    sources: readonly T[],
    configuration: (source: T) => unknown,
  ): void => {
    for (const source of sources) {
      const definition = projectSource(
        registry,
        environment,
        type,
        isEnabled,
        source,
        configuration(source),
      )
      if (definition !== undefined) definitions.push(definition)
    }
  }

  if (configured(environment, 'FOUNDRY_SOURCES_JSON')) {
    const config = parseFoundryPortfolioConfig(environment)
    add(
      'foundry',
      environment['AGENT_SENTINEL_CONNECTOR']?.trim() === 'foundry',
      config.sources,
      (source) => ({ type: 'foundry', projectEndpoint: source.projectEndpoint }),
    )
  }
  if (configured(environment, 'ENTRA_SOURCES_JSON')) {
    const sources = parseEntraSourcesConfig(environment)
    add('entra-identity', enabled(environment, 'ENTRA_CONNECTOR_ENABLED'), sources, (source) => ({
      type: 'entra-identity',
      graphBaseUrl: source.graphBaseUrl,
      capabilities: source.capabilities,
      limits: connectorLimits(source.limits),
    }))
  }
  if (configured(environment, 'POWER_PLATFORM_SOURCES_JSON')) {
    const config = parsePowerPlatformConfig(environment)
    add(
      'power-platform',
      enabled(environment, 'POWER_PLATFORM_CONNECTOR_ENABLED'),
      config.sources,
      (source) => ({
        type: 'power-platform',
        environmentId: source.environment,
        apiBaseUrl: config.apiBaseUrl,
        limits: connectorLimits(config.limits),
      }),
    )
  }
  if (configured(environment, 'AGENT365_SOURCES_JSON')) {
    const config = parseAgent365Config(environment)
    add('agent365', enabled(environment, 'AGENT365_CONNECTOR_ENABLED'), config.sources, () => ({
      type: 'agent365',
      graphBaseUrl: config.graphBaseUrl,
      limits: connectorLimits(config.limits),
    }))
  }
  if (configured(environment, 'DEFENDER_CLOUD_APPS_SOURCES_JSON')) {
    const config = parseDefenderCloudAppsConfig(environment)
    add(
      'defender-cloud-apps',
      enabled(environment, 'DEFENDER_CLOUD_APPS_CONNECTOR_ENABLED'),
      config.sources,
      (source) => ({
        type: 'defender-cloud-apps',
        apiBaseUrl: source.apiBaseUrl,
        lookbackHours: config.limits.lookbackHours,
        limits: connectorLimits(config.limits),
      }),
    )
  }
  if (configured(environment, 'PURVIEW_SOURCES_JSON')) {
    const config = parsePurviewConfig(environment)
    add('purview', enabled(environment, 'PURVIEW_CONNECTOR_ENABLED'), config.sources, () => ({
      type: 'purview',
      graphBaseUrl: config.graphBaseUrl,
      limits: connectorLimits(config.limits),
    }))
  }
  if (configured(environment, 'AZURE_RESOURCE_GRAPH_SOURCES_JSON')) {
    const config = parseAzureResourceGraphConfig(environment)
    add(
      'azure-resource-graph',
      enabled(environment, 'AZURE_RESOURCE_GRAPH_CONNECTOR_ENABLED'),
      config.sources,
      (source) => ({
        type: 'azure-resource-graph',
        subscriptions: source.subscriptions,
        managementBaseUrl: 'https://management.azure.com',
        limits: connectorLimits(config.limits),
      }),
    )
  }
  if (configured(environment, 'TEAMS_DISTRIBUTION_SOURCES_JSON')) {
    const config = parseTeamsDistributionConfig(environment)
    add(
      'teams-distribution',
      enabled(environment, 'TEAMS_DISTRIBUTION_CONNECTOR_ENABLED'),
      config.sources,
      () => ({
        type: 'teams-distribution',
        graphBaseUrl: config.graphBaseUrl,
        limits: connectorLimits(config.limits),
      }),
    )
  }
  const azureMonitorActivation = resolveAzureMonitorOtelRuntimeActivation(environment, dataMode)
  add(
    'azure-monitor-otel',
    azureMonitorActivation.active,
    azureMonitorActivation.sources,
    (source) => ({
      type: 'azure-monitor-otel',
      workspaceId: source.workspaceId,
      logsBaseUrl: 'https://api.loganalytics.io',
      baselineWindowHours: source.baselineWindowHours,
      observedWindowHours: source.observedWindowHours,
      requestTimeoutMs: source.requestTimeoutMs,
    }),
  )

  const keys = new Set<string>()
  for (const definition of definitions) {
    const key = `${definition.estateId}\0${definition.sourceId}`
    if (keys.has(key)) {
      throw new Error(`Duplicate projected deployment connector source: ${definition.sourceId}`)
    }
    keys.add(key)
  }
  return definitions.toSorted((left, right) => left.sourceId.localeCompare(right.sourceId))
}

export class DeploymentConnectorSourceRepository implements ConnectorSourceRepository {
  private readonly projected = new Map<string, ConnectorSourceDefinition>()

  constructor(
    private readonly repository: ConnectorSourceRepository,
    definitions: readonly ConnectorSourceDefinition[],
  ) {
    for (const value of definitions) {
      const source = connectorSourceDefinitionSchema.parse(value)
      if (source.origin !== 'deployment') {
        throw new Error('Projected connector sources must have deployment origin.')
      }
      const key = this.key(source.estateId, source.sourceId)
      if (this.projected.has(key)) {
        throw new Error(`Duplicate projected deployment connector source: ${source.sourceId}`)
      }
      this.projected.set(key, structuredClone(source))
    }
  }

  create(
    estate: EstateContext,
    input: ConnectorSourceCreateInput,
    mutation: ConnectorSourceMutationContext,
  ): Promise<ConnectorSourceWriteResult> {
    this.assertEstateProjectionBoundary(estate)
    if (this.projectedSource(estate, input.sourceId) !== undefined) {
      return Promise.resolve({ status: 'immutable' })
    }
    return this.repository.create(estate, input, mutation)
  }

  findById(
    estate: EstateContext,
    sourceIdValue: string,
  ): Promise<ConnectorSourceDefinition | null> {
    this.assertEstateProjectionBoundary(estate)
    const source = this.projectedSource(estate, sourceIdValue)
    return source === undefined
      ? this.repository.findById(estate, sourceIdValue)
      : Promise.resolve(structuredClone(source))
  }

  async list(
    estate: EstateContext,
    limit = 100,
    afterSourceId?: string,
  ): Promise<ConnectorSourceDefinition[]> {
    this.assertEstateProjectionBoundary(estate)
    const projected = [...this.projected.values()].filter(
      (source) =>
        source.estateId === estate.id &&
        (afterSourceId === undefined || source.sourceId > afterSourceId),
    )
    const persisted = await this.repository.list(
      estate,
      Math.min(1_000, limit + projected.length),
      afterSourceId,
    )
    const merged = new Map(persisted.map((source) => [source.sourceId, source]))
    for (const source of projected) merged.set(source.sourceId, source)
    return [...merged.values()]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
      .slice(0, limit)
      .map((source) => structuredClone(source))
  }

  update(
    estate: EstateContext,
    sourceIdValue: string,
    expectedEtag: string,
    patch: ConnectorSourceUpdateInput,
    mutation: ConnectorSourceMutationContext,
  ): Promise<ConnectorSourceWriteResult> {
    this.assertEstateProjectionBoundary(estate)
    if (this.projectedSource(estate, sourceIdValue) !== undefined) {
      return Promise.resolve({ status: 'immutable' })
    }
    return this.repository.update(estate, sourceIdValue, expectedEtag, patch, mutation)
  }

  delete(
    estate: EstateContext,
    sourceIdValue: string,
    expectedEtag: string,
    mutation: ConnectorSourceMutationContext,
  ): Promise<ConnectorSourceWriteResult> {
    this.assertEstateProjectionBoundary(estate)
    if (this.projectedSource(estate, sourceIdValue) !== undefined) {
      return Promise.resolve({ status: 'immutable' })
    }
    return this.repository.delete(estate, sourceIdValue, expectedEtag, mutation)
  }

  listAudit(
    estate: EstateContext,
    sourceIdValue: string,
    limit?: number,
    after?: ConnectorSourceAuditCursor,
  ): Promise<ConnectorSourceAuditRecord[]> {
    this.assertEstateProjectionBoundary(estate)
    if (this.projectedSource(estate, sourceIdValue) !== undefined) return Promise.resolve([])
    return this.repository.listAudit(estate, sourceIdValue, limit, after)
  }

  private assertEstateProjectionBoundary(estate: EstateContext): void {
    const source = [...this.projected.values()].find(
      (candidate) => candidate.estateId === estate.id,
    )
    if (
      source !== undefined &&
      (source.tenantId !== estate.tenantId || source.environment !== estate.environment)
    ) {
      throw new Error('Connector source estate boundary does not match the projected estate.')
    }
  }

  private projectedSource(
    estate: EstateContext,
    sourceIdValue: string,
  ): ConnectorSourceDefinition | undefined {
    return this.projected.get(this.key(estate.id, sourceIdValue))
  }

  private key(estateId: string, sourceIdValue: string): string {
    return `${estateId}\0${sourceIdValue}`
  }
}
