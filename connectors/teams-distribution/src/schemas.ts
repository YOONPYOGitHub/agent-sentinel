import { z } from 'zod'

export const TEAMS_DISTRIBUTION_GRAPH_ORIGIN = 'https://graph.microsoft.com'
export const TEAMS_DISTRIBUTION_API_VERSION = 'v1.0'
export const TEAMS_DISTRIBUTION_APPS_PATH = '/v1.0/appCatalogs/teamsApps'
export const TEAMS_DISTRIBUTION_ORGANIZATION_FILTER = "distributionMethod eq 'organization'"
export const TEAMS_DISTRIBUTION_SELECT = 'id,externalId,displayName,distributionMethod'

// Graph identifiers are Azure GUIDs but aren't restricted to RFC UUID version/variant bits.
const azureGuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const optionalText = z
  .string()
  .trim()
  .max(4_096)
  .nullable()
  .optional()
  .transform((value) => (value === null || value === '' ? undefined : value))
const optionalExternalId = z
  .string()
  .trim()
  .max(512)
  .nullable()
  .optional()
  .transform((value) => (value === null || value === '' ? undefined : value))

export function sanitizeTeamsDistributionGraphBaseUrl(value: string): string {
  const candidate = value.trim()
  if (
    candidate !== TEAMS_DISTRIBUTION_GRAPH_ORIGIN &&
    candidate !== `${TEAMS_DISTRIBUTION_GRAPH_ORIGIN}/`
  ) {
    throw new Error('Teams distribution Graph base URL is not allowed.')
  }
  return TEAMS_DISTRIBUTION_GRAPH_ORIGIN
}

export const teamsDistributionLimitsSchema = z
  .strictObject({
    maxPages: z.number().int().min(1).max(100).default(20),
    maxItems: z.number().int().min(1).max(50_000).default(5_000),
    requestTimeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    maxRetries: z.number().int().min(0).max(5).default(2),
    maxRetryAfterMs: z.number().int().min(0).max(60_000).default(30_000),
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
export type TeamsDistributionLimits = z.infer<typeof teamsDistributionLimitsSchema>

const sourceCredentialSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('default'),
    managedIdentityClientId: azureGuidSchema.optional(),
  }),
  z.strictObject({
    mode: z.literal('federated-app'),
    clientId: azureGuidSchema,
    managedIdentityClientId: azureGuidSchema.optional(),
  }),
])

export const teamsDistributionSourceConfigSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().trim().min(1).max(100),
  tenantId: azureGuidSchema,
  environment: z.string().trim().min(1).max(128),
  credential: sourceCredentialSchema.optional(),
})
export type TeamsDistributionSourceConfig = z.infer<typeof teamsDistributionSourceConfigSchema>

export const teamsDistributionSourcesConfigSchema = z
  .array(teamsDistributionSourceConfigSchema)
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
          message: `Duplicate Teams distribution source id: ${source.id}`,
        })
      }
      ids.add(source.id)
      const tenant = source.tenantId.toLowerCase()
      if (tenants.has(tenant)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'tenantId'],
          message: 'Duplicate Teams distribution tenant source boundary.',
        })
      }
      tenants.add(tenant)
    }
  })

export const teamsDistributionConfigSchema = z.strictObject({
  graphBaseUrl: z.string().transform(sanitizeTeamsDistributionGraphBaseUrl),
  limits: teamsDistributionLimitsSchema,
  sources: teamsDistributionSourcesConfigSchema,
})
export type TeamsDistributionConfig = z.infer<typeof teamsDistributionConfigSchema>

export interface TeamsApp {
  id: string
  externalId?: string | undefined
  displayName?: string | undefined
  distributionMethod: 'organization'
}

export const teamsAppSchema: z.ZodType<TeamsApp> = z
  .object({
    '@odata.type': z
      .string()
      .max(128)
      .regex(/^#?microsoft\.graph\.teamsApp$/i)
      .optional(),
    id: azureGuidSchema,
    externalId: optionalExternalId,
    displayName: optionalText,
    distributionMethod: z.literal('organization'),
  })
  .transform(({ '@odata.type': metadataType, ...app }) => {
    void metadataType
    return app
  })

export const teamsAppCollectionSchema = z.object({
  '@odata.context': z.url().max(2_048).optional(),
  '@odata.count': z.number().int().min(0).max(10_000_000).optional(),
  '@odata.nextLink': z.url().max(8_192).optional(),
  value: z.array(teamsAppSchema).max(10_000),
})
