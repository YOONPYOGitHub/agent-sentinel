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

function clone<T>(value: T): T {
  return structuredClone(value)
}

function makeKey(estate: EstateContext, sourceId: string): string {
  return `${estate.id}\0${sourceId}`
}

function makeIdempotencyKey(scope: string, value: string): string {
  return `${scope}\0${value}`
}

export class InMemoryConnectorSourceRepository implements ConnectorSourceRepository {
  private readonly documents = new Map<string, ConnectorSourceDefinition>()
  private readonly history = new Map<string, ConnectorSourceAuditTransition[]>()
  private readonly idempotencyKeys = new Map<string, string>()

  async create(
    estate: EstateContext,
    source: ConnectorSourceDefinition,
    idempotencyKey: string,
  ): Promise<{ source: ConnectorSourceDefinition; created: boolean; reason?: 'idempotency_conflict' | 'source_conflict' }> {
    await Promise.resolve()
    const record = connectorSourceDefinitionSchema.parse({
      ...source,
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
    })
    const documentKey = makeKey(estate, record.id)
    const idempotencyRecordKey = makeIdempotencyKey(`create:${estate.id}:${record.id}`, idempotencyKey)

    if (this.idempotencyKeys.has(idempotencyRecordKey)) {
      const existing = this.documents.get(documentKey)
      if (existing) {
        return { source: clone(existing), created: false, reason: 'idempotency_conflict' }
      }
    }

    const existing = this.documents.get(documentKey)
    if (existing) {
      return { source: clone(existing), created: false, reason: 'source_conflict' }
    }

    const transition: ConnectorSourceAuditTransition = connectorSourceAuditTransitionSchema.parse({
      id: `audit-create-${record.id}-${record.version}`,
      sourceId: record.id,
      action: 'create',
      fromStatus: null,
      toStatus: record.status,
      actor: record.actor,
      timestamp: record.createdAt,
      version: record.version,
      idempotencyKey,
      summary: `Created connector source ${record.displayName}.`,
    })
    const next = connectorSourceDefinitionSchema.parse({
      ...record,
      auditHistory: [...record.auditHistory, transition],
    })

    this.documents.set(documentKey, clone(next))
    this.history.set(documentKey, clone(next.auditHistory))
    this.idempotencyKeys.set(idempotencyRecordKey, record.id)
    return { source: clone(next), created: true }
  }

  async update(
    estate: EstateContext,
    sourceId: string,
    expectedEtag: string,
    updated: ConnectorSourceDefinition,
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
    await Promise.resolve()
    const documentKey = makeKey(estate, sourceId)
    const existing = this.documents.get(documentKey)
    if (!existing) {
      return { applied: false, reason: 'not_found' }
    }

    if (existing.etag !== expectedEtag) {
      return { applied: false, reason: 'etag_conflict' }
    }

    if (existing.origin === 'deployment' && updated.actor.type !== 'deployment') {
      return { applied: false, reason: 'immutable_origin' }
    }

    const idempotencyRecordKey = makeIdempotencyKey(`update:${estate.id}:${sourceId}`, idempotencyKey)
    if (this.idempotencyKeys.has(idempotencyRecordKey)) {
      return { applied: false, reason: 'idempotency_conflict' }
    }

    const transition: ConnectorSourceAuditTransition = connectorSourceAuditTransitionSchema.parse({
      id: `audit-update-${sourceId}-${updated.version}`,
      sourceId,
      action: updated.enabled ? 'enable' : 'disable',
      fromStatus: existing.status,
      toStatus: updated.status,
      actor: updated.actor,
      timestamp: updated.updatedAt,
      version: updated.version,
      idempotencyKey,
      summary: `Updated connector source ${updated.displayName}.`,
    })

    const next = connectorSourceDefinitionSchema.parse({
      ...updated,
      id: sourceId,
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      auditHistory: [...existing.auditHistory, transition],
    })

    this.documents.set(documentKey, clone(next))
    this.history.set(documentKey, clone(next.auditHistory))
    this.idempotencyKeys.set(idempotencyRecordKey, sourceId)
    return {
      applied: true,
      source: clone(next),
      audit: clone(next.auditHistory),
    }
  }

  async findById(estate: EstateContext, sourceId: string): Promise<ConnectorSourceDefinition | null> {
    await Promise.resolve()
    const source = this.documents.get(makeKey(estate, sourceId))
    return source ? clone(source) : null
  }

  async list(
    estate: EstateContext,
    filters: ConnectorSourceListFilters = {},
  ): Promise<{ items: ConnectorSourceDefinition[]; total: number }> {
    await Promise.resolve()
    const items = [...this.documents.values()]
      .filter((source) => source.estateId === estate.id)
      .filter((source) => source.tenantId === estate.tenantId)
      .filter((source) => source.environment === estate.environment)
      .filter((source) => (filters.enabled === undefined ? true : source.enabled === filters.enabled))
      .filter((source) =>
        filters.connectorType === undefined ? true : source.connectorType === filters.connectorType,
      )
      .filter((source) =>
        filters.origin === undefined ? true : source.origin === filters.origin,
      )
      .filter((source) => {
        const search = (filters.search ?? '').trim().toLocaleLowerCase()
        if (!search) return true
        const haystack = [
          source.id,
          source.displayName,
          source.connectorType,
          source.status,
          source.config.kind,
        ]
          .join(' ')
          .toLocaleLowerCase()
        return haystack.includes(search)
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))

    const total = items.length
    const page = Math.max(1, filters.page ?? 1)
    const pageSize = Math.min(Math.max(1, filters.pageSize ?? 50), 200)
    const start = (page - 1) * pageSize
    return {
      items: items.slice(start, start + pageSize).map((item) => clone(item)),
      total,
    }
  }

  async delete(
    estate: EstateContext,
    sourceId: string,
    expectedEtag: string,
    actor: ConnectorSourceActor,
  ): Promise<{ deleted: boolean; reason?: 'not_found' | 'etag_conflict' | 'immutable_origin' }> {
    await Promise.resolve()
    const documentKey = makeKey(estate, sourceId)
    const existing = this.documents.get(documentKey)
    if (!existing) {
      return { deleted: false, reason: 'not_found' }
    }

    if (existing.etag !== expectedEtag) {
      return { deleted: false, reason: 'etag_conflict' }
    }

    if (existing.origin === 'deployment' && actor.type !== 'deployment') {
      return { deleted: false, reason: 'immutable_origin' }
    }

    const transition: ConnectorSourceAuditTransition = connectorSourceAuditTransitionSchema.parse({
      id: `audit-delete-${sourceId}-${existing.version}`,
      sourceId,
      action: 'delete',
      fromStatus: existing.status,
      toStatus: 'draft',
      actor,
      timestamp: new Date().toISOString(),
      version: existing.version + 1,
      idempotencyKey: `delete:${sourceId}`,
      summary: `Deleted connector source ${existing.displayName}.`,
    })
    const history = this.history.get(documentKey) ?? existing.auditHistory
    this.history.set(documentKey, [...history, transition])
    this.documents.delete(documentKey)
    return { deleted: true }
  }

  async getAuditHistory(
    estate: EstateContext,
    sourceId: string,
  ): Promise<ConnectorSourceAuditTransition[]> {
    await Promise.resolve()
    const history = this.history.get(makeKey(estate, sourceId))
    return history ? clone(history) : []
  }
}
