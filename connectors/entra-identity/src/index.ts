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
import {
  ClientAssertionCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity'
import { z } from 'zod'

import { EntraGraphClient, EntraGraphError, type EntraGraphClientOptions } from './client.js'
import {
  enrichAggregateSnapshotWithEntra,
  enrichSnapshotWithEntra,
  enrichSnapshotWithEntraDiagnostics,
  mapEntraInventoryToSnapshot,
  summarizeEntraCorrelationCoverage,
  type EntraAggregateSource,
  type EntraCapabilityCoverage,
  type EntraCoverageStatus,
  type EntraCorrelationCoverageSummary,
} from './normalize.js'
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

const entraSourceCredentialSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('default'),
    managedIdentityClientId: z.string().uuid().optional(),
  }),
  z.strictObject({
    mode: z.literal('federated-app'),
    clientId: z.string().uuid(),
    managedIdentityClientId: z.string().uuid().optional(),
  }),
])

export const entraSourceConfigSchema = entraIdentityConnectorConfigSchema.extend({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().trim().min(1).max(100),
  credential: entraSourceCredentialSchema.optional(),
})
export type EntraSourceConfig = z.infer<typeof entraSourceConfigSchema>

export const entraSourcesConfigSchema = z
  .array(entraSourceConfigSchema)
  .min(1)
  .max(50)
  .superRefine((sources, context) => {
    const ids = new Set<string>()
    const boundaries = new Set<string>()
    for (const [index, source] of sources.entries()) {
      if (ids.has(source.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `Duplicate Entra source id: ${source.id}`,
        })
      }
      ids.add(source.id)
      const boundary = `${source.tenantId.toLowerCase()}\0${source.environment}`
      if (boundaries.has(boundary)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Duplicate Entra tenant and environment source boundary.',
        })
      }
      boundaries.add(boundary)
    }
  })
export type EntraCredentialFactory = (source: EntraSourceConfig) => TokenCredential

export function createEntraSourceCredential(source: EntraSourceConfig): TokenCredential {
  if (source.credential?.mode === 'federated-app') {
    const managedIdentityClientId =
      source.credential.managedIdentityClientId ?? process.env['AZURE_CLIENT_ID']?.trim()
    if (!managedIdentityClientId) {
      throw new Error(
        'Cross-tenant Entra federation requires a user-assigned managed identity client ID.',
      )
    }
    const assertionCredential = new ManagedIdentityCredential({
      clientId: managedIdentityClientId,
    })
    return new ClientAssertionCredential(source.tenantId, source.credential.clientId, async () => {
      const assertion = await assertionCredential.getToken('api://AzureADTokenExchange/.default')
      if (assertion === null) {
        throw new Error('Managed identity did not return a workload identity federation assertion.')
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

function safeFailureReason(error: unknown): string {
  if (error instanceof EntraGraphError)
    return `${error.code}${error.status ? ` (${error.status})` : ''}`
  if (error instanceof Error && error.name === 'ZodError') return 'malformed-response'
  return 'unexpected-failure'
}

function capabilityCoverage(
  health: EntraConnectorHealth,
  base: EstateSnapshot,
  identities: EstateSnapshot,
): Pick<EntraCorrelationCoverageSummary, 'ownerCoverage' | 'appRoleCoverage' | 'previewCoverage'> {
  const principals = identities.nodes.filter(
    (node) => node.kind === 'identity' && node.metadata['inventoryCoverage'] !== 'assignment-reference-only',
  )
  const evidenceIds = identities.evidence.map((item) => item.id).slice(0, 100)
  const coverage = (
    status: EntraCoverageStatus,
    covered: number,
    total: number,
    reference: string,
  ): EntraCapabilityCoverage => ({
    status,
    covered,
    total,
    evidenceIds,
    diagnosticReferences: [`entra:${reference}`],
  })
  const ownerCount = principals.filter((node) => node.metadata['ownerObjectIds'] !== undefined).length
  const assignedPrincipalIds = new Set(
    identities.edges
      .filter((edge) => edge.relationship === 'CAN_CALL')
      .map((edge) => edge.from),
  )
  const agentCount = base.nodes.filter((node) => node.kind === 'agent').length
  return {
    ownerCoverage: coverage(
      health.owners.status,
      ownerCount,
      principals.length,
      'owner-coverage',
    ),
    appRoleCoverage: coverage(
      health.appRoleAssignments.status,
      [...assignedPrincipalIds].filter((id) => principals.some((node) => node.id === id)).length,
      principals.length,
      'app-role-coverage',
    ),
    previewCoverage: coverage(
      health.agentIdentityPreview.status,
      0,
      agentCount,
      'agent-identity-preview',
    ),
  }
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
  correlation?: EntraCorrelationCoverageSummary
}

export interface MultiEntraSourceHealth {
  readonly sources: readonly {
    readonly id: string
    readonly coverage?: EntraCorrelationCoverageSummary
  }[]
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
  private correlation: EntraCorrelationCoverageSummary | undefined

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
      const result = enrichSnapshotWithEntraDiagnostics(
        base,
        identities,
        capabilityCoverage(this.entra.getHealth(), base, identities),
      )
      snapshot = result.snapshot
      result.coverage.previewCoverage = {
        ...result.coverage.previewCoverage,
        covered: result.coverage.exactAgentIdentityMatches,
      }
      this.correlation = result.coverage
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
      ...(this.correlation !== undefined ? { correlation: structuredClone(this.correlation) } : {}),
    }
  }

  getConnectorHealth(): ConnectorHealthReport {
    const baseHealth = this.base.getConnectorHealth?.()
    const entraHealth = this.getHealth().entra
    const baseReady =
      baseHealth !== undefined ? baseHealth.overall !== 'unavailable' : this.baseHealth.ok
    const basePartial = baseHealth?.partial === true
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
      overall: !baseReady
        ? 'unavailable'
        : basePartial || (this.enabled && !entraReady)
          ? 'degraded'
          : 'ready',
      partial: baseReady && (basePartial || (this.enabled && !entraReady)),
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
            ...(!baseReady ? { reason: 'unavailable' } : {}),
          },
        ]),
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

export type ExpectedEntraSource = EntraAggregateSource

export interface MultiEntraEnrichmentOptions {
  enabled: boolean
  expectedSources: readonly ExpectedEntraSource[]
  credentialFactory?: EntraCredentialFactory
  clientFactory?: (source: EntraSourceConfig) => EntraGraphClientOptions
}

interface MultiEntraSourceState {
  expected: ExpectedEntraSource
  config: EntraSourceConfig | undefined
  connector: EntraIdentityConnector | undefined
  configured: boolean
  readiness: ConnectorReadiness
  checkedAt: string | undefined
  reason: string | undefined
  correlation: EntraCorrelationCoverageSummary | undefined
}

function sourceBoundary(source: Pick<EntraAggregateSource, 'tenantId' | 'environment'>): string {
  return `${source.tenantId.toLowerCase()}\0${source.environment}`
}

function entraReadiness(connector: EntraIdentityConnector): {
  readiness: 'ready' | 'degraded'
  reason?: string
} {
  const health = connector.getHealth()
  const optionalReady = [
    health.owners,
    health.appRoleAssignments,
    health.agentIdentityPreview,
  ].every((capability) => capability.status === 'disabled' || capability.status === 'available')
  if (health.stableInventory.status === 'available' && optionalReady) {
    return { readiness: 'ready' }
  }
  return {
    readiness: 'degraded',
    reason:
      health.stableInventory.reason ??
      health.owners.reason ??
      health.appRoleAssignments.reason ??
      health.agentIdentityPreview.reason ??
      'not-queried',
  }
}

export class MultiEntraEnrichmentConnector implements AgentConnector {
  readonly descriptor: ConnectorDescriptor
  private readonly sources: MultiEntraSourceState[]
  private readonly enabled: boolean
  private evidenceById = new Map<string, Evidence>()
  private baseHealth: ConnectionTestResult = {
    ok: false,
    checkedAt: new Date(0).toISOString(),
    message: 'Base connector has not been tested.',
  }

  constructor(
    private readonly base: AgentConnector,
    configuredSources: readonly EntraSourceConfig[],
    options: MultiEntraEnrichmentOptions,
  ) {
    this.enabled = options.enabled
    const credentialFactory = options.credentialFactory ?? createEntraSourceCredential
    const expectedIds = new Set(options.expectedSources.map((source) => source.id))
    const unexpected = configuredSources.find((source) => !expectedIds.has(source.id))
    if (unexpected !== undefined) {
      throw new Error(`Entra source has no matching Foundry source: ${unexpected.id}`)
    }
    const configuredById = new Map(configuredSources.map((source) => [source.id, source]))
    this.sources = options.expectedSources.map((expected) => {
      const config = configuredById.get(expected.id)
      const boundaryMatches =
        config !== undefined && sourceBoundary(config) === sourceBoundary(expected)
      let connector: EntraIdentityConnector | undefined
      let reason: string | undefined
      if (config !== undefined && !boundaryMatches) reason = 'boundary-mismatch'
      if (this.enabled && boundaryMatches && config !== undefined) {
        try {
          connector = new EntraIdentityConnector(
            {
              tenantId: config.tenantId,
              environment: config.environment,
              graphBaseUrl: config.graphBaseUrl,
              capabilities: config.capabilities,
              limits: config.limits,
            },
            credentialFactory(config),
            options.clientFactory?.(config),
          )
        } catch {
          reason = 'invalid-configuration'
        }
      }
      return {
        expected,
        config,
        connector,
        configured: boundaryMatches,
        readiness: !this.enabled
          ? boundaryMatches
            ? 'disabled'
            : 'authorization-required'
          : connector !== undefined
            ? 'degraded'
            : boundaryMatches
              ? 'degraded'
              : 'authorization-required',
        checkedAt: undefined,
        reason:
          reason ??
          (this.enabled && connector !== undefined
            ? 'not-queried'
            : boundaryMatches
              ? undefined
              : 'not-configured'),
        correlation: undefined,
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
          ...configuredSources.flatMap((source) => [
            'Application.Read.All',
            ...(source.capabilities.agentIdentityPreview
              ? ['AgentIdentity.Read.All (preview)']
              : []),
          ]),
        ]),
      ],
      blindSpots: [
        ...base.descriptor.blindSpots,
        'Every Foundry tenant/environment requires a matching Entra source for complete identity coverage.',
      ],
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const [base, ...results] = await Promise.all([
      this.base.testConnection(),
      ...this.sources.map(async (source) =>
        this.enabled && source.connector !== undefined
          ? source.connector.testConnection()
          : undefined,
      ),
    ])
    this.baseHealth = base
    for (const [index, result] of results.entries()) {
      const source = this.sources[index]!
      if (result === undefined || source.connector === undefined) continue
      source.checkedAt = result.checkedAt
      const measured = entraReadiness(source.connector)
      source.readiness = result.ok ? measured.readiness : 'unavailable'
      source.reason = result.ok ? measured.reason : 'authentication-or-access'
    }
    return {
      ok: base.ok,
      checkedAt: new Date().toISOString(),
      message: base.ok
        ? 'Primary discovery sources are reachable.'
        : 'One or more primary discovery sources are unavailable.',
    }
  }

  async discover(): Promise<EstateSnapshot> {
    let snapshot = await this.base.discover()
    this.baseHealth = {
      ok: true,
      checkedAt: new Date().toISOString(),
      message: 'Primary discovery completed.',
    }
    if (!this.enabled) {
      this.evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
      return snapshot
    }

    const results = await Promise.allSettled(
      this.sources.map(async (source) =>
        source.connector === undefined
          ? undefined
          : {
              source,
              identities: await source.connector.discover(),
            },
      ),
    )
    for (const [index, result] of results.entries()) {
      const source = this.sources[index]!
      source.checkedAt = new Date().toISOString()
      if (result.status === 'rejected') {
        source.readiness = 'unavailable'
        source.reason = safeFailureReason(result.reason)
        continue
      }
      if (result.value === undefined || source.connector === undefined) continue
      try {
        snapshot = enrichAggregateSnapshotWithEntra(
          snapshot,
          result.value.identities,
          source.expected,
        )
        const coverage = summarizeEntraCorrelationCoverage(
          snapshot,
          result.value.identities,
          (agent) =>
            agent.metadata['sourceTenantId']?.toLowerCase() ===
              source.expected.tenantId.toLowerCase() &&
            agent.metadata['sourceEnvironment'] === source.expected.environment,
          capabilityCoverage(source.connector.getHealth(), snapshot, result.value.identities),
        )
        coverage.previewCoverage = {
          ...coverage.previewCoverage,
          covered: coverage.exactAgentIdentityMatches,
        }
        source.correlation = coverage
        const measured = entraReadiness(source.connector)
        source.readiness = measured.readiness
        source.reason = measured.reason
      } catch {
        source.readiness = 'degraded'
        source.reason = 'composition-failed'
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
    const entraComplete =
      !this.enabled || this.sources.every((source) => source.readiness === 'ready')
    return {
      overall: !baseReady ? 'unavailable' : basePartial || !entraComplete ? 'degraded' : 'ready',
      partial: baseReady && (basePartial || !entraComplete),
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
        ...this.sources.map((source) => ({
          id: `entra:${source.expected.id}`,
          name: `${source.expected.name} · Microsoft Entra`,
          role: 'enrichment' as const,
          enabled: this.enabled,
          configured: source.configured,
          readiness: source.readiness,
          ...(source.checkedAt !== undefined ? { checkedAt: source.checkedAt } : {}),
          ...(source.reason !== undefined ? { reason: source.reason } : {}),
        })),
      ],
    }
  }

  getEntraHealth(): MultiEntraSourceHealth {
    return {
      sources: this.sources.map((source) => ({
        id: source.expected.id,
        ...(source.correlation !== undefined ? { coverage: structuredClone(source.correlation) } : {}),
      })),
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
    if (this.base.execute === undefined) {
      return Promise.reject(new Error('Base connector does not support remediation execution.'))
    }
    return this.base.execute(remediation, approval)
  }
}

function entraConfigInput(environment: NodeJS.ProcessEnv) {
  return {
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
  }
}

export function parseEntraSourcesConfig(
  environment: NodeJS.ProcessEnv = process.env,
): EntraSourceConfig[] {
  const sourcesJson = environment['ENTRA_SOURCES_JSON']?.trim()
  if (sourcesJson !== undefined && sourcesJson.length > 0) {
    let sources: unknown
    try {
      sources = JSON.parse(sourcesJson)
    } catch {
      throw new Error('ENTRA_SOURCES_JSON must be valid JSON.')
    }
    return entraSourcesConfigSchema.parse(sources)
  }
  const input = entraConfigInput(environment)
  if (input.tenantId.length === 0 || input.environment.length === 0) return []
  return [
    entraSourceConfigSchema.parse({
      ...input,
      id: 'primary',
      name: 'Primary Foundry project',
    }),
  ]
}

export function createEntraIdentityConnector(
  environment: NodeJS.ProcessEnv = process.env,
  credential?: TokenCredential,
  options: EntraGraphClientOptions = {},
): EntraIdentityConnector {
  const config = entraIdentityConnectorConfigSchema.parse(entraConfigInput(environment))
  return new EntraIdentityConnector(
    config,
    credential ?? new DefaultAzureCredential({ tenantId: config.tenantId }),
    options,
  )
}

export interface OptionalEntraEnrichmentOptions {
  credential?: TokenCredential
  client?: EntraGraphClientOptions
  credentialFactory?: EntraCredentialFactory
  clientFactory?: (source: EntraSourceConfig) => EntraGraphClientOptions
  expectedSources?: readonly ExpectedEntraSource[]
  expectedTenantId?: string
  expectedEnvironment?: string
}

export function createOptionalEntraEnrichmentConnector(
  base: AgentConnector,
  environment: NodeJS.ProcessEnv = process.env,
  options: OptionalEntraEnrichmentOptions = {},
): AgentConnector {
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
  if (options.expectedSources !== undefined) {
    let sources: EntraSourceConfig[]
    try {
      sources = parseEntraSourcesConfig(environment)
    } catch {
      return new EntraEnrichmentConnector(base, undefined, {
        enabled: true,
        configured: false,
        configurationReason: 'invalid-configuration',
      })
    }
    return new MultiEntraEnrichmentConnector(base, sources, {
      enabled,
      expectedSources: options.expectedSources,
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
  enrichAggregateSnapshotWithEntra,
  enrichSnapshotWithEntra,
  mapEntraInventoryToSnapshot,
  summarizeEntraCorrelationCoverage,
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
