import type { CosmosClient, OperationInput, SqlQuerySpec } from '@azure/cosmos'

type StoredDocument = Record<string, unknown> & {
  id: string
  documentType: string
  _etag: string
  tenantId?: string
  estateId?: string
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function notFound(): Error & { code: number } {
  return Object.assign(new Error('Not found'), { code: 404 })
}

export class FakeCosmosStore {
  private documents = new Map<string, StoredDocument>()
  private etagSequence = 0
  readonly queries: SqlQuerySpec[] = []

  readonly client = {
    database: () => ({
      container: () => this.container,
    }),
  } as unknown as CosmosClient

  snapshot(): StoredDocument[] {
    return [...this.documents.values()].map((document) => clone(document))
  }

  private readonly container = {
    item: (id: string, partitionKey: string) => ({
      read: () => {
        const document = this.documents.get(this.key(partitionKey, id))
        if (!document) return Promise.reject(notFound())
        return Promise.resolve({ resource: clone(document) })
      },
    }),
    items: {
      create: (resource: StoredDocument) => this.create(resource),
      batch: (operations: OperationInput[], partitionKey: string) =>
        Promise.resolve(this.batch(operations, partitionKey)),
      query: <T>(query: SqlQuerySpec, options: { partitionKey: string }) => ({
        fetchAll: () =>
          Promise.resolve({
            resources: this.query(query, options.partitionKey) as T[],
          }),
      }),
    },
  }

  private key(partitionKey: string, id: string): string {
    return `${partitionKey}\0${id}`
  }

  private partitionValue(document: StoredDocument): string | undefined {
    return document.estateId ?? document.tenantId
  }

  private nextEtag(): string {
    this.etagSequence += 1
    return `etag-${this.etagSequence}`
  }

  private create(resource: StoredDocument) {
    const partitionKey = this.partitionValue(resource)
    if (!partitionKey) return Promise.reject(new Error('Partition key is required.'))
    const key = this.key(partitionKey, resource.id)
    const versionConflict =
      resource.documentType === 'manifest-ingestion' &&
      [...this.documents.values()].some(
        (document) =>
          document.tenantId === resource.tenantId &&
          document.documentType === resource.documentType &&
          document.manifestId === resource.manifestId &&
          (document.envelope as { producedAt?: string }).producedAt ===
            (resource.envelope as { producedAt?: string }).producedAt,
      )
    if (this.documents.has(key) || versionConflict) {
      return Promise.reject(Object.assign(new Error('Conflict'), { code: 409 }))
    }
    const stored = { ...clone(resource), _etag: this.nextEtag() }
    this.documents.set(key, stored)
    return Promise.resolve({ resource: clone(stored), statusCode: 201 })
  }

  private batch(operations: OperationInput[], partitionKey: string) {
    const working = new Map(
      [...this.documents.entries()].map(([key, value]) => [key, clone(value)]),
    )
    const results: Array<{ statusCode: number; requestCharge: number }> = []

    for (const operation of operations) {
      if (operation.operationType === 'Create') {
        const resource = operation.resourceBody as unknown as StoredDocument
        const key = this.key(partitionKey, resource.id)
        if (this.partitionValue(resource) !== partitionKey || working.has(key))
          return { code: 409, result: [{ statusCode: 409, requestCharge: 1 }] }
        working.set(key, { ...clone(resource), _etag: this.nextEtag() })
        results.push({ statusCode: 201, requestCharge: 1 })
        continue
      }

      if (operation.operationType === 'Replace') {
        const key = this.key(partitionKey, operation.id)
        const existing = working.get(key)
        if (!existing) return { code: 404, result: [{ statusCode: 404, requestCharge: 1 }] }
        if (operation.ifMatch !== existing._etag)
          return { code: 412, result: [{ statusCode: 412, requestCharge: 1 }] }
        const resource = operation.resourceBody as unknown as StoredDocument
        if (this.partitionValue(resource) !== partitionKey || resource.id !== operation.id)
          return { code: 400, result: [{ statusCode: 400, requestCharge: 1 }] }
        working.set(key, { ...clone(resource), _etag: this.nextEtag() })
        results.push({ statusCode: 200, requestCharge: 1 })
        continue
      }

      throw new Error(`Unsupported fake Cosmos operation: ${operation.operationType}`)
    }

    this.documents = working
    return { code: 200, result: results }
  }

  private query(query: SqlQuerySpec, partitionKey: string): unknown[] {
    this.queries.push(clone(query))
    const parameters = new Map(
      (query.parameters ?? []).map((parameter) => [parameter.name, parameter.value]),
    )
    const documentType = parameters.get('@documentType')
    let documents = [...this.documents.values()].filter(
      (document) =>
        this.partitionValue(document) === partitionKey && document.documentType === documentType,
    )

    if (documentType === 'connector-source') {
      documents = documents.filter((document) => document.deleted !== true)
      documents.sort((left, right) => {
        const leftSource = left.source as { sourceId: string }
        const rightSource = right.source as { sourceId: string }
        return leftSource.sourceId.localeCompare(rightSource.sourceId)
      })
      return clone(documents.slice(0, Number(parameters.get('@limit') ?? 100)))
    }

    if (documentType === 'connector-source-audit') {
      documents = documents
        .filter((document) => document.sourceId === parameters.get('@sourceId'))
        .sort((left, right) => {
          const time = String(left.occurredAt).localeCompare(String(right.occurredAt))
          if (time !== 0) return time
          const leftAudit = left.audit as { id: string }
          const rightAudit = right.audit as { id: string }
          return leftAudit.id.localeCompare(rightAudit.id)
        })
      return clone(documents.slice(0, Number(parameters.get('@limit') ?? 100)))
    }

    if (documentType === 'governance-case-transition') {
      documents = documents
        .filter((document) => document.caseId === parameters.get('@caseId'))
        .sort((left, right) => {
          const sequenceDelta = Number(left.sequence) - Number(right.sequence)
          if (sequenceDelta !== 0) return sequenceDelta
          const leftTransition = left.transition as { timestamp: string; id: string }
          const rightTransition = right.transition as { timestamp: string; id: string }
          return leftTransition.id.localeCompare(rightTransition.id)
        })
      return clone(documents)
    }

    if (documentType === 'manifest-ingestion') {
      documents = documents.filter(
        (document) => document.environmentId === parameters.get('@environmentId'),
      )
      if (query.query.startsWith('SELECT DISTINCT')) {
        const limit = Number.parseInt(query.query.match(/TOP (\d+)/)?.[1] ?? '500', 10)
        return [...new Set(documents.map((document) => document.manifestId))].slice(0, limit)
      }
      documents = documents.filter(
        (document) => document.manifestId === parameters.get('@manifestId'),
      )
      documents.sort((left, right) =>
        String((right.envelope as { producedAt?: string }).producedAt).localeCompare(
          String((left.envelope as { producedAt?: string }).producedAt),
        ),
      )
      return clone(documents.slice(0, 1))
    }

    documents = documents.filter((document) => {
      const caseRecord = document.case as Record<string, unknown>
      if (parameters.has('@status') && caseRecord.status !== parameters.get('@status')) return false
      if (parameters.has('@kind') && caseRecord.kind !== parameters.get('@kind')) return false
      if (
        parameters.has('@assignee') &&
        caseRecord.assigneeIdentity !== parameters.get('@assignee')
      )
        return false
      const search = parameters.get('@search')
      return typeof search !== 'string' || (document.searchText as string).includes(search)
    })

    if (query.query.startsWith('SELECT VALUE COUNT(1)')) return [documents.length]

    documents.sort((left, right) => {
      const leftCase = left.case as { id: string; lastTransitionAt: string }
      const rightCase = right.case as { id: string; lastTransitionAt: string }
      return (
        rightCase.lastTransitionAt.localeCompare(leftCase.lastTransitionAt) ||
        leftCase.id.localeCompare(rightCase.id)
      )
    })
    const offset = Number(parameters.get('@offset') ?? 0)
    const pageSize = Number(parameters.get('@pageSize') ?? 50)
    return clone(documents.slice(offset, offset + pageSize))
  }
}
