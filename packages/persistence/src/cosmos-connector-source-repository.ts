import { createHash } from 'node:crypto'
import type { Container, CosmosClient, OperationInput } from '@azure/cosmos'

import {
  connectorSourceAuditRecordSchema,
  connectorSourceCreateInputSchema,
  connectorSourceDefinitionSchema,
  connectorSourceMutationContextSchema,
  connectorSourceUpdateInputSchema,
  estateContextSchema,
  type ConnectorSourceAuditRecord,
  type ConnectorSourceCreateInput,
  type ConnectorSourceDefinition,
  type ConnectorSourceMutationContext,
  type ConnectorSourceRepository,
  type ConnectorSourceUpdateInput,
  type ConnectorSourceWriteResult,
  type EstateContext,
} from '@agent-sentinel/domain'

const SOURCE_TYPE = 'connector-source'
const AUDIT_TYPE = 'connector-source-audit'
const IDEMPOTENCY_TYPE = 'connector-source-idempotency'
const ESTATE_BOUNDARY_TYPE = 'connector-source-estate-boundary'

type BatchBody = Extract<OperationInput, { operationType: 'Create' }>['resourceBody']

interface SourceDocument {
  id: string
  estateId: string
  tenantId: string
  environment: string
  documentType: typeof SOURCE_TYPE
  source: ConnectorSourceDefinition
  deleted?: boolean
  _etag?: string
}

interface AuditDocument {
  id: string
  estateId: string
  tenantId: string
  environment: string
  documentType: typeof AUDIT_TYPE
  sourceId: string
  occurredAt: string
  audit: ConnectorSourceAuditRecord
}

interface IdempotencyDocument {
  id: string
  estateId: string
  tenantId: string
  environment: string
  documentType: typeof IDEMPOTENCY_TYPE
  fingerprint: string
  sourceId: string
  auditId: string
}

interface EstateBoundaryDocument {
  id: string
  estateId: string
  tenantId: string
  environment: string
  documentType: typeof ESTATE_BOUNDARY_TYPE
}

export interface CosmosConnectorSourceRepositoryOptions {
  databaseId?: string
  containerId?: string
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function physicalId(kind: string, estateId: string, logicalId: string): string {
  return `${kind}:${digest([estateId, logicalId])}`
}

function sourceId(estateId: string, logicalId: string): string {
  return physicalId('source', estateId, logicalId)
}

function auditId(estateId: string, logicalId: string): string {
  return physicalId('audit', estateId, logicalId)
}

function idempotencyId(estateId: string, logicalId: string): string {
  return physicalId('idempotency', estateId, logicalId)
}

function estateBoundaryId(estateId: string): string {
  return physicalId('estate-boundary', estateId, 'immutable-boundary')
}

function applicationEtag(
  estateId: string,
  logicalSourceId: string,
  version: number,
  logicalAuditId: string,
): string {
  return `source-${version}-${digest([estateId, logicalSourceId, version, logicalAuditId]).slice(0, 24)}`
}

function asBody(document: object): BatchBody {
  return document as BatchBody
}

function errorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if ('code' in error && typeof error.code === 'number') return error.code
  if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode
  return undefined
}

function isSuccess(code: number): boolean {
  return code >= 200 && code < 300
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 100
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Connector source list limit must be a positive integer.')
  }
  return Math.min(limit, 200)
}

export class CosmosConnectorSourceRepository implements ConnectorSourceRepository {
  private readonly container: Container

  constructor(client: CosmosClient, options: CosmosConnectorSourceRepositoryOptions = {}) {
    this.container = client
      .database(options.databaseId ?? 'agent-sentinel-db')
      .container(options.containerId ?? 'connector-sources')
  }

  async create(
    estateValue: EstateContext,
    inputValue: ConnectorSourceCreateInput,
    mutationValue: ConnectorSourceMutationContext,
  ): Promise<ConnectorSourceWriteResult> {
    const estate = estateContextSchema.parse(estateValue)
    const input = connectorSourceCreateInputSchema.parse(inputValue)
    const mutation = connectorSourceMutationContextSchema.parse(mutationValue)
    this.assertBoundary(estate, input)
    if (input.origin === 'deployment' && mutation.actor.type !== 'deployment') {
      throw new Error('Deployment sources must be created by a deployment actor.')
    }
    const boundaryExists = await this.readEstateBoundary(estate)
    const fingerprint = digest(['create', input, mutation])
    const replay = await this.replay(estate, input.sourceId, mutation, fingerprint)
    if (replay) return replay
    const source = connectorSourceDefinitionSchema.parse({
      ...input,
      version: 1,
      etag: applicationEtag(estate.id, input.sourceId, 1, mutation.auditId),
      createdBy: mutation.actor,
      updatedBy: mutation.actor,
      createdAt: mutation.occurredAt,
      updatedAt: mutation.occurredAt,
    })
    const audit = this.createAudit('create', source, null, source, mutation)
    const createOperations: OperationInput[] = [
      { operationType: 'Create', resourceBody: asBody(this.sourceDocument(source)) },
      { operationType: 'Create', resourceBody: asBody(this.auditDocument(audit)) },
      {
        operationType: 'Create',
        resourceBody: asBody(
          this.idempotencyDocument(estate, source.sourceId, mutation, fingerprint),
        ),
      },
    ]
    const code = await this.batch(
      estate.id,
      boundaryExists
        ? [{ operationType: 'Read', id: estateBoundaryId(estate.id) }, ...createOperations]
        : [
            {
              operationType: 'Create',
              resourceBody: asBody(this.estateBoundaryDocument(estate)),
            },
            ...createOperations,
          ],
    )
    if (isSuccess(code)) return { status: 'applied', source: clone(source), audit: clone(audit) }
    if (code === 409) {
      if (!boundaryExists && (await this.readEstateBoundary(estate))) {
        const retryCode = await this.batch(estate.id, [
          { operationType: 'Read', id: estateBoundaryId(estate.id) },
          ...createOperations,
        ])
        if (isSuccess(retryCode)) {
          return { status: 'applied', source: clone(source), audit: clone(audit) }
        }
        return this.createConflict(estate, input.sourceId, mutation, fingerprint, retryCode)
      }
      return this.createConflict(estate, input.sourceId, mutation, fingerprint, code)
    }
    throw new Error(`Cosmos connector source create batch failed with status ${code}.`)
  }

  private async createConflict(
    estate: EstateContext,
    logicalSourceId: string,
    mutation: ConnectorSourceMutationContext,
    fingerprint: string,
    code: number,
  ): Promise<ConnectorSourceWriteResult> {
    if (code === 409) {
      const concurrentReplay = await this.replay(estate, logicalSourceId, mutation, fingerprint)
      if (concurrentReplay) return concurrentReplay
      if (await this.readSource(estate, logicalSourceId)) {
        return { status: 'conflict', reason: 'already_exists' }
      }
      await this.readAudit(estate, mutation.auditId)
      return { status: 'conflict', reason: 'audit_id_reuse' }
    }
    throw new Error(`Cosmos connector source create batch failed with status ${code}.`)
  }

  async findById(
    estateValue: EstateContext,
    logicalSourceId: string,
  ): Promise<ConnectorSourceDefinition | null> {
    const estate = estateContextSchema.parse(estateValue)
    await this.readEstateBoundary(estate)
    const document = await this.readSource(estate, logicalSourceId)
    return document === null || document.deleted === true ? null : clone(document.source)
  }

  async list(estateValue: EstateContext, limit?: number): Promise<ConnectorSourceDefinition[]> {
    const estate = estateContextSchema.parse(estateValue)
    await this.readEstateBoundary(estate)
    const { resources } = await this.container.items
      .query<SourceDocument>(
        {
          query:
            'SELECT * FROM c WHERE c.documentType = @documentType AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false) ORDER BY c.source.sourceId ASC OFFSET 0 LIMIT @limit',
          parameters: [
            { name: '@documentType', value: SOURCE_TYPE },
            { name: '@limit', value: boundedLimit(limit) },
          ],
        },
        { partitionKey: estate.id },
      )
      .fetchAll()
    return resources.map((document) => {
      this.assertSourceDocument(estate, document, document.source.sourceId)
      return clone(document.source)
    })
  }

  async update(
    estateValue: EstateContext,
    logicalSourceId: string,
    expectedEtag: string,
    patchValue: ConnectorSourceUpdateInput,
    mutationValue: ConnectorSourceMutationContext,
  ): Promise<ConnectorSourceWriteResult> {
    const estate = estateContextSchema.parse(estateValue)
    const patch = connectorSourceUpdateInputSchema.parse(patchValue)
    const mutation = connectorSourceMutationContextSchema.parse(mutationValue)
    await this.readEstateBoundary(estate)
    const fingerprint = digest(['update', logicalSourceId, expectedEtag, patch, mutation])
    const replay = await this.replay(estate, logicalSourceId, mutation, fingerprint)
    if (replay) return replay
    const document = await this.readSource(estate, logicalSourceId)
    if (!document || document.deleted === true) return { status: 'not_found' }
    const existing = document.source
    if (existing.origin === 'deployment') return { status: 'immutable' }
    if (existing.etag !== expectedEtag) return { status: 'conflict', reason: 'etag_mismatch' }
    if (!document._etag) {
      throw new Error(`Cosmos did not return an ETag for source: ${logicalSourceId}`)
    }
    if (patch.configuration && patch.configuration.type !== existing.connectorType) {
      throw new Error('Connector configuration must match the existing connector type.')
    }
    this.assertMutationAfterCurrentSource('update', existing, mutation)
    const source = connectorSourceDefinitionSchema.parse({
      ...existing,
      ...patch,
      version: existing.version + 1,
      etag: applicationEtag(estate.id, logicalSourceId, existing.version + 1, mutation.auditId),
      updatedBy: mutation.actor,
      updatedAt: mutation.occurredAt,
    })
    const audit = this.createAudit('update', source, existing, source, mutation)
    const code = await this.batch(estate.id, [
      {
        operationType: 'Replace',
        id: document.id,
        ifMatch: document._etag,
        resourceBody: asBody(this.sourceDocument(source)),
      },
      { operationType: 'Create', resourceBody: asBody(this.auditDocument(audit)) },
      {
        operationType: 'Create',
        resourceBody: asBody(
          this.idempotencyDocument(estate, logicalSourceId, mutation, fingerprint),
        ),
      },
    ])
    if (isSuccess(code)) return { status: 'applied', source: clone(source), audit: clone(audit) }
    return this.writeConflict(estate, logicalSourceId, mutation, fingerprint, code)
  }

  async delete(
    estateValue: EstateContext,
    logicalSourceId: string,
    expectedEtag: string,
    mutationValue: ConnectorSourceMutationContext,
  ): Promise<ConnectorSourceWriteResult> {
    const estate = estateContextSchema.parse(estateValue)
    const mutation = connectorSourceMutationContextSchema.parse(mutationValue)
    await this.readEstateBoundary(estate)
    const fingerprint = digest(['delete', logicalSourceId, expectedEtag, mutation])
    const replay = await this.replay(estate, logicalSourceId, mutation, fingerprint)
    if (replay) return replay
    const document = await this.readSource(estate, logicalSourceId)
    if (!document || document.deleted === true) return { status: 'not_found' }
    const existing = document.source
    if (existing.origin === 'deployment') return { status: 'immutable' }
    if (existing.etag !== expectedEtag) return { status: 'conflict', reason: 'etag_mismatch' }
    if (!document._etag) {
      throw new Error(`Cosmos did not return an ETag for source: ${logicalSourceId}`)
    }
    this.assertMutationAfterCurrentSource('delete', existing, mutation)
    const audit = this.createAudit('delete', existing, existing, null, mutation)
    const code = await this.batch(estate.id, [
      {
        operationType: 'Replace',
        id: document.id,
        ifMatch: document._etag,
        resourceBody: asBody({ ...this.sourceDocument(existing), deleted: true }),
      },
      { operationType: 'Create', resourceBody: asBody(this.auditDocument(audit)) },
      {
        operationType: 'Create',
        resourceBody: asBody(
          this.idempotencyDocument(estate, logicalSourceId, mutation, fingerprint),
        ),
      },
    ])
    if (isSuccess(code)) return { status: 'applied', source: null, audit: clone(audit) }
    return this.writeConflict(estate, logicalSourceId, mutation, fingerprint, code)
  }

  async listAudit(
    estateValue: EstateContext,
    logicalSourceId: string,
    limit?: number,
  ): Promise<ConnectorSourceAuditRecord[]> {
    const estate = estateContextSchema.parse(estateValue)
    await this.readEstateBoundary(estate)
    const { resources } = await this.container.items
      .query<AuditDocument>(
        {
          query:
            'SELECT * FROM c WHERE c.documentType = @documentType AND c.sourceId = @sourceId ORDER BY c.occurredAt ASC, c.audit.id ASC OFFSET 0 LIMIT @limit',
          parameters: [
            { name: '@documentType', value: AUDIT_TYPE },
            { name: '@sourceId', value: logicalSourceId },
            { name: '@limit', value: boundedLimit(limit) },
          ],
        },
        { partitionKey: estate.id },
      )
      .fetchAll()
    return resources.map((document) => {
      this.assertAuditDocument(estate, document, logicalSourceId, document.audit.id)
      return clone(document.audit)
    })
  }

  private async writeConflict(
    estate: EstateContext,
    logicalSourceId: string,
    mutation: ConnectorSourceMutationContext,
    fingerprint: string,
    code: number,
  ): Promise<ConnectorSourceWriteResult> {
    if (code === 404) return { status: 'not_found' }
    if (code === 412) return { status: 'conflict', reason: 'etag_mismatch' }
    if (code === 409) {
      const replay = await this.replay(estate, logicalSourceId, mutation, fingerprint)
      if (replay) return replay
      await this.readAudit(estate, mutation.auditId)
      return { status: 'conflict', reason: 'audit_id_reuse' }
    }
    throw new Error(`Cosmos connector source write batch failed with status ${code}.`)
  }

  private async replay(
    estate: EstateContext,
    logicalSourceId: string,
    mutation: ConnectorSourceMutationContext,
    fingerprint: string,
  ): Promise<ConnectorSourceWriteResult | null> {
    const marker = await this.readIdempotency(estate, mutation.idempotencyKey)
    if (!marker) return null
    if (marker.fingerprint !== fingerprint) {
      return { status: 'conflict', reason: 'idempotency_key_reuse' }
    }
    if (marker.sourceId !== logicalSourceId) {
      throw new Error(`Invalid Cosmos connector source idempotency document: ${marker.id}`)
    }
    const audit = await this.readAudit(estate, marker.auditId)
    if (!audit) {
      throw new Error(`Connector source idempotency marker references missing audit: ${marker.id}`)
    }
    if (audit.sourceId !== marker.sourceId) {
      throw new Error(
        `Connector source idempotency marker references mismatched audit: ${marker.id}`,
      )
    }
    return { status: 'idempotent', source: clone(audit.after), audit: clone(audit) }
  }

  private async readSource(
    estate: EstateContext,
    logicalSourceId: string,
  ): Promise<SourceDocument | null> {
    try {
      const { resource } = await this.container
        .item(sourceId(estate.id, logicalSourceId), estate.id)
        .read<SourceDocument>()
      if (!resource) return null
      this.assertSourceDocument(estate, resource, logicalSourceId)
      return resource
    } catch (error: unknown) {
      if (errorCode(error) === 404) return null
      throw error
    }
  }

  private async readAudit(
    estate: EstateContext,
    logicalAuditId: string,
  ): Promise<ConnectorSourceAuditRecord | null> {
    try {
      const { resource } = await this.container
        .item(auditId(estate.id, logicalAuditId), estate.id)
        .read<AuditDocument>()
      if (!resource) return null
      this.assertAuditDocument(estate, resource, resource.sourceId, logicalAuditId)
      return resource.audit
    } catch (error: unknown) {
      if (errorCode(error) === 404) return null
      throw error
    }
  }

  private async readIdempotency(
    estate: EstateContext,
    key: string,
  ): Promise<IdempotencyDocument | null> {
    try {
      const { resource } = await this.container
        .item(idempotencyId(estate.id, key), estate.id)
        .read<IdempotencyDocument>()
      if (!resource) return null
      if (
        resource.id !== idempotencyId(estate.id, key) ||
        resource.estateId !== estate.id ||
        resource.tenantId !== estate.tenantId ||
        resource.environment !== estate.environment ||
        resource.documentType !== IDEMPOTENCY_TYPE
      ) {
        throw new Error(`Invalid Cosmos connector source idempotency document: ${resource.id}`)
      }
      return resource
    } catch (error: unknown) {
      if (errorCode(error) === 404) return null
      throw error
    }
  }

  private async readEstateBoundary(estate: EstateContext): Promise<boolean> {
    try {
      const { resource } = await this.container
        .item(estateBoundaryId(estate.id), estate.id)
        .read<EstateBoundaryDocument>()
      if (!resource) return false
      if (
        resource.id !== estateBoundaryId(estate.id) ||
        resource.estateId !== estate.id ||
        resource.tenantId !== estate.tenantId ||
        resource.environment !== estate.environment ||
        resource.documentType !== ESTATE_BOUNDARY_TYPE
      ) {
        throw new Error('Connector source estate boundary does not match the bound estate.')
      }
      return true
    } catch (error: unknown) {
      if (errorCode(error) === 404) return false
      throw error
    }
  }

  private async batch(estateId: string, operations: OperationInput[]): Promise<number> {
    try {
      const response = await this.container.items.batch(operations, estateId)
      if (response.code !== undefined) return response.code
      const failed = response.result?.find((operation) => !isSuccess(operation.statusCode))
      return failed?.statusCode ?? 200
    } catch (error: unknown) {
      const code = errorCode(error)
      if (code === 404 || code === 409 || code === 412) return code
      throw error
    }
  }

  private assertBoundary(estate: EstateContext, input: ConnectorSourceCreateInput): void {
    if (
      input.estateId !== estate.id ||
      input.tenantId !== estate.tenantId ||
      input.environment !== estate.environment
    ) {
      throw new Error('Connector source boundary does not match the target estate.')
    }
  }

  private assertMutationAfterCurrentSource(
    operation: 'update' | 'delete',
    source: ConnectorSourceDefinition,
    mutation: ConnectorSourceMutationContext,
  ): void {
    if (mutation.occurredAt <= source.updatedAt) {
      throw new Error(
        `Connector source ${operation} occurredAt must be strictly greater than the current source updatedAt.`,
      )
    }
  }

  private assertSourceDocument(
    estate: EstateContext,
    document: SourceDocument,
    logicalSourceId: string,
  ): void {
    const source = connectorSourceDefinitionSchema.parse(document.source)
    if (
      document.estateId !== estate.id ||
      document.tenantId !== estate.tenantId ||
      document.environment !== estate.environment ||
      document.documentType !== SOURCE_TYPE ||
      document.id !== sourceId(estate.id, logicalSourceId) ||
      source.estateId !== estate.id ||
      source.tenantId !== estate.tenantId ||
      source.environment !== estate.environment ||
      source.sourceId !== logicalSourceId
    ) {
      throw new Error(`Invalid Cosmos connector source document: ${logicalSourceId}`)
    }
  }

  private createAudit(
    operation: ConnectorSourceAuditRecord['operation'],
    source: ConnectorSourceDefinition,
    before: ConnectorSourceDefinition | null,
    after: ConnectorSourceDefinition | null,
    mutation: ConnectorSourceMutationContext,
  ): ConnectorSourceAuditRecord {
    return connectorSourceAuditRecordSchema.parse({
      id: mutation.auditId,
      estateId: source.estateId,
      tenantId: source.tenantId,
      environment: source.environment,
      sourceId: source.sourceId,
      operation,
      actor: mutation.actor,
      occurredAt: mutation.occurredAt,
      idempotencyKey: mutation.idempotencyKey,
      before,
      after,
    })
  }

  private sourceDocument(source: ConnectorSourceDefinition): SourceDocument {
    return {
      id: sourceId(source.estateId, source.sourceId),
      estateId: source.estateId,
      tenantId: source.tenantId,
      environment: source.environment,
      documentType: SOURCE_TYPE,
      source,
    }
  }

  private auditDocument(audit: ConnectorSourceAuditRecord): AuditDocument {
    return {
      id: auditId(audit.estateId, audit.id),
      estateId: audit.estateId,
      tenantId: audit.tenantId,
      environment: audit.environment,
      documentType: AUDIT_TYPE,
      sourceId: audit.sourceId,
      occurredAt: audit.occurredAt,
      audit,
    }
  }

  private idempotencyDocument(
    estate: EstateContext,
    logicalSourceId: string,
    mutation: ConnectorSourceMutationContext,
    fingerprint: string,
  ): IdempotencyDocument {
    return {
      id: idempotencyId(estate.id, mutation.idempotencyKey),
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      documentType: IDEMPOTENCY_TYPE,
      fingerprint,
      sourceId: logicalSourceId,
      auditId: mutation.auditId,
    }
  }

  private estateBoundaryDocument(estate: EstateContext): EstateBoundaryDocument {
    return {
      id: estateBoundaryId(estate.id),
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      documentType: ESTATE_BOUNDARY_TYPE,
    }
  }

  private assertAuditDocument(
    estate: EstateContext,
    document: AuditDocument,
    logicalSourceId: string,
    logicalAuditId: string,
  ): void {
    const audit = connectorSourceAuditRecordSchema.parse(document.audit)
    if (
      document.id !== auditId(estate.id, logicalAuditId) ||
      document.estateId !== estate.id ||
      document.tenantId !== estate.tenantId ||
      document.environment !== estate.environment ||
      document.documentType !== AUDIT_TYPE ||
      document.sourceId !== logicalSourceId ||
      audit.id !== logicalAuditId ||
      audit.estateId !== estate.id ||
      audit.tenantId !== estate.tenantId ||
      audit.environment !== estate.environment ||
      audit.sourceId !== logicalSourceId
    ) {
      throw new Error(`Invalid Cosmos connector source audit document: ${logicalAuditId}`)
    }
  }
}
