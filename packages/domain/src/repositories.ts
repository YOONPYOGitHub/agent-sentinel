import type { EstateSnapshot, Evidence, Finding, ValidationRun } from './index.js'
import type {
  GovernanceCase,
  GovernanceCaseKind,
  GovernanceCaseStatus,
  GovernanceCaseTransition,
} from './governance-queue.js'
import type { ExposureFinding, ExposureFindingSeverity, ExposureFindingStatus } from './index.js'

export interface SnapshotRepository {
  save(snapshot: EstateSnapshot): Promise<void>
  findLatest(tenantId: string, environment: string): Promise<EstateSnapshot | null>
  findById(id: string, tenantId: string): Promise<EstateSnapshot | null>
  list(tenantId: string, limit?: number): Promise<EstateSnapshot[]>
}

export interface FindingRepository {
  save(finding: Finding): Promise<void>
  findById(id: string): Promise<Finding | null>
  listByTenantAndSeverity(tenantId: string, severity?: string): Promise<Finding[]>
  update(id: string, patch: Partial<Finding>): Promise<Finding>
  delete(id: string): Promise<void>
}

export interface EvidenceRepository {
  save(evidence: Evidence): Promise<void>
  findById(id: string): Promise<Evidence | null>
  findBySource(source: string, sourceObjectId: string): Promise<Evidence[]>
  listBySnapshot(snapshotId: string): Promise<Evidence[]>
}

export interface ValidationRunRepository {
  save(run: ValidationRun): Promise<void>
  findById(id: string): Promise<ValidationRun | null>
  findByFindingId(findingId: string): Promise<ValidationRun[]>
  update(id: string, patch: Partial<ValidationRun>): Promise<ValidationRun>
}

export interface ExposureFindingListFilters {
  severity?: ExposureFindingSeverity
  status?: ExposureFindingStatus
  policyId?: string
  search?: string
  page?: number
  pageSize?: number
}

export interface ExposureFindingFacets {
  severity: Record<string, number>
  status: Record<string, number>
  policyId: Record<string, number>
}

export interface ExposureFindingRepository {
  upsert(finding: ExposureFinding): Promise<ExposureFinding>
  findById(id: string, tenantId: string): Promise<ExposureFinding | null>
  listByTenant(
    tenantId: string,
    filters?: ExposureFindingListFilters,
  ): Promise<{ items: ExposureFinding[]; total: number }>
  getFacets(tenantId: string): Promise<ExposureFindingFacets>
  resolveAbsent(
    tenantId: string,
    presentIds: readonly string[],
    sourceModes?: readonly ExposureFinding['sourceMode'][],
  ): Promise<ExposureFinding[]>
}

export interface GovernanceCaseListFilters {
  status?: GovernanceCaseStatus
  kind?: GovernanceCaseKind
  assignee?: string
  search?: string
  page?: number
  pageSize?: number
}

export interface GovernanceCaseRepository {
  create(
    caseRecord: GovernanceCase,
    firstTransition: GovernanceCaseTransition,
  ): Promise<{ case: GovernanceCase; created: boolean }>
  findById(
    id: string,
  ): Promise<{ case: GovernanceCase; transitions: GovernanceCaseTransition[] } | null>
  listAll(filters?: GovernanceCaseListFilters): Promise<{ items: GovernanceCase[]; total: number }>
  applyTransition(
    caseId: string,
    expectedStatus: GovernanceCaseStatus,
    updated: GovernanceCase,
    transition: GovernanceCaseTransition,
  ): Promise<
    | {
        applied: true
        case: GovernanceCase
        transitions: GovernanceCaseTransition[]
      }
    | {
        applied: false
        reason: 'not_found' | 'idempotency_conflict' | 'state_conflict'
      }
  >
}
