import { describe, expect, it } from 'vitest'

import type {
  EstateSnapshot,
  RuntimeOtelProvenance,
  SnapshotRepository,
} from '@agent-sentinel/domain'

import { CosmosSnapshotRepository, InMemorySnapshotRepository } from '../src/index.js'
import { FakeCosmosStore } from './fake-cosmos.js'

const estate = {
  id: 'default',
  tenantId: 'tenant-a',
  environment: 'portfolio',
}

function legacyRuntimeSnapshot(
  exactProjectContext = true,
  provenanceEstateId = estate.id,
): unknown {
  const generatedAt = '2026-09-09T00:00:00.000Z'
  return {
    tenantId: estate.tenantId,
    environment: estate.environment,
    generatedAt,
    nodes: [
      {
        id: 'agent-a',
        kind: 'agent',
        name: 'Agent A',
        description: 'Authoritative agent.',
        environment: 'production',
        evidenceIds: ['declared-agent', 'runtime-observed'],
        metadata: {
          sourceOfTruth: 'true',
          sourceConnectorId: 'primary',
          sourceTenantId: estate.tenantId,
          sourceProjectId: 'project-a',
          sourceObjectId: 'provider-agent-a',
          sourceEnvironment: 'production',
        },
      },
    ],
    edges: [],
    evidence: [
      {
        id: 'declared-agent',
        source: 'Foundry',
        sourceObjectId: 'provider-agent-a',
        observedAt: generatedAt,
        freshness: 'live',
        confidence: 1,
        evidenceTypes: ['declared_configuration'],
        summary: 'Declared agent.',
        metadata: {
          sourceOfTruth: 'true',
          estateTenantId: estate.tenantId,
          estateEnvironment: estate.environment,
          sourceConnectorId: 'primary',
          sourceTenantId: estate.tenantId,
          ...(exactProjectContext ? { sourceProjectId: 'project-a' } : {}),
          sourceEnvironment: 'production',
          sourceObjectId: 'provider-agent-a',
        },
      },
      {
        id: 'runtime-observed',
        source: 'Azure Monitor OpenTelemetry',
        sourceObjectId: 'observed-window',
        observedAt: '2026-09-08T12:00:00.000Z',
        freshness: 'live',
        confidence: 1,
        evidenceTypes: ['observed_runtime'],
        summary: 'One measured invocation.',
        metadata: {
          sourceConnector: 'azure-monitor-otel',
          windowKind: 'observed',
        },
        otel: {
          quality: {
            status: 'available',
            classification: 'live',
            caveats: [],
            recordsReceived: 1,
            recordsAccepted: 1,
            duplicatesRemoved: 0,
            pagesProcessed: 1,
          },
          invocations: [
            {
              id: 'invocation-a',
              observedAt: '2026-09-08T12:00:00.000Z',
              latencyMs: 42,
              inputTokens: 10,
              outputTokens: 5,
              costUsd: 0.001,
              success: true,
              provenance: {
                estateId: provenanceEstateId,
                estateTenantId: estate.tenantId,
                estateEnvironment: estate.environment,
                sourceConnectorId: 'primary',
                sourceTenantId: estate.tenantId,
                sourceEnvironment: 'production',
                provider: 'azure-monitor-otel',
                providerResourceId: '/subscriptions/example/resource',
                providerAgentId: 'provider-agent-a',
                traceId: '11111111111111111111111111111111',
                spanId: 'aaaaaaaaaaaaaaaa',
                observedAt: '2026-09-08T12:00:00.000Z',
                classification: 'live',
                sampling: { state: 'complete', rate: 1 },
                aggregation: { kind: 'raw' },
                partial: false,
                evidenceIds: ['invocation', 'latency', 'error', 'input-tokens', 'output-tokens'],
              },
            },
          ],
        },
      },
    ],
  }
}

function legacyEmptyRuntimeSnapshot(): unknown {
  const snapshot = legacyRuntimeSnapshot() as {
    evidence: Array<{
      otel?: {
        quality: {
          status: string
          classification: string
          caveats: string[]
          recordsReceived: number
          recordsAccepted: number
          duplicatesRemoved: number
          pagesProcessed: number
        }
        invocations: unknown[]
      }
    }>
  }
  const runtime = snapshot.evidence[1]?.otel
  if (runtime === undefined) throw new Error('Expected legacy runtime evidence.')
  runtime.quality = {
    status: 'unknown',
    classification: 'unknown',
    caveats: ['empty'],
    recordsReceived: 0,
    recordsAccepted: 0,
    duplicatesRemoved: 0,
    pagesProcessed: 1,
  }
  runtime.invocations = []
  return snapshot
}

function currentRuntimeSnapshot(): EstateSnapshot {
  const snapshot = legacyRuntimeSnapshot() as EstateSnapshot
  const node = snapshot.nodes[0]
  const declared = snapshot.evidence[0]
  const runtime = snapshot.evidence[1]
  const invocation = runtime?.otel?.invocations[0]
  if (
    node === undefined ||
    declared === undefined ||
    runtime === undefined ||
    invocation === undefined
  ) {
    throw new Error('Expected one complete runtime snapshot fixture.')
  }
  node.metadata = {
    ...node.metadata,
    estateId: estate.id,
    estateTenantId: estate.tenantId,
    estateEnvironment: estate.environment,
  }
  declared.metadata = {
    ...declared.metadata,
    estateId: estate.id,
  }
  runtime.metadata = {
    ...runtime.metadata,
    estateId: estate.id,
    estateTenantId: estate.tenantId,
    estateEnvironment: estate.environment,
    sourceConnectorId: 'primary',
    sourceTenantId: estate.tenantId,
    sourceProjectId: 'project-a',
    sourceEnvironment: 'production',
    sourceAgentId: 'provider-agent-a',
  }
  invocation.toolCallNames = []
  invocation.provenance = {
    ...invocation.provenance,
    sourceProjectId: 'project-a',
    snapshotGeneratedAt: snapshot.generatedAt,
  }
  return snapshot
}

function invocationProvenance(snapshot: EstateSnapshot): RuntimeOtelProvenance {
  const provenance = snapshot.evidence[1]?.otel?.invocations[0]?.provenance
  if (provenance === undefined) throw new Error('Expected runtime invocation provenance.')
  return provenance
}

const repositoryFactories: ReadonlyArray<{
  name: string
  create: () => SnapshotRepository
}> = [
  {
    name: 'in-memory',
    create: () => new InMemorySnapshotRepository(),
  },
  {
    name: 'Cosmos',
    create: () => new CosmosSnapshotRepository(new FakeCosmosStore().client),
  },
]

describe('snapshot persistence compatibility', () => {
  it('keeps current in-memory and Cosmos writes strict', async () => {
    const malformed = legacyRuntimeSnapshot() as EstateSnapshot
    const store = new FakeCosmosStore()

    await expect(new InMemorySnapshotRepository().save(estate, malformed)).rejects.toThrow()
    await expect(
      new CosmosSnapshotRepository(store.client).save(estate, malformed),
    ).rejects.toThrow()
    expect(store.snapshot()).toEqual([])

    const current: EstateSnapshot = {
      tenantId: estate.tenantId,
      environment: estate.environment,
      generatedAt: '2026-09-10T00:00:00.000Z',
      nodes: [],
      edges: [],
      evidence: [],
    }
    await new CosmosSnapshotRepository(store.client).save(estate, current)
    expect(store.snapshot()).toEqual([
      expect.objectContaining({
        documentType: 'estate-snapshot',
        snapshotSchemaVersion: 2,
        snapshot: current,
      }),
    ])
  })

  it('hydrates legacy runtime invocation fields from one exact persisted snapshot context', async () => {
    const store = new FakeCosmosStore()
    await store.client
      .database('agent-sentinel-db')
      .container('snapshots')
      .items.upsert({
        id: `snapshot:${estate.id}:${estate.tenantId}-${estate.environment}-2026-09-09T00:00:00.000Z`,
        documentType: 'estate-snapshot',
        estateId: estate.id,
        tenantId: estate.tenantId,
        environment: estate.environment,
        snapshotId: `${estate.tenantId}-${estate.environment}-2026-09-09T00:00:00.000Z`,
        generatedAt: '2026-09-09T00:00:00.000Z',
        snapshot: legacyRuntimeSnapshot(),
      })

    const snapshot = await new CosmosSnapshotRepository(store.client).findLatest(estate)
    if (snapshot === null) throw new Error('Expected a hydrated snapshot.')

    expect(snapshot?.evidence[1]?.otel?.invocations[0]).toMatchObject({
      toolCallNames: [],
      provenance: {
        sourceProjectId: 'project-a',
        snapshotGeneratedAt: snapshot.generatedAt,
      },
    })
  })

  it('marks legacy runtime evidence migration-required when project authority is not exact', async () => {
    const store = new FakeCosmosStore()
    await store.client
      .database('agent-sentinel-db')
      .container('snapshots')
      .items.upsert({
        id: `snapshot:${estate.id}:${estate.tenantId}-${estate.environment}-2026-09-09T00:00:00.000Z`,
        documentType: 'estate-snapshot',
        estateId: estate.id,
        tenantId: estate.tenantId,
        environment: estate.environment,
        snapshotId: `${estate.tenantId}-${estate.environment}-2026-09-09T00:00:00.000Z`,
        generatedAt: '2026-09-09T00:00:00.000Z',
        snapshot: legacyRuntimeSnapshot(false),
      })

    const snapshot = await new CosmosSnapshotRepository(store.client).findLatest(estate)

    expect(snapshot?.evidence[1]).toMatchObject({
      confidence: 0,
      evidenceTypes: ['unknown'],
      metadata: {
        isNonAuthoritative: 'true',
        migrationStatus: 'migration-required',
        migrationReason: 'legacy-runtime-evidence-missing-exact-source-context',
      },
    })
    expect(snapshot?.evidence[1]).not.toHaveProperty('otel')
  })

  it.each([
    ['an explicit version-1 wrapper', 1],
    ['an unversioned wrapper', undefined],
  ])(
    'marks legacy runtime evidence migration-required for cross-estate provenance in %s',
    async (_label, snapshotSchemaVersion) => {
      const store = new FakeCosmosStore()
      await store.client
        .database('agent-sentinel-db')
        .container('snapshots')
        .items.upsert({
          id: `snapshot:${estate.id}:${estate.tenantId}-${estate.environment}-2026-09-09T00:00:00.000Z`,
          documentType: 'estate-snapshot',
          estateId: estate.id,
          tenantId: estate.tenantId,
          environment: estate.environment,
          snapshotId: `${estate.tenantId}-${estate.environment}-2026-09-09T00:00:00.000Z`,
          generatedAt: '2026-09-09T00:00:00.000Z',
          ...(snapshotSchemaVersion === undefined ? {} : { snapshotSchemaVersion }),
          snapshot: legacyRuntimeSnapshot(true, 'other-estate'),
        })

      const snapshot = await new CosmosSnapshotRepository(store.client).findLatest(estate)

      expect(snapshot?.evidence[1]).toMatchObject({
        confidence: 0,
        evidenceTypes: ['unknown'],
        metadata: {
          isNonAuthoritative: 'true',
          migrationStatus: 'migration-required',
          migrationReason: 'legacy-runtime-evidence-missing-exact-source-context',
        },
      })
      expect(snapshot?.evidence[1]).not.toHaveProperty('otel')
    },
  )

  it('selects version-1 migration before current parsing for empty invocation evidence', async () => {
    const store = new FakeCosmosStore()
    await store.client
      .database('agent-sentinel-db')
      .container('snapshots')
      .items.upsert({
        id: `snapshot:${estate.id}:${estate.tenantId}-${estate.environment}-2026-09-09T00:00:00.000Z`,
        documentType: 'estate-snapshot',
        estateId: estate.id,
        tenantId: estate.tenantId,
        environment: estate.environment,
        snapshotId: `${estate.tenantId}-${estate.environment}-2026-09-09T00:00:00.000Z`,
        generatedAt: '2026-09-09T00:00:00.000Z',
        snapshotSchemaVersion: 1,
        snapshot: legacyEmptyRuntimeSnapshot(),
      })

    const snapshot = await new CosmosSnapshotRepository(store.client).findLatest(estate)

    expect(snapshot?.evidence[1]).toMatchObject({
      confidence: 0,
      evidenceTypes: ['unknown'],
      metadata: {
        isNonAuthoritative: 'true',
        migrationStatus: 'migration-required',
        migrationReason: 'legacy-runtime-evidence-missing-exact-source-context',
      },
    })
    expect(snapshot?.evidence[1]).not.toHaveProperty('otel')
  })

  it('retains schema-version-2 empty invocation evidence as a strict current snapshot', async () => {
    const store = new FakeCosmosStore()
    const current = legacyEmptyRuntimeSnapshot() as EstateSnapshot
    await new CosmosSnapshotRepository(store.client).save(estate, current)

    const snapshot = await new CosmosSnapshotRepository(store.client).findLatest(estate)

    expect(snapshot?.evidence[1]).toMatchObject({
      confidence: 1,
      evidenceTypes: ['observed_runtime'],
      otel: {
        quality: {
          status: 'unknown',
          caveats: ['empty'],
        },
        invocations: [],
      },
    })
  })
})

describe.each(repositoryFactories)(
  '$name version-2 snapshot provenance validation',
  ({ create }) => {
    it('accepts an exact nested invocation provenance binding', async () => {
      const repository = create()
      const snapshot = currentRuntimeSnapshot()

      await repository.save(estate, snapshot)

      await expect(repository.findLatest(estate)).resolves.toEqual(snapshot)
    })

    it.each([
      [
        'estate ID',
        (provenance: RuntimeOtelProvenance) => {
          provenance.estateId = 'other-estate'
        },
      ],
      [
        'estate tenant',
        (provenance: RuntimeOtelProvenance) => {
          provenance.estateTenantId = 'other-tenant'
        },
      ],
      [
        'estate environment',
        (provenance: RuntimeOtelProvenance) => {
          provenance.estateEnvironment = 'other-environment'
        },
      ],
      [
        'snapshot generation',
        (provenance: RuntimeOtelProvenance) => {
          provenance.snapshotGeneratedAt = '2026-09-10T00:00:00.000Z'
        },
      ],
      [
        'source connector',
        (provenance: RuntimeOtelProvenance) => {
          provenance.sourceConnectorId = 'other-source'
        },
      ],
      [
        'source tenant',
        (provenance: RuntimeOtelProvenance) => {
          provenance.sourceTenantId = 'other-source-tenant'
        },
      ],
      [
        'source project',
        (provenance: RuntimeOtelProvenance) => {
          provenance.sourceProjectId = 'other-project'
        },
      ],
      [
        'source environment',
        (provenance: RuntimeOtelProvenance) => {
          provenance.sourceEnvironment = 'other-source-environment'
        },
      ],
      [
        'provider agent',
        (provenance: RuntimeOtelProvenance) => {
          provenance.providerAgentId = 'other-provider-agent'
        },
      ],
      [
        'invocation observation',
        (provenance: RuntimeOtelProvenance) => {
          provenance.observedAt = '2026-09-08T13:00:00.000Z'
        },
      ],
    ])('rejects a nested invocation with mismatched %s', async (_label, mutate) => {
      const snapshot = currentRuntimeSnapshot()
      mutate(invocationProvenance(snapshot))

      await expect(create().save(estate, snapshot)).rejects.toThrow(
        'OpenTelemetry invocation provenance',
      )
    })
  },
)
