import type { Container, CosmosClient, SqlQuerySpec } from '@azure/cosmos'

import type {
  EstateContext,
  ExposureFinding,
  ExposureFindingFacets,
  ExposureFindingListFilters,
  ExposureFindingRepository,
} from '@agent-sentinel/domain'

interface ExposureFindingDocument {
  id: string
  documentType: 'exposure-finding'
  estateId: string
  tenantId: string
  environment: string
  findingId: string
  finding: ExposureFinding
}

type StoredFinding = ExposureFindingDocument | ExposureFinding

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === 404
}

function isFindingDocument(value: StoredFinding): value is ExposureFindingDocument {
  return 'documentType' in value && value.documentType === 'exposure-finding'
}

function physicalFindingId(estate: EstateContext, findingId: string): string {
  return `finding:${estate.id}:${findingId}`
}

function legacySnapshotPrefix(estate: EstateContext): string {
  return `${estate.tenantId}-${estate.environment}-`
}

function unwrapFinding(value: StoredFinding, estate: EstateContext): ExposureFinding | null {
  if (isFindingDocument(value)) {
    return value.estateId === estate.id &&
      value.tenantId === estate.tenantId &&
      value.environment === estate.environment &&
      value.finding.tenantId === estate.tenantId
      ? value.finding
      : null
  }
  return estate.id === 'default' &&
    value.tenantId === estate.tenantId &&
    value.snapshotId.startsWith(legacySnapshotPrefix(estate))
    ? value
    : null
}

function scopeWhere(estate: EstateContext): {
  where: string
  parameters: Array<{ name: string; value: string | boolean }>
} {
  return {
    where:
      'c.tenantId = @tenantId AND ((c.documentType = "exposure-finding" ' +
      'AND c.estateId = @estateId AND c.environment = @environment) ' +
      'OR (@allowLegacy = true AND NOT IS_DEFINED(c.documentType) ' +
      'AND STARTSWITH(c.snapshotId, @legacySnapshotPrefix)))',
    parameters: [
      { name: '@tenantId', value: estate.tenantId },
      { name: '@estateId', value: estate.id },
      { name: '@environment', value: estate.environment },
      { name: '@allowLegacy', value: estate.id === 'default' },
      { name: '@legacySnapshotPrefix', value: legacySnapshotPrefix(estate) },
    ],
  }
}

function fieldExpression(field: string): string {
  return `IIF(IS_DEFINED(c.finding), c.finding.${field}, c.${field})`
}

export class CosmosExposureFindingRepository implements ExposureFindingRepository {
  private readonly container: Container

  constructor(client: CosmosClient, databaseId = 'agent-sentinel-db', containerId = 'findings') {
    this.container = client.database(databaseId).container(containerId)
  }

  private async readStored(id: string, estate: EstateContext): Promise<StoredFinding | null> {
    try {
      const { resource } = await this.container
        .item(physicalFindingId(estate, id), estate.tenantId)
        .read<ExposureFindingDocument>()
      if (resource !== undefined) return resource
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error
    }
    if (estate.id !== 'default') return null
    try {
      const { resource } = await this.container.item(id, estate.tenantId).read<ExposureFinding>()
      return resource ?? null
    } catch (error: unknown) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  private async write(estate: EstateContext, finding: ExposureFinding): Promise<void> {
    await this.container.items.upsert<ExposureFindingDocument>({
      id: physicalFindingId(estate, finding.id),
      documentType: 'exposure-finding',
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      findingId: finding.id,
      finding,
    })
  }

  async upsert(estate: EstateContext, finding: ExposureFinding): Promise<ExposureFinding> {
    if (finding.tenantId !== estate.tenantId) {
      throw new Error('Exposure finding tenant does not match the target estate.')
    }
    const existing = await this.readStored(finding.id, estate)
    const previous = existing === null ? null : unwrapFinding(existing, estate)
    const merged: ExposureFinding = {
      ...finding,
      firstSeen: previous?.firstSeen ?? finding.firstSeen,
    }
    await this.write(estate, merged)
    return merged
  }

  async findById(id: string, estate: EstateContext): Promise<ExposureFinding | null> {
    const stored = await this.readStored(id, estate)
    return stored === null ? null : unwrapFinding(stored, estate)
  }

  private async readAll(
    estate: EstateContext,
    filters: ExposureFindingListFilters = {},
  ): Promise<ExposureFinding[]> {
    const scoped = scopeWhere(estate)
    const parameters = [...scoped.parameters]
    let where = scoped.where
    if (filters.severity !== undefined) {
      where += ` AND ${fieldExpression('severity')} = @severity`
      parameters.push({ name: '@severity', value: filters.severity })
    }
    if (filters.status !== undefined) {
      where += ` AND ${fieldExpression('status')} = @status`
      parameters.push({ name: '@status', value: filters.status })
    }
    if (filters.policyId !== undefined) {
      where += ` AND ${fieldExpression('policyId')} = @policyId`
      parameters.push({ name: '@policyId', value: filters.policyId })
    }
    const query: SqlQuerySpec = {
      query: `SELECT * FROM c WHERE ${where}`,
      parameters,
    }
    const { resources } = await this.container.items
      .query<StoredFinding>(query, { partitionKey: estate.tenantId })
      .fetchAll()
    const findings = new Map<string, ExposureFinding>()
    for (const resource of resources) {
      const finding = unwrapFinding(resource, estate)
      if (finding === null) continue
      if (!findings.has(finding.id) || isFindingDocument(resource))
        findings.set(finding.id, finding)
    }
    return [...findings.values()].sort((left, right) => right.riskScore - left.riskScore)
  }

  async listByTenant(
    estate: EstateContext,
    filters: ExposureFindingListFilters = {},
  ): Promise<{ items: ExposureFinding[]; total: number }> {
    const search = filters.search?.trim().toLocaleLowerCase() ?? ''
    const searched = (await this.readAll(estate, filters)).filter((finding) => {
      if (search.length === 0) return true
      return [
        finding.title,
        finding.summary,
        finding.affectedAgentName,
        finding.policyName,
        finding.policyId,
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(search)
    })
    const total = searched.length
    const page = filters.page ?? 1
    const pageSize = filters.pageSize ?? 50
    const start = Math.max(0, (page - 1) * pageSize)
    return { items: searched.slice(start, start + pageSize), total }
  }

  async getFacets(estate: EstateContext): Promise<ExposureFindingFacets> {
    const facets: ExposureFindingFacets = { severity: {}, status: {}, policyId: {} }
    for (const finding of await this.readAll(estate)) {
      facets.severity[finding.severity] = (facets.severity[finding.severity] ?? 0) + 1
      facets.status[finding.status] = (facets.status[finding.status] ?? 0) + 1
      facets.policyId[finding.policyId] = (facets.policyId[finding.policyId] ?? 0) + 1
    }
    return facets
  }

  async resolveAbsent(
    estate: EstateContext,
    presentIds: readonly string[],
    sourceModes?: readonly ExposureFinding['sourceMode'][],
  ): Promise<ExposureFinding[]> {
    const findings = await this.readAll(estate)
    const presentSet = new Set(presentIds)
    const sourceModeSet = sourceModes === undefined ? undefined : new Set(sourceModes)
    const now = new Date().toISOString()
    const resolved: ExposureFinding[] = []
    for (const finding of findings) {
      if (finding.status === 'resolved' || finding.status === 'mitigated') continue
      if (sourceModeSet !== undefined && !sourceModeSet.has(finding.sourceMode)) continue
      if (presentSet.has(finding.id)) continue
      const updated: ExposureFinding = { ...finding, status: 'resolved', lastSeen: now }
      await this.write(estate, updated)
      resolved.push(updated)
    }
    return resolved
  }
}
