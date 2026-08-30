import { describe, expect, it } from 'vitest'
import { tokenEconomicsReportSchema } from '@agent-sentinel/domain'
import { createApp } from '../src/app.js'
import type { ExposureFindingRepository, SnapshotRepository } from '@agent-sentinel/domain'
import {
  createFailingRuntimeTelemetryFixture,
  createRuntimeTelemetryFixture,
  createSyntheticCanaryTelemetryFixture,
} from './runtime-telemetry-fixture.js'
import { tokenEconomicsAttributionForAgent } from '../src/token-economics-routes.js'

function makeStubRepositories(): {
  exposureRepository: ExposureFindingRepository
  snapshotRepository: SnapshotRepository
} {
  const snapshot = {
    tenantId: 'tenant-demo',
    environment: 'validation',
    generatedAt: '2026-08-28T00:00:00.000Z',
    nodes: [
      {
        id: 'live-agent',
        kind: 'agent' as const,
        name: 'Live agent',
        description: 'Test agent.',
        environment: 'production',
        owner: 'Runtime Platform',
        evidenceIds: ['evidence-1'],
        metadata: {
          businessUnit: 'Engineering',
          sourceConnectorId: 'primary',
          sourceTenantId: 'tenant-demo',
          sourceEnvironment: 'production',
          sourceObjectId: 'live-agent',
        },
      },
    ],
    edges: [],
    evidence: [
      {
        id: 'evidence-1',
        source: 'Foundry',
        sourceObjectId: 'live-agent',
        observedAt: '2026-08-28T00:00:00.000Z',
        freshness: 'live' as const,
        confidence: 1,
        evidenceTypes: ['declared_configuration' as const],
        summary: 'Declared configuration.',
      },
    ],
  }
  return {
    exposureRepository: {
      upsert: (f) => Promise.resolve(f),
      findById: () => Promise.resolve(null),
      listByTenant: () => Promise.resolve({ items: [], total: 0 }),
      getFacets: () => Promise.resolve({ severity: {}, status: {}, policyId: {} }),
      resolveAbsent: () => Promise.resolve([]),
    },
    snapshotRepository: {
      save: () => Promise.resolve(),
      findLatest: () => Promise.resolve(snapshot),
      findById: () => Promise.resolve(snapshot),
      list: () => Promise.resolve([snapshot]),
    },
  }
}

async function makeMockApp() {
  process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
  return createApp(
    undefined,
    { mode: 'disabled', allowedScopes: { read: [], write: [] } },
    { dataMode: 'mock' },
  )
}

async function makeFoundryApp() {
  return createApp(
    undefined,
    { mode: 'disabled', allowedScopes: { read: [], write: [] } },
    { dataMode: 'live', runtimeTelemetryConnector: null, ...makeStubRepositories() },
  )
}

describe('token economics API - mock mode', () => {
  it('reports an unavailable source snapshot separately from an unknown agent', () => {
    expect(tokenEconomicsAttributionForAgent(undefined, 'agent-a')).toEqual({
      status: 'unknown',
      reason: 'source-snapshot-unavailable',
    })
  })

  it('returns ready status for hr-policy-agent (healthy with cost)', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/hr-policy-agent',
    })
    expect(response.statusCode).toBe(200)
    const result = tokenEconomicsReportSchema.parse(response.json())
    expect(result.agentId).toBe('hr-policy-agent')
    expect(result.status).toBe('ready')
    expect(result.source).toBe('mock-synthetic')
    expect(result.measuredCostUsd).toBeGreaterThan(0)
    expect(result.coverage?.costCoverage).toBe(1)
    expect(result.anomalies).toEqual([])
    expect(result.attribution).toMatchObject({
      status: 'partial',
      owner: { value: 'People & Culture' },
      reason: 'source-value-unavailable',
    })
    expect(result.baselineEvidenceId).toBeDefined()
    expect(result.observedEvidenceId).toBeDefined()
    expect(result.unavailableReason).toBeUndefined()
    await app.close()
  })

  it('returns ready with cost anomaly for code-review-copilot', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/code-review-copilot',
    })
    expect(response.statusCode).toBe(200)
    const result = tokenEconomicsReportSchema.parse(response.json())
    expect(result.status).toBe('ready')
    expect(result.source).toBe('mock-synthetic')
    expect(result.measuredCostUsd).toBeGreaterThan(0)
    expect(result.anomalies?.some((a) => a.dimension === 'cost')).toBe(true)
    const costAnomaly = result.anomalies?.find((a) => a.dimension === 'cost')
    expect(costAnomaly?.severity).toMatch(/medium|high|critical/)
    await app.close()
  })

  it('returns ready without cost for sales-research-agent (missing-cost example)', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/sales-research-agent',
    })
    expect(response.statusCode).toBe(200)
    const result = tokenEconomicsReportSchema.parse(response.json())
    expect(result.status).toBe('ready')
    expect(result.source).toBe('mock-synthetic')
    expect(result.measuredCostUsd).toBeUndefined()
    expect(result.costPerSuccessUsd).toBeUndefined()
    expect(result.coverage?.costCoverage).toBe(0)
    await app.close()
  })

  it('returns insufficient-data for unknown agent, not invented success', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/unknown-agent-xyz',
    })

    expect(response.statusCode).toBe(200)
    const result = tokenEconomicsReportSchema.parse(response.json())
    expect(result.status).toBe('insufficient-data')
    expect(result.source).toBe('mock-synthetic')
    expect(result.measuredCostUsd).toBeUndefined()
    expect(result.attribution).toEqual({
      status: 'unknown',
      reason: 'agent-not-found',
    })
    await app.close()
  })

  it('does not accept a caller-controlled tenant override', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/hr-policy-agent?tenantId=other-tenant',
    })
    const result = tokenEconomicsReportSchema.parse(response.json())
    expect(result.tenantId).toBe('contoso-ai-lab')
    await app.close()
  })

  it('returns 414 for agentId longer than the router parameter limit', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/' + 'a'.repeat(201),
    })
    expect(response.statusCode).toBe(414)
    await app.close()
  })
})

describe('token economics API - foundry mode', () => {
  it('returns connector-not-connected and never synthetic data', async () => {
    const app = await makeFoundryApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/hr-policy-agent',
    })
    expect(response.statusCode).toBe(200)
    const result = tokenEconomicsReportSchema.parse(response.json())
    expect(result.status).toBe('connector-not-connected')
    expect(result.source).toBe('azure-monitor-otel')
    expect(result.measuredCostUsd).toBeUndefined()
    expect(result.coverage).toBeUndefined()
    expect(result.unavailableReason).toContain('connector')
    await app.close()
  })

  it('returns connector-not-connected even for unknown agents in foundry mode', async () => {
    const app = await makeFoundryApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/nonexistent',
    })
    expect(response.statusCode).toBe(200)
    const result = tokenEconomicsReportSchema.parse(response.json())
    expect(result.status).toBe('connector-not-connected')
    expect(result.source).toBe('azure-monitor-otel')
    await app.close()
  })

  it('runs token economics on injected measured Azure Monitor OTel windows', async () => {
    const app = await createApp(
      undefined,
      { mode: 'disabled', allowedScopes: { read: [], write: [] } },
      {
        dataMode: 'live',
        runtimeTelemetryConnector: createRuntimeTelemetryFixture(),
        ...makeStubRepositories(),
      },
    )
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/live-agent',
    })
    const result = tokenEconomicsReportSchema.parse(response.json())

    expect(result.status).toBe('ready')
    expect(result.source).toBe('azure-monitor-otel')
    expect(result.environment).toBe('production')
    expect(result.coverage?.costCoverage).toBe(1)
    expect(result.measuredCostUsd).toBeGreaterThan(0)
    expect(result.anomalies?.length).toBeGreaterThan(0)
    expect(result.attribution).toEqual({
      status: 'sourced',
      owner: {
        value: 'Runtime Platform',
        evidenceIds: ['evidence-1'],
      },
      businessUnit: {
        value: 'Engineering',
        evidenceIds: ['evidence-1'],
      },
    })
    await app.close()
  })

  it('returns typed unknown rather than mock economics when the provider fails', async () => {
    const app = await createApp(
      undefined,
      { mode: 'disabled', allowedScopes: { read: [], write: [] } },
      {
        dataMode: 'live',
        runtimeTelemetryConnector: createFailingRuntimeTelemetryFixture(),
        ...makeStubRepositories(),
      },
    )
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/live-agent',
    })
    const result = tokenEconomicsReportSchema.parse(response.json())

    expect(result.status).toBe('unavailable')
    expect(result.source).toBe('azure-monitor-otel')
    expect(result.coverage).toBeUndefined()
    expect(result.unavailableReason).not.toContain('provider details')
    await app.close()
  })

  it('does not attribute measured cost to a non-authoritative manifest owner', async () => {
    const repositories = makeStubRepositories()
    const snapshot = await repositories.snapshotRepository.findLatest('tenant-demo', 'validation')
    if (snapshot === null) throw new Error('Expected the test snapshot.')
    snapshot.nodes[0]!.metadata['sourceOfTruth'] = 'false'
    snapshot.nodes[0]!.metadata['isNonAuthoritative'] = 'true'
    const app = await createApp(
      undefined,
      { mode: 'disabled', allowedScopes: { read: [], write: [] } },
      {
        dataMode: 'live',
        runtimeTelemetryConnector: createRuntimeTelemetryFixture(),
        ...repositories,
      },
    )

    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/live-agent',
    })
    const result = tokenEconomicsReportSchema.parse(response.json())

    expect(result.status).toBe('ready')
    expect(result.attribution).toEqual({
      status: 'unknown',
      reason: 'non-authoritative-agent',
    })
    await app.close()
  })

  it('does not include synthetic validation canaries in live token economics', async () => {
    const app = await createApp(
      undefined,
      { mode: 'disabled', allowedScopes: { read: [], write: [] } },
      {
        dataMode: 'live',
        runtimeTelemetryConnector: createSyntheticCanaryTelemetryFixture(),
        ...makeStubRepositories(),
      },
    )
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/live-agent',
    })
    const result = tokenEconomicsReportSchema.parse(response.json())

    expect(result.status).toBe('insufficient-data')
    expect(result.coverage).toBeUndefined()
    expect(result.unavailableReason).toContain('Window has 0 unique samples')
    await app.close()
  })
})
