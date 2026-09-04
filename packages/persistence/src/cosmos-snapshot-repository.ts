import type { Container, CosmosClient, SqlQuerySpec } from '@azure/cosmos'

import type { EstateContext, EstateSnapshot, SnapshotRepository } from '@agent-sentinel/domain'

interface SnapshotDocument {
  id: string
  documentType: 'estate-snapshot'
  estateId: string
  tenantId: string
  environment: string
  snapshotId: string
  generatedAt: string
  snapshot: EstateSnapshot
}

interface LegacySnapshotDocument extends EstateSnapshot {
  id: string
  partitionKey?: string
}

type StoredSnapshot = SnapshotDocument | LegacySnapshotDocument

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === 404
}

function logicalSnapshotId(snapshot: EstateSnapshot): string {
  return `${snapshot.tenantId}-${snapshot.environment}-${snapshot.generatedAt}`
}

function physicalSnapshotId(estate: EstateContext, snapshotId: string): string {
  return `snapshot:${estate.id}:${snapshotId}`
}

function isSnapshotDocument(value: StoredSnapshot): value is SnapshotDocument {
  return 'documentType' in value && value.documentType === 'estate-snapshot'
}

function unwrapSnapshot(value: StoredSnapshot, estate: EstateContext): EstateSnapshot | null {
  if (isSnapshotDocument(value)) {
    return value.estateId === estate.id &&
      value.tenantId === estate.tenantId &&
      value.environment === estate.environment
      ? value.snapshot
      : null
  }
  return estate.id === 'default' &&
    value.tenantId === estate.tenantId &&
    value.environment === estate.environment
    ? value
    : null
}

function scopedSnapshotQuery(estate: EstateContext, suffix: string): SqlQuerySpec {
  return {
    query:
      'SELECT * FROM c WHERE c.tenantId = @tenantId AND c.environment = @environment ' +
      'AND ((c.documentType = "estate-snapshot" AND c.estateId = @estateId) ' +
      'OR (@allowLegacy = true AND NOT IS_DEFINED(c.documentType))) ' +
      suffix,
    parameters: [
      { name: '@tenantId', value: estate.tenantId },
      { name: '@environment', value: estate.environment },
      { name: '@estateId', value: estate.id },
      { name: '@allowLegacy', value: estate.id === 'default' },
    ],
  }
}

export class CosmosSnapshotRepository implements SnapshotRepository {
  private readonly container: Container

  constructor(client: CosmosClient, databaseId = 'agent-sentinel-db', containerId = 'snapshots') {
    this.container = client.database(databaseId).container(containerId)
  }

  async save(estate: EstateContext, snapshot: EstateSnapshot): Promise<void> {
    if (snapshot.tenantId !== estate.tenantId || snapshot.environment !== estate.environment) {
      throw new Error('Snapshot boundary does not match the target estate.')
    }
    const snapshotId = logicalSnapshotId(snapshot)
    await this.container.items.upsert<SnapshotDocument>({
      id: physicalSnapshotId(estate, snapshotId),
      documentType: 'estate-snapshot',
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      snapshotId,
      generatedAt: snapshot.generatedAt,
      snapshot,
    })
  }

  async findLatest(estate: EstateContext): Promise<EstateSnapshot | null> {
    const { resources } = await this.container.items
      .query<StoredSnapshot>(
        scopedSnapshotQuery(estate, 'ORDER BY c.generatedAt DESC OFFSET 0 LIMIT 2'),
        { partitionKey: estate.tenantId },
      )
      .fetchAll()
    for (const resource of resources) {
      const snapshot = unwrapSnapshot(resource, estate)
      if (snapshot !== null) return snapshot
    }
    return null
  }

  async findById(id: string, estate: EstateContext): Promise<EstateSnapshot | null> {
    const physicalId = physicalSnapshotId(estate, id)
    try {
      const { resource } = await this.container
        .item(physicalId, estate.tenantId)
        .read<SnapshotDocument>()
      if (resource !== undefined) return unwrapSnapshot(resource, estate)
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error
    }
    if (estate.id !== 'default') return null
    try {
      const { resource } = await this.container
        .item(id, estate.tenantId)
        .read<LegacySnapshotDocument>()
      return resource === undefined ? null : unwrapSnapshot(resource, estate)
    } catch (error: unknown) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async list(estate: EstateContext, limit = 100): Promise<EstateSnapshot[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 500))
    const query = scopedSnapshotQuery(
      estate,
      `ORDER BY c.generatedAt DESC OFFSET 0 LIMIT ${boundedLimit * 2}`,
    )
    const { resources } = await this.container.items
      .query<StoredSnapshot>(query, { partitionKey: estate.tenantId })
      .fetchAll()
    const snapshots = new Map<string, EstateSnapshot>()
    for (const resource of resources) {
      const snapshot = unwrapSnapshot(resource, estate)
      if (snapshot === null) continue
      const id = logicalSnapshotId(snapshot)
      if (!snapshots.has(id) || isSnapshotDocument(resource)) snapshots.set(id, snapshot)
    }
    return [...snapshots.values()]
      .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))
      .slice(0, boundedLimit)
  }
}
