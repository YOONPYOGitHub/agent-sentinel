import type { TokenCredential } from '@azure/core-auth'
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
  AzureResourceGraphClient,
  AzureResourceGraphConnectorError,
  type AzureResourceGraphClientOptions,
} from './client.js'
import {
  mapAzureResourcesToSnapshot,
  mergeAzureResourceGraphSnapshots,
  type AzureResourceGraphSourceSnapshot,
} from './normalize.js'
import {
  createAzureResourceGraphSourceCredential,
  parseAzureResourceGraphConfig,
  type AzureResourceGraphCredentialFactory,
} from './source.js'
import {
  AZURE_RESOURCE_GRAPH_API_VERSION,
  type AzureResourceGraphConfig,
  type AzureResourceGraphLimits,
  type AzureResourceGraphSourceConfig,
} from './schemas.js'

export function safeAzureResourceGraphFailureReason(error: unknown): string {
  if (error instanceof AzureResourceGraphConnectorError) {
    return error.code === 'request-failed' && error.status !== undefined
      ? `request-failed:${error.status}`
      : error.code
  }
  if (error instanceof z.ZodError) return 'malformed-response'
  return 'request-failed'
}

function readinessForFailure(reason: string | undefined): ConnectorReadiness {
  return reason === 'authorization' || reason === 'authentication'
    ? 'authorization-required'
    : 'unavailable'
}

export class AzureResourceInventoryConnector implements AgentConnector {
  readonly descriptor: ConnectorDescriptor = {
    id: 'azure-resource-graph',
    name: 'Azure Resource Graph inventory',
    apiVersion: AZURE_RESOURCE_GRAPH_API_VERSION,
    releaseStatus: 'ga',
    capabilities: ['evidence'],
    requiredPermissions: [
      'Azure Reader or narrower read access on every configured subscription',
      'Microsoft.ResourceGraph/resources/read through Azure Resource Manager',
    ],
    blindSpots: [
      'Resource inventory does not identify AI agents, runtime behavior, data access, ownership, health, trust, or compliance.',
      'Only fixed Azure AI and supporting-resource types and bounded core fields are queried.',
    ],
  }
  private readonly client: AzureResourceGraphClient
  private evidenceById = new Map<string, Evidence>()
  private failureReason: string | undefined = 'not-queried'

  constructor(
    private readonly source: AzureResourceGraphSourceConfig,
    limits: AzureResourceGraphLimits,
    credential: TokenCredential,
    options: AzureResourceGraphClientOptions = {},
  ) {
    this.client = new AzureResourceGraphClient(source, limits, credential, options)
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const checkedAt = new Date().toISOString()
    try {
      await this.client.probe()
      this.failureReason = undefined
      return { ok: true, checkedAt, message: 'Azure Resource Graph is reachable.' }
    } catch (error) {
      this.failureReason = safeAzureResourceGraphFailureReason(error)
      return { ok: false, checkedAt, message: 'Azure Resource Graph is unavailable.' }
    }
  }

  async discover(maximum?: number): Promise<EstateSnapshot> {
    try {
      const snapshot = mapAzureResourcesToSnapshot(await this.client.collect(maximum), this.source)
      this.failureReason = undefined
      this.evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
      return snapshot
    } catch (error) {
      this.failureReason = safeAzureResourceGraphFailureReason(error)
      throw error
    }
  }

  getFailureReason(): string | undefined {
    return this.failureReason
  }

  getEvidence(id: string): Promise<Evidence> {
    const item = this.evidenceById.get(id)
    return item === undefined
      ? Promise.reject(
          new AzureResourceGraphConnectorError(
            'request-failed',
            'Azure Resource Graph evidence was not found.',
          ),
        )
      : Promise.resolve(structuredClone(item))
  }

  execute(): Promise<{ remediation: Remediation; snapshot: EstateSnapshot }> {
    return Promise.reject(new Error('Azure Resource Graph connector is read-only.'))
  }
}

interface AzureResourceGraphSourceState {
  source: AzureResourceGraphSourceConfig
  connector: AzureResourceInventoryConnector | undefined
  readiness: ConnectorReadiness
  checkedAt: string | undefined
  reason: string | undefined
}

export interface AzureResourceGraphCompositionOptions {
  credentialFactory?: AzureResourceGraphCredentialFactory
  clientFactory?: (
    source: AzureResourceGraphSourceConfig,
  ) => AzureResourceGraphClientOptions | undefined
}

export class AzureResourceGraphCompositionConnector implements AgentConnector {
  readonly descriptor: ConnectorDescriptor
  private readonly sources: AzureResourceGraphSourceState[]
  private evidenceById = new Map<string, Evidence>()
  private baseHealth: ConnectionTestResult = {
    ok: false,
    checkedAt: new Date(0).toISOString(),
    message: 'Base connector has not been tested.',
  }

  constructor(
    private readonly base: AgentConnector,
    private readonly config: AzureResourceGraphConfig | undefined,
    options: AzureResourceGraphCompositionOptions = {},
  ) {
    const credentialFactory = options.credentialFactory ?? createAzureResourceGraphSourceCredential
    this.sources = (config?.sources ?? []).map((source) => {
      try {
        return {
          source,
          connector: new AzureResourceInventoryConnector(
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
        const reason = safeAzureResourceGraphFailureReason(error)
        return {
          source,
          connector: undefined,
          readiness: readinessForFailure(reason),
          checkedAt: undefined,
          reason,
        }
      }
    })
    this.descriptor = {
      ...base.descriptor,
      capabilities: [
        ...new Set<ConnectorCapability>([...base.descriptor.capabilities, 'evidence']),
      ],
      requiredPermissions: [
        ...new Set([
          ...base.descriptor.requiredPermissions,
          'Azure Reader or narrower read access on every configured subscription',
        ]),
      ],
      blindSpots: [
        ...base.descriptor.blindSpots,
        'Azure Resource Graph resource presence remains unattributed control evidence and never identifies an agent.',
      ],
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const base = await this.base.testConnection()
    this.baseHealth = base
    for (const state of this.sources) {
      if (state.connector === undefined) continue
      const result = await state.connector.testConnection()
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
    const additions: AzureResourceGraphSourceSnapshot[] = []
    let remainingItems = this.config.limits.maxItems
    for (const state of this.sources) {
      state.checkedAt = new Date().toISOString()
      if (state.connector === undefined) continue
      if (remainingItems === 0) {
        state.reason = 'bounds'
        state.readiness = 'unavailable'
        continue
      }
      let discovered: EstateSnapshot
      try {
        discovered = await state.connector.discover(remainingItems)
      } catch (error) {
        state.reason =
          state.connector.getFailureReason() ?? safeAzureResourceGraphFailureReason(error)
        state.readiness = readinessForFailure(state.reason)
        continue
      }
      if (
        discovered.tenantId.toLowerCase() !== state.source.tenantId.toLowerCase() ||
        discovered.environment !== state.source.environment ||
        discovered.nodes.length > remainingItems
      ) {
        state.reason = 'malformed-response'
        state.readiness = 'unavailable'
        continue
      }
      additions.push({ source: state.source, snapshot: discovered })
      remainingItems -= discovered.nodes.length
      state.readiness = 'ready'
      state.reason = undefined
    }
    let snapshot = base
    try {
      snapshot = mergeAzureResourceGraphSnapshots(base, additions)
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
              id: 'azure-resource-graph:configuration',
              name: 'Azure Resource Graph configuration',
              role: 'enrichment' as const,
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
          id: `azure-resource-graph:${state.source.id}`,
          name: state.source.name,
          role: 'enrichment' as const,
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
    return item === undefined ? this.base.getEvidence(id) : Promise.resolve(structuredClone(item))
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

export interface OptionalAzureResourceGraphOptions extends AzureResourceGraphCompositionOptions {
  credential?: TokenCredential
  client?: AzureResourceGraphClientOptions
}

function envBoolean(environment: NodeJS.ProcessEnv, name: string): boolean {
  const value = environment[name]?.trim().toLowerCase()
  if (value === undefined || value === '') return false
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false.`)
  return value === 'true'
}

export function createOptionalAzureResourceGraphConnector(
  base: AgentConnector,
  environment: NodeJS.ProcessEnv = process.env,
  options: OptionalAzureResourceGraphOptions = {},
): AgentConnector {
  let enabled: boolean
  try {
    enabled = envBoolean(environment, 'AZURE_RESOURCE_GRAPH_CONNECTOR_ENABLED')
  } catch {
    return new AzureResourceGraphCompositionConnector(base, undefined, options)
  }
  if (!enabled) return base
  let config: AzureResourceGraphConfig
  try {
    config = parseAzureResourceGraphConfig(environment)
  } catch {
    return new AzureResourceGraphCompositionConnector(base, undefined, options)
  }
  return new AzureResourceGraphCompositionConnector(base, config, {
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
