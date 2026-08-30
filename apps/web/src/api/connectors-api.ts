import { apiFetch } from './auth-fetch'
import { z } from 'zod'

export const connectorLifecycleStateSchema = z.enum([
  'connected',
  'degraded',
  'available-to-configure',
  'authorization-required',
  'planned',
  'preview-authorization-required',
  'unavailable',
])

export const connectorCapabilityKindSchema = z.enum([
  'discovery',
  'identity',
  'entitlement',
  'runtime-telemetry',
  'business-outcomes',
  'security-alerts',
  'data-governance',
  'lifecycle-admin',
  'write-remediation',
])

const catalogEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  lifecycleState: connectorLifecycleStateSchema,
  capabilities: z.array(connectorCapabilityKindSchema),
  sourceOfTruth: z.boolean(),
  ownershipModel: z.enum(['consumes', 'owns']),
  prerequisiteNote: z.string().optional(),
  unlocksScorecard: z.array(z.string()).optional(),
  settingsPath: z.string().optional(),
})

const connectorSourceHealthSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(['discovery', 'enrichment']),
  enabled: z.boolean(),
  configured: z.boolean(),
  readiness: z.enum(['ready', 'degraded', 'unavailable', 'disabled', 'authorization-required']),
  checkedAt: z.iso.datetime().optional(),
  reason: z.string().optional(),
})

const connectorsCollectionSchema = z.object({
  active: z.object({
    id: z.string().min(1),
    mode: z.enum(['mock', 'foundry']),
    source: z.enum(['mock', 'foundry']),
    lifecycleState: connectorLifecycleStateSchema,
    writeEnabled: z.boolean().optional().default(false),
    projectEndpoint: z.url().optional(),
  }),
  catalog: z.array(catalogEntrySchema),
  health: z
    .object({
      overall: z.enum(['ready', 'degraded', 'unavailable']),
      partial: z.boolean(),
      sources: z.array(connectorSourceHealthSchema),
    })
    .optional(),
})

export type ConnectorLifecycleState = z.infer<typeof connectorLifecycleStateSchema>
export type ConnectorCapabilityKind = z.infer<typeof connectorCapabilityKindSchema>
export type CatalogEntry = z.infer<typeof catalogEntrySchema>
export type ConnectorsCollection = z.infer<typeof connectorsCollectionSchema>

function responseMessage(value: unknown): string | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string'
  ) {
    return value.message
  }
  return undefined
}

export const connectorsApi = {
  async listConnectors(): Promise<ConnectorsCollection> {
    const response = await apiFetch('/api/connectors')
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new Error(responseMessage(body) ?? `Request failed with status ${response.status}.`)
    }
    return connectorsCollectionSchema.parse(body)
  },
}
