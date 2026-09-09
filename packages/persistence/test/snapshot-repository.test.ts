import { describe, expect, it } from 'vitest'

import type { EstateSnapshot } from '@agent-sentinel/domain'

import { CosmosSnapshotRepository, InMemorySnapshotRepository } from '../src/index.js'
import { FakeCosmosStore } from './fake-cosmos.js'

const estate = {
  id: 'default',
  tenantId: 'tenant-a',
  environment: 'portfolio',
}

function legacyRuntimeSnapshot(exactProjectContext = true): unknown {
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
                estateId: estate.id,
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
})
