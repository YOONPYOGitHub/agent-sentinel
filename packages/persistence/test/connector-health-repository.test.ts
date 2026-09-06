import { describe, expect, it } from 'vitest'

import type {
  ConnectorHealthMeasurement,
  ConnectorHealthRepository,
  ExactIdentityCorrelationDiagnostics,
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
