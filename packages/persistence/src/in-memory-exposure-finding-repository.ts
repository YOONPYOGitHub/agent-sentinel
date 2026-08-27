import type {
  ExposureFinding,
  ExposureFindingFacets,
  ExposureFindingListFilters,
  ExposureFindingRepository,
} from '@agent-sentinel/domain'

export class InMemoryExposureFindingRepository implements ExposureFindingRepository {
  private readonly findings = new Map<string, ExposureFinding>()

  private key(id: string, tenantId: string): string {
    return `${tenantId}\u0000${id}`
  }

  upsert(finding: ExposureFinding): Promise<ExposureFinding> {
    const key = this.key(finding.id, finding.tenantId)
    const existing = this.findings.get(key)
    const merged: ExposureFinding = {
      ...structuredClone(finding),
      firstSeen: existing?.firstSeen ?? finding.firstSeen,
    }
    this.findings.set(key, merged)
    return Promise.resolve(structuredClone(merged))
  }

  findById(id: string, tenantId: string): Promise<ExposureFinding | null> {
    const finding = this.findings.get(this.key(id, tenantId))
    return Promise.resolve(finding ? structuredClone(finding) : null)
  }

  listByTenant(
    tenantId: string,
    filters: ExposureFindingListFilters = {},
  ): Promise<{ items: ExposureFinding[]; total: number }> {
    const search = filters.search?.trim().toLocaleLowerCase() ?? ''
    const filtered = [...this.findings.values()]
      .filter((finding) => finding.tenantId === tenantId)
      .filter((finding) =>
        filters.severity === undefined ? true : finding.severity === filters.severity,
      )
      .filter((finding) =>
        filters.status === undefined ? true : finding.status === filters.status,
      )
      .filter((finding) =>
        filters.policyId === undefined ? true : finding.policyId === filters.policyId,
      )
      .filter((finding) => {
        if (search.length === 0) return true
        const haystack = [
          finding.title,
          finding.summary,
          finding.affectedAgentName,
          finding.policyName,
          finding.policyId,
        ]
          .join(' ')
          .toLocaleLowerCase()
        return haystack.includes(search)
      })
      .sort((left, right) => right.riskScore - left.riskScore)

    const total = filtered.length
    const page = filters.page ?? 1
    const pageSize = filters.pageSize ?? 50
    const start = Math.max(0, (page - 1) * pageSize)
    const items = filtered.slice(start, start + pageSize).map((finding) => structuredClone(finding))
    return Promise.resolve({ items, total })
  }

  getFacets(tenantId: string): Promise<ExposureFindingFacets> {
    const facets: ExposureFindingFacets = { severity: {}, status: {}, policyId: {} }
    for (const finding of this.findings.values()) {
      if (finding.tenantId !== tenantId) continue
      facets.severity[finding.severity] = (facets.severity[finding.severity] ?? 0) + 1
      facets.status[finding.status] = (facets.status[finding.status] ?? 0) + 1
      facets.policyId[finding.policyId] = (facets.policyId[finding.policyId] ?? 0) + 1
    }
    return Promise.resolve(facets)
  }

  resolveAbsent(
    tenantId: string,
    presentIds: readonly string[],
    sourceModes?: readonly ExposureFinding['sourceMode'][],
  ): Promise<ExposureFinding[]> {
    const presentSet = new Set(presentIds)
    const sourceModeSet = sourceModes === undefined ? undefined : new Set(sourceModes)
    const resolved: ExposureFinding[] = []
    const now = new Date().toISOString()
    for (const finding of this.findings.values()) {
      if (finding.tenantId !== tenantId) continue
      if (sourceModeSet !== undefined && !sourceModeSet.has(finding.sourceMode)) continue
      if (presentSet.has(finding.id)) continue
      if (finding.status === 'resolved' || finding.status === 'mitigated') continue
      const updated: ExposureFinding = {
        ...structuredClone(finding),
        status: 'resolved',
        lastSeen: now,
      }
      this.findings.set(this.key(finding.id, tenantId), updated)
      resolved.push(structuredClone(updated))
    }
    return Promise.resolve(resolved)
  }
}
