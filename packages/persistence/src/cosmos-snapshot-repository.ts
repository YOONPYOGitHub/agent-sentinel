import type { Container, CosmosClient } from '@azure/cosmos'

import type { EstateSnapshot, SnapshotRepository } from '@agent-sentinel/domain'

interface SnapshotDocument extends EstateSnapshot {
  id: string
  partitionKey: string
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }
  return error.code === 404
}

export class CosmosSnapshotRepository implements SnapshotRepository {
  private readonly container: Container

  constructor(client: CosmosClient, databaseId = 'agent-sentinel-db', containerId = 'snapshots') {
    this.container = client.database(databaseId).container(containerId)
  }

  async save(snapshot: EstateSnapshot): Promise<void> {
    const id = `${snapshot.tenantId}-${snapshot.environment}-${snapshot.generatedAt}`
    await this.container.items.upsert<SnapshotDocument>({
      ...snapshot,
      id,
      partitionKey: snapshot.tenantId,
    })
  }

  async findLatest(tenantId: string, environment: string): Promise<EstateSnapshot | null> {
    const query = {
      query:
        'SELECT * FROM c WHERE c.tenantId = @tenantId AND c.environment = @environment ORDER BY c.generatedAt DESC OFFSET 0 LIMIT 1',
      parameters: [
        { name: '@tenantId', value: tenantId },
        { name: '@environment', value: environment },
      ],
    }
    const { resources } = await this.container.items
      .query<SnapshotDocument>(query, { partitionKey: tenantId })
      .fetchAll()
    return resources[0] ?? null
  }

  async findById(id: string): Promise<EstateSnapshot | null> {
    const tenantId = id.split('-', 1)[0]
    if (!tenantId) {
      return null
    }

    try {
      const { resource } = await this.container.item(id, tenantId).read<SnapshotDocument>()
      return resource ?? null
    } catch (error: unknown) {
      if (isNotFound(error)) {
        return null
      }
      throw error
    }
  }

  async list(tenantId: string, limit = 100): Promise<EstateSnapshot[]> {
    const query = {
      query:
        'SELECT * FROM c WHERE c.tenantId = @tenantId ORDER BY c.generatedAt DESC OFFSET 0 LIMIT @limit',
      parameters: [
        { name: '@tenantId', value: tenantId },
        { name: '@limit', value: limit },
      ],
    }
    const { resources } = await this.container.items
      .query<SnapshotDocument>(query, { partitionKey: tenantId })
      .fetchAll()
    return resources
  }
}
