import { z } from 'zod'

export const PURVIEW_GRAPH_ORIGIN = 'https://graph.microsoft.com'
export const PURVIEW_API_VERSION = 'v1.0'
export const PURVIEW_SENSITIVITY_LABELS_PATH =
  '/v1.0/security/dataSecurityAndGovernance/sensitivityLabels'

const azureGuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const boundedOptionalLabelText = z.string().trim().min(1).max(4_096).optional()
const boundedInteger = z.number().int().min(-2_147_483_648).max(2_147_483_647)
const applicableTargets = new Set([
  'email',
  'site',
  'unifiedGroup',
  'teamwork',
  'file',
  'schematizedData',
])
const applicableTargetSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .transform((value) => {
    const known = value
      .split(',')
      .map((target) => target.trim())
      .filter((target) => applicableTargets.has(target))
    return known.length === 0 ? undefined : known.join(',')
  })
  .optional()

export function sanitizePurviewGraphBaseUrl(value: string): string {
  const candidate = value.trim()
  if (candidate !== PURVIEW_GRAPH_ORIGIN && candidate !== `${PURVIEW_GRAPH_ORIGIN}/`) {
    throw new Error('Purview Graph base URL is not allowed.')
  }
  return PURVIEW_GRAPH_ORIGIN
}

export const purviewLimitsSchema = z
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
export type PurviewLimits = z.infer<typeof purviewLimitsSchema>

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

export const purviewSourceConfigSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().trim().min(1).max(100),
  tenantId: azureGuidSchema,
  environment: z.string().trim().min(1).max(128),
  credential: sourceCredentialSchema.optional(),
})
export type PurviewSourceConfig = z.infer<typeof purviewSourceConfigSchema>

export const purviewSourcesConfigSchema = z
  .array(purviewSourceConfigSchema)
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
          message: `Duplicate Purview source id: ${source.id}`,
        })
      }
      ids.add(source.id)
      const tenant = source.tenantId.toLowerCase()
      if (tenants.has(tenant)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'tenantId'],
          message: 'Duplicate Purview tenant source boundary.',
        })
      }
      tenants.add(tenant)
    }
  })

export const purviewConfigSchema = z.strictObject({
  graphBaseUrl: z.string().transform(sanitizePurviewGraphBaseUrl),
  limits: purviewLimitsSchema,
  sources: purviewSourcesConfigSchema,
})
export type PurviewConfig = z.infer<typeof purviewConfigSchema>

export interface PurviewSensitivityLabel {
  id: string
  displayName?: string | undefined
  name?: string | undefined
  color?: string | undefined
  sensitivity?: number | undefined
  priority?: number | undefined
  applicableTo?: string | undefined
  isEnabled?: boolean | undefined
  sublabels?: PurviewSensitivityLabel[] | undefined
}

export const purviewSensitivityLabelSchema: z.ZodType<PurviewSensitivityLabel> = z.lazy(() =>
  z
    .object({
      '@odata.type': z
        .string()
        .max(128)
        .regex(/^#?microsoft\.graph\.security\.sensitivityLabel$/i)
        .optional(),
      id: azureGuidSchema,
      displayName: boundedOptionalLabelText,
      name: boundedOptionalLabelText,
      color: z.string().trim().min(1).max(128).optional(),
      sensitivity: boundedInteger.optional(),
      priority: boundedInteger.optional(),
      applicableTo: applicableTargetSchema,
      isEnabled: z.boolean().optional(),
      sublabels: z.array(purviewSensitivityLabelSchema).max(100).optional(),
    })
    .superRefine((label, context) => {
      if (label.displayName === undefined && label.name === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['displayName'],
          message: 'Sensitivity label requires displayName or name.',
        })
      }
    })
    .transform(({ '@odata.type': metadataType, ...label }) => {
      void metadataType
      return label
    }),
)

export const purviewSensitivityLabelCollectionSchema = z.object({
  '@odata.context': z.url().max(2_048).optional(),
  '@odata.count': z.number().int().min(0).max(10_000_000).optional(),
  '@odata.nextLink': z.url().max(8_192).optional(),
  value: z.array(purviewSensitivityLabelSchema).max(10_000),
})
