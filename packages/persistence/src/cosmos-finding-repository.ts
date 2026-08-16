import type { Container, CosmosClient } from '@azure/cosmos'

import type { Finding, FindingRepository } from '@agent-sentinel/domain'

type TenantFinding = Finding & { tenantId: string }

function getTenantId(finding: Finding): string {
  const tenantId = (finding as Partial<TenantFinding>).tenantId
  if (!tenantId) {
    throw new Error('Finding must include tenantId for persistence')
  }
  return tenantId
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }
  return error.code === 404
}

export class CosmosFindingRepository implements FindingRepository {
  private readonly container: Container

  constructor(client: CosmosClient, databaseId = 'agent-sentinel-db', containerId = 'findings') {
    this.container = client.database(databaseId).container(containerId)
  }

  async save(finding: Finding): Promise<void> {
    await this.container.items.upsert({
      ...finding,
      tenantId: getTenantId(finding),
      id: finding.id,
    })
  }

  async findById(id: string): Promise<Finding | null> {
    const query = {
      query: 'SELECT * FROM c WHERE c.id = @id',
      parameters: [{ name: '@id', value: id }],
    }
    const { resources } = await this.container.items.query<Finding>(query).fetchAll()
    return resources[0] ?? null
  }

  async listByTenantAndSeverity(tenantId: string, severity?: string): Promise<Finding[]> {
    const parameters: Array<{ name: string; value: string }> = [
      { name: '@tenantId', value: tenantId },
    ]
    let query = 'SELECT * FROM c WHERE c.tenantId = @tenantId'
    if (severity !== undefined) {
      query += ' AND c.severity = @severity'
      parameters.push({ name: '@severity', value: severity })
    }
    const { resources } = await this.container.items
      .query<Finding>({ query, parameters }, { partitionKey: tenantId })
      .fetchAll()
    return resources
  }

  async update(id: string, patch: Partial<Finding>): Promise<Finding> {
    const existing = await this.findById(id)
    if (!existing) {
      throw new Error(`Finding not found: ${id}`)
    }
    const updated = { ...existing, ...patch, id }
    const tenantId = getTenantId(updated)
    const { resource } = await this.container.item(id, tenantId).replace(updated)
    if (!resource) {
      throw new Error(`Cosmos DB did not return updated finding: ${id}`)
    }
    return resource
  }

  async delete(id: string): Promise<void> {
    const existing = await this.findById(id)
    if (!existing) {
      return
    }
    try {
      await this.container.item(id, getTenantId(existing)).delete()
    } catch (error: unknown) {
      if (!isNotFound(error)) {
        throw error
      }
    }
  }
}
