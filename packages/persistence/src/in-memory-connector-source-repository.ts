import { createHash } from 'node:crypto'

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

type AppliedResult = Extract<ConnectorSourceWriteResult, { status: 'applied' }>

interface SourceRecord {
  estateId: string
  tenantId: string
  environment: string
  source: ConnectorSourceDefinition
  deleted: boolean
}

interface IdempotencyRecord {
  estateId: string
  tenantId: string
  environment: string
  sourceId: string
  fingerprint: string
  result: AppliedResult
}

interface BoundaryRecord {
  estateId: string
  tenantId: string
  environment: string
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 100
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('Connector source list limit must be a positive integer.')
  }
  return Math.min(limit, 200)
}

export class InMemoryConnectorSourceRepository implements ConnectorSourceRepository {
  private readonly sources = new Map<string, SourceRecord>()
  private readonly audits = new Map<string, ConnectorSourceAuditRecord[]>()
  private readonly auditIds = new Map<string, BoundaryRecord>()
  private readonly idempotency = new Map<string, IdempotencyRecord>()
  private readonly estateBoundaries = new Map<string, BoundaryRecord>()

  create(
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
    const boundaryExists = this.assertEstateBoundary(estate)
    const fingerprint = digest(['create', input, mutation])
    const replay = this.replay(estate, input.sourceId, mutation, fingerprint)
    if (replay) return Promise.resolve(replay)
    const key = this.sourceKey(estate.id, input.sourceId)
    const existing = this.sources.get(key)
    if (existing) {
      this.assertSourceRecord(estate, existing, input.sourceId)
      return Promise.resolve({ status: 'conflict', reason: 'already_exists' })
    }
    if (this.hasAuditId(estate, mutation.auditId)) {
      return Promise.resolve({ status: 'conflict', reason: 'audit_id_reuse' })
    }
    const source = connectorSourceDefinitionSchema.parse({
      ...input,
      version: 1,
      etag: this.sourceEtag(estate.id, input.sourceId, 1, mutation.auditId),
      createdBy: mutation.actor,
      updatedBy: mutation.actor,
      createdAt: mutation.occurredAt,
      updatedAt: mutation.occurredAt,
    })
    const audit = this.createAudit('create', source, null, source, mutation)
    const result: AppliedResult = { status: 'applied', source, audit }
    if (!boundaryExists) {
      this.estateBoundaries.set(estate.id, this.boundaryRecord(estate))
    }
    this.sources.set(key, this.sourceRecord(source, false))
    this.appendAudit(estate.id, audit)
    this.remember(estate, mutation, fingerprint, result)
    return Promise.resolve(clone(result))
  }

  findById(
    estateValue: EstateContext,
    sourceId: string,
  ): Promise<ConnectorSourceDefinition | null> {
    const estate = estateContextSchema.parse(estateValue)
    this.assertEstateBoundary(estate)
    const record = this.sources.get(this.sourceKey(estate.id, sourceId))
    if (record === undefined) return Promise.resolve(null)
    this.assertSourceRecord(estate, record, sourceId)
    return Promise.resolve(record.deleted ? null : clone(record.source))
  }

  list(estateValue: EstateContext, limit?: number): Promise<ConnectorSourceDefinition[]> {
    const estate = estateContextSchema.parse(estateValue)
    this.assertEstateBoundary(estate)
    const prefix = `${estate.id}\u0000`
    return Promise.resolve(
      [...this.sources.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, record]) => {
          this.assertSourceRecord(estate, record, record.source.sourceId)
          return record
        })
        .filter((record) => !record.deleted)
        .map((record) => record.source)
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
        .slice(0, boundedLimit(limit))
        .map(clone),
    )
  }

  update(
    estateValue: EstateContext,
    sourceId: string,
    expectedEtag: string,
    patchValue: ConnectorSourceUpdateInput,
    mutationValue: ConnectorSourceMutationContext,
  ): Promise<ConnectorSourceWriteResult> {
    const estate = estateContextSchema.parse(estateValue)
    const patch = connectorSourceUpdateInputSchema.parse(patchValue)
    const mutation = connectorSourceMutationContextSchema.parse(mutationValue)
    this.assertEstateBoundary(estate)
    const fingerprint = digest(['update', sourceId, expectedEtag, patch, mutation])
    const replay = this.replay(estate, sourceId, mutation, fingerprint)
    if (replay) return Promise.resolve(replay)
    const key = this.sourceKey(estate.id, sourceId)
    const record = this.sources.get(key)
    if (!record) return Promise.resolve({ status: 'not_found' })
    this.assertSourceRecord(estate, record, sourceId)
    if (record.deleted) return Promise.resolve({ status: 'not_found' })
    const existing = record.source
    if (existing.origin === 'deployment') return Promise.resolve({ status: 'immutable' })
    if (existing.etag !== expectedEtag) {
      return Promise.resolve({ status: 'conflict', reason: 'etag_mismatch' })
    }
    if (patch.configuration && patch.configuration.type !== existing.connectorType) {
      throw new Error('Connector configuration must match the existing connector type.')
    }
    if (this.hasAuditId(estate, mutation.auditId)) {
      return Promise.resolve({ status: 'conflict', reason: 'audit_id_reuse' })
    }
    const source = connectorSourceDefinitionSchema.parse({
      ...existing,
      ...patch,
      version: existing.version + 1,
      etag: this.sourceEtag(estate.id, sourceId, existing.version + 1, mutation.auditId),
      updatedBy: mutation.actor,
      updatedAt: mutation.occurredAt,
    })
    const audit = this.createAudit('update', source, existing, source, mutation)
    const result: AppliedResult = { status: 'applied', source, audit }
    this.sources.set(key, this.sourceRecord(source, false))
    this.appendAudit(estate.id, audit)
    this.remember(estate, mutation, fingerprint, result)
    return Promise.resolve(clone(result))
  }

  delete(
    estateValue: EstateContext,
    sourceId: string,
    expectedEtag: string,
    mutationValue: ConnectorSourceMutationContext,
  ): Promise<ConnectorSourceWriteResult> {
    const estate = estateContextSchema.parse(estateValue)
    const mutation = connectorSourceMutationContextSchema.parse(mutationValue)
    this.assertEstateBoundary(estate)
    const fingerprint = digest(['delete', sourceId, expectedEtag, mutation])
    const replay = this.replay(estate, sourceId, mutation, fingerprint)
    if (replay) return Promise.resolve(replay)
    const key = this.sourceKey(estate.id, sourceId)
    const record = this.sources.get(key)
    if (!record) return Promise.resolve({ status: 'not_found' })
    this.assertSourceRecord(estate, record, sourceId)
    if (record.deleted) return Promise.resolve({ status: 'not_found' })
    const existing = record.source
    if (existing.origin === 'deployment') return Promise.resolve({ status: 'immutable' })
    if (existing.etag !== expectedEtag) {
      return Promise.resolve({ status: 'conflict', reason: 'etag_mismatch' })
    }
    if (this.hasAuditId(estate, mutation.auditId)) {
      return Promise.resolve({ status: 'conflict', reason: 'audit_id_reuse' })
    }
    const audit = this.createAudit('delete', existing, existing, null, mutation)
    const result: AppliedResult = { status: 'applied', source: null, audit }
    this.sources.set(key, this.sourceRecord(existing, true))
    this.appendAudit(estate.id, audit)
    this.remember(estate, mutation, fingerprint, result)
    return Promise.resolve(clone(result))
  }

  listAudit(
    estateValue: EstateContext,
    sourceId: string,
    limit?: number,
  ): Promise<ConnectorSourceAuditRecord[]> {
    const estate = estateContextSchema.parse(estateValue)
    this.assertEstateBoundary(estate)
    return Promise.resolve(
      (this.audits.get(this.sourceKey(estate.id, sourceId)) ?? [])
        .slice()
        .map((audit) => {
          this.assertAudit(estate, audit, sourceId)
          return audit
        })
        .sort(
          (left, right) =>
            left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id),
        )
        .slice(0, boundedLimit(limit))
        .map(clone),
    )
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

  private assertEstateBoundary(estate: EstateContext): boolean {
    const boundary = this.estateBoundaries.get(estate.id)
    if (!boundary) return false
    if (
      boundary.estateId !== estate.id ||
      boundary.tenantId !== estate.tenantId ||
      boundary.environment !== estate.environment
    ) {
      throw new Error('Connector source estate boundary does not match the bound estate.')
    }
    return true
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

  private appendAudit(estateId: string, audit: ConnectorSourceAuditRecord): void {
    const key = this.sourceKey(estateId, audit.sourceId)
    this.audits.set(key, [...(this.audits.get(key) ?? []), clone(audit)])
    this.auditIds.set(this.auditKey(estateId, audit.id), {
      estateId: audit.estateId,
      tenantId: audit.tenantId,
      environment: audit.environment,
    })
  }

  private hasAuditId(estate: EstateContext, auditId: string): boolean {
    const boundary = this.auditIds.get(this.auditKey(estate.id, auditId))
    if (!boundary) return false
    if (
      boundary.estateId !== estate.id ||
      boundary.tenantId !== estate.tenantId ||
      boundary.environment !== estate.environment
    ) {
      throw new Error(`Invalid in-memory connector source audit record: ${auditId}`)
    }
    return true
  }

  private replay(
    estate: EstateContext,
    sourceId: string,
    mutation: ConnectorSourceMutationContext,
    fingerprint: string,
  ): ConnectorSourceWriteResult | null {
    const record = this.idempotency.get(this.idempotencyKey(estate.id, mutation.idempotencyKey))
    if (!record) return null
    this.assertIdempotencyRecord(estate, record)
    if (record.fingerprint !== fingerprint) {
      return { status: 'conflict', reason: 'idempotency_key_reuse' }
    }
    if (record.sourceId !== sourceId) {
      throw new Error(`Invalid in-memory connector source idempotency record: ${sourceId}`)
    }
    return { ...clone(record.result), status: 'idempotent' }
  }

  private remember(
    estate: EstateContext,
    mutation: ConnectorSourceMutationContext,
    fingerprint: string,
    result: AppliedResult,
  ): void {
    this.idempotency.set(this.idempotencyKey(estate.id, mutation.idempotencyKey), {
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      sourceId: result.audit.sourceId,
      fingerprint,
      result: clone(result),
    })
  }

  private sourceRecord(source: ConnectorSourceDefinition, deleted: boolean): SourceRecord {
    return clone({
      estateId: source.estateId,
      tenantId: source.tenantId,
      environment: source.environment,
      source,
      deleted,
    })
  }

  private boundaryRecord(estate: EstateContext): BoundaryRecord {
    return clone({
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
    })
  }

  private assertSourceRecord(estate: EstateContext, record: SourceRecord, sourceId: string): void {
    const source = connectorSourceDefinitionSchema.parse(record.source)
    if (
      record.estateId !== estate.id ||
      record.tenantId !== estate.tenantId ||
      record.environment !== estate.environment ||
      source.estateId !== estate.id ||
      source.tenantId !== estate.tenantId ||
      source.environment !== estate.environment ||
      source.sourceId !== sourceId
    ) {
      throw new Error(`Invalid in-memory connector source record: ${sourceId}`)
    }
  }

  private assertAudit(
    estate: EstateContext,
    auditValue: ConnectorSourceAuditRecord,
    sourceId: string,
  ): void {
    const audit = connectorSourceAuditRecordSchema.parse(auditValue)
    if (
      audit.estateId !== estate.id ||
      audit.tenantId !== estate.tenantId ||
      audit.environment !== estate.environment ||
      audit.sourceId !== sourceId
    ) {
      throw new Error(`Invalid in-memory connector source audit record: ${audit.id}`)
    }
  }

  private assertIdempotencyRecord(estate: EstateContext, record: IdempotencyRecord): void {
    if (
      record.estateId !== estate.id ||
      record.tenantId !== estate.tenantId ||
      record.environment !== estate.environment
    ) {
      throw new Error(`Invalid in-memory connector source idempotency record: ${record.sourceId}`)
    }
    this.assertAudit(estate, record.result.audit, record.sourceId)
    if (record.result.source !== null) {
      this.assertBoundary(estate, record.result.source)
      if (record.result.source.sourceId !== record.sourceId) {
        throw new Error(`Invalid in-memory connector source idempotency result: ${record.sourceId}`)
      }
    }
  }

  private sourceEtag(estateId: string, sourceId: string, version: number, auditId: string): string {
    return `source-${version}-${digest([estateId, sourceId, version, auditId]).slice(0, 24)}`
  }

  private sourceKey(estateId: string, sourceId: string): string {
    return `${estateId}\u0000${sourceId}`
  }

  private auditKey(estateId: string, auditId: string): string {
    return `${estateId}\u0000${auditId}`
  }

  private idempotencyKey(estateId: string, key: string): string {
    return `${estateId}\u0000${key}`
  }
}
