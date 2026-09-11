import type { TokenCredential } from '@azure/core-auth'
import { z } from 'zod'

import {
  composeConnectorHealthReport,
  type AgentConnector,
  type ApprovalContext,
  type ConnectionTestResult,
  type ConnectorCapability,
  type ConnectorDescriptor,
  type ConnectorHealthReport,
  type ConnectorReadiness,
} from '@agent-sentinel/connector-sdk'
import type { EstateSnapshot, Evidence, Remediation } from '@agent-sentinel/domain'

import { PurviewConnectorError, PurviewGraphClient, type PurviewClientOptions } from './client.js'
import {
  mapPurviewLabelsToSnapshot,
  mergePurviewSnapshots,
  type PurviewSourceSnapshot,
} from './normalize.js'
import {
  createPurviewSourceCredential,
  parsePurviewConfig,
  type PurviewCredentialFactory,
} from './source.js'
import {
  PURVIEW_API_VERSION,
  type PurviewConfig,
  type PurviewLimits,
  type PurviewSourceConfig,
} from './schemas.js'

export function safePurviewFailureReason(error: unknown): string {
  if (error instanceof PurviewConnectorError) {
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

export class PurviewLabelCatalogConnector implements AgentConnector {
  readonly descriptor: ConnectorDescriptor = {
    id: 'purview-sensitivity-labels',
    name: 'Microsoft Purview sensitivity-label catalog',
    apiVersion: PURVIEW_API_VERSION,
    releaseStatus: 'ga',
    capabilities: ['evidence'],
    requiredPermissions: [
      'Microsoft Graph application permission SensitivityLabel.Read with tenant-admin consent',
      'Microsoft Graph Global service',
    ],
    blindSpots: [
      'Catalog definitions do not observe labeled files, content, users, activity, usage, or label application.',
      'Microsoft Graph exposes no supported agent-specific key for sensitivity-label catalog definitions.',
    ],
  }
  private readonly client: PurviewGraphClient
  private evidenceById = new Map<string, Evidence>()
  private failureReason: string | undefined = 'not-queried'

  constructor(
    private readonly source: PurviewSourceConfig,
    limits: PurviewLimits,
    credential: TokenCredential,
    options: PurviewClientOptions = {},
  ) {
    this.client = new PurviewGraphClient(limits, credential, source.tenantId, options)
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const checkedAt = new Date().toISOString()
    try {
      await this.client.probe()
      this.failureReason = undefined
      return { ok: true, checkedAt, message: 'Purview sensitivity-label catalog is reachable.' }
    } catch (error) {
      this.failureReason = safePurviewFailureReason(error)
      return { ok: false, checkedAt, message: 'Purview sensitivity-label catalog is unavailable.' }
    }
  }

  async discover(maximum?: number): Promise<EstateSnapshot> {
    try {
      const snapshot = mapPurviewLabelsToSnapshot(await this.client.collect(maximum), this.source)
      this.failureReason = undefined
      this.evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
      return snapshot
    } catch (error) {
      this.failureReason = safePurviewFailureReason(error)
      throw error
    }
  }

  getFailureReason(): string | undefined {
    return this.failureReason
  }

  getEvidence(id: string): Promise<Evidence> {
    const item = this.evidenceById.get(id)
    if (item === undefined) {
      return Promise.reject(
        new PurviewConnectorError('request-failed', 'Purview evidence was not found.'),
      )
    }
    return Promise.resolve(structuredClone(item))
  }

  execute(): Promise<{ remediation: Remediation; snapshot: EstateSnapshot }> {
    return Promise.reject(new Error('Microsoft Purview sensitivity-label connector is read-only.'))
  }
}

interface PurviewSourceState {
  source: PurviewSourceConfig
  connector: PurviewLabelCatalogConnector | undefined
  readiness: ConnectorReadiness
  checkedAt: string | undefined
  reason: string | undefined
}

export interface PurviewCompositionOptions {
  credentialFactory?: PurviewCredentialFactory
  clientFactory?: (source: PurviewSourceConfig) => PurviewClientOptions | undefined
}

export class PurviewCompositionConnector implements AgentConnector {
  readonly descriptor: ConnectorDescriptor
  private readonly sources: PurviewSourceState[]
  private evidenceById = new Map<string, Evidence>()
  private baseHealth: ConnectionTestResult = {
    ok: false,
    checkedAt: new Date(0).toISOString(),
    message: 'Base connector has not been tested.',
  }

  constructor(
    private readonly base: AgentConnector,
    private readonly config: PurviewConfig | undefined,
    options: PurviewCompositionOptions = {},
  ) {
    const credentialFactory = options.credentialFactory ?? createPurviewSourceCredential
    this.sources = (config?.sources ?? []).map((source) => {
      try {
        return {
          source,
          connector: new PurviewLabelCatalogConnector(
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
        const reason = safePurviewFailureReason(error)
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
          'Microsoft Graph application permission SensitivityLabel.Read with tenant-admin consent',
        ]),
      ],
      blindSpots: [
        ...base.descriptor.blindSpots,
        'Purview sensitivity-label definitions remain tenant governance metadata and are not correlated to agents, content, users, activity, usage, trust, or compliance.',
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
    const additions: PurviewSourceSnapshot[] = []
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
        state.reason = state.connector.getFailureReason() ?? safePurviewFailureReason(error)
        state.readiness = readinessForFailure(state.reason)
        continue
      }
      if (
        discovered.tenantId.toLowerCase() !== state.source.tenantId.toLowerCase() ||
        discovered.environment !== state.source.environment
      ) {
        state.reason = 'malformed-response'
        state.readiness = 'unavailable'
        continue
      }
      if (discovered.nodes.length > remainingItems) {
        state.reason = 'bounds'
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
      snapshot = mergePurviewSnapshots(base, additions)
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
              id: 'purview:configuration',
              name: 'Microsoft Purview sensitivity-label catalog configuration',
              role: 'enrichment' as const,
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
          id: `purview:${state.source.id}`,
          name: state.source.name,
          role: 'enrichment' as const,
          enabled: true,
          configured: true,
          readiness: state.readiness,
          ...(state.checkedAt !== undefined ? { checkedAt: state.checkedAt } : {}),
          ...(state.reason !== undefined ? { reason: state.reason } : {}),
        })),
      ],
    })
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

export interface OptionalPurviewOptions extends PurviewCompositionOptions {
  credential?: TokenCredential
  client?: PurviewClientOptions
}

function envBoolean(environment: NodeJS.ProcessEnv, name: string): boolean {
  const value = environment[name]?.trim().toLowerCase()
  if (value === undefined || value === '') return false
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false.`)
  return value === 'true'
}

export function createOptionalPurviewConnector(
  base: AgentConnector,
  environment: NodeJS.ProcessEnv = process.env,
  options: OptionalPurviewOptions = {},
): AgentConnector {
  let enabled: boolean
  try {
    enabled = envBoolean(environment, 'PURVIEW_CONNECTOR_ENABLED')
  } catch {
    return new PurviewCompositionConnector(base, undefined, options)
  }
  if (!enabled) return base
  let config: PurviewConfig
  try {
    config = parsePurviewConfig(environment)
  } catch {
    return new PurviewCompositionConnector(base, undefined, options)
  }
  return new PurviewCompositionConnector(base, config, {
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
