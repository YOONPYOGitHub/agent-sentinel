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
import type { TokenCredential } from '@azure/core-auth'
import { DefaultAzureCredential } from '@azure/identity'
import type { z } from 'zod'

import { EntraGraphClient, EntraGraphError, type EntraGraphClientOptions } from './client.js'
import { enrichSnapshotWithEntra, mapEntraInventoryToSnapshot } from './normalize.js'
import {
  entraIdentityConnectorConfigSchema,
  type AgentIdentityPreview,
  type EntraAppRoleAssignment,
  type EntraDirectoryOwner,
  type EntraIdentityConnectorConfig,
  type EntraServicePrincipal,
} from './schemas.js'

export type EntraCapabilityStatus = 'disabled' | 'available' | 'degraded' | 'unavailable'

export interface EntraConnectorHealth {
  stableInventory: { status: 'available' | 'unavailable'; reason?: string }
  owners: { status: EntraCapabilityStatus; reason?: string }
  appRoleAssignments: { status: EntraCapabilityStatus; reason?: string }
  agentIdentityPreview: { status: EntraCapabilityStatus; reason?: string }
}

function safeFailureReason(error: unknown): string {
  if (error instanceof EntraGraphError)
    return `${error.code}${error.status ? ` (${error.status})` : ''}`
  if (error instanceof Error && error.name === 'ZodError') return 'malformed-response'
  return 'unexpected-failure'
}

function envBoolean(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim().toLowerCase()
  if (value === undefined || value === '') return false
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false.`)
  return value === 'true'
}

function envNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = env[name]?.trim()
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number.`)
  return parsed
}

export class EntraIdentityConnector implements AgentConnector {
  readonly descriptor: ConnectorDescriptor
  private readonly config: EntraIdentityConnectorConfig
  private readonly client: EntraGraphClient
  private evidenceById = new Map<string, Evidence>()
  private health: EntraConnectorHealth

  constructor(
    configInput: z.input<typeof entraIdentityConnectorConfigSchema>,
    credential: TokenCredential,
    options: EntraGraphClientOptions = {},
  ) {
    this.config = entraIdentityConnectorConfigSchema.parse(configInput)
    this.client = new EntraGraphClient(this.config, credential, options)
    this.descriptor = {
      id: 'microsoft-entra-service-principals',
      name: 'Microsoft Entra service principals',
      apiVersion: 'v1.0',
      releaseStatus: 'ga',
      capabilities: ['discovery', 'evidence'],
      requiredPermissions: [
        'Application.Read.All',
        ...(this.config.capabilities.agentIdentityPreview
          ? ['AgentIdentity.Read.All (preview)']
          : []),
      ],
      blindSpots: [
        'Correlation requires an explicit Entra object, application/client, or Agent Identity ID in source metadata.',
        'Sponsors are not read because the preview sponsors endpoint requires AgentIdentity.ReadWrite.All.',
      ],
    }
    this.health = {
      stableInventory: { status: 'unavailable', reason: 'not-queried' },
      owners: { status: this.config.capabilities.owners ? 'unavailable' : 'disabled' },
      appRoleAssignments: {
        status: this.config.capabilities.appRoleAssignments ? 'unavailable' : 'disabled',
      },
      agentIdentityPreview: {
        status: this.config.capabilities.agentIdentityPreview ? 'unavailable' : 'disabled',
      },
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const checkedAt = new Date().toISOString()
    try {
      await this.client.probeStableInventory()
      this.health.stableInventory = { status: 'available' }
      return {
        ok: true,
        checkedAt,
        message: 'Microsoft Graph v1.0 service-principal inventory is reachable.',
      }
    } catch (error) {
      this.health.stableInventory = { status: 'unavailable', reason: safeFailureReason(error) }
      return {
        ok: false,
        checkedAt,
        message: 'Microsoft Graph v1.0 service-principal inventory is unavailable.',
      }
    }
  }

  async discover(): Promise<EstateSnapshot> {
    let servicePrincipals: EntraServicePrincipal[]
    try {
      servicePrincipals = await this.client.listServicePrincipals()
      this.health.stableInventory = { status: 'available' }
    } catch (error) {
      this.health.stableInventory = { status: 'unavailable', reason: safeFailureReason(error) }
      throw error
    }

    const owners = new Map<string, EntraDirectoryOwner[]>()
    if (this.config.capabilities.owners) {
      try {
        for (const [id, values] of await this.client.listOwners(servicePrincipals))
          owners.set(id, values)
        this.health.owners = { status: 'available' }
      } catch (error) {
        this.health.owners = { status: 'degraded', reason: safeFailureReason(error) }
      }
    }

    const appRoleAssignments = new Map<string, EntraAppRoleAssignment[]>()
    if (this.config.capabilities.appRoleAssignments) {
      try {
        for (const [id, values] of await this.client.listAppRoleAssignments(servicePrincipals))
          appRoleAssignments.set(id, values)
        this.health.appRoleAssignments = { status: 'available' }
      } catch (error) {
        this.health.appRoleAssignments = {
          status: 'degraded',
          reason: safeFailureReason(error),
        }
      }
    }

    let agentIdentitiesPreview: AgentIdentityPreview[] = []
    if (this.config.capabilities.agentIdentityPreview) {
      try {
        agentIdentitiesPreview = await this.client.listAgentIdentitiesPreview()
        this.health.agentIdentityPreview = { status: 'available' }
      } catch (error) {
        this.health.agentIdentityPreview = { status: 'degraded', reason: safeFailureReason(error) }
      }
    }

    const snapshot = mapEntraInventoryToSnapshot(
      { servicePrincipals, owners, appRoleAssignments, agentIdentitiesPreview },
      this.config,
    )
    this.evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
    return snapshot
  }

  getHealth(): EntraConnectorHealth {
    return structuredClone(this.health)
  }

  getEvidence(evidenceId: string): Promise<Evidence> {
    const evidence = this.evidenceById.get(evidenceId)
    if (evidence === undefined) throw new Error(`Entra evidence was not found: ${evidenceId}`)
    return Promise.resolve(structuredClone(evidence))
  }

  execute(): Promise<{ remediation: Remediation; snapshot: EstateSnapshot }> {
    return Promise.reject(new Error('Microsoft Entra identity connector is read-only.'))
  }
}

export interface EntraEnrichmentHealth {
  base: ConnectionTestResult
  entra: EntraConnectorHealth
  composition: { status: 'disabled' | 'available' | 'degraded'; reason?: string }
}

export interface EntraEnrichmentConnectorOptions {
  enabled?: boolean
  configured?: boolean
  configurationReason?: 'invalid-configuration' | 'tenant-mismatch' | 'environment-mismatch'
}

export class EntraEnrichmentConnector implements AgentConnector {
  readonly descriptor: ConnectorDescriptor
  private evidenceById = new Map<string, Evidence>()
  private baseHealth: ConnectionTestResult = {
    ok: false,
    checkedAt: new Date(0).toISOString(),
    message: 'Base connector has not been tested.',
  }
  private readonly entra: EntraIdentityConnector | undefined
  private readonly enabled: boolean
  private readonly configured: boolean
  private composition: EntraEnrichmentHealth['composition']

  constructor(
    private readonly base: AgentConnector,
    entra?: EntraIdentityConnector,
    options: EntraEnrichmentConnectorOptions = {},
  ) {
    this.entra = entra
    this.enabled = options.enabled ?? entra !== undefined
    this.configured = options.configured ?? entra !== undefined
    this.composition = this.enabled
      ? options.configurationReason
        ? { status: 'degraded', reason: options.configurationReason }
        : { status: 'degraded', reason: 'not-queried' }
      : { status: 'disabled' }
    this.descriptor = {
      ...base.descriptor,
      capabilities: [
        ...new Set<ConnectorCapability>([...base.descriptor.capabilities, 'discovery', 'evidence']),
      ],
      requiredPermissions: [
        ...new Set([
          ...base.descriptor.requiredPermissions,
          ...(entra?.descriptor.requiredPermissions ?? []),
        ]),
      ],
      blindSpots: [
        ...base.descriptor.blindSpots,
        ...(entra?.descriptor.blindSpots ?? [
          'Microsoft Entra enrichment is disabled or not configured.',
        ]),
      ],
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const [base, entra] = await Promise.all([
      this.base.testConnection(),
      this.enabled && this.entra ? this.entra.testConnection() : Promise.resolve(undefined),
    ])
    this.baseHealth = base
    if (entra?.ok === true) this.composition = { status: 'available' }
    else if (entra !== undefined) this.composition = { status: 'degraded', reason: 'unavailable' }
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
    if (!this.enabled || !this.entra) {
      this.evidenceById = new Map(base.evidence.map((item) => [item.id, item]))
      return base
    }

    let snapshot: EstateSnapshot
    try {
      const identities = await this.entra.discover()
      snapshot = enrichSnapshotWithEntra(base, identities)
      this.composition = { status: 'available' }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      this.composition = {
        status: 'degraded',
        reason: message.includes('different Microsoft Entra tenants')
          ? 'tenant-mismatch'
          : message.includes('different environments')
            ? 'environment-mismatch'
            : safeFailureReason(error),
      }
      this.evidenceById = new Map(base.evidence.map((item) => [item.id, item]))
      return base
    }
    this.evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
    return snapshot
  }

  getHealth(): EntraEnrichmentHealth {
    return {
      base: structuredClone(this.baseHealth),
      entra: this.entra?.getHealth() ?? {
        stableInventory: {
          status: 'unavailable',
          reason: this.composition.reason ?? 'not-configured',
        },
        owners: { status: 'disabled' },
        appRoleAssignments: { status: 'disabled' },
        agentIdentityPreview: { status: 'disabled' },
      },
      composition: structuredClone(this.composition),
    }
  }

  getConnectorHealth(): ConnectorHealthReport {
    const entraHealth = this.getHealth().entra
    const baseReady = this.baseHealth.ok
    const optionalCapabilitiesReady = [
      entraHealth.owners,
      entraHealth.appRoleAssignments,
      entraHealth.agentIdentityPreview,
    ].every((capability) => capability.status === 'disabled' || capability.status === 'available')
    const entraReady =
      this.enabled &&
      this.entra !== undefined &&
      entraHealth.stableInventory.status === 'available' &&
      this.composition.status === 'available' &&
      optionalCapabilitiesReady
    const entraReadiness: ConnectorReadiness = !this.enabled
      ? this.configured
        ? 'disabled'
        : 'authorization-required'
      : entraReady
        ? 'ready'
        : 'degraded'
    const reason =
      entraReadiness === 'degraded'
        ? (this.composition.reason ??
          entraHealth.stableInventory.reason ??
          entraHealth.owners.reason ??
          entraHealth.appRoleAssignments.reason ??
          entraHealth.agentIdentityPreview.reason ??
          'unavailable')
        : undefined
    return {
      overall: !baseReady ? 'unavailable' : this.enabled && !entraReady ? 'degraded' : 'ready',
      partial: baseReady && this.enabled && !entraReady,
      sources: [
        {
          id: this.base.descriptor.id,
          name: this.base.descriptor.name,
          role: 'discovery',
          enabled: true,
          configured: true,
          readiness: baseReady ? 'ready' : 'unavailable',
          checkedAt: this.baseHealth.checkedAt,
          ...(!baseReady ? { reason: 'unavailable' } : {}),
        },
        {
          id: 'microsoft-entra-service-principals',
          name: 'Microsoft Entra service principals',
          role: 'enrichment',
          enabled: this.enabled,
          configured: this.configured,
          readiness: entraReadiness,
          ...(reason ? { reason } : {}),
        },
      ],
    }
  }

  getEvidence(evidenceId: string): Promise<Evidence> {
    const evidence = this.evidenceById.get(evidenceId)
    if (evidence === undefined) throw new Error(`Composite evidence was not found: ${evidenceId}`)
    return Promise.resolve(structuredClone(evidence))
  }

  execute(
    remediation: Remediation,
    approval: ApprovalContext,
  ): Promise<{ remediation: Remediation; snapshot: EstateSnapshot }> {
    if (this.base.execute === undefined)
      return Promise.reject(new Error('Base connector does not support remediation execution.'))
    return this.base.execute(remediation, approval)
  }
}

export function createEntraIdentityConnector(
  environment: NodeJS.ProcessEnv = process.env,
  credential?: TokenCredential,
  options: EntraGraphClientOptions = {},
): EntraIdentityConnector {
  const config = entraIdentityConnectorConfigSchema.parse({
    tenantId: environment['ENTRA_CONNECTOR_TENANT_ID']?.trim() ?? '',
    environment: environment['ENTRA_CONNECTOR_ENVIRONMENT']?.trim() ?? '',
    graphBaseUrl:
      environment['ENTRA_CONNECTOR_GRAPH_BASE_URL']?.trim() || 'https://graph.microsoft.com',
    capabilities: {
      owners: envBoolean(environment, 'ENTRA_CONNECTOR_OWNERS_ENABLED'),
      appRoleAssignments: envBoolean(environment, 'ENTRA_CONNECTOR_APP_ROLES_ENABLED'),
      agentIdentityPreview: envBoolean(environment, 'ENTRA_CONNECTOR_AGENT_IDENTITY_PREVIEW'),
    },
    limits: {
      maxPages: envNumber(environment, 'ENTRA_CONNECTOR_MAX_PAGES'),
      maxItems: envNumber(environment, 'ENTRA_CONNECTOR_MAX_ITEMS'),
      requestTimeoutMs: envNumber(environment, 'ENTRA_CONNECTOR_REQUEST_TIMEOUT_MS'),
      maxRetries: envNumber(environment, 'ENTRA_CONNECTOR_MAX_RETRIES'),
      maxRetryAfterMs: envNumber(environment, 'ENTRA_CONNECTOR_MAX_RETRY_AFTER_MS'),
    },
  })
  return new EntraIdentityConnector(
    config,
    credential ?? new DefaultAzureCredential({ tenantId: config.tenantId }),
    options,
  )
}

export interface OptionalEntraEnrichmentOptions {
  credential?: TokenCredential
  client?: EntraGraphClientOptions
  expectedTenantId?: string
  expectedEnvironment?: string
}

export function createOptionalEntraEnrichmentConnector(
  base: AgentConnector,
  environment: NodeJS.ProcessEnv = process.env,
  options: OptionalEntraEnrichmentOptions = {},
): EntraEnrichmentConnector {
  let enabled = false
  try {
    enabled = envBoolean(environment, 'ENTRA_CONNECTOR_ENABLED')
  } catch {
    return new EntraEnrichmentConnector(base, undefined, {
      enabled: true,
      configured: false,
      configurationReason: 'invalid-configuration',
    })
  }
  const tenantId = environment['ENTRA_CONNECTOR_TENANT_ID']?.trim() ?? ''
  const connectorEnvironment = environment['ENTRA_CONNECTOR_ENVIRONMENT']?.trim() ?? ''
  const configured = tenantId.length > 0 && connectorEnvironment.length > 0
  if (!enabled) return new EntraEnrichmentConnector(base, undefined, { enabled, configured })
  if (
    options.expectedTenantId &&
    tenantId.toLowerCase() !== options.expectedTenantId.toLowerCase()
  ) {
    return new EntraEnrichmentConnector(base, undefined, {
      enabled,
      configured,
      configurationReason: 'tenant-mismatch',
    })
  }
  if (options.expectedEnvironment && connectorEnvironment !== options.expectedEnvironment) {
    return new EntraEnrichmentConnector(base, undefined, {
      enabled,
      configured,
      configurationReason: 'environment-mismatch',
    })
  }
  try {
    const entra = createEntraIdentityConnector(environment, options.credential, options.client)
    return new EntraEnrichmentConnector(base, entra, { enabled, configured: true })
  } catch {
    return new EntraEnrichmentConnector(base, undefined, {
      enabled,
      configured,
      configurationReason: 'invalid-configuration',
    })
  }
}

export {
  EntraGraphClient,
  EntraGraphError,
  enrichSnapshotWithEntra,
  mapEntraInventoryToSnapshot,
  entraIdentityConnectorConfigSchema,
}
export type { EntraGraphClientOptions } from './client.js'
export type { EntraInventory } from './normalize.js'
export type {
  AgentIdentityPreview,
  EntraAppRoleAssignment,
  EntraDirectoryOwner,
  EntraIdentityConnectorConfig,
  EntraServicePrincipal,
} from './schemas.js'
export {
  agentIdentityPreviewPageSchema,
  appRoleAssignmentPageSchema,
  directoryOwnerPageSchema,
  servicePrincipalPageSchema,
} from './schemas.js'
