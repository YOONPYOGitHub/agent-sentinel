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

interface IdempotencyRecord {
  fingerprint: string
  result: AppliedResult
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
  private readonly sources = new Map<string, ConnectorSourceDefinition>()
  private readonly audits = new Map<string, ConnectorSourceAuditRecord[]>()
  private readonly auditIds = new Set<string>()
  private readonly idempotency = new Map<string, IdempotencyRecord>()

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
    const fingerprint = digest(['create', input, mutation])
    const replay = this.replay(estate, mutation, fingerprint)
    if (replay) return Promise.resolve(replay)
    const key = this.sourceKey(estate.id, input.sourceId)
    if (this.sources.has(key)) {
      return Promise.resolve({ status: 'conflict', reason: 'already_exists' })
    }
    if (this.auditIds.has(this.auditKey(estate.id, mutation.auditId))) {
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
    this.sources.set(key, clone(source))
    this.appendAudit(estate.id, audit)
    this.remember(estate, mutation, fingerprint, result)
    return Promise.resolve(clone(result))
  }

  findById(
    estateValue: EstateContext,
    sourceId: string,
  ): Promise<ConnectorSourceDefinition | null> {
    const estate = estateContextSchema.parse(estateValue)
    const source = this.sources.get(this.sourceKey(estate.id, sourceId))
    return Promise.resolve(source === undefined ? null : clone(source))
  }

  list(estateValue: EstateContext, limit?: number): Promise<ConnectorSourceDefinition[]> {
    const estate = estateContextSchema.parse(estateValue)
    const prefix = `${estate.id}\u0000`
    return Promise.resolve(
      [...this.sources.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, source]) => source)
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
    const fingerprint = digest(['update', sourceId, expectedEtag, patch, mutation])
    const replay = this.replay(estate, mutation, fingerprint)
    if (replay) return Promise.resolve(replay)
    const key = this.sourceKey(estate.id, sourceId)
    const existing = this.sources.get(key)
    if (!existing) return Promise.resolve({ status: 'not_found' })
    if (existing.origin === 'deployment') return Promise.resolve({ status: 'immutable' })
    if (existing.etag !== expectedEtag) {
      return Promise.resolve({ status: 'conflict', reason: 'etag_mismatch' })
    }
    if (patch.configuration && patch.configuration.type !== existing.connectorType) {
      throw new Error('Connector configuration must match the existing connector type.')
    }
    if (this.auditIds.has(this.auditKey(estate.id, mutation.auditId))) {
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
    this.sources.set(key, clone(source))
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
    const fingerprint = digest(['delete', sourceId, expectedEtag, mutation])
    const replay = this.replay(estate, mutation, fingerprint)
    if (replay) return Promise.resolve(replay)
    const key = this.sourceKey(estate.id, sourceId)
    const existing = this.sources.get(key)
    if (!existing) return Promise.resolve({ status: 'not_found' })
    if (existing.origin === 'deployment') return Promise.resolve({ status: 'immutable' })
    if (existing.etag !== expectedEtag) {
      return Promise.resolve({ status: 'conflict', reason: 'etag_mismatch' })
    }
    if (this.auditIds.has(this.auditKey(estate.id, mutation.auditId))) {
      return Promise.resolve({ status: 'conflict', reason: 'audit_id_reuse' })
    }
    const audit = this.createAudit('delete', existing, existing, null, mutation)
    const result: AppliedResult = { status: 'applied', source: null, audit }
    this.sources.delete(key)
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
    return Promise.resolve(
      (this.audits.get(this.sourceKey(estate.id, sourceId)) ?? [])
        .slice()
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
    this.auditIds.add(this.auditKey(estateId, audit.id))
  }

  private replay(
    estate: EstateContext,
    mutation: ConnectorSourceMutationContext,
    fingerprint: string,
  ): ConnectorSourceWriteResult | null {
    const record = this.idempotency.get(this.idempotencyKey(estate.id, mutation.idempotencyKey))
    if (!record) return null
    if (record.fingerprint !== fingerprint) {
      return { status: 'conflict', reason: 'idempotency_key_reuse' }
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
      fingerprint,
      result: clone(result),
    })
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
