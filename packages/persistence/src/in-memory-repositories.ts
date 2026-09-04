import type {
  EstateSnapshot,
  EstateContext,
  Evidence,
  EvidenceRepository,
  Finding,
  FindingRepository,
  SnapshotRepository,
  ValidationRun,
  ValidationRunRepository,
} from '@agent-sentinel/domain'

type TenantFinding = Finding & { tenantId?: string }

export class InMemorySnapshotRepository implements SnapshotRepository {
  private readonly snapshots = new Map<
    string,
    { estate: EstateContext; snapshot: EstateSnapshot }
  >()

  save(estate: EstateContext, snapshot: EstateSnapshot): Promise<void> {
    if (snapshot.tenantId !== estate.tenantId || snapshot.environment !== estate.environment) {
      return Promise.reject(new Error('Snapshot boundary does not match the target estate.'))
    }
    this.snapshots.set(
      `${estate.id}\u0000${snapshot.tenantId}-${snapshot.environment}-${snapshot.generatedAt}`,
      { estate: structuredClone(estate), snapshot: structuredClone(snapshot) },
    )
    return Promise.resolve()
  }

  findLatest(estate: EstateContext): Promise<EstateSnapshot | null> {
    const snapshot = [...this.snapshots.values()]
      .filter((item) => item.estate.id === estate.id)
      .map((item) => item.snapshot)
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0]
    return Promise.resolve(snapshot === undefined ? null : structuredClone(snapshot))
  }

  findById(id: string, estate: EstateContext): Promise<EstateSnapshot | null> {
    const record = this.snapshots.get(`${estate.id}\u0000${id}`)
    return Promise.resolve(record === undefined ? null : structuredClone(record.snapshot))
  }

  list(estate: EstateContext, limit = 100): Promise<EstateSnapshot[]> {
    const snapshots = [...this.snapshots.values()]
      .filter((record) => record.estate.id === estate.id)
      .map((record) => record.snapshot)
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))
      .slice(0, limit)
      .map((snapshot) => structuredClone(snapshot))
    return Promise.resolve(snapshots)
  }
}

export class InMemoryFindingRepository implements FindingRepository {
  private readonly findings = new Map<string, Finding>()

  save(finding: Finding): Promise<void> {
    this.findings.set(finding.id, structuredClone(finding))
    return Promise.resolve()
  }

  findById(id: string): Promise<Finding | null> {
    const finding = this.findings.get(id)
    return Promise.resolve(finding ? structuredClone(finding) : null)
  }

  listByTenantAndSeverity(tenantId: string, severity?: string): Promise<Finding[]> {
    const findings = [...this.findings.values()]
      .filter((finding) => {
        const candidateTenantId = (finding as TenantFinding).tenantId
        return (
          (candidateTenantId === undefined || candidateTenantId === tenantId) &&
          (severity === undefined || finding.severity === severity)
        )
      })
      .map((finding) => structuredClone(finding))
    return Promise.resolve(findings)
  }

  update(id: string, patch: Partial<Finding>): Promise<Finding> {
    const finding = this.findings.get(id)
    if (!finding) {
      return Promise.reject(new Error(`Finding not found: ${id}`))
    }
    const updated = { ...finding, ...structuredClone(patch), id }
    this.findings.set(id, updated)
    return Promise.resolve(structuredClone(updated))
  }

  delete(id: string): Promise<void> {
    this.findings.delete(id)
    return Promise.resolve()
  }
}

export class InMemoryEvidenceRepository implements EvidenceRepository {
  private readonly evidence = new Map<string, Evidence>()
  private readonly snapshotEvidence = new Map<string, Set<string>>()

  save(evidence: Evidence): Promise<void> {
    this.evidence.set(evidence.id, structuredClone(evidence))
    return Promise.resolve()
  }

  findById(id: string): Promise<Evidence | null> {
    const evidence = this.evidence.get(id)
    return Promise.resolve(evidence ? structuredClone(evidence) : null)
  }

  findBySource(source: string, sourceObjectId: string): Promise<Evidence[]> {
    const evidence = [...this.evidence.values()]
      .filter((item) => item.source === source && item.sourceObjectId === sourceObjectId)
      .map((item) => structuredClone(item))
    return Promise.resolve(evidence)
  }

  listBySnapshot(snapshotId: string): Promise<Evidence[]> {
    const ids = this.snapshotEvidence.get(snapshotId) ?? new Set<string>()
    const evidence = [...ids]
      .map((id) => this.evidence.get(id))
      .filter((item): item is Evidence => item !== undefined)
      .map((item) => structuredClone(item))
    return Promise.resolve(evidence)
  }
}

export class InMemoryValidationRunRepository implements ValidationRunRepository {
  private readonly runs = new Map<string, ValidationRun>()

  save(run: ValidationRun): Promise<void> {
    this.runs.set(run.id, structuredClone(run))
    return Promise.resolve()
  }

  findById(id: string): Promise<ValidationRun | null> {
    const run = this.runs.get(id)
    return Promise.resolve(run ? structuredClone(run) : null)
  }

  findByFindingId(findingId: string): Promise<ValidationRun[]> {
    const runs = [...this.runs.values()]
      .filter((run) => run.findingId === findingId)
      .map((run) => structuredClone(run))
    return Promise.resolve(runs)
  }

  update(id: string, patch: Partial<ValidationRun>): Promise<ValidationRun> {
    const run = this.runs.get(id)
    if (!run) {
      return Promise.reject(new Error(`Validation run not found: ${id}`))
    }
    const updated = { ...run, ...structuredClone(patch), id }
    this.runs.set(id, updated)
    return Promise.resolve(structuredClone(updated))
  }
}
