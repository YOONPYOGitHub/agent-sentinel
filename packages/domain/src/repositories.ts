import type { EstateContext, EstateSnapshot, Evidence, Finding, ValidationRun } from './index.js'
import type {
  GovernanceCase,
  GovernanceCaseKind,
  GovernanceCaseStatus,
  GovernanceCaseTransition,
} from './governance-queue.js'
import type { ExposureFinding, ExposureFindingSeverity, ExposureFindingStatus } from './index.js'
import type {
  ConnectorSourceAuditRecord,
  ConnectorSourceCreateInput,
  ConnectorSourceDefinition,
  ConnectorSourceMutationContext,
  ConnectorSourceUpdateInput,
} from './connector-source.js'

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

export type ConnectorSourceWriteResult =
  | {
      status: 'applied'
      source: ConnectorSourceDefinition | null
      audit: ConnectorSourceAuditRecord
    }
  | {
      status: 'idempotent'
      source: ConnectorSourceDefinition | null
      audit: ConnectorSourceAuditRecord
    }
  | {
      status: 'conflict'
      reason: 'already_exists' | 'etag_mismatch' | 'idempotency_key_reuse' | 'audit_id_reuse'
    }
  | {
      status: 'not_found' | 'immutable'
    }

export interface ConnectorSourceAuditCursor {
  occurredAt: string
  id: string
}

export interface ConnectorSourceRepository {
  create(
    estate: EstateContext,
    input: ConnectorSourceCreateInput,
    mutation: ConnectorSourceMutationContext,
  ): Promise<ConnectorSourceWriteResult>
  findById(estate: EstateContext, sourceId: string): Promise<ConnectorSourceDefinition | null>
  list(
    estate: EstateContext,
    limit?: number,
    afterSourceId?: string,
  ): Promise<ConnectorSourceDefinition[]>
  update(
    estate: EstateContext,
    sourceId: string,
    expectedEtag: string,
    patch: ConnectorSourceUpdateInput,
    mutation: ConnectorSourceMutationContext,
  ): Promise<ConnectorSourceWriteResult>
  delete(
    estate: EstateContext,
    sourceId: string,
    expectedEtag: string,
    mutation: ConnectorSourceMutationContext,
  ): Promise<ConnectorSourceWriteResult>
  listAudit(
    estate: EstateContext,
    sourceId: string,
    limit?: number,
    after?: ConnectorSourceAuditCursor,
  ): Promise<ConnectorSourceAuditRecord[]>
}
