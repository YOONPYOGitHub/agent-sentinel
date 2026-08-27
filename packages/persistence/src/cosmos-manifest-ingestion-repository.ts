import type { Container, CosmosClient } from '@azure/cosmos'

import {
  manifestIngestionRecordSchema,
  type ManifestIngestionRecord,
  type ManifestIngestionRepository,
} from '@agent-sentinel/connector-sdk'

const DOCUMENT_TYPE = 'manifest-ingestion'
interface ManifestIngestionDocument extends ManifestIngestionRecord {
  id: string
  documentType: typeof DOCUMENT_TYPE
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if ('code' in error && typeof error.code === 'number') return error.code
  if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode
  return undefined
}

function documentId(manifestHash: string): string {
  return `ingestion:${manifestHash}`
}

function recordFromDocument(document: ManifestIngestionDocument): ManifestIngestionRecord {
  return manifestIngestionRecordSchema.parse({
    tenantId: document.tenantId,
    environmentId: document.environmentId,
    manifestId: document.manifestId,
    manifestHash: document.manifestHash,
    ingestedAt: document.ingestedAt,
    ingestedBySubject: document.ingestedBySubject,
    envelope: document.envelope,
    snapshot: document.snapshot,
  })
}

export interface CosmosManifestIngestionRepositoryOptions {
  tenantId: string
  databaseId?: string
  containerId?: string
}

export class CosmosManifestIngestionRepository implements ManifestIngestionRepository {
  private readonly container: Container
  private readonly tenantId: string

  constructor(client: CosmosClient, options: CosmosManifestIngestionRepositoryOptions) {
    this.tenantId = options.tenantId.trim()
    if (this.tenantId.length === 0) {
      throw new Error('A tenantId is required for manifest ingestion persistence.')
    }
    this.container = client
      .database(options.databaseId ?? 'agent-sentinel-db')
      .container(options.containerId ?? 'manifest-ingestions')
  }

  async save(
    recordInput: ManifestIngestionRecord,
  ): Promise<{ record: ManifestIngestionRecord; created: boolean }> {
    const record = manifestIngestionRecordSchema.parse(recordInput)
    if (record.tenantId !== this.tenantId) {
      throw new Error('Manifest ingestion tenant does not match the repository boundary.')
    }
    const document: ManifestIngestionDocument = {
      ...record,
      id: documentId(record.manifestHash),
      documentType: DOCUMENT_TYPE,
    }
    try {
      await this.container.items.create(document)
      return { record: structuredClone(record), created: true }
    } catch (error: unknown) {
      if (statusCode(error) !== 409) throw error
      const existing = await this.read(record.manifestHash)
      if (existing === null) {
        throw new Error('A different manifest version already uses this manifestId and producedAt.')
      }
      return { record: existing, created: false }
    }
  }

  async listLatest(environmentId: string, limit = 100): Promise<ManifestIngestionRecord[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 500)
    const { resources: manifestIds } = await this.container.items
      .query<string>(
        {
          query:
            'SELECT DISTINCT VALUE c.manifestId FROM c WHERE c.documentType = @documentType AND c.environmentId = @environmentId',
          parameters: [
            { name: '@documentType', value: DOCUMENT_TYPE },
            { name: '@environmentId', value: environmentId },
          ],
        },
        { partitionKey: this.tenantId },
      )
      .fetchAll()
    if (manifestIds.length > boundedLimit) {
      throw new Error(`Manifest ingestion source limit (${boundedLimit}) exceeded.`)
    }
    const records = await Promise.all(
      manifestIds.sort().map(async (manifestId) => {
        const { resources } = await this.container.items
          .query<ManifestIngestionDocument>(
            {
              query:
                'SELECT TOP 1 * FROM c WHERE c.documentType = @documentType AND c.environmentId = @environmentId AND c.manifestId = @manifestId ORDER BY c.envelope.producedAt DESC',
              parameters: [
                { name: '@documentType', value: DOCUMENT_TYPE },
                { name: '@environmentId', value: environmentId },
                { name: '@manifestId', value: manifestId },
              ],
            },
            { partitionKey: this.tenantId },
          )
          .fetchAll()
        const document = resources[0]
        if (document === undefined) {
          throw new Error(`Latest manifest ingestion record was not found: ${manifestId}`)
        }
        return recordFromDocument(document)
      }),
    )
    return structuredClone(records)
  }

  private async read(manifestHash: string): Promise<ManifestIngestionRecord | null> {
    try {
      const { resource } = await this.container
        .item(documentId(manifestHash), this.tenantId)
        .read<ManifestIngestionDocument>()
      return resource === undefined ? null : recordFromDocument(resource)
    } catch (error: unknown) {
      if (statusCode(error) === 404) return null
      throw error
    }
  }
}
