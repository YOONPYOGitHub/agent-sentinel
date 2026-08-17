import type {
  ExposureFinding,
  ExposureFindingListFilters,
  ExposureFindingRepository,
} from '@agent-sentinel/domain'

export class InMemoryExposureFindingRepository implements ExposureFindingRepository {
  private readonly findings = new Map<string, ExposureFinding>()

  upsert(finding: ExposureFinding): Promise<ExposureFinding> {
    const existing = this.findings.get(finding.id)
    const merged: ExposureFinding = {
      ...structuredClone(finding),
      firstSeen: existing?.firstSeen ?? finding.firstSeen,
    }
    this.findings.set(finding.id, merged)
    return Promise.resolve(structuredClone(merged))
  }

  findById(id: string): Promise<ExposureFinding | null> {
    const finding = this.findings.get(id)
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

  resolveAbsent(tenantId: string, presentIds: readonly string[]): Promise<ExposureFinding[]> {
    const presentSet = new Set(presentIds)
    const resolved: ExposureFinding[] = []
    const now = new Date().toISOString()
    for (const finding of this.findings.values()) {
      if (finding.tenantId !== tenantId) continue
      if (presentSet.has(finding.id)) continue
      if (finding.status === 'resolved' || finding.status === 'mitigated') continue
      const updated: ExposureFinding = {
        ...structuredClone(finding),
        status: 'resolved',
        lastSeen: now,
      }
      this.findings.set(finding.id, updated)
      resolved.push(structuredClone(updated))
    }
    return Promise.resolve(resolved)
  }
}
