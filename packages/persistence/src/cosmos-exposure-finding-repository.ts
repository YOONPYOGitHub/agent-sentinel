import type { Container, CosmosClient } from '@azure/cosmos'

import type {
  ExposureFinding,
  ExposureFindingFacets,
  ExposureFindingListFilters,
  ExposureFindingRepository,
} from '@agent-sentinel/domain'

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const candidate = error as { code?: unknown }
  return candidate.code === 404
}

export function buildExposureFacetQuery(field: 'severity' | 'status' | 'policyId'): string {
  return `SELECT c.${field} AS facetValue, COUNT(1) AS facetCount FROM c WHERE c.tenantId = @tenantId GROUP BY c.${field}`
}

export class CosmosExposureFindingRepository implements ExposureFindingRepository {
  private readonly container: Container

  constructor(client: CosmosClient, databaseId = 'agent-sentinel-db', containerId = 'findings') {
    this.container = client.database(databaseId).container(containerId)
  }

  async upsert(finding: ExposureFinding): Promise<ExposureFinding> {
    let firstSeen = finding.firstSeen
    try {
      const { resource } = await this.container
        .item(finding.id, finding.tenantId)
        .read<ExposureFinding>()
      if (resource) firstSeen = resource.firstSeen
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error
    }
    const merged: ExposureFinding = { ...finding, firstSeen }
    await this.container.items.upsert<ExposureFinding>(merged)
    return merged
  }

  async findById(id: string, tenantId: string): Promise<ExposureFinding | null> {
    try {
      const { resource } = await this.container.item(id, tenantId).read<ExposureFinding>()
      return resource ?? null
    } catch (error: unknown) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async listByTenant(
    tenantId: string,
    filters: ExposureFindingListFilters = {},
  ): Promise<{ items: ExposureFinding[]; total: number }> {
    const parameters: Array<{ name: string; value: string }> = [
      { name: '@tenantId', value: tenantId },
    ]
    let where = 'c.tenantId = @tenantId'
    if (filters.severity !== undefined) {
      where += ' AND c.severity = @severity'
      parameters.push({ name: '@severity', value: filters.severity })
    }
    if (filters.status !== undefined) {
      where += ' AND c.status = @status'
      parameters.push({ name: '@status', value: filters.status })
    }
    if (filters.policyId !== undefined) {
      where += ' AND c.policyId = @policyId'
      parameters.push({ name: '@policyId', value: filters.policyId })
    }
    const query = `SELECT * FROM c WHERE ${where} ORDER BY c.riskScore DESC`
    const { resources } = await this.container.items
      .query<ExposureFinding>({ query, parameters }, { partitionKey: tenantId })
      .fetchAll()
    const search = filters.search?.trim().toLocaleLowerCase() ?? ''
    const searched =
      search.length === 0
        ? resources
        : resources.filter((finding) =>
            [
              finding.title,
              finding.summary,
              finding.affectedAgentName,
              finding.policyName,
              finding.policyId,
            ]
              .join(' ')
              .toLocaleLowerCase()
              .includes(search),
          )
    const total = searched.length
    const page = filters.page ?? 1
    const pageSize = filters.pageSize ?? 50
    const start = Math.max(0, (page - 1) * pageSize)
    return { items: searched.slice(start, start + pageSize), total }
  }

  async getFacets(tenantId: string): Promise<ExposureFindingFacets> {
    const facets: ExposureFindingFacets = { severity: {}, status: {}, policyId: {} }
    const dimensions = [
      ['severity', facets.severity],
      ['status', facets.status],
      ['policyId', facets.policyId],
    ] as const
    await Promise.all(
      dimensions.map(async ([field, target]) => {
        const { resources } = await this.container.items
          .query<{ facetValue: string; facetCount: number }>(
            {
              query: buildExposureFacetQuery(field),
              parameters: [{ name: '@tenantId', value: tenantId }],
            },
            { partitionKey: tenantId },
          )
          .fetchAll()
        for (const row of resources) target[row.facetValue] = row.facetCount
      }),
    )
    return facets
  }

  async resolveAbsent(tenantId: string, presentIds: readonly string[]): Promise<ExposureFinding[]> {
    const { resources } = await this.container.items
      .query<ExposureFinding>(
        {
          query:
            'SELECT * FROM c WHERE c.tenantId = @tenantId AND c.status != "resolved" AND c.status != "mitigated"',
          parameters: [{ name: '@tenantId', value: tenantId }],
        },
        { partitionKey: tenantId },
      )
      .fetchAll()
    const presentSet = new Set(presentIds)
    const now = new Date().toISOString()
    const resolved: ExposureFinding[] = []
    for (const finding of resources) {
      if (presentSet.has(finding.id)) continue
      const updated: ExposureFinding = { ...finding, status: 'resolved', lastSeen: now }
      await this.container.item(finding.id, tenantId).replace(updated)
      resolved.push(updated)
    }
    return resolved
  }
}
