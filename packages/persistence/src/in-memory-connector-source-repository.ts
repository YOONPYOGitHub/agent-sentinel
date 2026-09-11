import { createHash } from 'node:crypto'

import {
  connectorSourceAuditRecordSchema,
  connectorSourceCreateInputSchema,
  connectorSourceDefinitionSchema,
  connectorSourceMutationContextSchema,
  connectorSourceUpdateInputSchema,
  estateContextSchema,
  hydratePersistedConnectorSourceAuditRecord,
  hydratePersistedConnectorSourceDefinition,
  isConnectorSourceMigrationRequired,
  type ConnectorSourceAuditRecord,
  type ConnectorSourceAuditReadModel,
  type ConnectorSourceAuditCursor,
  type ConnectorSourceCreateInput,
  type ConnectorSourceDefinition,
  type ConnectorSourceReadModel,
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
  sourceId: string
  source: unknown
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
  if (limit > 1_000) {
    throw new Error('Connector source list limit cannot exceed 1000.')
  }
  return limit
}

export interface InMemoryConnectorSourceRepositoryOptions {
  persistedSources?: readonly unknown[]
  persistedAudits?: readonly unknown[]
  authoritativeSources?: readonly ConnectorSourceDefinition[]
}

export class InMemoryConnectorSourceRepository implements ConnectorSourceRepository {
  private readonly sources = new Map<string, SourceRecord>()
  private readonly audits = new Map<string, unknown[]>()
  private readonly auditIds = new Map<string, BoundaryRecord>()
  private readonly idempotency = new Map<string, IdempotencyRecord>()
  private readonly estateBoundaries = new Map<string, BoundaryRecord>()
  private readonly authoritativeSources: readonly ConnectorSourceDefinition[]

  constructor(options: InMemoryConnectorSourceRepositoryOptions = {}) {
    this.authoritativeSources = (options.authoritativeSources ?? []).map((source) =>
      connectorSourceDefinitionSchema.parse(source),
    )
    for (const value of options.persistedSources ?? []) {
      const source = hydratePersistedConnectorSourceDefinition(value, this.authoritativeSources)
      const key = this.sourceKey(source.estateId, source.sourceId)
      if (this.sources.has(key)) {
        throw new Error(`Duplicate persisted connector source: ${source.sourceId}`)
      }
      const estate = estateContextSchema.parse({
        id: source.estateId,
        tenantId: source.tenantId,
        environment: source.environment,
      })
      this.assertEstateBoundary(estate)
      this.estateBoundaries.set(estate.id, this.boundaryRecord(estate))
      this.sources.set(key, {
        estateId: source.estateId,
        tenantId: source.tenantId,
        environment: source.environment,
        sourceId: source.sourceId,
        source: clone(value),
        deleted: false,
      })
    }
    for (const value of options.persistedAudits ?? []) {
      const audit = hydratePersistedConnectorSourceAuditRecord(value, this.authoritativeSources)
      const estate = estateContextSchema.parse({
        id: audit.estateId,
        tenantId: audit.tenantId,
        environment: audit.environment,
      })
      const boundaryExists = this.assertEstateBoundary(estate)
      if (this.hasAuditId(estate, audit.id)) {
        throw new Error(`Duplicate persisted connector source audit: ${audit.id}`)
      }
      if (!boundaryExists) {
        this.estateBoundaries.set(estate.id, this.boundaryRecord(estate))
      }
      const key = this.sourceKey(estate.id, audit.sourceId)
      this.audits.set(key, [...(this.audits.get(key) ?? []), clone(value)])
      this.auditIds.set(this.auditKey(estate.id, audit.id), this.boundaryRecord(estate))
    }
  }

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
    const fingerprint = digest(['create', input])
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

  findById(estateValue: EstateContext, sourceId: string): Promise<ConnectorSourceReadModel | null> {
    const estate = estateContextSchema.parse(estateValue)
    this.assertEstateBoundary(estate)
    const record = this.sources.get(this.sourceKey(estate.id, sourceId))
    if (record === undefined) return Promise.resolve(null)
    const source = this.assertSourceRecord(estate, record, sourceId)
    return Promise.resolve(record.deleted ? null : clone(source))
  }

  list(
    estateValue: EstateContext,
    limit?: number,
    afterSourceId?: string,
  ): Promise<ConnectorSourceReadModel[]> {
    const estate = estateContextSchema.parse(estateValue)
    this.assertEstateBoundary(estate)
    const prefix = `${estate.id}\u0000`
    return Promise.resolve(
      [...this.sources.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, record]) => {
          const source = this.assertSourceRecord(estate, record, record.sourceId)
          return { record, source }
        })
        .filter(({ record }) => !record.deleted)
        .map(({ source }) => source)
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
        .filter((source) => afterSourceId === undefined || source.sourceId > afterSourceId)
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
    const fingerprint = digest(['update', sourceId, expectedEtag, patch])
    const replay = this.replay(estate, sourceId, mutation, fingerprint)
    if (replay) return Promise.resolve(replay)
    const key = this.sourceKey(estate.id, sourceId)
    const record = this.sources.get(key)
    if (!record) return Promise.resolve({ status: 'not_found' })
    const existing = this.assertSourceRecord(estate, record, sourceId)
    if (record.deleted) return Promise.resolve({ status: 'not_found' })
    if (isConnectorSourceMigrationRequired(existing)) {
      return Promise.resolve({ status: 'migration_required' })
    }
    if (existing.origin === 'deployment') return Promise.resolve({ status: 'immutable' })
    if (existing.etag !== expectedEtag) {
      return Promise.resolve({ status: 'conflict', reason: 'etag_mismatch' })
    }
    if (patch.configuration && patch.configuration.type !== existing.connectorType) {
      throw new Error('Connector configuration must match the existing connector type.')
    }
    this.assertMutationAfterCurrentSource('update', existing, mutation)
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
    const fingerprint = digest(['delete', sourceId, expectedEtag])
    const replay = this.replay(estate, sourceId, mutation, fingerprint)
    if (replay) return Promise.resolve(replay)
    const key = this.sourceKey(estate.id, sourceId)
    const record = this.sources.get(key)
    if (!record) return Promise.resolve({ status: 'not_found' })
    const existing = this.assertSourceRecord(estate, record, sourceId)
    if (record.deleted) return Promise.resolve({ status: 'not_found' })
    if (isConnectorSourceMigrationRequired(existing)) {
      return Promise.resolve({ status: 'migration_required' })
    }
    if (existing.origin === 'deployment') return Promise.resolve({ status: 'immutable' })
    if (existing.etag !== expectedEtag) {
      return Promise.resolve({ status: 'conflict', reason: 'etag_mismatch' })
    }
    this.assertMutationAfterCurrentSource('delete', existing, mutation)
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
    after?: ConnectorSourceAuditCursor,
  ): Promise<ConnectorSourceAuditReadModel[]> {
    const estate = estateContextSchema.parse(estateValue)
    this.assertEstateBoundary(estate)
    return Promise.resolve(
      (this.audits.get(this.sourceKey(estate.id, sourceId)) ?? [])
        .slice()
        .map((audit) => this.assertAudit(estate, audit, sourceId))
        .sort(
          (left, right) =>
            left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id),
        )
        .filter(
          (audit) =>
            after === undefined ||
            audit.occurredAt > after.occurredAt ||
            (audit.occurredAt === after.occurredAt && audit.id > after.id),
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
      sourceId: source.sourceId,
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

  private assertSourceRecord(
    estate: EstateContext,
    record: SourceRecord,
    sourceId: string,
  ): ConnectorSourceReadModel {
    const source = hydratePersistedConnectorSourceDefinition(
      record.source,
      this.authoritativeSources,
    )
    if (
      record.estateId !== estate.id ||
      record.tenantId !== estate.tenantId ||
      record.environment !== estate.environment ||
      record.sourceId !== sourceId ||
      source.estateId !== estate.id ||
      source.tenantId !== estate.tenantId ||
      source.environment !== estate.environment ||
      source.sourceId !== sourceId
    ) {
      throw new Error(`Invalid in-memory connector source record: ${sourceId}`)
    }
    return source
  }

  private assertAudit(
    estate: EstateContext,
    auditValue: unknown,
    sourceId: string,
  ): ConnectorSourceAuditReadModel {
    const audit = hydratePersistedConnectorSourceAuditRecord(auditValue, this.authoritativeSources)
    if (
      audit.estateId !== estate.id ||
      audit.tenantId !== estate.tenantId ||
      audit.environment !== estate.environment ||
      audit.sourceId !== sourceId
    ) {
      throw new Error(`Invalid in-memory connector source audit record: ${audit.id}`)
    }
    return audit
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
