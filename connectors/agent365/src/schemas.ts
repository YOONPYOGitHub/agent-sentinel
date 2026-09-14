import { z } from 'zod'

import { AGENT365_MAX_RETRY_AFTER_MS, agent365AggregationSchema } from '@agent-sentinel/domain'

export const AGENT365_GRAPH_ORIGIN = 'https://graph.microsoft.com'
export const AGENT365_API_VERSION = 'v1.0'
export const AGENT365_PACKAGES_PATH = '/v1.0/copilot/admin/catalog/packages'
export const AGENT365_DETAIL_CAPABILITY_ENABLED = false

const boundedId = z.string().trim().min(1).max(512)
const boundedText = z.string().trim().min(1).max(4_096)
const boundedOptionalText = z.string().max(4_096).optional()
const azureGuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const tenantIdSchema = azureGuidSchema
const environmentSchema = z.string().trim().min(1).max(128)
const metadataTypeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^#?microsoft\.graph\.copilotPackage(?:Detail)?$/i)
const boundedStringCollection = z.array(z.string().trim().min(1).max(128)).max(100)

export function sanitizeAgent365GraphBaseUrl(value: string): string {
  const candidate = value.trim()
  if (candidate !== AGENT365_GRAPH_ORIGIN && candidate !== `${AGENT365_GRAPH_ORIGIN}/`) {
    throw new Error('Agent 365 Graph base URL is not allowed.')
  }
  return AGENT365_GRAPH_ORIGIN
}

export const agent365LimitsSchema = z
  .strictObject({
    maxPages: z.number().int().min(1).max(100).default(20),
    maxItems: z.number().int().min(1).max(50_000).default(5_000),
    requestTimeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    maxRetries: z.number().int().min(0).max(5).default(2),
    maxRetryAfterMs: z.number().int().min(0).max(AGENT365_MAX_RETRY_AFTER_MS).default(30_000),
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
export type Agent365Limits = z.infer<typeof agent365LimitsSchema>

const sourceCredentialSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('default'),
    managedIdentityClientId: azureGuidSchema.optional(),
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
])

export const agent365SourceConfigSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().trim().min(1).max(100),
  tenantId: tenantIdSchema,
  environment: environmentSchema,
  graphBaseUrl: z.string().transform(sanitizeAgent365GraphBaseUrl).default(AGENT365_GRAPH_ORIGIN),
  limits: agent365LimitsSchema,
  credential: sourceCredentialSchema.optional(),
})
export type Agent365SourceConfig = z.infer<typeof agent365SourceConfigSchema>

export const agent365SourcesConfigSchema = z
  .array(agent365SourceConfigSchema)
  .min(1)
  .max(50)
  .superRefine((sources, context) => {
    const ids = new Set<string>()
    const tenants = new Set<string>()
    for (const [index, source] of sources.entries()) {
      if (ids.has(source.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `Duplicate Agent 365 source id: ${source.id}`,
        })
      }
      ids.add(source.id)
      const tenant = source.tenantId.toLowerCase()
      if (tenants.has(tenant)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Duplicate Agent 365 tenant source boundary.',
        })
      }
      tenants.add(tenant)
    }
  })

export const agent365ConfigSchema = z.strictObject({
  graphBaseUrl: z.string().transform(sanitizeAgent365GraphBaseUrl),
  limits: agent365LimitsSchema,
  aggregation: agent365AggregationSchema,
  sources: agent365SourcesConfigSchema,
})
export type Agent365Config = z.infer<typeof agent365ConfigSchema>

const packageAvailabilitySchema = z.enum([
  'none',
  'some',
  'all',
  'allowedForAll',
  'allowedForSome',
  'unknownFutureValue',
])
const packageDeploymentSchema = z.enum([
  'none',
  'some',
  'all',
  'acquiredForNone',
  'acquiredForSome',
  'unknownFutureValue',
])
const packageTypeSchema = z.enum([
  'microsoft',
  'external',
  'shared',
  'custom',
  'firstParty',
  'thirdParty',
  'unknownFutureValue',
])

export const copilotPackageSchema = z.object({
  '@odata.type': metadataTypeSchema.optional(),
  id: boundedId,
  displayName: boundedText,
  type: packageTypeSchema.optional(),
  shortDescription: boundedOptionalText,
  isBlocked: z.boolean().optional(),
  supportedHosts: boundedStringCollection.optional(),
  lastModifiedDateTime: z.iso.datetime({ offset: true }).optional(),
  publisher: z.string().max(1_024).optional(),
  availableTo: packageAvailabilitySchema.optional(),
  deployedTo: packageDeploymentSchema.optional(),
  elementTypes: boundedStringCollection.optional(),
  platform: z.string().max(256).optional(),
  version: z.string().max(128).optional(),
  manifestVersion: z.string().max(128).optional(),
  manifestId: z.string().max(512).nullable().optional(),
  appId: azureGuidSchema.nullable().optional(),
  assetId: z.string().max(512).optional(),
})
export type CopilotPackage = z.infer<typeof copilotPackageSchema>

export const copilotPackageCollectionSchema = z.object({
  '@odata.context': z.url().max(2_048).optional(),
  '@odata.count': z.number().int().min(0).max(10_000_000).optional(),
  '@odata.nextLink': z.url().max(8_192).optional(),
  value: z.array(copilotPackageSchema).max(10_000),
})
export type CopilotPackageCollection = z.infer<typeof copilotPackageCollectionSchema>
