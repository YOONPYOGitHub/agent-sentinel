import { createHash } from 'node:crypto'
import type { Container, CosmosClient, OperationInput, SqlParameter } from '@azure/cosmos'

import {
  governanceCaseSchema,
  governanceCaseTransitionSchema,
  type GovernanceCase,
  type GovernanceCaseListFilters,
  type GovernanceCaseRepository,
  type GovernanceCaseStatus,
  type GovernanceCaseTransition,
} from '@agent-sentinel/domain'

const MAX_PAGE_SIZE = 200
const CASE_DOCUMENT_TYPE = 'governance-case'
const TRANSITION_DOCUMENT_TYPE = 'governance-case-transition'
const IDEMPOTENCY_DOCUMENT_TYPE = 'governance-case-idempotency'

type BatchResourceBody = Extract<OperationInput, { operationType: 'Create' }>['resourceBody']

interface GovernanceCaseDocument {
  id: string
  tenantId: string
  documentType: typeof CASE_DOCUMENT_TYPE
  version: number
  searchText: string
  case: GovernanceCase
  _etag?: string
}

interface GovernanceTransitionDocument {
  id: string
  tenantId: string
  documentType: typeof TRANSITION_DOCUMENT_TYPE
  caseId: string
  sequence: number
  transition: GovernanceCaseTransition
}

interface GovernanceIdempotencyDocument {
  id: string
  tenantId: string
  documentType: typeof IDEMPOTENCY_DOCUMENT_TYPE
  scope: 'create' | 'transition'
  caseId: string
  transitionId: string
}

export interface CosmosGovernanceCaseRepositoryOptions {
  tenantId: string
  databaseId?: string
  containerId?: string
}

function caseDocumentId(caseId: string): string {
  return `case:${caseId}`
}

function transitionDocumentId(transitionId: string): string {
  return `transition:${transitionId}`
}

function idempotencyDocumentId(scope: string, key: string): string {
  const digest = createHash('sha256').update(`${scope}\0${key}`, 'utf8').digest('hex')
  return `idempotency:${digest}`
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

function asBatchResource(document: object): BatchResourceBody {
  return document as BatchResourceBody
}

function searchText(caseRecord: GovernanceCase): string {
  return [
    caseRecord.id,
    caseRecord.title,
    caseRecord.description,
    caseRecord.createdByIdentity,
    caseRecord.assigneeIdentity ?? '',
    caseRecord.findingId ?? '',
    caseRecord.agentId ?? '',
    caseRecord.policyId ?? '',
  ]
    .join(' ')
    .toLocaleLowerCase()
}

function parsePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return fallback
  return value
}

export class CosmosGovernanceCaseRepository implements GovernanceCaseRepository {
  private readonly container: Container
  private readonly tenantId: string

  constructor(client: CosmosClient, options: CosmosGovernanceCaseRepositoryOptions) {
    const tenantId = options.tenantId.trim()
    if (tenantId.length === 0) throw new Error('A tenantId is required for governance persistence.')
    this.tenantId = tenantId
    this.container = client
      .database(options.databaseId ?? 'agent-sentinel-db')
      .container(options.containerId ?? 'governance-cases')
  }

  async create(
    caseRecordInput: GovernanceCase,
    firstTransitionInput: GovernanceCaseTransition,
  ): Promise<{ case: GovernanceCase; created: boolean }> {
    const caseRecord = governanceCaseSchema.parse(caseRecordInput)
    const firstTransition = governanceCaseTransitionSchema.parse(firstTransitionInput)
    if (
      firstTransition.operation !== 'create' ||
      firstTransition.caseId !== caseRecord.id ||
      firstTransition.toStatus !== caseRecord.status ||
      firstTransition.timestamp !== caseRecord.createdAt ||
      caseRecord.createdAt !== caseRecord.lastTransitionAt
    ) {
      throw new Error('The initial governance transition does not match its case.')
    }

    const markerId = idempotencyDocumentId('create', firstTransition.idempotencyKey)
    const existingMarker = await this.readIdempotency(markerId)
    if (existingMarker) return this.resolveCreateRetry(existingMarker)

    const caseDocument: GovernanceCaseDocument = {
      id: caseDocumentId(caseRecord.id),
      tenantId: this.tenantId,
      documentType: CASE_DOCUMENT_TYPE,
      version: 1,
      searchText: searchText(caseRecord),
      case: caseRecord,
    }
    const transitionDocument: GovernanceTransitionDocument = {
      id: transitionDocumentId(firstTransition.id),
      tenantId: this.tenantId,
      documentType: TRANSITION_DOCUMENT_TYPE,
      caseId: caseRecord.id,
      sequence: 1,
      transition: firstTransition,
    }
    const markerDocument: GovernanceIdempotencyDocument = {
      id: markerId,
      tenantId: this.tenantId,
      documentType: IDEMPOTENCY_DOCUMENT_TYPE,
      scope: 'create',
      caseId: caseRecord.id,
      transitionId: firstTransition.id,
    }

    const operations: OperationInput[] = [
      { operationType: 'Create', resourceBody: asBatchResource(caseDocument) },
      { operationType: 'Create', resourceBody: asBatchResource(transitionDocument) },
      { operationType: 'Create', resourceBody: asBatchResource(markerDocument) },
    ]
    const statusCode = await this.executeBatch(operations)
    if (isSuccess(statusCode)) return { case: caseRecord, created: true }
    if (statusCode === 409) {
      const concurrentMarker = await this.readIdempotency(markerId)
      if (concurrentMarker) return this.resolveCreateRetry(concurrentMarker)
      throw new Error(`Governance case or transition already exists: ${caseRecord.id}`)
    }
    throw new Error(`Cosmos governance create batch failed with status ${statusCode}.`)
  }

  async findById(
    id: string,
  ): Promise<{ case: GovernanceCase; transitions: GovernanceCaseTransition[] } | null> {
    const document = await this.readCaseDocument(id)
    if (!document) return null
    const query = {
      query:
        'SELECT * FROM c WHERE c.documentType = @documentType AND c.caseId = @caseId ORDER BY c.sequence ASC, c.transition.id ASC',
      parameters: [
        { name: '@documentType', value: TRANSITION_DOCUMENT_TYPE },
        { name: '@caseId', value: id },
      ],
    }
    const { resources } = await this.container.items
      .query<GovernanceTransitionDocument>(query, { partitionKey: this.tenantId })
      .fetchAll()
    return {
      case: governanceCaseSchema.parse(document.case),
      transitions: resources.map((resource) =>
        governanceCaseTransitionSchema.parse(resource.transition),
      ),
    }
  }

  async listAll(
    filters: GovernanceCaseListFilters = {},
  ): Promise<{ items: GovernanceCase[]; total: number }> {
    const parameters: SqlParameter[] = [{ name: '@documentType', value: CASE_DOCUMENT_TYPE }]
    const clauses = ['c.documentType = @documentType']
    if (filters.status !== undefined) {
      clauses.push('c["case"]["status"] = @status')
      parameters.push({ name: '@status', value: filters.status })
    }
    if (filters.kind !== undefined) {
      clauses.push('c["case"]["kind"] = @kind')
      parameters.push({ name: '@kind', value: filters.kind })
    }
    if (filters.assignee !== undefined) {
      clauses.push('c["case"]["assigneeIdentity"] = @assignee')
      parameters.push({ name: '@assignee', value: filters.assignee })
    }
    const normalizedSearch = filters.search?.trim().toLocaleLowerCase()
    if (normalizedSearch) {
      clauses.push('CONTAINS(c.searchText, @search)')
      parameters.push({ name: '@search', value: normalizedSearch })
    }

    const page = parsePositiveInteger(filters.page, 1)
    const pageSize = Math.min(parsePositiveInteger(filters.pageSize, 50), MAX_PAGE_SIZE)
    const offset = (page - 1) * pageSize
    const where = clauses.join(' AND ')
    const [itemsResponse, totalResponse] = await Promise.all([
      this.container.items
        .query<GovernanceCaseDocument>(
          {
            query: `SELECT * FROM c WHERE ${where} ORDER BY c["case"]["lastTransitionAt"] DESC, c["case"]["id"] ASC OFFSET @offset LIMIT @pageSize`,
            parameters: [
              ...parameters,
              { name: '@offset', value: offset },
              { name: '@pageSize', value: pageSize },
            ],
          },
          { partitionKey: this.tenantId },
        )
        .fetchAll(),
      this.container.items
        .query<number>(
          {
            query: `SELECT VALUE COUNT(1) FROM c WHERE ${where}`,
            parameters,
          },
          { partitionKey: this.tenantId },
        )
        .fetchAll(),
    ])
    return {
      items: itemsResponse.resources.map((document) => governanceCaseSchema.parse(document.case)),
      total: totalResponse.resources[0] ?? 0,
    }
  }

  async applyTransition(
    caseId: string,
    expectedStatus: GovernanceCaseStatus,
    updatedInput: GovernanceCase,
    transitionInput: GovernanceCaseTransition,
  ): ReturnType<GovernanceCaseRepository['applyTransition']> {
    const updated = governanceCaseSchema.parse(updatedInput)
    const transition = governanceCaseTransitionSchema.parse(transitionInput)
    if (
      updated.id !== caseId ||
      transition.caseId !== caseId ||
      transition.operation === 'create' ||
      transition.fromStatus !== expectedStatus ||
      transition.toStatus !== updated.status ||
      transition.timestamp !== updated.lastTransitionAt
    ) {
      throw new Error('The governance transition does not match its case update.')
    }

    const existing = await this.readCaseDocument(caseId)
    if (!existing) return { applied: false, reason: 'not_found' }
    const markerId = idempotencyDocumentId(`transition:${caseId}`, transition.idempotencyKey)
    if (await this.readIdempotency(markerId))
      return { applied: false, reason: 'idempotency_conflict' }
    if (existing.case.status !== expectedStatus) return { applied: false, reason: 'state_conflict' }
    if (!existing._etag)
      throw new Error(`Cosmos did not return an ETag for governance case: ${caseId}`)

    const updatedDocument: GovernanceCaseDocument = {
      id: existing.id,
      tenantId: this.tenantId,
      documentType: CASE_DOCUMENT_TYPE,
      version: existing.version + 1,
      searchText: searchText(updated),
      case: updated,
    }
    const transitionDocument: GovernanceTransitionDocument = {
      id: transitionDocumentId(transition.id),
      tenantId: this.tenantId,
      documentType: TRANSITION_DOCUMENT_TYPE,
      caseId,
      sequence: existing.version + 1,
      transition,
    }
    const markerDocument: GovernanceIdempotencyDocument = {
      id: markerId,
      tenantId: this.tenantId,
      documentType: IDEMPOTENCY_DOCUMENT_TYPE,
      scope: 'transition',
      caseId,
      transitionId: transition.id,
    }
    const operations: OperationInput[] = [
      {
        operationType: 'Replace',
        id: existing.id,
        ifMatch: existing._etag,
        resourceBody: asBatchResource(updatedDocument),
      },
      { operationType: 'Create', resourceBody: asBatchResource(transitionDocument) },
      { operationType: 'Create', resourceBody: asBatchResource(markerDocument) },
    ]
    const statusCode = await this.executeBatch(operations)
    if (statusCode === 404) return { applied: false, reason: 'not_found' }
    if (statusCode === 409) return { applied: false, reason: 'idempotency_conflict' }
    if (statusCode === 412) return { applied: false, reason: 'state_conflict' }
    if (!isSuccess(statusCode))
      throw new Error(`Cosmos governance transition batch failed with status ${statusCode}.`)

    const detail = await this.findById(caseId)
    if (!detail)
      throw new Error(`Governance case disappeared after applying a transition: ${caseId}`)
    return { applied: true, case: detail.case, transitions: detail.transitions }
  }

  private async executeBatch(operations: OperationInput[]): Promise<number> {
    try {
      const response = await this.container.items.batch(operations, this.tenantId)
      if (response.code !== undefined) return response.code
      const failedOperation = response.result?.find((operation) => !isSuccess(operation.statusCode))
      return failedOperation?.statusCode ?? 200
    } catch (error: unknown) {
      const statusCode = errorStatusCode(error)
      if (statusCode === 404 || statusCode === 409 || statusCode === 412) return statusCode
      throw error
    }
  }

  private async readCaseDocument(caseId: string): Promise<GovernanceCaseDocument | null> {
    try {
      const { resource } = await this.container
        .item(caseDocumentId(caseId), this.tenantId)
        .read<GovernanceCaseDocument>()
      if (!resource) return null
      if (
        resource.documentType !== CASE_DOCUMENT_TYPE ||
        resource.tenantId !== this.tenantId ||
        resource.case.id !== caseId
      ) {
        throw new Error(`Invalid Cosmos governance case document: ${caseId}`)
      }
      return resource
    } catch (error: unknown) {
      if (errorStatusCode(error) === 404) return null
      throw error
    }
  }

  private async readIdempotency(id: string): Promise<GovernanceIdempotencyDocument | null> {
    try {
      const { resource } = await this.container
        .item(id, this.tenantId)
        .read<GovernanceIdempotencyDocument>()
      if (!resource) return null
      if (
        resource.documentType !== IDEMPOTENCY_DOCUMENT_TYPE ||
        resource.tenantId !== this.tenantId
      ) {
        throw new Error(`Invalid Cosmos governance idempotency document: ${id}`)
      }
      return resource
    } catch (error: unknown) {
      if (errorStatusCode(error) === 404) return null
      throw error
    }
  }

  private async resolveCreateRetry(
    marker: GovernanceIdempotencyDocument,
  ): Promise<{ case: GovernanceCase; created: false }> {
    if (marker.scope !== 'create')
      throw new Error(`Invalid governance creation idempotency marker: ${marker.id}`)
    const existing = await this.readCaseDocument(marker.caseId)
    if (!existing)
      throw new Error(`Governance idempotency marker references a missing case: ${marker.caseId}`)
    return { case: governanceCaseSchema.parse(existing.case), created: false }
  }
}
