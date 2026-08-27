import type {
  GovernanceCase,
  GovernanceCaseListFilters,
  GovernanceCaseRepository,
  GovernanceCaseTransition,
} from '@agent-sentinel/domain'

export class InMemoryGovernanceCaseRepository implements GovernanceCaseRepository {
  private readonly cases = new Map<string, GovernanceCase>()
  private readonly transitions = new Map<string, GovernanceCaseTransition[]>()
  private readonly creationIdempotencyKeys = new Map<string, string>()

  static seed(
    cases: readonly GovernanceCase[],
    transitions: readonly GovernanceCaseTransition[],
  ): InMemoryGovernanceCaseRepository {
    const repository = new InMemoryGovernanceCaseRepository()

    for (const caseRecord of cases) {
      repository.cases.set(caseRecord.id, structuredClone(caseRecord))
      repository.transitions.set(caseRecord.id, [])
    }

    for (const transition of transitions) {
      const caseTransitions = repository.transitions.get(transition.caseId) ?? []
      caseTransitions.push(structuredClone(transition))
      repository.transitions.set(transition.caseId, caseTransitions)
    }

    for (const [caseId, caseTransitions] of repository.transitions.entries()) {
      repository.transitions.set(caseId, repository.sortTransitions(caseTransitions))
      const createTransition = caseTransitions.find(
        (transition) => transition.operation === 'create',
      )
      if (createTransition) {
        repository.creationIdempotencyKeys.set(createTransition.idempotencyKey, caseId)
      }
    }

    return repository
  }

  create(
    caseRecord: GovernanceCase,
    firstTransition: GovernanceCaseTransition,
  ): Promise<{ case: GovernanceCase; created: boolean }> {
    const existingCaseId = this.creationIdempotencyKeys.get(firstTransition.idempotencyKey)
    if (existingCaseId) {
      const existingCase = this.cases.get(existingCaseId)
      if (existingCase) {
        return Promise.resolve({ case: structuredClone(existingCase), created: false })
      }
    }

    this.cases.set(caseRecord.id, structuredClone(caseRecord))
    this.transitions.set(caseRecord.id, [structuredClone(firstTransition)])
    this.creationIdempotencyKeys.set(firstTransition.idempotencyKey, caseRecord.id)
    return Promise.resolve({ case: structuredClone(caseRecord), created: true })
  }

  findById(
    id: string,
  ): Promise<{ case: GovernanceCase; transitions: GovernanceCaseTransition[] } | null> {
    const caseRecord = this.cases.get(id)
    if (!caseRecord) {
      return Promise.resolve(null)
    }

    return Promise.resolve({
      case: structuredClone(caseRecord),
      transitions: structuredClone(this.sortTransitions(this.transitions.get(id) ?? [])),
    })
  }

  listAll(
    filters: GovernanceCaseListFilters = {},
  ): Promise<{ items: GovernanceCase[]; total: number }> {
    const search = filters.search?.trim().toLocaleLowerCase() ?? ''
    const filtered = [...this.cases.values()]
      .filter((caseRecord) =>
        filters.status === undefined ? true : caseRecord.status === filters.status,
      )
      .filter((caseRecord) =>
        filters.kind === undefined ? true : caseRecord.kind === filters.kind,
      )
      .filter((caseRecord) =>
        filters.assignee === undefined ? true : caseRecord.assigneeIdentity === filters.assignee,
      )
      .filter((caseRecord) => {
        if (search.length === 0) {
          return true
        }

        const haystack = [
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
        return haystack.includes(search)
      })
      .sort(
        (left, right) =>
          right.lastTransitionAt.localeCompare(left.lastTransitionAt) ||
          left.id.localeCompare(right.id),
      )

    const total = filtered.length
    const page = filters.page ?? 1
    const pageSize = Math.min(filters.pageSize ?? 50, 200)
    const start = Math.max(0, (page - 1) * pageSize)
    const items = filtered
      .slice(start, start + pageSize)
      .map((caseRecord) => structuredClone(caseRecord))
    return Promise.resolve({ items, total })
  }

  applyTransition(
    caseId: string,
    expectedStatus: GovernanceCase['status'],
    updated: GovernanceCase,
    transition: GovernanceCaseTransition,
  ): ReturnType<GovernanceCaseRepository['applyTransition']> {
    const existingCase = this.cases.get(caseId)
    if (!existingCase) {
      return Promise.resolve({ applied: false, reason: 'not_found' })
    }

    const existingTransitions = this.transitions.get(caseId) ?? []
    if (
      existingTransitions.some((existing) => existing.idempotencyKey === transition.idempotencyKey)
    ) {
      return Promise.resolve({ applied: false, reason: 'idempotency_conflict' })
    }

    if (existingCase.status !== expectedStatus) {
      return Promise.resolve({ applied: false, reason: 'state_conflict' })
    }

    this.cases.set(caseId, structuredClone(updated))
    const nextTransitions = this.sortTransitions([
      ...existingTransitions,
      structuredClone(transition),
    ])
    this.transitions.set(caseId, nextTransitions)

    return Promise.resolve({
      applied: true,
      case: structuredClone(updated),
      transitions: structuredClone(nextTransitions),
    })
  }

  private sortTransitions(
    transitions: readonly GovernanceCaseTransition[],
  ): GovernanceCaseTransition[] {
    return [...transitions].sort((left, right) => left.timestamp.localeCompare(right.timestamp))
  }
}
