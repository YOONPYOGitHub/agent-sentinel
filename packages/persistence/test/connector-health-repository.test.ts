import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  ConnectorHealthConflictError,
  type ConnectorHealthMeasurement,
  type ConnectorHealthRepository,
  type ExactIdentityCorrelationDiagnostics,
} from '@agent-sentinel/connector-sdk'

import { CosmosConnectorHealthRepository, InMemoryConnectorHealthRepository } from '../src/index.js'
import { FakeCosmosStore } from './fake-cosmos.js'

const estateA = {
  id: 'estate-a',
  tenantId: 'tenant-a',
  environment: 'validation',
}
const estateB = {
  id: 'estate-b',
  tenantId: 'tenant-a',
  environment: 'validation',
}
const estateATenantB = {
  id: 'estate-a',
  tenantId: 'tenant-b',
  environment: 'validation',
}
const estateAProduction = {
  id: 'estate-a',
  tenantId: 'tenant-a',
  environment: 'production',
}

function measurement(
  connectorId: string,
  measuredAt: string,
  readiness: 'ready' | 'degraded' = 'ready',
  estate = estateA,
): ConnectorHealthMeasurement {
  return {
    estateId: estate.id,
    tenantId: estate.tenantId,
    environment: estate.environment,
    connectorId,
    measuredAt,
    health: {
      overall: readiness,
      partial: readiness === 'degraded',
      sources: [
        {
          id: `${connectorId}:primary`,
          name: 'Primary source',
          role: 'discovery',
          enabled: true,
          configured: true,
          readiness,
          checkedAt: measuredAt,
        },
      ],
    },
  }
}

function diagnosticMeasurement(
  overrides: Partial<ExactIdentityCorrelationDiagnostics> = {},
): ConnectorHealthMeasurement {
  const measuredAt = '2026-09-04T13:00:00.000Z'
  const diagnostics: ExactIdentityCorrelationDiagnostics = {
    kind: 'exact-identity-correlation',
    provider: 'microsoft-entra',
    sourceId: 'primary',
    sourceTenantId: estateA.tenantId,
    sourceEnvironment: estateA.environment,
    authoritativeAgentsConsidered: 2,
    exactObjectIdMatches: 1,
    exactApplicationIdMatches: 0,
    exactAgentIdentityMatches: 0,
    unmatched: 1,
    ambiguous: 0,
    runsAsEdgesEmitted: 1,
    ownerCoverage: { status: 'disabled', evidenceReferences: [] },
    appRoleCoverage: { status: 'disabled', evidenceReferences: [] },
    previewCoverage: { status: 'disabled', evidenceReferences: [] },
    evidenceReferences: ['evidence-agent-1', 'evidence-identity-1'],
    ...overrides,
  }
  return {
    ...measurement('foundry', measuredAt),
    health: {
      overall: 'ready',
      partial: false,
      sources: [
        {
          id: 'entra:primary',
          name: 'Primary Entra source',
          role: 'enrichment',
          enabled: true,
          configured: true,
          readiness: 'ready',
          checkedAt: measuredAt,
          diagnostics,
        },
      ],
    },
  }
}

function repositories(): Array<{
  name: string
  create: () => { repository: ConnectorHealthRepository; store?: FakeCosmosStore }
}> {
  return [
    {
      name: 'in-memory',
      create: () => ({ repository: new InMemoryConnectorHealthRepository() }),
    },
    {
      name: 'Cosmos',
      create: () => {
        const store = new FakeCosmosStore()
        return {
          repository: new CosmosConnectorHealthRepository(store.client),
          store,
        }
      },
    },
  ]
}

describe.each(repositories())('$name connector health repository', ({ create }) => {
  it('returns the latest measurement for one estate and connector source', async () => {
    const { repository } = create()
    const latest = measurement('foundry', '2026-09-04T13:05:00.000Z', 'degraded')
    const stale = measurement('foundry', '2026-09-04T13:00:00.000Z')

    await Promise.all([repository.save(estateA, latest), repository.save(estateA, stale)])

    await expect(repository.findLatest(estateA, 'foundry')).resolves.toEqual(latest)
  })

  it('atomically preserves the first concurrent measurement for the same identity', async () => {
    const { repository } = create()
    const measuredAt = '2026-09-04T13:00:00.000Z'
    const ready = measurement('foundry', measuredAt)
    const degraded = measurement('foundry', measuredAt, 'degraded')

    const results = await Promise.allSettled([
      repository.save(estateA, ready),
      repository.save(estateA, degraded),
    ])
    expect(results[0]).toMatchObject({ status: 'fulfilled' })
    expect(results[0]).toMatchObject({ status: 'fulfilled' })
    expect(results[1]?.status).toBe('rejected')
    if (results[1]?.status !== 'rejected') throw new Error('Expected the second write to conflict.')
    expect(results[1].reason).toBeInstanceOf(ConnectorHealthConflictError)
    await expect(repository.findLatest(estateA, 'foundry')).resolves.toEqual(ready)
  })

  it('treats concurrent byte-equivalent duplicates as idempotent', async () => {
    const { repository } = create()
    const first = diagnosticMeasurement()
    const duplicate = structuredClone(first)

    await expect(
      Promise.all([repository.save(estateA, first), repository.save(estateA, duplicate)]),
    ).resolves.toEqual([undefined, undefined])
    await expect(repository.findLatest(estateA, 'foundry')).resolves.toEqual(first)
  })

  it('round-trips optional snapshot binding while retaining legacy compatibility', async () => {
    const { repository } = create()
    const legacy = measurement('foundry', '2026-09-04T13:00:00.000Z')
    const bound = {
      ...measurement('foundry', '2026-09-04T13:05:00.000Z'),
      snapshotBinding: {
        snapshotGeneratedAt: '2026-09-04T13:04:00.000Z',
        evidenceDigest: 'a'.repeat(64),
      },
    }

    await repository.save(estateA, legacy)
    await repository.save(estateA, bound)

    await expect(repository.findLatest(estateA, 'foundry')).resolves.toEqual(bound)
  })

  it('conflicts when the same measurement identity has a different snapshot binding', async () => {
    const { repository } = create()
    const first = {
      ...measurement('foundry', '2026-09-04T13:00:00.000Z'),
      snapshotBinding: {
        snapshotGeneratedAt: '2026-09-04T12:59:00.000Z',
        evidenceDigest: 'a'.repeat(64),
      },
    }
    const conflicting = {
      ...structuredClone(first),
      snapshotBinding: {
        ...first.snapshotBinding,
        evidenceDigest: 'b'.repeat(64),
      },
    }

    await repository.save(estateA, first)
    await expect(repository.save(estateA, conflicting)).rejects.toBeInstanceOf(
      ConnectorHealthConflictError,
    )
    await expect(repository.findLatest(estateA, 'foundry')).resolves.toEqual(first)
  })

  it('does not partially overwrite health or diagnostics on conflict', async () => {
    const { repository } = create()
    const first = diagnosticMeasurement()
    const conflicting = {
      ...structuredClone(first),
      health: {
        ...structuredClone(first.health),
        overall: 'degraded' as const,
        partial: true,
        sources: first.health.sources.map((source) => ({
          ...structuredClone(source),
          readiness: 'degraded' as const,
        })),
      },
    }

    await repository.save(estateA, first)
    await expect(repository.save(estateA, conflicting)).rejects.toBeInstanceOf(
      ConnectorHealthConflictError,
    )
    await expect(repository.findLatest(estateA, 'foundry')).resolves.toEqual(first)
  })

  it('isolates measurements by estate and connector source', async () => {
    const { repository } = create()
    const first = measurement('foundry', '2026-09-04T13:00:00.000Z')
    const second = {
      ...measurement('entra', '2026-09-04T13:01:00.000Z', 'degraded'),
      estateId: estateB.id,
    }

    await repository.save(estateA, first)
    await repository.save(estateB, second)

    await expect(repository.findLatest(estateA, 'foundry')).resolves.toEqual(first)
    await expect(repository.findLatest(estateA, 'entra')).resolves.toBeNull()
    await expect(repository.findLatest(estateB, 'entra')).resolves.toEqual(second)
    await expect(repository.findLatest(estateB, 'foundry')).resolves.toBeNull()
  })

  it('rejects a measurement outside the target estate boundary', async () => {
    const { repository } = create()

    await expect(
      repository.save(estateA, {
        ...measurement('foundry', '2026-09-04T13:00:00.000Z'),
        tenantId: 'tenant-b',
      }),
    ).rejects.toThrow('boundary')
  })

  it('isolates the same estate and source identifiers across environments', async () => {
    const { repository } = create()
    const validation = measurement('foundry', '2026-09-04T13:00:00.000Z')
    const production = measurement(
      'foundry',
      '2026-09-04T13:00:00.000Z',
      'degraded',
      estateAProduction,
    )

    await repository.save(estateA, validation)
    await repository.save(estateAProduction, production)

    await expect(repository.findLatest(estateA, 'foundry')).resolves.toEqual(validation)
    await expect(repository.findLatest(estateAProduction, 'foundry')).resolves.toEqual(production)
  })

  it('isolates the same estate, environment, and source identifiers across tenants', async () => {
    const { repository } = create()
    const tenantA = measurement('foundry', '2026-09-04T13:00:00.000Z')
    const tenantB = measurement('foundry', '2026-09-04T13:01:00.000Z', 'degraded', estateATenantB)

    await repository.save(estateA, tenantA)
    await repository.save(estateATenantB, tenantB)

    await expect(repository.findLatest(estateA, 'foundry')).resolves.toEqual(tenantA)
    await expect(repository.findLatest(estateATenantB, 'foundry')).resolves.toEqual(tenantB)
  })

  it.each([
    {
      name: 'overlapping or missing correlation categories',
      measurement: diagnosticMeasurement({ unmatched: 0 }),
    },
    {
      name: 'a RUNS_AS count that differs from exact matches',
      measurement: diagnosticMeasurement({ runsAsEdgesEmitted: 0 }),
    },
  ])('rejects diagnostics with $name', async ({ measurement: invalid }) => {
    const { repository } = create()

    await expect(repository.save(estateA, invalid)).rejects.toThrow()
  })
})

describe('Cosmos connector health query', () => {
  it('partitions by tenant and filters every remaining scope dimension', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosConnectorHealthRepository(store.client)
    await repository.save(estateA, measurement('foundry', '2026-09-04T13:00:00.000Z'))

    await repository.findLatest(estateA, 'foundry')

    expect(store.queries).toEqual([
      {
        query:
          'SELECT TOP 1 * FROM c WHERE c.documentType = @documentType AND c.estateId = @estateId AND c.tenantId = @tenantId AND c.environment = @environment AND c.connectorId = @connectorId ORDER BY c.measuredAt DESC',
        parameters: [
          { name: '@documentType', value: 'connector-health-measurement' },
          { name: '@estateId', value: estateA.id },
          { name: '@tenantId', value: estateA.tenantId },
          { name: '@environment', value: estateA.environment },
          { name: '@connectorId', value: 'foundry' },
        ],
      },
    ])
  })

  it('rejects a stored measurement whose nested connector source does not match the document', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosConnectorHealthRepository(store.client)
    const storedAt = '2026-09-04T13:00:00.000Z'
    await store.client
      .database('agent-sentinel-db')
      .container('snapshots')
      .items.upsert({
        id: 'corrupt-connector-health',
        documentType: 'connector-health-measurement',
        estateId: estateA.id,
        tenantId: estateA.tenantId,
        environment: estateA.environment,
        connectorId: 'foundry',
        measuredAt: storedAt,
        measurement: measurement('entra', storedAt),
      })

    await expect(repository.findLatest(estateA, 'foundry')).rejects.toThrow('boundary')
  })

  it('does not collide when delimiter-containing tuple fields are saved concurrently', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosConnectorHealthRepository(store.client)
    const measuredAt = '2026-09-04T13:00:00.000Z'
    const expandedEnvironment = {
      ...estateA,
      environment: 'validation:west',
    }
    const first = measurement('otel', measuredAt, 'ready', expandedEnvironment)
    const second = measurement('west:otel', measuredAt, 'degraded', estateA)

    await Promise.all([
      repository.save(expandedEnvironment, first),
      repository.save(estateA, second),
    ])

    await expect(repository.findLatest(expandedEnvironment, 'otel')).resolves.toEqual(first)
    await expect(repository.findLatest(estateA, 'west:otel')).resolves.toEqual(second)
  })

  it('treats a physical ID collision with a different canonical tuple as a conflict', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosConnectorHealthRepository(store.client)
    const measuredAt = '2026-09-04T13:00:00.000Z'
    const incoming = measurement('foundry', measuredAt)
    const colliding = measurement('entra', measuredAt, 'degraded')
    const incomingTuple = JSON.stringify([
      incoming.estateId,
      incoming.tenantId,
      incoming.environment,
      incoming.connectorId,
      incoming.measuredAt,
    ])
    const id = `connector-health:${createHash('sha256').update(incomingTuple, 'utf8').digest('hex')}`
    await store.client
      .database('agent-sentinel-db')
      .container('snapshots')
      .items.create({
        id,
        documentType: 'connector-health-measurement',
        estateId: colliding.estateId,
        tenantId: colliding.tenantId,
        environment: colliding.environment,
        connectorId: colliding.connectorId,
        measuredAt: colliding.measuredAt,
        measurementBytes: JSON.stringify(colliding),
        measurement: colliding,
      })

    await expect(repository.save(estateA, incoming)).rejects.toBeInstanceOf(
      ConnectorHealthConflictError,
    )
    await expect(repository.findLatest(estateA, 'foundry')).resolves.toBeNull()
    await expect(repository.findLatest(estateA, 'entra')).resolves.toEqual(colliding)
  })

  it('rejects persisted diagnostics with inconsistent correlation accounting', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosConnectorHealthRepository(store.client)
    const storedAt = '2026-09-04T13:00:00.000Z'
    const corrupted = diagnosticMeasurement({ ambiguous: 1 })
    await store.client.database('agent-sentinel-db').container('snapshots').items.upsert({
      id: 'corrupt-diagnostics',
      documentType: 'connector-health-measurement',
      estateId: estateA.id,
      tenantId: estateA.tenantId,
      environment: estateA.environment,
      connectorId: 'foundry',
      measuredAt: storedAt,
      measurement: corrupted,
    })

    await expect(repository.findLatest(estateA, 'foundry')).rejects.toThrow()
  })
})
