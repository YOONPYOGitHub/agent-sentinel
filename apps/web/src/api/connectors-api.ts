import { apiFetch } from './auth-fetch'
import { z } from 'zod'
import {
  parseConnectorsCollectionResponse,
  type CatalogConnectorEntry,
  type ConnectorCapabilityKind as SdkConnectorCapabilityKind,
  type ConnectorLifecycleState as SdkConnectorLifecycleState,
  type ConnectorsCollectionResponse,
} from '@agent-sentinel/connector-sdk/demo-readiness'
import {
  connectorCredentialMetadataSchema,
  connectorSourceConfigurationSchema,
  connectorSourceDefinitionSchema,
  connectorSourceIdSchema,
  connectorSourceReadModelSchema,
  connectorTypeSchema,
  type ConnectorCredentialMetadata,
  type ConnectorSourceConfiguration,
  type ConnectorSourceDefinition,
  type ConnectorSourceReadModel,
} from '@agent-sentinel/domain'

export type ConnectorLifecycleState = SdkConnectorLifecycleState
export type ConnectorCapabilityKind = SdkConnectorCapabilityKind
export type CatalogEntry = CatalogConnectorEntry
export type ConnectorsCollection = ConnectorsCollectionResponse

const connectorSourceMutationPolicySchema = z.strictObject({
  enabled: z.boolean(),
  requiresAuthentication: z.literal(true),
  requiredCapability: z.literal('configure'),
})

const connectorSourcePageSchema = z.strictObject({
  items: z.array(connectorSourceReadModelSchema),
  page: z.strictObject({
    limit: z.number().int().min(1).max(100),
    nextCursor: connectorSourceIdSchema.nullable(),
  }),
  mutationPolicy: connectorSourceMutationPolicySchema,
})

const connectorSourceMutationResponseSchema = z
  .object({
    replayed: z.boolean(),
    source: connectorSourceDefinitionSchema.nullable(),
  })
  .passthrough()

const connectorSourceConnectionStatusSchema = z.strictObject({
  estateId: z.string().min(1),
  tenantId: z.string().min(1),
  environment: z.string().min(1),
  sourceId: connectorSourceIdSchema,
  connectorType: connectorTypeSchema,
  readOnly: z.literal(true),
  status: z.enum([
    'passed',
    'failed',
    'degraded',
    'authorization-required',
    'insufficient-data',
    'unknown',
  ]),
  evidenceAvailability: z.enum(['available', 'unavailable']),
  evidenceBasis: z.enum(['provider-response', 'synthetic']).nullable(),
  evidenceIds: z.array(z.string()),
  checkedAt: z.iso.datetime().nullable(),
  checkedBy: z
    .strictObject({
      type: z.enum(['user', 'service-principal', 'deployment']),
      id: z.string(),
    })
    .nullable(),
  summary: z.string(),
})

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const etagSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('"'))

export type ConnectorSourcePage = z.infer<typeof connectorSourcePageSchema>
export type ConnectorSourceConnectionStatus = z.infer<typeof connectorSourceConnectionStatusSchema>
export type ConnectorSourceCreateRequest = {
  sourceId: string
  connectorType: z.infer<typeof connectorTypeSchema>
  displayName: string
  enabled: boolean
  configuration: ConnectorSourceConfiguration
  credential: ConnectorCredentialMetadata
}
export type ConnectorSourceUpdateRequest = Partial<
  Pick<ConnectorSourceDefinition, 'displayName' | 'enabled' | 'configuration' | 'credential'>
>

export class ConnectorSourceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ConnectorSourceApiError'
  }
}

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

function responseCode(value: unknown): string | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'string'
  ) {
    return value.error
  }
  return undefined
}

async function connectorSourceRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await apiFetch(path, init ?? { headers: new Headers() })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new ConnectorSourceApiError(
      responseMessage(body) ?? `Request failed with status ${response.status}.`,
      response.status,
      responseCode(body),
    )
  }
  return schema.parse(body)
}

export const connectorsApi = {
  async listConnectors(): Promise<ConnectorsCollection> {
    const response = await apiFetch('/api/connectors')
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new Error(responseMessage(body) ?? `Request failed with status ${response.status}.`)
    }
    return parseConnectorsCollectionResponse(body)
  },
}

export const connectorSourcesApi = {
  list(cursor?: string): Promise<ConnectorSourcePage> {
    const query = new URLSearchParams({ limit: '50' })
    if (cursor !== undefined) query.set('cursor', connectorSourceIdSchema.parse(cursor))
    return connectorSourceRequest(
      `/api/connector-sources?${query.toString()}`,
      connectorSourcePageSchema,
    )
  },

  get(sourceId: string): Promise<ConnectorSourceReadModel> {
    return connectorSourceRequest(
      `/api/connector-sources/${encodeURIComponent(connectorSourceIdSchema.parse(sourceId))}`,
      connectorSourceReadModelSchema,
    )
  },

  create(
    input: ConnectorSourceCreateRequest,
    idempotencyKey: string,
  ): Promise<z.infer<typeof connectorSourceMutationResponseSchema>> {
    const body = z
      .strictObject({
        sourceId: connectorSourceIdSchema,
        connectorType: connectorTypeSchema,
        displayName: z.string().trim().min(1).max(100),
        enabled: z.boolean(),
        configuration: connectorSourceConfigurationSchema,
        credential: connectorCredentialMetadataSchema,
      })
      .parse(input)
    return connectorSourceRequest('/api/connector-sources', connectorSourceMutationResponseSchema, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKeySchema.parse(idempotencyKey),
      },
      body: JSON.stringify(body),
    })
  },

  update(
    sourceId: string,
    patch: ConnectorSourceUpdateRequest,
    etag: string,
    idempotencyKey: string,
  ): Promise<z.infer<typeof connectorSourceMutationResponseSchema>> {
    const body = z
      .strictObject({
        displayName: z.string().trim().min(1).max(100).optional(),
        enabled: z.boolean().optional(),
        configuration: connectorSourceConfigurationSchema.optional(),
        credential: connectorCredentialMetadataSchema.optional(),
      })
      .refine((value) => Object.values(value).some((item) => item !== undefined))
      .parse(patch)
    return connectorSourceRequest(
      `/api/connector-sources/${encodeURIComponent(connectorSourceIdSchema.parse(sourceId))}`,
      connectorSourceMutationResponseSchema,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKeySchema.parse(idempotencyKey),
          'If-Match': `"${etagSchema.parse(etag)}"`,
        },
        body: JSON.stringify(body),
      },
    )
  },

  delete(
    sourceId: string,
    etag: string,
    idempotencyKey: string,
  ): Promise<z.infer<typeof connectorSourceMutationResponseSchema>> {
    return connectorSourceRequest(
      `/api/connector-sources/${encodeURIComponent(connectorSourceIdSchema.parse(sourceId))}`,
      connectorSourceMutationResponseSchema,
      {
        method: 'DELETE',
        headers: {
          'Idempotency-Key': idempotencyKeySchema.parse(idempotencyKey),
          'If-Match': `"${etagSchema.parse(etag)}"`,
        },
      },
    )
  },

  getConnectionTestStatus(sourceId: string): Promise<ConnectorSourceConnectionStatus> {
    return connectorSourceRequest(
      `/api/connector-sources/${encodeURIComponent(
        connectorSourceIdSchema.parse(sourceId),
      )}/connection-test-status`,
      connectorSourceConnectionStatusSchema,
    )
  },
}
