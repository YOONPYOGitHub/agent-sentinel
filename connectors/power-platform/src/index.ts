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
  PowerPlatformConnectorError,
  PowerPlatformResourceQueryClient,
  type PowerPlatformClientOptions,
} from './client.js'
import {
  mapPowerPlatformAgentsToSnapshot,
  mergePowerPlatformSnapshots,
  type PowerPlatformSourceSnapshot,
} from './normalize.js'
import {
  POWER_PLATFORM_API_ORIGIN,
  POWER_PLATFORM_API_VERSION,
  powerPlatformConfigSchema,
  powerPlatformLimitsSchema,
  type PowerPlatformConfig,
  type PowerPlatformLimits,
  type PowerPlatformSourceConfig,
} from './schemas.js'

export type PowerPlatformCredentialFactory = (source: PowerPlatformSourceConfig) => TokenCredential

export function createPowerPlatformSourceCredential(
  source: PowerPlatformSourceConfig,
): TokenCredential {
  if (source.credential?.mode === 'federated-app') {
    const managedIdentityClientId =
      source.credential.managedIdentityClientId ?? process.env['AZURE_CLIENT_ID']?.trim()
    if (!managedIdentityClientId) {
      throw new PowerPlatformConnectorError(
        'authentication',
        'Cross-tenant Power Platform federation requires a user-assigned managed identity.',
      )
    }
    const assertionCredential = new ManagedIdentityCredential({
      clientId: managedIdentityClientId,
    })
    return new ClientAssertionCredential(source.tenantId, source.credential.clientId, async () => {
      const assertion = await assertionCredential.getToken('api://AzureADTokenExchange/.default')
      if (assertion === null) {
        throw new PowerPlatformConnectorError(
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

function limitsFromEnvironment(environment: NodeJS.ProcessEnv): PowerPlatformLimits {
  return powerPlatformLimitsSchema.parse({
    pageSize: envNumber(environment, 'POWER_PLATFORM_PAGE_SIZE'),
    maxPages: envNumber(environment, 'POWER_PLATFORM_MAX_PAGES'),
    maxItems: envNumber(environment, 'POWER_PLATFORM_MAX_ITEMS'),
    requestTimeoutMs: envNumber(environment, 'POWER_PLATFORM_REQUEST_TIMEOUT_MS'),
    maxRetries: envNumber(environment, 'POWER_PLATFORM_MAX_RETRIES'),
    maxRetryAfterMs: envNumber(environment, 'POWER_PLATFORM_MAX_RETRY_AFTER_MS'),
    maxResponseBytes: envNumber(environment, 'POWER_PLATFORM_MAX_RESPONSE_BYTES'),
  })
}

export function parsePowerPlatformConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PowerPlatformConfig {
  let sources: unknown
  const sourcesJson = environment['POWER_PLATFORM_SOURCES_JSON']?.trim()
  if (sourcesJson !== undefined && sourcesJson !== '') {
    try {
      sources = JSON.parse(sourcesJson)
    } catch {
      throw new Error('POWER_PLATFORM_SOURCES_JSON must be valid JSON.')
    }
  } else {
    const tenantId = environment['POWER_PLATFORM_TENANT_ID']?.trim()
    const sourceEnvironment = environment['POWER_PLATFORM_ENVIRONMENT']?.trim()
    if (!tenantId || !sourceEnvironment) {
      throw new Error(
        'POWER_PLATFORM_TENANT_ID and POWER_PLATFORM_ENVIRONMENT are required when no source JSON is supplied.',
      )
    }
    sources = [
      {
        id: 'primary',
        name: 'Primary Power Platform environment',
        tenantId,
        environment: sourceEnvironment,
      },
    ]
  }
  return powerPlatformConfigSchema.parse({
    apiBaseUrl: environment['POWER_PLATFORM_API_BASE_URL']?.trim() || POWER_PLATFORM_API_ORIGIN,
    limits: limitsFromEnvironment(environment),
    sources,
  })
}

export function safePowerPlatformFailureReason(error: unknown): string {
  if (error instanceof PowerPlatformConnectorError) {
    return error.code === 'request-failed' &&
      error.status !== undefined &&
      error.status >= 400 &&
      error.status <= 599
      ? `request-failed:${error.status}`
      : error.code
  }
  if (error instanceof z.ZodError) return 'malformed-response'
  return 'request-failed'
}

function readinessForFailure(reason: string | undefined): ConnectorReadiness {
  return reason === 'authorization' ? 'authorization-required' : 'unavailable'
}

export class PowerPlatformInventoryConnector implements AgentConnector {
  readonly descriptor: ConnectorDescriptor = {
    id: 'power-platform-resourcequery',
    name: 'Power Platform ResourceQuery agent inventory',
    apiVersion: POWER_PLATFORM_API_VERSION,
    releaseStatus: 'preview',
    capabilities: ['discovery', 'evidence'],
    requiredPermissions: [
      'Power Platform Reader (or approved least-privilege ResourceQuery read RBAC) at the intended tenant scope',
    ],
    blindSpots: [
      'Copilot Studio inventory schema is preview overall.',
      'Core inventory does not authoritatively describe connectors, channels, authentication, entitlements, tools, or runtime behavior.',
    ],
  }
  private readonly client: PowerPlatformResourceQueryClient
  private evidenceById = new Map<string, Evidence>()
  private failureReason: string | undefined = 'not-queried'

  constructor(
    private readonly source: PowerPlatformSourceConfig,
    limits: PowerPlatformLimits,
    credential: TokenCredential,
    options: PowerPlatformClientOptions = {},
  ) {
    this.client = new PowerPlatformResourceQueryClient(source, limits, credential, options)
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const checkedAt = new Date().toISOString()
    try {
      await this.client.probe()
      this.failureReason = undefined
      return {
        ok: true,
        checkedAt,
        message: 'Power Platform ResourceQuery agent inventory is reachable.',
      }
    } catch (error) {
      this.failureReason = safePowerPlatformFailureReason(error)
      return {
        ok: false,
        checkedAt,
        message: 'Power Platform ResourceQuery agent inventory is unavailable.',
      }
    }
  }

  async discover(): Promise<EstateSnapshot> {
    try {
      const snapshot = mapPowerPlatformAgentsToSnapshot(await this.client.collect(), this.source)
      this.failureReason = undefined
      this.evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
      return snapshot
    } catch (error) {
      this.failureReason = safePowerPlatformFailureReason(error)
      throw error
    }
  }

  getFailureReason(): string | undefined {
    return this.failureReason
  }

  getEvidence(id: string): Promise<Evidence> {
    const item = this.evidenceById.get(id)
    if (item === undefined) {
      throw new PowerPlatformConnectorError(
        'request-failed',
        'Power Platform evidence was not found.',
      )
    }
    return Promise.resolve(structuredClone(item))
  }

  execute(): Promise<{ remediation: Remediation; snapshot: EstateSnapshot }> {
    return Promise.reject(new Error('Power Platform ResourceQuery connector is read-only.'))
  }
}

interface PowerPlatformSourceState {
  source: PowerPlatformSourceConfig
  connector: PowerPlatformInventoryConnector | undefined
  readiness: ConnectorReadiness
  checkedAt: string | undefined
  reason: string | undefined
}

export interface PowerPlatformCompositionOptions {
  credentialFactory?: PowerPlatformCredentialFactory
  clientFactory?: (source: PowerPlatformSourceConfig) => PowerPlatformClientOptions
}

export class PowerPlatformCompositionConnector implements AgentConnector {
  readonly descriptor: ConnectorDescriptor
  private readonly sources: PowerPlatformSourceState[]
  private evidenceById = new Map<string, Evidence>()
  private baseHealth: ConnectionTestResult = {
    ok: false,
    checkedAt: new Date(0).toISOString(),
    message: 'Base connector has not been tested.',
  }

  constructor(
    private readonly base: AgentConnector,
    private readonly config: PowerPlatformConfig | undefined,
    options: PowerPlatformCompositionOptions = {},
  ) {
    const credentialFactory = options.credentialFactory ?? createPowerPlatformSourceCredential
    this.sources = (config?.sources ?? []).map((source) => {
      try {
        return {
          source,
          connector: new PowerPlatformInventoryConnector(
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
          readiness: 'degraded' as const,
          checkedAt: undefined,
          reason: safePowerPlatformFailureReason(error),
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
          'Power Platform Reader (or approved least-privilege ResourceQuery read RBAC) at the intended tenant scope',
        ]),
      ],
      blindSpots: [
        ...base.descriptor.blindSpots,
        'Power Platform core agent inventory schema is preview and does not prove runtime behavior.',
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
    const results = await Promise.allSettled(
      this.sources.map(async (state) =>
        state.connector === undefined
          ? { state, snapshot: undefined }
          : { state, snapshot: await state.connector.discover() },
      ),
    )
    const additions: PowerPlatformSourceSnapshot[] = []
    for (const [index, result] of results.entries()) {
      const state = this.sources[index]!
      state.checkedAt = new Date().toISOString()
      if (result.status === 'rejected') {
        state.reason =
          state.connector?.getFailureReason() ?? safePowerPlatformFailureReason(result.reason)
        state.readiness = readinessForFailure(state.reason)
        continue
      }
      if (result.value.snapshot === undefined) continue
      if (
        result.value.snapshot.tenantId.toLowerCase() !== state.source.tenantId.toLowerCase() ||
        result.value.snapshot.environment !== state.source.environment
      ) {
        state.readiness = 'degraded'
        state.reason = 'malformed-response'
        continue
      }
      additions.push({ source: state.source, snapshot: result.value.snapshot })
      state.readiness = 'ready'
      state.reason = undefined
    }
    let snapshot = base
    try {
      snapshot = mergePowerPlatformSnapshots(base, additions)
    } catch {
      for (const state of this.sources.filter((item) => item.readiness === 'ready')) {
        state.readiness = 'degraded'
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
    const powerPlatformComplete =
      this.config !== undefined &&
      this.sources.length > 0 &&
      this.sources.every((source) => source.readiness === 'ready')
    const configurationSource =
      this.config === undefined
        ? [
            {
              id: 'power-platform:configuration',
              name: 'Power Platform ResourceQuery configuration',
              role: 'discovery' as const,
              enabled: true,
              configured: false,
              readiness: 'authorization-required' as const,
              reason: 'invalid-configuration',
            },
          ]
        : []
    return {
      overall: !baseReady
        ? 'unavailable'
        : basePartial || !powerPlatformComplete
          ? 'degraded'
          : 'ready',
      partial: baseReady && (basePartial || !powerPlatformComplete),
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
          id: `power-platform:${state.source.id}`,
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

export interface OptionalPowerPlatformOptions extends PowerPlatformCompositionOptions {
  credential?: TokenCredential
  client?: PowerPlatformClientOptions
}

export function createOptionalPowerPlatformConnector(
  base: AgentConnector,
  environment: NodeJS.ProcessEnv = process.env,
  options: OptionalPowerPlatformOptions = {},
): AgentConnector {
  let enabled: boolean
  try {
    enabled = envBoolean(environment, 'POWER_PLATFORM_CONNECTOR_ENABLED')
  } catch {
    return new PowerPlatformCompositionConnector(base, undefined, options)
  }
  if (!enabled) return base
  let config: PowerPlatformConfig
  try {
    config = parsePowerPlatformConfig(environment)
  } catch {
    return new PowerPlatformCompositionConnector(base, undefined, options)
  }
  return new PowerPlatformCompositionConnector(base, config, {
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

export {
  PowerPlatformConnectorError,
  PowerPlatformResourceQueryClient,
  POWER_PLATFORM_TOKEN_SCOPE,
} from './client.js'
export {
  POWER_PLATFORM_API_ORIGIN,
  POWER_PLATFORM_API_VERSION,
  POWER_PLATFORM_RESOURCE_TYPE,
  powerPlatformConfigSchema,
  powerPlatformLimitsSchema,
  powerPlatformResourceItemSchema,
  powerPlatformResourceQueryResponseSchema,
  powerPlatformSourceConfigSchema,
  powerPlatformSourcesConfigSchema,
  sanitizePowerPlatformApiBaseUrl,
} from './schemas.js'
export { mapPowerPlatformAgentsToSnapshot, mergePowerPlatformSnapshots } from './normalize.js'

export type { PowerPlatformClientOptions, PowerPlatformErrorCode } from './client.js'
export type {
  PowerPlatformConfig,
  PowerPlatformLimits,
  PowerPlatformResourceItem,
  PowerPlatformResourceQueryResponse,
  PowerPlatformSourceConfig,
} from './schemas.js'
