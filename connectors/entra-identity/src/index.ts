import type {
  AgentConnector,
  ApprovalContext,
  ConnectionTestResult,
  ConnectorCapability,
  ConnectorDescriptor,
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
  base: ConnectionTestResult | { ok: false; checkedAt: string; message: string }
  entra: EntraConnectorHealth
}

export class EntraEnrichmentConnector implements AgentConnector {
  readonly descriptor: ConnectorDescriptor
  private evidenceById = new Map<string, Evidence>()
  private baseHealth: ConnectionTestResult = {
    ok: false,
    checkedAt: new Date(0).toISOString(),
    message: 'Base connector has not been tested.',
  }

  constructor(
    private readonly base: AgentConnector,
    private readonly entra: EntraIdentityConnector,
  ) {
    this.descriptor = {
      ...base.descriptor,
      id: `${base.descriptor.id}+entra-identity`,
      name: `${base.descriptor.name} with Microsoft Entra identity enrichment`,
      capabilities: [
        ...new Set<ConnectorCapability>([...base.descriptor.capabilities, 'discovery', 'evidence']),
      ],
      requiredPermissions: [
        ...new Set([
          ...base.descriptor.requiredPermissions,
          ...entra.descriptor.requiredPermissions,
        ]),
      ],
      blindSpots: [...base.descriptor.blindSpots, ...entra.descriptor.blindSpots],
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const [base, entra] = await Promise.all([
      this.base.testConnection(),
      this.entra.testConnection(),
    ])
    this.baseHealth = base
    return {
      ok: base.ok && entra.ok,
      checkedAt: new Date().toISOString(),
      message:
        base.ok && entra.ok
          ? 'Base discovery and Microsoft Entra stable inventory are reachable.'
          : 'One or more explicitly configured discovery sources are unavailable.',
    }
  }

  async discover(): Promise<EstateSnapshot> {
    const base = await this.base.discover()
    const identities = await this.entra.discover()
    const snapshot = enrichSnapshotWithEntra(base, identities)
    this.evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
    return snapshot
  }

  getHealth(): EntraEnrichmentHealth {
    return { base: structuredClone(this.baseHealth), entra: this.entra.getHealth() }
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
