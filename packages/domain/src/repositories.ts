import type { EstateSnapshot, Finding, Evidence, ValidationRun } from './index.js'

export interface SnapshotRepository {
  save(snapshot: EstateSnapshot): Promise<void>
  findLatest(tenantId: string, environment: string): Promise<EstateSnapshot | null>
  findById(id: string): Promise<EstateSnapshot | null>
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
