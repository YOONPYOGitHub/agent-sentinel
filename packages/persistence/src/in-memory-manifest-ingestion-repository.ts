import {
  manifestIngestionRecordSchema,
  ManifestIngestionSourceLimitError,
  MAX_MANIFEST_SOURCES,
  type ManifestIngestionRecord,
  type ManifestIngestionRepository,
} from '@agent-sentinel/connector-sdk'

export class InMemoryManifestIngestionRepository implements ManifestIngestionRepository {
  private readonly records = new Map<string, ManifestIngestionRecord>()

  constructor(private readonly tenantId: string) {
    if (tenantId.trim().length === 0) {
      throw new Error('A tenantId is required for manifest ingestion persistence.')
    }
  }

  save(
    recordInput: ManifestIngestionRecord,
  ): Promise<{ record: ManifestIngestionRecord; created: boolean }> {
    const record = manifestIngestionRecordSchema.parse(recordInput)
    if (record.tenantId !== this.tenantId) {
      throw new Error('Manifest ingestion tenant does not match the repository boundary.')
    }
    const existing = this.records.get(record.manifestHash)
    if (existing !== undefined) {
      return Promise.resolve({ record: structuredClone(existing), created: false })
    }
    const versionConflict = [...this.records.values()].some(
      (candidate) =>
        candidate.manifestId === record.manifestId &&
        candidate.envelope.producedAt === record.envelope.producedAt,
    )
    if (versionConflict) {
      throw new Error('A different manifest version already uses this manifestId and producedAt.')
    }
    this.records.set(record.manifestHash, structuredClone(record))
    return Promise.resolve({ record: structuredClone(record), created: true })
  }

  listLatest(
    environmentId: string,
    limit = MAX_MANIFEST_SOURCES,
  ): Promise<ManifestIngestionRecord[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), MAX_MANIFEST_SOURCES)
    const records = [...this.records.values()]
      .filter((record) => record.environmentId === environmentId)
      .sort(
        (left, right) =>
          right.envelope.producedAt.localeCompare(left.envelope.producedAt) ||
          left.manifestHash.localeCompare(right.manifestHash),
      )
    const latest = new Map<string, ManifestIngestionRecord>()
    for (const record of records) {
      if (!latest.has(record.manifestId)) latest.set(record.manifestId, record)
    }
    if (latest.size > boundedLimit) {
      throw new ManifestIngestionSourceLimitError(boundedLimit)
    }
    return Promise.resolve(structuredClone([...latest.values()]))
  }
}
