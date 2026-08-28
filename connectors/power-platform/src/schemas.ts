import { z } from 'zod'

export const POWER_PLATFORM_API_ORIGIN = 'https://api.powerplatform.com'
export const POWER_PLATFORM_API_VERSION = '2024-10-01'
export const POWER_PLATFORM_RESOURCE_TYPE = 'microsoft.copilotstudio/agents'

const boundedId = z.string().trim().min(1).max(256)
const boundedText = z.string().max(1_024)
const azureGuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const tenantIdSchema = azureGuidSchema
const environmentSchema = z.string().trim().min(1).max(128)
const optionalDate = z.iso.datetime({ offset: true }).nullable().optional()

function validateBoundedFreeForm(
  value: unknown,
  context: z.RefinementCtx,
  path: (string | number)[] = [],
  depth = 0,
): void {
  if (depth > 8) {
    context.addIssue({ code: 'custom', path, message: 'Resource properties exceed depth limits.' })
    return
  }
  if (typeof value === 'string') {
    if (value.length > 4_096) {
      context.addIssue({
        code: 'custom',
        path,
        message: 'Resource property string exceeds length limits.',
      })
    }
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 100) {
      context.addIssue({
        code: 'custom',
        path,
        message: 'Resource property array exceeds item limits.',
      })
      return
    }
    value.forEach((item, index) =>
      validateBoundedFreeForm(item, context, [...path, index], depth + 1),
    )
    return
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
    if (entries.length > 100) {
      context.addIssue({
        code: 'custom',
        path,
        message: 'Resource properties exceed field limits.',
      })
      return
    }
    for (const [key, item] of entries) {
      if (key.length > 256) {
        context.addIssue({
          code: 'custom',
          path: [...path, key],
          message: 'Resource property name exceeds length limits.',
        })
        continue
      }
      validateBoundedFreeForm(item, context, [...path, key], depth + 1)
    }
  }
}

export function sanitizePowerPlatformApiBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Power Platform API base URL is invalid.')
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'api.powerplatform.com' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Power Platform API base URL is not allowed.')
  }
  return POWER_PLATFORM_API_ORIGIN
}

export const powerPlatformLimitsSchema = z
  .strictObject({
    pageSize: z.number().int().min(1).max(1_000).default(100),
    maxPages: z.number().int().min(1).max(100).default(20),
    maxItems: z.number().int().min(1).max(50_000).default(5_000),
    requestTimeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    maxRetries: z.number().int().min(0).max(5).default(2),
    maxRetryAfterMs: z.number().int().min(0).max(60_000).default(30_000),
    maxResponseBytes: z.number().int().min(1_024).max(10_000_000).default(2_000_000),
  })
  .default({
    pageSize: 100,
    maxPages: 20,
    maxItems: 5_000,
    requestTimeoutMs: 15_000,
    maxRetries: 2,
    maxRetryAfterMs: 30_000,
    maxResponseBytes: 2_000_000,
  })
export type PowerPlatformLimits = z.infer<typeof powerPlatformLimitsSchema>

const sourceCredentialSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('default'),
    managedIdentityClientId: z.uuid().optional(),
  }),
  z.strictObject({
    mode: z.literal('federated-app'),
    clientId: z.uuid(),
    managedIdentityClientId: z.uuid().optional(),
  }),
])

export const powerPlatformSourceConfigSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().trim().min(1).max(100),
  tenantId: tenantIdSchema,
  environment: environmentSchema,
  credential: sourceCredentialSchema.optional(),
})
export type PowerPlatformSourceConfig = z.infer<typeof powerPlatformSourceConfigSchema>

export const powerPlatformSourcesConfigSchema = z
  .array(powerPlatformSourceConfigSchema)
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
          message: `Duplicate Power Platform source id: ${source.id}`,
        })
      }
      ids.add(source.id)
      const boundary = `${source.tenantId.toLowerCase()}\0${source.environment}`
      if (boundaries.has(boundary)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Duplicate Power Platform tenant and environment source boundary.',
        })
      }
      boundaries.add(boundary)
    }
  })

export const powerPlatformConfigSchema = z.strictObject({
  apiBaseUrl: z.string().transform(sanitizePowerPlatformApiBaseUrl),
  limits: powerPlatformLimitsSchema,
  sources: powerPlatformSourcesConfigSchema,
})
export type PowerPlatformConfig = z.infer<typeof powerPlatformConfigSchema>

export const powerPlatformAgentPropertiesSchema = z
  .object({
    displayName: z.string().trim().min(1).max(256).optional(),
    name: azureGuidSchema.optional(),
    createdAt: optionalDate,
    createdBy: boundedId.optional(),
    ownerId: boundedId.optional(),
    environmentId: environmentSchema.optional(),
    lastPublishedAt: optionalDate,
    createdIn: boundedText.optional(),
    schemaName: boundedText.optional(),
    entraAppId: azureGuidSchema.optional(),
    entraAgentId: azureGuidSchema.optional(),
    entraAgentBlueprintId: azureGuidSchema.optional(),
  })
  .passthrough()
  .superRefine((properties, context) => validateBoundedFreeForm(properties, context))

export const powerPlatformResourceItemSchema = z
  .object({
    id: boundedId.optional(),
    name: azureGuidSchema,
    type: z
      .string()
      .max(128)
      .refine(
        (value) => value.toLowerCase() === POWER_PLATFORM_RESOURCE_TYPE,
        'Unexpected Power Platform resource type.',
      ),
    tenantId: tenantIdSchema,
    location: z.string().trim().min(1).max(128).optional(),
    environmentId: environmentSchema.optional(),
    environmentName: z.string().trim().min(1).max(256).optional(),
    environmentDisplayName: z.string().trim().min(1).max(256).optional(),
    properties: powerPlatformAgentPropertiesSchema,
  })
  .passthrough()
  .superRefine((resource, context) => {
    validateBoundedFreeForm(resource, context)
    if (resource.environmentId === undefined && resource.properties.environmentId === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Power Platform agent resource must include an environment ID.',
      })
    }
  })
export type PowerPlatformResourceItem = z.infer<typeof powerPlatformResourceItemSchema>

export const powerPlatformResourceQueryResponseSchema = z
  .object({
    count: z.number().int().min(0).max(1_000),
    data: z.array(powerPlatformResourceItemSchema).max(1_000),
    resultTruncated: z.union([z.literal(0), z.literal(1)]),
    skipToken: z.string().trim().min(1).max(4_096).optional(),
    totalRecords: z.number().int().min(0).max(10_000_000),
  })
  .passthrough()
export type PowerPlatformResourceQueryResponse = z.infer<
  typeof powerPlatformResourceQueryResponseSchema
>
