import { z } from 'zod'

import { estateIdSchema } from './estate.js'
import { sourceProjectIdSchema } from './source-project.js'

const azureGuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
export const connectorSourceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
export const connectorRuntimeBindingSchema = z.strictObject({
  bindingSourceId: connectorSourceIdSchema,
})
export type ConnectorRuntimeBinding = z.infer<typeof connectorRuntimeBindingSchema>
const boundedIdentifierSchema = z.string().trim().min(1).max(256)
const boundedEnvironmentSchema = z.string().trim().min(1).max(128)
const boundedSummarySchema = z.string().trim().min(1).max(500)
export const AGENT365_MAX_RETRY_AFTER_MS = 60_000
export const AGENT365_APPROVED_MANAGED_IDENTITY_CLIENT_ID = '59dbea72-1e91-403a-89cf-e02cdb8da350'
const normalizedTimestampSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())

function exactHttpsOriginSchema(origin: string, label: string) {
  return z.string().transform((value, context) => {
    const candidate = value.trim()
    if (candidate !== origin && candidate !== `${origin}/`) {
      context.addIssue({ code: 'custom', message: `${label} URL is not allowed.` })
      return z.NEVER
    }
    return origin
  })
}

const foundryProjectEndpointSchema = z.string().transform((value, context) => {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    context.addIssue({ code: 'custom', message: 'Azure AI Foundry project endpoint is invalid.' })
    return z.NEVER
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !url.hostname.toLowerCase().endsWith('.services.ai.azure.com') ||
    !/^\/api\/projects\/[A-Za-z0-9][A-Za-z0-9._-]*\/?$/.test(url.pathname)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Azure AI Foundry project endpoint is not allowed.',
    })
    return z.NEVER
  }
  const sourceProjectId = sourceProjectIdSchema.safeParse(
    url.pathname.replace(/\/+$/, '').split('/').at(-1),
  )
  if (!sourceProjectId.success) {
    context.addIssue({
      code: 'custom',
      message: 'Azure AI Foundry project ID must be between 1 and 200 characters.',
    })
    return z.NEVER
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
})

const defenderPortalSchema = z.string().transform((value, context) => {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'Defender for Cloud Apps tenant portal is invalid.',
    })
    return z.NEVER
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.portal\.cloudappsecurity\.com$/i.test(
      url.hostname,
    )
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Defender for Cloud Apps tenant portal is not allowed.',
    })
    return z.NEVER
  }
  return `https://${url.hostname.toLowerCase()}`
})

const keyVaultUriSchema = z.string().transform((value, context) => {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    context.addIssue({ code: 'custom', message: 'Key Vault URI is invalid.' })
    return z.NEVER
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^[a-z0-9](?:[a-z0-9-]{1,22}[a-z0-9])?\.vault\.azure\.net$/i.test(url.hostname)
  ) {
    context.addIssue({ code: 'custom', message: 'Key Vault URI is not allowed.' })
    return z.NEVER
  }
  return `https://${url.hostname.toLowerCase()}`
})

function connectorLimitsSchema(maxRetryAfterMs: number) {
  return z
    .strictObject({
      maxPages: z.number().int().min(1).max(100).default(20),
      maxItems: z.number().int().min(1).max(50_000).default(5_000),
      requestTimeoutMs: z.number().int().min(100).max(120_000).default(15_000),
      maxRetries: z.number().int().min(0).max(5).default(2),
      maxRetryAfterMs: z.number().int().min(0).max(maxRetryAfterMs).default(30_000),
      maxResponseBytes: z.number().int().min(1_024).max(10_000_000).default(2_000_000),
    })
    .default({
      maxPages: 20,
      maxItems: 5_000,
      requestTimeoutMs: 15_000,
      maxRetries: 2,
      maxRetryAfterMs: 30_000,
      maxResponseBytes: 2_000_000,
    })
}

const standardConnectorLimitsSchema = connectorLimitsSchema(120_000)
const agent365ConnectorLimitsSchema = connectorLimitsSchema(AGENT365_MAX_RETRY_AFTER_MS)

export const agent365AggregationSchema = z
  .strictObject({
    maxConcurrency: z.number().int().min(1).max(10).default(2),
    maxDurationMs: z.number().int().min(100).max(300_000).default(60_000),
  })
  .default({
    maxConcurrency: 2,
    maxDurationMs: 60_000,
  })

export const connectorTypeSchema = z.enum([
  'foundry',
  'entra-identity',
  'power-platform',
  'agent365',
  'defender-cloud-apps',
  'purview',
  'azure-resource-graph',
  'teams-distribution',
  'azure-monitor-otel',
  'manifest',
])
export type ConnectorType = z.infer<typeof connectorTypeSchema>

const foundryConnectorSourceConfigurationSchema = z
  .strictObject({
    type: z.literal('foundry'),
    projectEndpoint: foundryProjectEndpointSchema,
    sourceTenantId: boundedIdentifierSchema.optional(),
    sourceEnvironment: boundedEnvironmentSchema.optional(),
    sourceProjectId: sourceProjectIdSchema.optional(),
  })
  .superRefine((configuration, context) => {
    const retainedBoundary = [
      configuration.sourceTenantId,
      configuration.sourceEnvironment,
      configuration.sourceProjectId,
    ]
    const retainedCount = retainedBoundary.filter((value) => value !== undefined).length
    if (retainedCount > 0 && retainedCount < retainedBoundary.length) {
      context.addIssue({
        code: 'custom',
        message:
          'Retained Foundry provider boundaries must include tenant, environment, and project.',
      })
    }
    const endpointProjectId = new URL(configuration.projectEndpoint).pathname.split('/').at(-1)
    if (
      configuration.sourceProjectId !== undefined &&
      configuration.sourceProjectId !== endpointProjectId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sourceProjectId'],
        message: 'Retained Foundry sourceProjectId must match the project endpoint.',
      })
    }
  })

export const connectorSourceConfigurationSchema = z.discriminatedUnion('type', [
  foundryConnectorSourceConfigurationSchema,
  z.strictObject({
    type: z.literal('entra-identity'),
    graphBaseUrl: exactHttpsOriginSchema(
      'https://graph.microsoft.com',
      'Microsoft Graph base',
    ).default('https://graph.microsoft.com'),
    capabilities: z
      .strictObject({
        owners: z.boolean().default(false),
        appRoleAssignments: z.boolean().default(false),
        agentIdentityPreview: z.boolean().default(false),
      })
      .default({
        owners: false,
        appRoleAssignments: false,
        agentIdentityPreview: false,
      }),
    limits: standardConnectorLimitsSchema,
  }),
  z.strictObject({
    type: z.literal('power-platform'),
    environmentId: boundedIdentifierSchema,
    apiBaseUrl: exactHttpsOriginSchema(
      'https://api.powerplatform.com',
      'Power Platform API base',
    ).default('https://api.powerplatform.com'),
    limits: standardConnectorLimitsSchema,
  }),
  z.strictObject({
    type: z.literal('agent365'),
    graphBaseUrl: exactHttpsOriginSchema(
      'https://graph.microsoft.com',
      'Microsoft Graph base',
    ).default('https://graph.microsoft.com'),
    limits: agent365ConnectorLimitsSchema,
    aggregation: agent365AggregationSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('defender-cloud-apps'),
    apiBaseUrl: defenderPortalSchema,
    lookbackHours: z.number().int().min(1).max(168).default(24),
    limits: standardConnectorLimitsSchema,
  }),
  z.strictObject({
    type: z.literal('purview'),
    graphBaseUrl: exactHttpsOriginSchema(
      'https://graph.microsoft.com',
      'Microsoft Graph base',
    ).default('https://graph.microsoft.com'),
    limits: standardConnectorLimitsSchema,
  }),
  z.strictObject({
    type: z.literal('azure-resource-graph'),
    subscriptions: z.array(azureGuidSchema).min(1).max(100),
    managementBaseUrl: exactHttpsOriginSchema(
      'https://management.azure.com',
      'Azure Resource Manager base',
    ).default('https://management.azure.com'),
    limits: standardConnectorLimitsSchema,
  }),
  z.strictObject({
    type: z.literal('teams-distribution'),
    graphBaseUrl: exactHttpsOriginSchema(
      'https://graph.microsoft.com',
      'Microsoft Graph base',
    ).default('https://graph.microsoft.com'),
    limits: standardConnectorLimitsSchema,
  }),
  z.strictObject({
    type: z.literal('azure-monitor-otel'),
    workspaceId: azureGuidSchema,
    sourceProjectId: sourceProjectIdSchema,
    logsBaseUrl: exactHttpsOriginSchema(
      'https://api.loganalytics.io',
      'Azure Monitor Logs base',
    ).default('https://api.loganalytics.io'),
    baselineWindowHours: z.number().int().min(1).max(744).default(168),
    observedWindowHours: z.number().int().min(1).max(168).default(24),
    requestTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
    maxResponseBytes: z
      .number()
      .int()
      .min(1_024)
      .max(64 * 1024 * 1024)
      .default(4 * 1024 * 1024),
  }),
  z.strictObject({
    type: z.literal('manifest'),
    manifestId: boundedIdentifierSchema,
  }),
])
export type ConnectorSourceConfiguration = z.infer<typeof connectorSourceConfigurationSchema>

export const connectorCredentialMetadataSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('default'),
  }),
  z.strictObject({
    mode: z.literal('managed-identity'),
    managedIdentityClientId: azureGuidSchema,
  }),
  z.strictObject({
    mode: z.literal('federated-app'),
    clientId: azureGuidSchema,
    managedIdentityClientId: azureGuidSchema,
  }),
  z.strictObject({
    mode: z.literal('key-vault-secret-reference'),
    vaultUri: keyVaultUriSchema,
    secretName: z.string().regex(/^[0-9A-Za-z-]{1,127}$/),
    secretVersion: z
      .string()
      .regex(/^[0-9a-f]{32}$/i)
      .optional(),
  }),
])
export type ConnectorCredentialMetadata = z.infer<typeof connectorCredentialMetadataSchema>

export type Agent365SourcePolicyInactiveReason =
  | 'deployment-origin-required'
  | 'source-disabled'
  | 'managed-identity-required'
  | 'managed-identity-client-id-not-approved'

export type Agent365SourcePolicyDecision =
  | { readonly status: 'not-applicable' }
  | { readonly status: 'active' }
  | {
      readonly status: 'inactive'
      readonly reason: Agent365SourcePolicyInactiveReason
    }

export interface Agent365SourcePolicyInput {
  readonly connectorType: ConnectorType
  readonly origin: 'deployment' | 'user'
  readonly enabled: boolean
  readonly credential: ConnectorCredentialMetadata
}

export function evaluateAgent365SourcePolicy(
  source: Agent365SourcePolicyInput,
): Agent365SourcePolicyDecision {
  if (source.connectorType !== 'agent365') return { status: 'not-applicable' }
  if (source.origin !== 'deployment') {
    return { status: 'inactive', reason: 'deployment-origin-required' }
  }
  if (!source.enabled) return { status: 'inactive', reason: 'source-disabled' }
  if (source.credential.mode !== 'managed-identity') {
    return { status: 'inactive', reason: 'managed-identity-required' }
  }
  if (
    source.credential.managedIdentityClientId.toLowerCase() !==
    AGENT365_APPROVED_MANAGED_IDENTITY_CLIENT_ID
  ) {
    return {
      status: 'inactive',
      reason: 'managed-identity-client-id-not-approved',
    }
  }
  return { status: 'active' }
}

export const connectorSourceActorSchema = z.strictObject({
  type: z.enum(['user', 'service-principal', 'deployment']),
  id: boundedIdentifierSchema,
})
export type ConnectorSourceActor = z.infer<typeof connectorSourceActorSchema>

const testedConnectorSourceStatusSchema = z
  .strictObject({
    status: z.enum(['passed', 'failed', 'degraded', 'authorization-required', 'insufficient-data']),
    evidenceBasis: z.enum(['provider-response', 'synthetic']),
    evidenceIds: z.array(boundedIdentifierSchema).min(1).max(50),
    checkedAt: normalizedTimestampSchema,
    checkedBy: connectorSourceActorSchema,
    summary: boundedSummarySchema,
  })
  .superRefine((status, context) => {
    if (status.status === 'passed' && status.evidenceBasis !== 'provider-response') {
      context.addIssue({
        code: 'custom',
        path: ['evidenceBasis'],
        message: 'A passing connector test requires real provider-response evidence.',
      })
    }
  })

export const connectorSourceTestStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('not-tested') }),
  testedConnectorSourceStatusSchema,
])
export type ConnectorSourceTestStatus = z.infer<typeof connectorSourceTestStatusSchema>

const connectorSourceCoreSchema = z
  .strictObject({
    estateId: estateIdSchema,
    tenantId: z.string().trim().min(1).max(128),
    environment: boundedEnvironmentSchema,
    sourceId: connectorSourceIdSchema,
    connectorType: connectorTypeSchema,
    displayName: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    origin: z.enum(['deployment', 'user']),
    configuration: connectorSourceConfigurationSchema,
    credential: connectorCredentialMetadataSchema,
    runtimeBinding: connectorRuntimeBindingSchema.optional(),
    testStatus: connectorSourceTestStatusSchema,
  })
  .superRefine((source, context) => {
    if (source.configuration.type !== source.connectorType) {
      context.addIssue({
        code: 'custom',
        path: ['configuration', 'type'],
        message: 'Connector configuration must match connectorType.',
      })
    }
    if (source.runtimeBinding !== undefined && source.origin !== 'deployment') {
      context.addIssue({
        code: 'custom',
        path: ['runtimeBinding'],
        message: 'Deployment runtime bindings are allowed only on deployment-origin sources.',
      })
    }
  })

export const connectorSourceCreateInputSchema = connectorSourceCoreSchema
export type ConnectorSourceCreateInput = z.infer<typeof connectorSourceCreateInputSchema>

export const connectorSourceUpdateInputSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    configuration: connectorSourceConfigurationSchema.optional(),
    credential: connectorCredentialMetadataSchema.optional(),
    testStatus: connectorSourceTestStatusSchema.optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: 'At least one connector source field must be updated.',
  })
export type ConnectorSourceUpdateInput = z.infer<typeof connectorSourceUpdateInputSchema>

export const connectorSourceDefinitionSchema = connectorSourceCoreSchema
  .safeExtend({
    version: z.number().int().min(1),
    etag: z.string().trim().min(1).max(256),
    createdBy: connectorSourceActorSchema,
    updatedBy: connectorSourceActorSchema,
    createdAt: normalizedTimestampSchema,
    updatedAt: normalizedTimestampSchema,
  })
  .superRefine((source, context) => {
    if (source.updatedAt < source.createdAt) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'updatedAt cannot precede createdAt.',
      })
    }
    if (source.origin === 'deployment' && source.createdBy.type !== 'deployment') {
      context.addIssue({
        code: 'custom',
        path: ['createdBy', 'type'],
        message: 'Deployment sources must be created by a deployment actor.',
      })
    }
  })
export type ConnectorSourceDefinition = z.infer<typeof connectorSourceDefinitionSchema>

const legacyAzureMonitorConfigurationSchema = z.strictObject({
  type: z.literal('azure-monitor-otel'),
  workspaceId: azureGuidSchema,
  logsBaseUrl: exactHttpsOriginSchema(
    'https://api.loganalytics.io',
    'Azure Monitor Logs base',
  ).default('https://api.loganalytics.io'),
  baselineWindowHours: z.number().int().min(1).max(744).default(168),
  observedWindowHours: z.number().int().min(1).max(168).default(24),
  requestTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
  maxResponseBytes: z
    .number()
    .int()
    .min(1_024)
    .max(64 * 1024 * 1024)
    .default(4 * 1024 * 1024),
})

const legacyAzureMonitorConnectorSourceSchema = z
  .strictObject({
    estateId: estateIdSchema,
    tenantId: z.string().trim().min(1).max(128),
    environment: boundedEnvironmentSchema,
    sourceId: connectorSourceIdSchema,
    connectorType: z.literal('azure-monitor-otel'),
    displayName: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    origin: z.enum(['deployment', 'user']),
    configuration: legacyAzureMonitorConfigurationSchema,
    credential: connectorCredentialMetadataSchema,
    testStatus: connectorSourceTestStatusSchema,
    version: z.number().int().min(1),
    etag: z.string().trim().min(1).max(256),
    createdBy: connectorSourceActorSchema,
    updatedBy: connectorSourceActorSchema,
    createdAt: normalizedTimestampSchema,
    updatedAt: normalizedTimestampSchema,
  })
  .superRefine((source, context) => {
    if (source.updatedAt < source.createdAt) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'updatedAt cannot precede createdAt.',
      })
    }
    if (source.origin === 'deployment' && source.createdBy.type !== 'deployment') {
      context.addIssue({
        code: 'custom',
        path: ['createdBy', 'type'],
        message: 'Deployment sources must be created by a deployment actor.',
      })
    }
  })

export const connectorSourceMigrationSchema = z.strictObject({
  status: z.literal('migration-required'),
  active: z.literal(false),
  reason: z.literal('missing-source-project-id'),
  action: z.literal('supply-exact-source-project-id'),
})
export type ConnectorSourceMigration = z.infer<typeof connectorSourceMigrationSchema>

export const connectorSourceMigrationRequiredSchema =
  legacyAzureMonitorConnectorSourceSchema.safeExtend({
    enabled: z.literal(false),
    testStatus: z.strictObject({ status: z.literal('not-tested') }),
    migration: connectorSourceMigrationSchema,
  })
export type ConnectorSourceMigrationRequired = z.infer<
  typeof connectorSourceMigrationRequiredSchema
>

export const connectorSourceReadModelSchema = z.union([
  connectorSourceDefinitionSchema,
  connectorSourceMigrationRequiredSchema,
])
export type ConnectorSourceReadModel = z.infer<typeof connectorSourceReadModelSchema>

export function isConnectorSourceMigrationRequired(
  source: ConnectorSourceReadModel,
): source is ConnectorSourceMigrationRequired {
  return 'migration' in source
}

function exactAzureMonitorBinding(
  legacy: z.infer<typeof legacyAzureMonitorConnectorSourceSchema>,
  candidate: ConnectorSourceDefinition,
): boolean {
  if (
    candidate.origin !== 'deployment' ||
    candidate.estateId !== legacy.estateId ||
    candidate.tenantId !== legacy.tenantId ||
    candidate.environment !== legacy.environment ||
    candidate.sourceId !== legacy.sourceId ||
    candidate.connectorType !== 'azure-monitor-otel' ||
    candidate.configuration.type !== 'azure-monitor-otel'
  ) {
    return false
  }
  const current = candidate.configuration
  const previous = legacy.configuration
  return (
    current.workspaceId === previous.workspaceId &&
    current.logsBaseUrl === previous.logsBaseUrl &&
    current.baselineWindowHours === previous.baselineWindowHours &&
    current.observedWindowHours === previous.observedWindowHours &&
    current.requestTimeoutMs === previous.requestTimeoutMs &&
    current.maxResponseBytes === previous.maxResponseBytes
  )
}

export function hydratePersistedConnectorSourceDefinition(
  value: unknown,
  authoritativeSources: readonly ConnectorSourceDefinition[] = [],
): ConnectorSourceReadModel {
  const current = connectorSourceDefinitionSchema.safeParse(value)
  if (current.success) return current.data

  const legacy = legacyAzureMonitorConnectorSourceSchema.parse(value)
  const matches = authoritativeSources.filter((candidate) =>
    exactAzureMonitorBinding(legacy, connectorSourceDefinitionSchema.parse(candidate)),
  )
  if (matches.length === 1) {
    const binding = matches[0]!
    if (binding.configuration.type !== 'azure-monitor-otel') {
      throw new Error('Exact Azure Monitor source binding changed during hydration.')
    }
    return connectorSourceDefinitionSchema.parse({
      ...legacy,
      configuration: {
        ...legacy.configuration,
        sourceProjectId: binding.configuration.sourceProjectId,
      },
    })
  }

  return connectorSourceMigrationRequiredSchema.parse({
    ...legacy,
    enabled: false,
    testStatus: { status: 'not-tested' },
    migration: {
      status: 'migration-required',
      active: false,
      reason: 'missing-source-project-id',
      action: 'supply-exact-source-project-id',
    },
  })
}

export const connectorSourceMutationContextSchema = z.strictObject({
  auditId: boundedIdentifierSchema,
  idempotencyKey: z.string().trim().min(1).max(256),
  actor: connectorSourceActorSchema,
  occurredAt: normalizedTimestampSchema,
})
export type ConnectorSourceMutationContext = z.infer<typeof connectorSourceMutationContextSchema>

const connectorSourceAuditMetadataSchema = z.strictObject({
  id: boundedIdentifierSchema,
  estateId: estateIdSchema,
  tenantId: z.string().trim().min(1).max(128),
  environment: boundedEnvironmentSchema,
  sourceId: connectorSourceIdSchema,
  operation: z.enum(['create', 'update', 'delete']),
  actor: connectorSourceActorSchema,
  occurredAt: normalizedTimestampSchema,
  idempotencyKey: z.string().trim().min(1).max(256),
})

type ConnectorSourceAuditValidation = z.infer<typeof connectorSourceAuditMetadataSchema> & {
  before: ConnectorSourceReadModel | null
  after: ConnectorSourceReadModel | null
}

function validateConnectorSourceAudit(
  audit: ConnectorSourceAuditValidation,
  context: z.RefinementCtx,
): void {
  for (const snapshot of [audit.before, audit.after]) {
    if (
      snapshot !== null &&
      (snapshot.estateId !== audit.estateId ||
        snapshot.tenantId !== audit.tenantId ||
        snapshot.environment !== audit.environment ||
        snapshot.sourceId !== audit.sourceId)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Audit snapshot does not match its source boundary.',
      })
    }
  }
  const validSnapshots =
    (audit.operation === 'create' && audit.before === null && audit.after !== null) ||
    (audit.operation === 'update' && audit.before !== null && audit.after !== null) ||
    (audit.operation === 'delete' && audit.before !== null && audit.after === null)
  if (!validSnapshots) {
    context.addIssue({
      code: 'custom',
      message: `Audit snapshots are invalid for ${audit.operation}.`,
    })
  }
  if (audit.before !== null && audit.after !== null) {
    const beforeRuntimeBinding =
      'runtimeBinding' in audit.before ? audit.before.runtimeBinding : undefined
    const afterRuntimeBinding =
      'runtimeBinding' in audit.after ? audit.after.runtimeBinding : undefined
    const immutableFieldsMatch =
      audit.before.estateId === audit.after.estateId &&
      audit.before.tenantId === audit.after.tenantId &&
      audit.before.environment === audit.after.environment &&
      audit.before.sourceId === audit.after.sourceId &&
      audit.before.connectorType === audit.after.connectorType &&
      audit.before.origin === audit.after.origin &&
      JSON.stringify(beforeRuntimeBinding) === JSON.stringify(afterRuntimeBinding) &&
      audit.before.createdAt === audit.after.createdAt &&
      audit.before.createdBy.type === audit.after.createdBy.type &&
      audit.before.createdBy.id === audit.after.createdBy.id
    if (!immutableFieldsMatch) {
      context.addIssue({
        code: 'custom',
        path: ['after'],
        message: 'Connector source immutable fields cannot change in audit history.',
      })
    }
    if (audit.after.version !== audit.before.version + 1) {
      context.addIssue({
        code: 'custom',
        path: ['after', 'version'],
        message: 'An update audit must increment the source version by one.',
      })
    }
  }
  const actorMatches = (left: ConnectorSourceActor, right: ConnectorSourceActor) =>
    left.type === right.type && left.id === right.id
  if (
    audit.operation === 'create' &&
    audit.after !== null &&
    (audit.after.version !== 1 ||
      audit.after.createdAt !== audit.occurredAt ||
      audit.after.updatedAt !== audit.occurredAt ||
      !actorMatches(audit.actor, audit.after.createdBy) ||
      !actorMatches(audit.actor, audit.after.updatedBy))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['after'],
      message: 'A create audit must bind its actor and timestamp to source creation.',
    })
  }
  if (
    audit.operation === 'update' &&
    audit.before !== null &&
    audit.after !== null &&
    (audit.occurredAt <= audit.before.updatedAt ||
      audit.after.updatedAt !== audit.occurredAt ||
      !actorMatches(audit.actor, audit.after.updatedBy))
  ) {
    context.addIssue({
      code: 'custom',
      path: ['after'],
      message:
        'An update audit must occur after the current source version and bind its actor and timestamp to the resulting source.',
    })
  }
  if (
    audit.operation === 'delete' &&
    audit.before !== null &&
    audit.occurredAt <= audit.before.updatedAt
  ) {
    context.addIssue({
      code: 'custom',
      path: ['occurredAt'],
      message: 'A delete audit must occur after the source version it removes.',
    })
  }
}

export const connectorSourceAuditRecordSchema = connectorSourceAuditMetadataSchema
  .safeExtend({
    before: connectorSourceDefinitionSchema.nullable(),
    after: connectorSourceDefinitionSchema.nullable(),
  })
  .superRefine(validateConnectorSourceAudit)
export type ConnectorSourceAuditRecord = z.infer<typeof connectorSourceAuditRecordSchema>

export const connectorSourceAuditReadModelSchema = connectorSourceAuditMetadataSchema
  .safeExtend({
    before: connectorSourceReadModelSchema.nullable(),
    after: connectorSourceReadModelSchema.nullable(),
  })
  .superRefine(validateConnectorSourceAudit)
export type ConnectorSourceAuditReadModel = z.infer<typeof connectorSourceAuditReadModelSchema>

const persistedConnectorSourceAuditSchema = connectorSourceAuditMetadataSchema.safeExtend({
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
})

export function hydratePersistedConnectorSourceAuditRecord(
  value: unknown,
  authoritativeSources: readonly ConnectorSourceDefinition[] = [],
): ConnectorSourceAuditReadModel {
  const current = connectorSourceAuditRecordSchema.safeParse(value)
  if (current.success) return current.data

  const persisted = persistedConnectorSourceAuditSchema.parse(value)
  return connectorSourceAuditReadModelSchema.parse({
    ...persisted,
    before:
      persisted.before === null
        ? null
        : hydratePersistedConnectorSourceDefinition(persisted.before, authoritativeSources),
    after:
      persisted.after === null
        ? null
        : hydratePersistedConnectorSourceDefinition(persisted.after, authoritativeSources),
  })
}
