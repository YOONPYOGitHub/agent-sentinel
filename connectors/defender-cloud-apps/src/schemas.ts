import { z } from 'zod'

export const DEFENDER_CLOUD_APPS_API_VERSION = 'v1'
export const DEFENDER_CLOUD_APPS_ALERTS_PATH = '/api/v1/alerts/'
export const DEFENDER_CLOUD_APPS_ACTIVITIES_PATH = '/api/v1/activities/'
export const DEFENDER_CLOUD_APPS_RESOURCE_APP_ID = '05a65629-4c1b-48c1-a78b-804c4abdd4af'

const azureGuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const providerIdSchema = z
  .union([
    z.string().trim().min(1).max(512),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform(String)
const boundedTypeSchema = z.string().trim().min(1).max(256)
const timestampSchema = z.number().int().nonnegative().max(8_640_000_000_000_000)

const tenantPortalHostPattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.portal\.cloudappsecurity\.com$/i

export function sanitizeDefenderCloudAppsApiBaseUrl(value: string): string {
  const candidate = value.trim()
  if (candidate === '') throw new Error('Defender for Cloud Apps tenant portal is required.')
  if (/^https:\/\/[^/?#]+:\d+(?:[/?#]|$)/i.test(candidate)) {
    throw new Error('Defender for Cloud Apps tenant portal is not allowed.')
  }
  const asUrl = candidate.includes('://') ? candidate : `https://${candidate}`
  let url: URL
  try {
    url = new URL(asUrl)
  } catch {
    throw new Error('Defender for Cloud Apps tenant portal is invalid.')
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== '' ||
    !tenantPortalHostPattern.test(url.hostname)
  ) {
    throw new Error('Defender for Cloud Apps tenant portal is not allowed.')
  }
  return `https://${url.hostname.toLowerCase()}`
}

export const defenderCloudAppsLimitsSchema = z
  .strictObject({
    lookbackHours: z.number().min(1).max(168).default(24),
    pageSize: z.number().int().min(1).max(100).default(100),
    maxPages: z.number().int().min(1).max(100).default(20),
    maxItems: z.number().int().min(1).max(20_000).default(4_000),
    requestTimeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    maxRetries: z.number().int().min(0).max(3).default(2),
    maxRetryAfterMs: z.number().int().min(0).max(120_000).default(30_000),
    maxResponseBytes: z.number().int().min(1_024).max(10_000_000).default(2_000_000),
  })
  .default({
    lookbackHours: 24,
    pageSize: 100,
    maxPages: 20,
    maxItems: 4_000,
    requestTimeoutMs: 15_000,
    maxRetries: 2,
    maxRetryAfterMs: 30_000,
    maxResponseBytes: 2_000_000,
  })
export type DefenderCloudAppsLimits = z.infer<typeof defenderCloudAppsLimitsSchema>

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

export const defenderCloudAppsSourceConfigSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    name: z.string().trim().min(1).max(100),
    tenantId: azureGuidSchema,
    environment: z.string().trim().min(1).max(128),
    apiBaseUrl: z.string().trim().min(1).max(512).optional(),
    portalHostname: z.string().trim().min(1).max(253).optional(),
    credential: sourceCredentialSchema.optional(),
  })
  .superRefine((source, context) => {
    if ((source.apiBaseUrl === undefined) === (source.portalHostname === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['apiBaseUrl'],
        message: 'Configure exactly one tenant apiBaseUrl or portalHostname.',
      })
    }
  })
  .transform(({ apiBaseUrl, portalHostname, ...source }) => ({
    ...source,
    apiBaseUrl: sanitizeDefenderCloudAppsApiBaseUrl(apiBaseUrl ?? portalHostname!),
  }))
export type DefenderCloudAppsSourceConfig = z.infer<typeof defenderCloudAppsSourceConfigSchema>

export const defenderCloudAppsSourcesConfigSchema = z
  .array(defenderCloudAppsSourceConfigSchema)
  .min(1)
  .max(50)
  .superRefine((sources, context) => {
    const ids = new Set<string>()
    const tenants = new Set<string>()
    const portals = new Set<string>()
    for (const [index, source] of sources.entries()) {
      if (ids.has(source.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `Duplicate Defender for Cloud Apps source id: ${source.id}`,
        })
      }
      ids.add(source.id)
      const tenant = source.tenantId.toLowerCase()
      if (tenants.has(tenant)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'tenantId'],
          message: 'Duplicate Defender for Cloud Apps tenant source boundary.',
        })
      }
      tenants.add(tenant)
      if (portals.has(source.apiBaseUrl)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'apiBaseUrl'],
          message: 'Duplicate Defender for Cloud Apps tenant portal boundary.',
        })
      }
      portals.add(source.apiBaseUrl)
    }
  })

export const defenderCloudAppsConfigSchema = z.strictObject({
  limits: defenderCloudAppsLimitsSchema,
  sources: defenderCloudAppsSourcesConfigSchema,
})
export type DefenderCloudAppsConfig = z.infer<typeof defenderCloudAppsConfigSchema>

const alertEntitySchema = z.object({
  type: z.string().trim().min(1).max(64),
  id: providerIdSchema.optional(),
  policyType: boundedTypeSchema.optional(),
})

const alertInputSchema = z.object({
  _id: providerIdSchema,
  timestamp: timestampSchema,
  severityValue: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  statusValue: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  resolutionStatusValue: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
    .optional(),
  stories: z
    .array(
      z.union([
        z.literal(0),
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(7),
        z.literal(8),
      ]),
    )
    .max(32)
    .optional(),
  intent: z.array(z.number().int().min(0).max(13)).max(32).optional(),
  entities: z.array(alertEntitySchema).max(200).optional(),
})

export const defenderCloudAppsAlertSchema = alertInputSchema.transform((alert) => {
  const policy = alert.entities?.find((entity) => entity.type.toLowerCase() === 'policyrule')
  const service = alert.entities?.find((entity) => entity.type.toLowerCase() === 'service')
  return {
    id: alert._id,
    timestamp: alert.timestamp,
    ...(alert.severityValue !== undefined ? { severityValue: alert.severityValue } : {}),
    ...(alert.statusValue !== undefined ? { statusValue: alert.statusValue } : {}),
    ...(alert.resolutionStatusValue !== undefined
      ? { resolutionStatusValue: alert.resolutionStatusValue }
      : {}),
    ...(alert.stories !== undefined ? { stories: alert.stories } : {}),
    ...(alert.intent !== undefined ? { intent: alert.intent } : {}),
    ...(policy?.id !== undefined ? { policyId: policy.id } : {}),
    ...(policy?.policyType !== undefined ? { policyType: policy.policyType } : {}),
    ...(service?.id !== undefined ? { serviceId: service.id } : {}),
  }
})
export type DefenderCloudAppsAlert = z.infer<typeof defenderCloudAppsAlertSchema>

const activityInputSchema = z
  .object({
    _id: providerIdSchema.optional(),
    timestamp: timestampSchema.optional(),
    date: timestampSchema.optional(),
    created: timestampSchema.optional(),
    actionType: boundedTypeSchema.optional(),
    service: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    policy: z.string().trim().min(1).max(512).optional(),
    activity: z
      .object({
        id: providerIdSchema.optional(),
        eventActionType: boundedTypeSchema.optional(),
        takenAction: boundedTypeSchema.optional(),
        type: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine((activity, context) => {
    if (activity._id === undefined && activity.activity?.id === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['_id'],
        message: 'Activity provider identifier is missing.',
      })
    }
    if (
      activity.timestamp === undefined &&
      activity.date === undefined &&
      activity.created === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['timestamp'],
        message: 'Activity timestamp is missing.',
      })
    }
  })

export const defenderCloudAppsActivitySchema = activityInputSchema.transform((activity) => ({
  id: activity._id ?? activity.activity!.id!,
  timestamp: activity.timestamp ?? activity.date ?? activity.created!,
  ...(activity.actionType !== undefined ? { actionType: activity.actionType } : {}),
  ...(activity.activity?.eventActionType !== undefined
    ? { eventActionType: activity.activity.eventActionType }
    : {}),
  ...(activity.activity?.takenAction !== undefined
    ? { takenAction: activity.activity.takenAction }
    : {}),
  ...(activity.activity?.type !== undefined ? { administrative: activity.activity.type } : {}),
  ...(activity.service !== undefined ? { serviceId: String(activity.service) } : {}),
  ...(activity.policy !== undefined ? { policyId: activity.policy } : {}),
}))
export type DefenderCloudAppsActivity = z.infer<typeof defenderCloudAppsActivitySchema>

function collectionSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema).max(100),
    hasNext: z.boolean(),
    total: z.number().int().nonnegative().max(1_000_000_000).optional(),
    max: z.number().int().nonnegative().max(1_000_000_000).optional(),
    moreThanTotal: z.boolean().optional(),
  })
}

export const defenderCloudAppsAlertCollectionSchema = collectionSchema(defenderCloudAppsAlertSchema)
export const defenderCloudAppsActivityCollectionSchema = collectionSchema(
  defenderCloudAppsActivitySchema,
)
