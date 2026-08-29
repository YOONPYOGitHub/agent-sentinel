import { z } from 'zod'

export const AZURE_RESOURCE_GRAPH_ORIGIN = 'https://management.azure.com'
export const AZURE_RESOURCE_GRAPH_API_VERSION = '2022-10-01'
export const AZURE_RESOURCE_GRAPH_PATH = '/providers/Microsoft.ResourceGraph/resources'

const azureGuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

export const AZURE_RESOURCE_TYPES = [
  'microsoft.app/containerapps',
  'microsoft.app/managedenvironments',
  'microsoft.cognitiveservices/accounts',
  'microsoft.cognitiveservices/accounts/deployments',
  'microsoft.cognitiveservices/accounts/projects',
  'microsoft.containerregistry/registries',
  'microsoft.documentdb/databaseaccounts',
  'microsoft.insights/components',
  'microsoft.keyvault/vaults',
  'microsoft.machinelearningservices/workspaces',
  'microsoft.managedidentity/userassignedidentities',
  'microsoft.operationalinsights/workspaces',
  'microsoft.search/searchservices',
  'microsoft.servicebus/namespaces',
] as const

const azureResourceTypeSchema = z.enum(AZURE_RESOURCE_TYPES)
const optionalText = z
  .string()
  .trim()
  .max(512)
  .nullable()
  .optional()
  .transform((value) => (value === null || value === '' ? undefined : value))

export const azureResourceGraphResourceSchema = z
  .object({
    id: z
      .string()
      .trim()
      .max(2_048)
      .regex(/^\/subscriptions\/[0-9a-f-]+\/resourceGroups\/[^/]+\/providers\/[^/]+\/.+$/i),
    name: z.string().trim().min(1).max(512),
    type: z.string().trim().toLowerCase().pipe(azureResourceTypeSchema),
    location: optionalText,
    subscriptionId: azureGuidSchema,
    resourceGroup: z.string().trim().min(1).max(256),
    resourceKind: optionalText,
    skuName: optionalText,
    identityType: optionalText,
  })
  .superRefine((resource, context) => {
    const match =
      /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/([^/]+)\/(.+)$/i.exec(
        resource.id,
      )
    if (match === null) return
    const [, idSubscription, idResourceGroup, providerNamespace, providerPath] = match
    if (idSubscription?.toLowerCase() !== resource.subscriptionId.toLowerCase()) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'ARM resource ID subscription does not match subscriptionId.',
      })
    }
    if (idResourceGroup?.toLowerCase() !== resource.resourceGroup.toLowerCase()) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'ARM resource ID resource group does not match resourceGroup.',
      })
    }
    const pathSegments = providerPath?.split('/') ?? []
    if (pathSegments.length < 2 || pathSegments.length % 2 !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'ARM resource ID provider path must contain type/name pairs.',
      })
      return
    }
    const idType = [
      providerNamespace?.toLowerCase(),
      ...pathSegments
        .filter((_segment, index) => index % 2 === 0)
        .map((item) => item.toLowerCase()),
    ].join('/')
    if (idType !== resource.type) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'ARM resource ID provider path does not match resource type.',
      })
    }
  })
  .transform((resource) => resource)
export type AzureResourceGraphResource = z.infer<typeof azureResourceGraphResourceSchema>

export const azureResourceGraphResponseSchema = z.object({
  totalRecords: z.number().int().min(0).max(10_000_000),
  count: z.number().int().min(0).max(10_000),
  resultTruncated: z.union([z.literal('true'), z.literal('false'), z.boolean()]),
  $skipToken: z.string().min(1).max(16_384).optional(),
  data: z.array(azureResourceGraphResourceSchema).max(10_000),
})
export type AzureResourceGraphResponse = z.infer<typeof azureResourceGraphResponseSchema>

export const azureResourceGraphLimitsSchema = z
  .strictObject({
    pageSize: z.number().int().min(1).max(1_000).default(200),
    maxPages: z.number().int().min(1).max(100).default(20),
    maxItems: z.number().int().min(1).max(50_000).default(5_000),
    requestTimeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    maxRetries: z.number().int().min(0).max(5).default(2),
    maxRetryAfterMs: z.number().int().min(0).max(60_000).default(30_000),
    maxResponseBytes: z.number().int().min(1_024).max(10_000_000).default(2_000_000),
  })
  .default({
    pageSize: 200,
    maxPages: 20,
    maxItems: 5_000,
    requestTimeoutMs: 15_000,
    maxRetries: 2,
    maxRetryAfterMs: 30_000,
    maxResponseBytes: 2_000_000,
  })
export type AzureResourceGraphLimits = z.infer<typeof azureResourceGraphLimitsSchema>

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

export const azureResourceGraphSourceConfigSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().trim().min(1).max(100),
  tenantId: azureGuidSchema,
  environment: z.string().trim().min(1).max(128),
  subscriptions: z.array(azureGuidSchema).min(1).max(100),
  credential: sourceCredentialSchema.optional(),
})
export type AzureResourceGraphSourceConfig = z.infer<typeof azureResourceGraphSourceConfigSchema>

export const azureResourceGraphSourcesConfigSchema = z
  .array(azureResourceGraphSourceConfigSchema)
  .min(1)
  .max(50)
  .superRefine((sources, context) => {
    const ids = new Set<string>()
    const subscriptions = new Set<string>()
    for (const [index, source] of sources.entries()) {
      if (ids.has(source.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `Duplicate Azure Resource Graph source id: ${source.id}`,
        })
      }
      ids.add(source.id)
      for (const [subscriptionIndex, subscription] of source.subscriptions.entries()) {
        const normalized = subscription.toLowerCase()
        if (subscriptions.has(normalized)) {
          context.addIssue({
            code: 'custom',
            path: [index, 'subscriptions', subscriptionIndex],
            message: 'Duplicate Azure Resource Graph subscription boundary.',
          })
        }
        subscriptions.add(normalized)
      }
    }
  })

export const azureResourceGraphConfigSchema = z.strictObject({
  limits: azureResourceGraphLimitsSchema,
  sources: azureResourceGraphSourcesConfigSchema,
})
export type AzureResourceGraphConfig = z.infer<typeof azureResourceGraphConfigSchema>

const typeList = AZURE_RESOURCE_TYPES.map((type) => `'${type}'`).join(', ')
export const AZURE_RESOURCE_GRAPH_QUERY = [
  'Resources',
  `| where type in~ (${typeList})`,
  '| project id = tostring(id), name = tostring(name), type = tolower(tostring(type)),',
  '          location = tostring(location), subscriptionId = tostring(subscriptionId),',
  '          resourceGroup = tostring(resourceGroup), resourceKind = tostring(kind),',
  '          skuName = tostring(sku.name), identityType = tostring(identity.type)',
  '| order by id asc',
].join('\n')
