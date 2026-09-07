import { z } from 'zod'

const graphIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const boundedText = z.string().max(512)
const nullableName = z.string().min(1).max(256).nullable().optional()

export const servicePrincipalSchema = z.strictObject({
  '@odata.type': z.string().min(1).max(128).optional(),
  id: graphIdSchema,
  appId: graphIdSchema,
  displayName: z.string().min(1).max(256),
  description: boundedText.nullable().optional(),
  servicePrincipalType: z.string().min(1).max(64).nullable().optional(),
  accountEnabled: z.boolean().nullable().optional(),
  appOwnerOrganizationId: graphIdSchema.nullable().optional(),
  tags: z.array(z.string().max(256)).max(100).optional(),
})
export type EntraServicePrincipal = z.infer<typeof servicePrincipalSchema>

export const directoryOwnerSchema = z.strictObject({
  '@odata.type': z.string().min(1).max(128).optional(),
  id: graphIdSchema,
  displayName: nullableName,
  userPrincipalName: z.string().min(1).max(320).nullable().optional(),
})
export type EntraDirectoryOwner = z.infer<typeof directoryOwnerSchema>

export const appRoleAssignmentSchema = z.strictObject({
  id: graphIdSchema,
  appRoleId: graphIdSchema,
  principalId: graphIdSchema,
  resourceId: graphIdSchema,
  principalDisplayName: nullableName,
  principalType: z.string().min(1).max(64).nullable().optional(),
  resourceDisplayName: nullableName,
  createdDateTime: z.iso.datetime({ offset: true }).nullable().optional(),
})
export type EntraAppRoleAssignment = z.infer<typeof appRoleAssignmentSchema>

export const agentIdentityPreviewSchema = z.strictObject({
  '@odata.type': z.literal('#microsoft.graph.agentIdentity').optional(),
  id: graphIdSchema,
  appId: graphIdSchema,
  displayName: z.string().min(1).max(256),
  accountEnabled: z.boolean().nullable().optional(),
  agentIdentityBlueprintId: graphIdSchema.nullable().optional(),
  createdByAppId: graphIdSchema.nullable().optional(),
  createdDateTime: z.iso.datetime({ offset: true }).nullable().optional(),
  managerApplications: z.array(graphIdSchema).max(100).optional(),
  servicePrincipalType: z.literal('ServiceIdentity').nullable().optional(),
  tags: z.array(z.string().max(256)).max(100).optional(),
})
export type AgentIdentityPreview = z.infer<typeof agentIdentityPreviewSchema>

function pageSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({
    '@odata.context': z.string().max(2048).optional(),
    '@odata.nextLink': z.string().max(4096).optional(),
    value: z.array(item),
  })
}

export const servicePrincipalPageSchema = pageSchema(servicePrincipalSchema)
export const directoryOwnerPageSchema = pageSchema(directoryOwnerSchema)
export const appRoleAssignmentPageSchema = pageSchema(appRoleAssignmentSchema)
export const agentIdentityPreviewPageSchema = pageSchema(agentIdentityPreviewSchema)

const graphBaseUrlSchema = z.string().transform((value, context) => {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    context.addIssue({ code: 'custom', message: 'Microsoft Graph base URL is invalid.' })
    return z.NEVER
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'graph.microsoft.com' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    context.addIssue({ code: 'custom', message: 'Microsoft Graph base URL is not allowed.' })
    return z.NEVER
  }
  return 'https://graph.microsoft.com'
})

export const entraIdentityConnectorConfigSchema = z.strictObject({
  tenantId: graphIdSchema,
  environment: z.string().min(1).max(128),
  graphBaseUrl: graphBaseUrlSchema.default('https://graph.microsoft.com'),
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
  limits: z
    .strictObject({
      maxPages: z.number().int().min(1).max(100).default(20),
      maxItems: z.number().int().min(1).max(5000).default(1000),
      requestTimeoutMs: z.number().int().min(100).max(120_000).default(15_000),
      maxRetries: z.number().int().min(0).max(5).default(2),
      maxRetryAfterMs: z.number().int().min(0).max(60_000).default(30_000),
      maxResponseBytes: z.number().int().min(1_024).max(10_000_000).default(2_000_000),
    })
    .default({
      maxPages: 20,
      maxItems: 1000,
      requestTimeoutMs: 15_000,
      maxRetries: 2,
      maxRetryAfterMs: 30_000,
      maxResponseBytes: 2_000_000,
    }),
})
export type EntraIdentityConnectorConfig = z.infer<typeof entraIdentityConnectorConfigSchema>
