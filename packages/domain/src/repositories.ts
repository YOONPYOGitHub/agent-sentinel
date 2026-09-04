import type { EstateContext, EstateSnapshot, Evidence, Finding, ValidationRun } from './index.js'
import type {
  ConnectorSourceActor,
  ConnectorSourceAuditTransition,
  ConnectorSourceDefinition,
  ConnectorSourceOrigin,
} from './connector-source.js'
import type {
  GovernanceCase,
  GovernanceCaseKind,
  GovernanceCaseStatus,
  GovernanceCaseTransition,
} from './governance-queue.js'
import type { ExposureFinding, ExposureFindingSeverity, ExposureFindingStatus } from './index.js'

export interface SnapshotRepository {
  save(estate: EstateContext, snapshot: EstateSnapshot): Promise<void>
  findLatest(estate: EstateContext): Promise<EstateSnapshot | null>
  findById(id: string, estate: EstateContext): Promise<EstateSnapshot | null>
  list(estate: EstateContext, limit?: number): Promise<EstateSnapshot[]>
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
  upsert(estate: EstateContext, finding: ExposureFinding): Promise<ExposureFinding>
  findById(id: string, estate: EstateContext): Promise<ExposureFinding | null>
  listByTenant(
    estate: EstateContext,
    filters?: ExposureFindingListFilters,
  ): Promise<{ items: ExposureFinding[]; total: number }>
  getFacets(estate: EstateContext): Promise<ExposureFindingFacets>
  resolveAbsent(
    estate: EstateContext,
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

export interface ConnectorSourceListFilters {
  enabled?: boolean
  connectorType?: string
  origin?: ConnectorSourceOrigin
  search?: string
  page?: number
  pageSize?: number
}

export interface ConnectorSourceRepository {
  create(
    estate: EstateContext,
    source: ConnectorSourceDefinition,
    idempotencyKey: string,
  ): Promise<{ source: ConnectorSourceDefinition; created: boolean; reason?: 'idempotency_conflict' | 'source_conflict' }>
  update(
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
  >
  findById(estate: EstateContext, sourceId: string): Promise<ConnectorSourceDefinition | null>
  list(
    estate: EstateContext,
    filters?: ConnectorSourceListFilters,
  ): Promise<{ items: ConnectorSourceDefinition[]; total: number }>
  delete(
    estate: EstateContext,
    sourceId: string,
    expectedEtag: string,
    actor: ConnectorSourceActor,
  ): Promise<{ deleted: boolean; reason?: 'not_found' | 'etag_conflict' | 'immutable_origin' }>
  getAuditHistory(
    estate: EstateContext,
    sourceId: string,
  ): Promise<ConnectorSourceAuditTransition[]>
}
