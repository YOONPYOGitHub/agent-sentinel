import { createHash } from 'node:crypto'
import type { Container, CosmosClient, OperationInput, SqlParameter } from '@azure/cosmos'

import type {
  ConnectorSourceActor,
  ConnectorSourceAuditTransition,
  ConnectorSourceDefinition,
  ConnectorSourceListFilters,
  ConnectorSourceRepository,
  EstateContext,
} from '@agent-sentinel/domain'
import {
  connectorSourceAuditTransitionSchema,
  connectorSourceDefinitionSchema,
} from '@agent-sentinel/domain'

const SOURCE_DOCUMENT_TYPE = 'connector-source'
const AUDIT_DOCUMENT_TYPE = 'connector-source-audit'
const IDEMPOTENCY_DOCUMENT_TYPE = 'connector-source-idempotency'

interface ConnectorSourceDocument {
  id: string
  tenantId: string
  estateId: string
  environment: string
  documentType: typeof SOURCE_DOCUMENT_TYPE
  source: ConnectorSourceDefinition
  _etag?: string
}

interface ConnectorSourceAuditDocument {
  id: string
  tenantId: string
  estateId: string
  documentType: typeof AUDIT_DOCUMENT_TYPE
  sourceId: string
  audit: ConnectorSourceAuditTransition
}

interface ConnectorSourceIdempotencyDocument {
  id: string
  tenantId: string
  estateId: string
  documentType: typeof IDEMPOTENCY_DOCUMENT_TYPE
  scope: 'create' | 'update' | 'delete'
  sourceId: string
}

function sourceDocumentId(estate: EstateContext, sourceId: string): string {
  return `source:${estate.id}:${sourceId}`
}

function auditDocumentId(estate: EstateContext, sourceId: string, transitionId: string): string {
  return `audit:${estate.id}:${sourceId}:${transitionId}`
}

function idempotencyDocumentId(estate: EstateContext, scope: string, sourceId: string, key: string): string {
  const digest = createHash('sha256')
    .update(`${estate.id}\0${scope}\0${sourceId}\0${key}`,'utf8')
    .digest('hex')
  return `idempotency:${digest}`
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null
  if (value === null) return null
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item))
  if (typeof value === 'object') {
    const next: Record<string, JsonValue> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      if (nestedValue !== undefined) next[key] = toJsonValue(nestedValue)
    }
    return next
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return String(value)
}

function errorStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if ('code' in error && typeof error.code === 'number') return error.code
  if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode
  return undefined
}

function isSuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300
}

export interface CosmosConnectorSourceRepositoryOptions {
  tenantId: string
  databaseId?: string
  containerId?: string
}

export class CosmosConnectorSourceRepository implements ConnectorSourceRepository {
  private readonly tenantId: string
  private readonly container: Container

  constructor(client: CosmosClient, options: CosmosConnectorSourceRepositoryOptions) {
    const tenantId = options.tenantId.trim()
    if (tenantId.length === 0) {
      throw new Error('A tenantId is required for connector source persistence.')
    }
    this.tenantId = tenantId
    this.container = client
      .database(options.databaseId ?? 'agent-sentinel-db')
      .container(options.containerId ?? 'connector-sources')
  }

  async create(
    estate: EstateContext,
    sourceInput: ConnectorSourceDefinition,
    idempotencyKey: string,
  ): Promise<{ source: ConnectorSourceDefinition; created: boolean; reason?: 'idempotency_conflict' | 'source_conflict' }> {
    const source = connectorSourceDefinitionSchema.parse({
      ...sourceInput,
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
    })
    const markerId = idempotencyDocumentId(estate, 'create', source.id, idempotencyKey)
    const existingMarker = await this.readIdempotency(estate, markerId)
    if (existingMarker) {
      const record = await this.readSourceDocument(estate, existingMarker.sourceId)
      if (record) return { source: record.source, created: false, reason: 'idempotency_conflict' }
    }

    const existing = await this.readSourceDocument(estate, source.id)
    if (existing) {
      return { source: existing.source, created: false, reason: 'source_conflict' }
    }

    const now = new Date().toISOString()
    const transition: ConnectorSourceAuditTransition = connectorSourceAuditTransitionSchema.parse({
      id: `audit-create-${source.id}-${source.version}`,
      sourceId: source.id,
      action: 'create',
      fromStatus: null,
      toStatus: source.status,
      actor: source.actor,
      timestamp: source.createdAt ?? now,
      version: source.version,
      idempotencyKey,
      summary: `Created connector source ${source.displayName}.`,
    })
    const next = connectorSourceDefinitionSchema.parse({
      ...source,
      auditHistory: [...source.auditHistory, transition],
    })

    const sourceBody = toJsonValue(next) as JsonValue
    const auditBody = toJsonValue(transition) as JsonValue
    const operations: OperationInput[] = [
      {
        operationType: 'Create',
        resourceBody: {
          id: sourceDocumentId(estate, source.id),
          tenantId: this.tenantId,
          estateId: estate.id,
          environment: estate.environment,
          documentType: SOURCE_DOCUMENT_TYPE,
          source: sourceBody,
        },
      },
      {
        operationType: 'Create',
        resourceBody: {
          id: auditDocumentId(estate, source.id, transition.id),
          tenantId: this.tenantId,
          estateId: estate.id,
          documentType: AUDIT_DOCUMENT_TYPE,
          sourceId: source.id,
          audit: auditBody,
        },
      },
      {
        operationType: 'Create',
        resourceBody: {
          id: markerId,
          tenantId: this.tenantId,
          estateId: estate.id,
          documentType: IDEMPOTENCY_DOCUMENT_TYPE,
          scope: 'create',
          sourceId: source.id,
        },
      },
    ]

    const statusCode = await this.executeBatch(estate, operations)
    if (isSuccess(statusCode)) return { source: next, created: true }
    if (statusCode === 409) {
      const marker = await this.readIdempotency(estate, markerId)
      if (marker) {
        const record = await this.readSourceDocument(estate, marker.sourceId)
        if (record) return { source: record.source, created: false, reason: 'idempotency_conflict' }
      }
      return { source: next, created: false, reason: 'source_conflict' }
    }
    throw new Error(`Cosmos connector source create batch failed with status ${statusCode}.`)
  }

  async update(
    estate: EstateContext,
    sourceId: string,
    expectedEtag: string,
    updatedInput: ConnectorSourceDefinition,
    idempotencyKey: string,
  ): Promise<
    | {
        applied: true
        source: ConnectorSourceDefinition
        audit: ConnectorSourceAuditTransition[]
      }
    | {
        applied: false
        reason: 'not_found' | 'idempotency_conflict' | 'etag_conflict' | 'immutable_origin'
      }
  > {
    const existing = await this.readSourceDocument(estate, sourceId)
    if (!existing) {
      return { applied: false, reason: 'not_found' }
    }
    if (existing.source.etag !== expectedEtag) {
      return { applied: false, reason: 'etag_conflict' }
    }
    const updated = connectorSourceDefinitionSchema.parse({
      ...updatedInput,
      id: sourceId,
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      auditHistory: existing.source.auditHistory,
    })
    if (existing.source.origin === 'deployment' && updated.actor.type !== 'deployment') {
      return { applied: false, reason: 'immutable_origin' }
    }

    const markerId = idempotencyDocumentId(estate, 'update', sourceId, idempotencyKey)
    if (await this.readIdempotency(estate, markerId)) {
      return { applied: false, reason: 'idempotency_conflict' }
    }

    const transition: ConnectorSourceAuditTransition = connectorSourceAuditTransitionSchema.parse({
      id: `audit-update-${sourceId}-${updated.version}`,
      sourceId,
      action: updated.enabled ? 'enable' : 'disable',
      fromStatus: existing.source.status,
      toStatus: updated.status,
      actor: updated.actor,
      timestamp: updated.updatedAt,
      version: updated.version,
      idempotencyKey,
      summary: `Updated connector source ${updated.displayName}.`,
    })
    const next = connectorSourceDefinitionSchema.parse({
      ...updated,
      etag: `etag-${updated.version}`,
      auditHistory: [...existing.source.auditHistory, transition],
    })

    const sourceBody = JSON.parse(JSON.stringify(next)) as Record<string, unknown>
    const auditBody = JSON.parse(JSON.stringify(transition)) as Record<string, unknown>
    const operations: OperationInput[] = [
      {
        operationType: 'Replace',
        id: sourceDocumentId(estate, sourceId),
        ifMatch: existing._etag,
        resourceBody: {
          id: sourceDocumentId(estate, sourceId),
          tenantId: this.tenantId,
          estateId: estate.id,
          environment: estate.environment,
          documentType: SOURCE_DOCUMENT_TYPE,
          source: sourceBody,
        },
      },
      {
        operationType: 'Create',
        resourceBody: {
          id: auditDocumentId(estate, sourceId, transition.id),
          tenantId: this.tenantId,
          estateId: estate.id,
          documentType: AUDIT_DOCUMENT_TYPE,
          sourceId,
          audit: auditBody,
        },
      },
      {
        operationType: 'Create',
        resourceBody: {
          id: markerId,
          tenantId: this.tenantId,
          estateId: estate.id,
          documentType: IDEMPOTENCY_DOCUMENT_TYPE,
          scope: 'update',
          sourceId,
        },
      },
    ]

    const statusCode = await this.executeBatch(estate, operations)
    if (statusCode === 404) return { applied: false, reason: 'not_found' }
    if (statusCode === 409) return { applied: false, reason: 'idempotency_conflict' }
    if (statusCode === 412) return { applied: false, reason: 'etag_conflict' }
    if (!isSuccess(statusCode))
      throw new Error(`Cosmos connector source update batch failed with status ${statusCode}.`)

    const refreshed = await this.readSourceDocument(estate, sourceId)
    if (!refreshed) throw new Error(`Connector source disappeared after update: ${sourceId}`)
    return { applied: true, source: refreshed.source, audit: refreshed.source.auditHistory }
  }

  async findById(estate: EstateContext, sourceId: string): Promise<ConnectorSourceDefinition | null> {
    const document = await this.readSourceDocument(estate, sourceId)
    return document ? document.source : null
  }

  async list(
    estate: EstateContext,
    filters: ConnectorSourceListFilters = {},
  ): Promise<{ items: ConnectorSourceDefinition[]; total: number }> {
    const parameters: SqlParameter[] = [
      { name: '@documentType', value: SOURCE_DOCUMENT_TYPE },
      { name: '@estateId', value: estate.id },
    ]
    const clauses = ['c.documentType = @documentType', 'c.estateId = @estateId']
    if (filters.enabled !== undefined) {
      clauses.push('c["source"]["enabled"] = @enabled')
      parameters.push({ name: '@enabled', value: filters.enabled })
    }
    if (filters.connectorType !== undefined) {
      clauses.push('c["source"]["connectorType"] = @connectorType')
      parameters.push({ name: '@connectorType', value: filters.connectorType })
    }
    if (filters.origin !== undefined) {
      clauses.push('c["source"]["origin"] = @origin')
      parameters.push({ name: '@origin', value: filters.origin })
    }
    const normalizedSearch = filters.search?.trim().toLocaleLowerCase()
    if (normalizedSearch) {
      clauses.push('CONTAINS(LOWER(c["source"]["id"] + " " + c["source"]["displayName"] + " " + c["source"]["connectorType"]), @search)')
      parameters.push({ name: '@search', value: normalizedSearch })
    }
    const page = Math.max(1, filters.page ?? 1)
    const pageSize = Math.min(Math.max(1, filters.pageSize ?? 50), 200)
    const offset = (page - 1) * pageSize
    const [itemsResponse, totalResponse] = await Promise.all([
      this.container.items
        .query<ConnectorSourceDocument>(
          {
            query: `SELECT * FROM c WHERE ${clauses.join(' AND ')} ORDER BY c["source"]["updatedAt"] DESC, c["source"]["id"] ASC OFFSET @offset LIMIT @pageSize`,
            parameters: [...parameters, { name: '@offset', value: offset }, { name: '@pageSize', value: pageSize }],
          },
          { partitionKey: this.tenantId },
        )
        .fetchAll(),
      this.container.items
        .query<number>(
          {
            query: `SELECT VALUE COUNT(1) FROM c WHERE ${clauses.join(' AND ')}`,
            parameters,
          },
          { partitionKey: this.tenantId },
        )
        .fetchAll(),
    ])

    return {
      items: itemsResponse.resources.map((document) => connectorSourceDefinitionSchema.parse(document.source)),
      total: totalResponse.resources[0] ?? 0,
    }
  }

  async delete(
    estate: EstateContext,
    sourceId: string,
    expectedEtag: string,
    actor: ConnectorSourceActor,
  ): Promise<{ deleted: boolean; reason?: 'not_found' | 'etag_conflict' | 'immutable_origin' }> {
    const existing = await this.readSourceDocument(estate, sourceId)
    if (!existing) {
      return { deleted: false, reason: 'not_found' }
    }
    if (existing.source.etag !== expectedEtag) {
      return { deleted: false, reason: 'etag_conflict' }
    }
    if (existing.source.origin === 'deployment' && actor.type !== 'deployment') {
      return { deleted: false, reason: 'immutable_origin' }
    }

    const markerId = idempotencyDocumentId(estate, 'delete', sourceId, `${actor.id}:${Date.now()}`)
    const transition: ConnectorSourceAuditTransition = connectorSourceAuditTransitionSchema.parse({
      id: `audit-delete-${sourceId}-${existing.source.version}`,
      sourceId,
      action: 'delete',
      fromStatus: existing.source.status,
      toStatus: 'draft',
      actor,
      timestamp: new Date().toISOString(),
      version: existing.source.version + 1,
      idempotencyKey: markerId,
      summary: `Deleted connector source ${existing.source.displayName}.`,
    })

    try {
      await this.container.item(sourceDocumentId(estate, sourceId), this.tenantId).delete({
        ifMatch: existing._etag,
      })
      const auditDoc: ConnectorSourceAuditDocument = {
        id: auditDocumentId(estate, sourceId, transition.id),
        tenantId: this.tenantId,
        estateId: estate.id,
        documentType: AUDIT_DOCUMENT_TYPE,
        sourceId,
        audit: transition,
      }
      await this.container.items.create(auditDoc)
      await this.container.items.create({
        id: markerId,
        tenantId: this.tenantId,
        estateId: estate.id,
        documentType: IDEMPOTENCY_DOCUMENT_TYPE,
        scope: 'delete',
        sourceId,
      })
      return { deleted: true }
    } catch (error: unknown) {
      const code = errorStatusCode(error)
      if (code === 404) return { deleted: false, reason: 'not_found' }
      if (code === 412) return { deleted: false, reason: 'etag_conflict' }
      throw error
    }
  }

  async getAuditHistory(
    estate: EstateContext,
    sourceId: string,
  ): Promise<ConnectorSourceAuditTransition[]> {
    const query = {
      query:
        'SELECT * FROM c WHERE c.documentType = @documentType AND c.estateId = @estateId AND c.sourceId = @sourceId ORDER BY c.audit.version ASC, c.audit.timestamp ASC',
      parameters: [
        { name: '@documentType', value: AUDIT_DOCUMENT_TYPE },
        { name: '@estateId', value: estate.id },
        { name: '@sourceId', value: sourceId },
      ],
    }
    const { resources } = await this.container.items
      .query<ConnectorSourceAuditDocument>(query, { partitionKey: this.tenantId })
      .fetchAll()
    return resources.map((resource) => connectorSourceAuditTransitionSchema.parse(resource.audit))
  }

  private async executeBatch(
    _estate: EstateContext,
    operations: OperationInput[],
  ): Promise<number> {
    try {
      const response = await this.container.items.batch(operations, this.tenantId)
      if (response.code !== undefined) return response.code
      const failedOperation = response.result?.find((operation) => !isSuccess(operation.statusCode))
      return failedOperation?.statusCode ?? 200
    } catch (error: unknown) {
      const code = errorStatusCode(error)
      if (code === 404 || code === 409 || code === 412) return code
      throw error
    }
  }

  private async readSourceDocument(
    estate: EstateContext,
    sourceId: string,
  ): Promise<{ source: ConnectorSourceDefinition; _etag?: string } | null> {
    try {
      const { resource } = await this.container
        .item(sourceDocumentId(estate, sourceId), this.tenantId)
        .read<ConnectorSourceDocument>()
      if (!resource) return null
      if (
        resource.documentType !== SOURCE_DOCUMENT_TYPE ||
        resource.tenantId !== this.tenantId ||
        resource.estateId !== estate.id ||
        resource.source.id !== sourceId
      ) {
        throw new Error(`Invalid Cosmos connector source document: ${sourceId}`)
      }
      return { source: connectorSourceDefinitionSchema.parse(resource.source), _etag: resource._etag }
    } catch (error: unknown) {
      if (errorStatusCode(error) === 404) return null
      throw error
    }
  }

  private async readIdempotency(
    estate: EstateContext,
    id: string,
  ): Promise<ConnectorSourceIdempotencyDocument | null> {
    try {
      const { resource } = await this.container.item(id, this.tenantId).read<ConnectorSourceIdempotencyDocument>()
      if (!resource) return null
      if (
        resource.documentType !== IDEMPOTENCY_DOCUMENT_TYPE ||
        resource.tenantId !== this.tenantId ||
        resource.estateId !== estate.id
      ) {
        throw new Error(`Invalid Cosmos connector source idempotency document: ${id}`)
      }
      return resource
    } catch (error: unknown) {
      if (errorStatusCode(error) === 404) return null
      throw error
    }
  }
}
