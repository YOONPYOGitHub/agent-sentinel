import { z } from 'zod'

import { estateIdSchema } from './estate.js'

const azureGuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const sourceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
const boundedIdentifierSchema = z.string().trim().min(1).max(256)
const boundedEnvironmentSchema = z.string().trim().min(1).max(128)
const boundedSummarySchema = z.string().trim().min(1).max(500)
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

const connectorLimitsSchema = z
  .strictObject({
    maxPages: z.number().int().min(1).max(100).default(20),
    maxItems: z.number().int().min(1).max(50_000).default(5_000),
    requestTimeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    maxRetries: z.number().int().min(0).max(5).default(2),
    maxRetryAfterMs: z.number().int().min(0).max(120_000).default(30_000),
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

export const connectorSourceConfigurationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('foundry'),
    projectEndpoint: foundryProjectEndpointSchema,
  }),
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
    limits: connectorLimitsSchema,
  }),
  z.strictObject({
    type: z.literal('power-platform'),
    environmentId: boundedIdentifierSchema,
    apiBaseUrl: exactHttpsOriginSchema(
      'https://api.powerplatform.com',
      'Power Platform API base',
    ).default('https://api.powerplatform.com'),
    limits: connectorLimitsSchema,
  }),
  z.strictObject({
    type: z.literal('agent365'),
    graphBaseUrl: exactHttpsOriginSchema(
      'https://graph.microsoft.com',
      'Microsoft Graph base',
    ).default('https://graph.microsoft.com'),
    limits: connectorLimitsSchema,
  }),
  z.strictObject({
    type: z.literal('defender-cloud-apps'),
    apiBaseUrl: defenderPortalSchema,
    lookbackHours: z.number().int().min(1).max(168).default(24),
    limits: connectorLimitsSchema,
  }),
  z.strictObject({
    type: z.literal('purview'),
    graphBaseUrl: exactHttpsOriginSchema(
      'https://graph.microsoft.com',
      'Microsoft Graph base',
    ).default('https://graph.microsoft.com'),
    limits: connectorLimitsSchema,
  }),
  z.strictObject({
    type: z.literal('azure-resource-graph'),
    subscriptions: z.array(azureGuidSchema).min(1).max(100),
    managementBaseUrl: exactHttpsOriginSchema(
      'https://management.azure.com',
      'Azure Resource Manager base',
    ).default('https://management.azure.com'),
    limits: connectorLimitsSchema,
  }),
  z.strictObject({
    type: z.literal('teams-distribution'),
    graphBaseUrl: exactHttpsOriginSchema(
      'https://graph.microsoft.com',
      'Microsoft Graph base',
    ).default('https://graph.microsoft.com'),
    limits: connectorLimitsSchema,
  }),
  z.strictObject({
    type: z.literal('azure-monitor-otel'),
    workspaceId: azureGuidSchema,
    logsBaseUrl: exactHttpsOriginSchema(
      'https://api.loganalytics.io',
      'Azure Monitor Logs base',
    ).default('https://api.loganalytics.io'),
    baselineWindowHours: z.number().int().min(1).max(744).default(168),
    observedWindowHours: z.number().int().min(1).max(168).default(24),
    requestTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
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
    sourceId: sourceIdSchema,
    connectorType: connectorTypeSchema,
    displayName: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    origin: z.enum(['deployment', 'user']),
    configuration: connectorSourceConfigurationSchema,
    credential: connectorCredentialMetadataSchema,
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

export const connectorSourceMutationContextSchema = z.strictObject({
  auditId: boundedIdentifierSchema,
  idempotencyKey: z.string().trim().min(1).max(256),
  actor: connectorSourceActorSchema,
  occurredAt: normalizedTimestampSchema,
})
export type ConnectorSourceMutationContext = z.infer<typeof connectorSourceMutationContextSchema>

export const connectorSourceAuditRecordSchema = z
  .strictObject({
    id: boundedIdentifierSchema,
    estateId: estateIdSchema,
    tenantId: z.string().trim().min(1).max(128),
    environment: boundedEnvironmentSchema,
    sourceId: sourceIdSchema,
    operation: z.enum(['create', 'update', 'delete']),
    actor: connectorSourceActorSchema,
    occurredAt: normalizedTimestampSchema,
    idempotencyKey: z.string().trim().min(1).max(256),
    before: connectorSourceDefinitionSchema.nullable(),
    after: connectorSourceDefinitionSchema.nullable(),
  })
  .superRefine((audit, context) => {
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
      const immutableFieldsMatch =
        audit.before.estateId === audit.after.estateId &&
        audit.before.tenantId === audit.after.tenantId &&
        audit.before.environment === audit.after.environment &&
        audit.before.sourceId === audit.after.sourceId &&
        audit.before.connectorType === audit.after.connectorType &&
        audit.before.origin === audit.after.origin &&
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
  })
export type ConnectorSourceAuditRecord = z.infer<typeof connectorSourceAuditRecordSchema>
