import { describe, expect, it } from 'vitest'

import {
  computeManifestHash,
  manifestEnvelopeSchema,
  manifestIngestionRecordSchema,
  type ManifestIngestionRecord,
} from '@agent-sentinel/connector-sdk'

import {
  CosmosManifestIngestionRepository,
  InMemoryManifestIngestionRepository,
} from '../src/index.js'
import { FakeCosmosStore } from './fake-cosmos.js'

const TENANT = 'tenant-a'
const ENVIRONMENT = 'validation'

function record(
  producedAt = '2026-08-28T00:00:00.000Z',
  ingestedAt = '2026-08-28T00:05:00.000Z',
  producerName = 'Partner Registry',
): ManifestIngestionRecord {
  const envelope = manifestEnvelopeSchema.parse({
    schemaVersion: '1.0',
    manifestId: 'partner-agents',
    tenantId: TENANT,
    environmentId: ENVIRONMENT,
    producedAt,
    producer: { name: producerName },
    capabilities: {
      supportsDiscovery: true,
      evidenceDepth: 'shallow',
      supportsRuntimeTelemetry: false,
      supportsActions: 'none',
    },
    agents: [],
    tools: [],
    identities: [],
    dataSources: [],
    mcpDependencies: [],
    edges: [],
    evidence: [],
    metadata: {},
  })
  return manifestIngestionRecordSchema.parse({
    tenantId: TENANT,
    environmentId: ENVIRONMENT,
    manifestId: envelope.manifestId,
    manifestHash: computeManifestHash(envelope),
    ingestedAt,
    ingestedBySubject: 'administrator-subject',
    envelope,
    snapshot: {
      tenantId: TENANT,
      environment: ENVIRONMENT,
      generatedAt: envelope.producedAt,
      nodes: [],
      edges: [],
      evidence: [],
    },
  })
}

describe.each([
  ['in-memory', () => new InMemoryManifestIngestionRepository(TENANT)],
  [
    'Cosmos',
    () =>
      new CosmosManifestIngestionRepository(new FakeCosmosStore().client, {
        tenantId: TENANT,
      }),
  ],
])('%s manifest ingestion repository', (_name, createRepository) => {
  it('is idempotent by content hash and returns only the latest manifest version', async () => {
    const repository = createRepository()
    const first = record()
    const next = record('2026-08-28T01:00:00.000Z', '2026-08-28T01:05:00.000Z')

    await expect(repository.save(first)).resolves.toMatchObject({ created: true })
    await expect(repository.save(first)).resolves.toMatchObject({ created: false })
    await expect(repository.save(next)).resolves.toMatchObject({ created: true })
    await expect(repository.listLatest(ENVIRONMENT)).resolves.toEqual([next])
  })

  it('rejects records outside its tenant boundary', async () => {
    const repository = createRepository()
    await expect(
      Promise.resolve().then(() => repository.save({ ...record(), tenantId: 'tenant-b' })),
    ).rejects.toThrow()
  })

  it('rejects conflicting content at the same manifest version timestamp', async () => {
    const repository = createRepository()
    await repository.save(record())
    await expect(
      Promise.resolve().then(() =>
        repository.save(
          record('2026-08-28T00:00:00.000Z', '2026-08-28T00:06:00.000Z', 'Different Producer'),
        ),
      ),
    ).rejects.toThrow('different manifest version')
  })

  it('orders producer timestamps chronologically after UTC normalization', async () => {
    const repository = createRepository()
    const older = record('2026-08-28T01:00:00+09:00', '2026-08-28T02:00:00.000Z')
    const newer = record('2026-08-27T23:00:00Z', '2026-08-28T01:00:00.000Z')
    await repository.save(older)
    await repository.save(newer)
    await expect(repository.listLatest(ENVIRONMENT)).resolves.toEqual([newer])
  })
})
