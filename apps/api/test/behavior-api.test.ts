import { describe, expect, it, vi } from 'vitest'
import { driftAnalysisResultSchema } from '@agent-sentinel/domain'
import type { ExposureFindingRepository, SnapshotRepository } from '@agent-sentinel/domain'
import { createApp } from '../src/app.js'
import {
  createFailingRuntimeTelemetryFixture,
  createRuntimeTelemetryFixture,
  createSyntheticCanaryTelemetryFixture,
  createSyntheticRuntimeTelemetryFixture,
} from './runtime-telemetry-fixture.js'

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
        evidenceIds: ['evidence-1'],
        metadata: {
          sourceOfTruth: 'true',
          sourceConnectorId: 'primary',
          sourceTenantId: 'tenant-demo',
          sourceProjectId: 'test',
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
        metadata: {
          sourceOfTruth: 'true',
          estateTenantId: 'tenant-demo',
          estateEnvironment: 'validation',
          sourceConnectorId: 'primary',
          sourceTenantId: 'tenant-demo',
          sourceProjectId: 'test',
          sourceEnvironment: 'production',
          sourceObjectId: 'live-agent',
        },
      },
    ],
  }
  const exposureRepository: ExposureFindingRepository = {
    upsert: (_estate, finding) => Promise.resolve(finding),
    findById: () => Promise.resolve(null),
    listByTenant: () => Promise.resolve({ items: [], total: 0 }),
    getFacets: () => Promise.resolve({ severity: {}, status: {}, policyId: {} }),
    resolveAbsent: () => Promise.resolve([]),
  }
  const snapshotRepository: SnapshotRepository = {
    save: () => Promise.resolve(),
    findLatest: () => Promise.resolve(snapshot),
    findById: () => Promise.resolve(snapshot),
    list: () => Promise.resolve([snapshot]),
  }
  return { exposureRepository, snapshotRepository }
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
  const app = await createApp(
    undefined,
    { mode: 'disabled', allowedScopes: { read: [], write: [] } },
    { dataMode: 'live', runtimeTelemetryConnector: null, ...makeStubRepositories() },
  )
  return app
}

describe('behavior drift API — mock mode', () => {
  it('returns status ready and source mock-synthetic for a known agent', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/behavior/agents/sales-research-agent/drift',
    })
    expect(response.statusCode).toBe(200)
    const body: unknown = response.json()
    const result = driftAnalysisResultSchema.parse(body)
    expect(result.agentId).toBe('sales-research-agent')
    expect(result.status).toBe('ready')
    expect(result.source).toBe('mock-synthetic')
    // Confirms synthetic data is always clearly labeled
    expect(result.unavailableReason).toBeUndefined()
    expect(
      result.dimensions.find((dimension) => dimension.dimension === 'input-tokens'),
    ).toMatchObject({ drifted: false, baselineMedian: 420, observedMedian: 430 })
  })

  it('returns status ready for hr-policy-agent (stable healthy)', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/behavior/agents/hr-policy-agent/drift',
    })
    expect(response.statusCode).toBe(200)
    const body: unknown = response.json()
    const result = driftAnalysisResultSchema.parse(body)
    expect(result.status).toBe('ready')
    expect(result.source).toBe('mock-synthetic')
  })

  it('returns status ready for code-review-copilot (high error drift)', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/behavior/agents/code-review-copilot/drift',
    })
    expect(response.statusCode).toBe(200)
    const body: unknown = response.json()
    const result = driftAnalysisResultSchema.parse(body)
    expect(result.status).toBe('ready')
    expect(result.source).toBe('mock-synthetic')
    // code-review-copilot has a high error-rate drift
    const errorDim = result.dimensions.find((d) => d.dimension === 'error-rate')
    expect(errorDim?.drifted).toBe(true)
  })

  it('returns insufficient-data for an unknown agent in mock mode', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/behavior/agents/nonexistent-agent-xyz/drift',
    })
    expect(response.statusCode).toBe(200)
    const body: unknown = response.json()
    const result = driftAnalysisResultSchema.parse(body)
    expect(result.agentId).toBe('nonexistent-agent-xyz')
    expect(result.status).toBe('insufficient-data')
    expect(result.source).toBe('mock-synthetic')
    expect(result.anyDrift).toBe(false)
  })

  it('never includes unavailableReason on synthetic results', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/behavior/agents/sales-research-agent/drift',
    })
    const body: unknown = response.json()
    const result = driftAnalysisResultSchema.parse(body)
    expect(result.unavailableReason).toBeUndefined()
  })

  it('response parses as valid DriftAnalysisResult for all known agents', async () => {
    const app = await makeMockApp()
    const agentIds = ['sales-research-agent', 'hr-policy-agent', 'code-review-copilot']
    for (const agentId of agentIds) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/behavior/agents/${agentId}/drift`,
      })
      expect(response.statusCode).toBe(200)
      // Will throw if schema validation fails
      driftAnalysisResultSchema.parse(response.json())
    }
  })

  it('is deterministic — identical results on repeated calls', async () => {
    const app = await makeMockApp()
    const url = '/api/behavior/agents/sales-research-agent/drift'
    const r1: unknown = (await app.inject({ method: 'GET', url })).json()
    const r2: unknown = (await app.inject({ method: 'GET', url })).json()
    const res1 = driftAnalysisResultSchema.parse(r1)
    const res2 = driftAnalysisResultSchema.parse(r2)
    expect(res1).toEqual(res2)
  })
})

describe('behavior drift API — foundry/live mode', () => {
  it('returns status invalid with unavailableReason in live mode', async () => {
    const app = await makeFoundryApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/behavior/agents/sales-research-agent/drift',
    })
    expect(response.statusCode).toBe(200)
    const body: unknown = response.json()
    const result = driftAnalysisResultSchema.parse(body)
    expect(result.status).toBe('invalid')
    expect(result.source).toBe('azure-monitor-otel')
    expect(result.unavailableReason).toBeDefined()
    expect(typeof result.unavailableReason).toBe('string')
    expect(result.unavailableReason!.length).toBeGreaterThan(0)
  })

  it('never returns source mock-synthetic in live mode', async () => {
    const app = await makeFoundryApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/behavior/agents/hr-policy-agent/drift',
    })
    const body: unknown = response.json()
    const result = driftAnalysisResultSchema.parse(body)
    expect(result.source).not.toBe('mock-synthetic')
  })

  it('never returns anyDrift=true in live mode without real data', async () => {
    const app = await makeFoundryApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/behavior/agents/code-review-copilot/drift',
    })
    const body: unknown = response.json()
    const result = driftAnalysisResultSchema.parse(body)
    expect(result.anyDrift).toBe(false)
  })

  it('returns HTTP 200 (not 503 or 404) in live mode — typed unavailable contract', async () => {
    const app = await makeFoundryApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/behavior/agents/any-agent/drift',
    })
    expect(response.statusCode).toBe(200)
  })

  it('does not read the snapshot repository while telemetry is disabled', async () => {
    const repositories = makeStubRepositories()
    repositories.snapshotRepository.findLatest = () =>
      Promise.reject(new Error('Cosmos unavailable'))
    const app = await createApp(
      undefined,
      { mode: 'disabled', allowedScopes: { read: [], write: [] } },
      {
        dataMode: 'live',
        runtimeTelemetryConnector: null,
        ...repositories,
      },
    )
    const response = await app.inject({
      method: 'GET',
      url: '/api/behavior/agents/any-agent/drift',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'invalid' })
    await app.close()
  })

  it('runs the drift engine on injected Azure Monitor OTel windows', async () => {
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
      url: '/api/behavior/agents/live-agent/drift',
    })
    const result = driftAnalysisResultSchema.parse(response.json())

    expect(result.status).toBe('ready')
    expect(result.source).toBe('azure-monitor-otel')
    expect(result.environment).toBe('production')
    expect(result.baselineWindowId).toBe('baseline-window')
    expect(result.observedWindowId).toBe('observed-window')
    expect(result.baselineEvidenceId).toBe('otel-baseline-evidence')
    expect(result.observedEvidenceId).toBe('otel-observed-evidence')
    expect(result.anyDrift).toBe(true)
    await app.close()
  })

  it('does not make stale degraded telemetry ready when ingestion counts are invalid', async () => {
    const fixture = createRuntimeTelemetryFixture()
    const app = await createApp(
      undefined,
      { mode: 'disabled', allowedScopes: { read: [], write: [] } },
      {
        dataMode: 'live',
        runtimeTelemetryConnector: {
          id: fixture.id,
          async readObservationWindows(request, options) {
            const windows = await fixture.readObservationWindows(request, options)
            return {
              ...windows,
              baseline: {
                ...windows.baseline,
                otelQuality: {
                  ...windows.baseline.otelQuality!,
                  status: 'degraded',
                  caveats: ['stale'],
                  recordsReceived: 0,
                  recordsAccepted: 0,
                  pagesProcessed: 0,
                },
              },
              observed: {
                ...windows.observed,
                otelQuality: {
                  ...windows.observed.otelQuality!,
                  status: 'degraded',
                  caveats: ['stale'],
                  recordsReceived: 60,
                  recordsAccepted: 59,
                  duplicatesRemoved: 1,
                },
              },
            }
          },
        },
        ...makeStubRepositories(),
      },
    )

    const response = await app.inject({
      method: 'GET',
      url: '/api/behavior/agents/live-agent/drift',
    })
    const result = driftAnalysisResultSchema.parse(response.json())

    expect(result.status).toBe('invalid')
    expect(result.anyDrift).toBe(false)
    expect(result.unavailableReason).toContain('invalid-record')
    await app.close()
  })

  it('resolves aggregate agent ids to exact telemetry source bindings', async () => {
    const fixture = createRuntimeTelemetryFixture()
    const readObservationWindows = vi.fn(fixture.readObservationWindows.bind(fixture))
    const runtimeTelemetryConnector = {
      id: 'azure-monitor-otel',
      readObservationWindows,
    }
    const repositories = makeStubRepositories()
    repositories.snapshotRepository.findLatest = () =>
      Promise.resolve({
        tenantId: 'tenant-demo',
        environment: 'validation',
        generatedAt: '2026-08-28T00:00:00.000Z',
        nodes: [
          {
            id: 'live-agent',
            kind: 'agent',
            name: 'Live agent',
            description: 'test',
            environment: 'production',
            evidenceIds: ['evidence-1'],
            metadata: {
              sourceOfTruth: 'true',
              sourceConnectorId: 'project-a',
              sourceTenantId: 'source-tenant',
              sourceProjectId: 'project-a',
              sourceEnvironment: 'production',
              sourceObjectId: 'provider-agent-id',
            },
          },
        ],
        edges: [],
        evidence: [
          {
            id: 'evidence-1',
            source: 'Foundry',
            sourceObjectId: 'provider-agent-id',
            observedAt: '2026-08-28T00:00:00.000Z',
            freshness: 'live',
            confidence: 1,
            evidenceTypes: ['declared_configuration'],
            summary: 'Declared configuration.',
            metadata: {
              sourceOfTruth: 'true',
              estateTenantId: 'tenant-demo',
              estateEnvironment: 'validation',
              sourceConnectorId: 'project-a',
              sourceTenantId: 'source-tenant',
              sourceProjectId: 'project-a',
              sourceEnvironment: 'production',
              sourceObjectId: 'provider-agent-id',
            },
          },
        ],
      })
    const app = await createApp(
      undefined,
      { mode: 'disabled', allowedScopes: { read: [], write: [] } },
      {
        dataMode: 'live',
        runtimeTelemetryConnector,
        ...repositories,
      },
    )
    await app.inject({
      method: 'GET',
      url: '/api/behavior/agents/live-agent/drift',
    })
    expect(readObservationWindows).toHaveBeenCalledWith({
      snapshotGeneratedAt: '2026-08-28T00:00:00.000Z',
      estateId: 'default',
      estateEnvironment: 'validation',
      tenantId: 'tenant-demo',
      agentId: 'live-agent',
      sourceConnectorId: 'project-a',
      sourceTenantId: 'source-tenant',
      sourceProjectId: 'project-a',
      sourceAgentId: 'provider-agent-id',
      sourceEnvironment: 'production',
    })
    await app.close()
  })

  it('rejects runtime telemetry with mismatched estate provenance before drift analysis', async () => {
    const fixture = createRuntimeTelemetryFixture()
    const app = await createApp(
      undefined,
      { mode: 'disabled', allowedScopes: { read: [], write: [] } },
      {
        dataMode: 'live',
        runtimeTelemetryConnector: {
          id: fixture.id,
          async readObservationWindows(request, options) {
            const windows = await fixture.readObservationWindows(request, options)
            return {
              ...windows,
              provenance: {
                ...windows.provenance!,
                estateId: 'wrong-estate',
              },
            }
          },
        },
        ...makeStubRepositories(),
      },
    )

    const response = await app.inject({
      method: 'GET',
      url: '/api/behavior/agents/live-agent/drift',
    })
    const result = driftAnalysisResultSchema.parse(response.json())

    expect(result.status).toBe('invalid')
    expect(result.anyDrift).toBe(false)
    await app.close()
  })

  it('returns typed unknown rather than mock data when the provider fails', async () => {
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
      url: '/api/behavior/agents/live-agent/drift',
    })

    const result = driftAnalysisResultSchema.parse(response.json())

    expect(result.status).toBe('invalid')
    expect(result.source).toBe('azure-monitor-otel')
    expect(result.anyDrift).toBe(false)
    expect(result.unavailableReason).not.toContain('provider details')
    await app.close()
  })

  it('does not query telemetry for an agent without an authoritative source binding', async () => {
    const fixture = createRuntimeTelemetryFixture()
    const readObservationWindows = vi.fn(fixture.readObservationWindows.bind(fixture))
    const app = await createApp(
      undefined,
      { mode: 'disabled', allowedScopes: { read: [], write: [] } },
      {
        dataMode: 'live',
        runtimeTelemetryConnector: { id: fixture.id, readObservationWindows },
        ...makeStubRepositories(),
      },
    )
    const response = await app.inject({
      method: 'GET',
      url: '/api/behavior/agents/unknown-agent/drift',
    })
    const result = driftAnalysisResultSchema.parse(response.json())

    expect(result.status).toBe('invalid')
    expect(result.unavailableReason).toContain('No exact runtime telemetry source binding')
    expect(readObservationWindows).not.toHaveBeenCalled()
    await app.close()
  })

  it('does not query configured telemetry when no snapshot resolver is available', async () => {
    const fixture = createRuntimeTelemetryFixture()
    const acquireCredential = vi.fn(() => Promise.resolve())
    const readObservationWindows = vi.fn(
      async (...args: Parameters<typeof fixture.readObservationWindows>) => {
        await acquireCredential()
        return fixture.readObservationWindows(...args)
      },
    )
    const { exposureRepository } = makeStubRepositories()
    const app = await createApp(
      undefined,
      { mode: 'disabled', allowedScopes: { read: [], write: [] } },
      {
        dataMode: 'live',
        runtimeTelemetryConnector: { id: fixture.id, readObservationWindows },
        exposureRepository,
      },
    )

    const response = await app.inject({
      method: 'GET',
      url: '/api/behavior/agents/live-agent/drift',
    })
    const result = driftAnalysisResultSchema.parse(response.json())

    expect(result.status).toBe('invalid')
    expect(result.unavailableReason).toContain('No exact runtime telemetry source binding')
    expect(readObservationWindows).not.toHaveBeenCalled()
    expect(acquireCredential).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects synthetic windows injected into live mode', async () => {
    const app = await createApp(
      undefined,
      { mode: 'disabled', allowedScopes: { read: [], write: [] } },
      {
        dataMode: 'live',
        runtimeTelemetryConnector: createSyntheticRuntimeTelemetryFixture(),
        ...makeStubRepositories(),
      },
    )
    const response = await app.inject({
      method: 'GET',
      url: '/api/behavior/agents/live-agent/drift',
    })
    const result = driftAnalysisResultSchema.parse(response.json())

    expect(result.status).toBe('invalid')
    expect(result.source).toBe('azure-monitor-otel')
    expect(result.anyDrift).toBe(false)
    await app.close()
  })

  it('does not use synthetic validation canaries as a live behavior baseline', async () => {
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
      url: '/api/behavior/agents/live-agent/drift',
    })
    const result = driftAnalysisResultSchema.parse(response.json())

    expect(result.status).toBe('insufficient-data')
    expect(result.anyDrift).toBe(false)
    expect(result.unavailableReason).toBe('OpenTelemetry evidence is unknown: empty.')
    await app.close()
  })

  it('keeps unavailable analysis IDs bounded at the HTTP path-parameter limit', async () => {
    const app = await makeFoundryApp()
    const agentId = 'a'.repeat(100)
    const response = await app.inject({
      method: 'GET',
      url: `/api/behavior/agents/${agentId}/drift`,
    })
    expect(response.statusCode).toBe(200)
    const result = driftAnalysisResultSchema.parse(response.json())
    expect(result.agentId).toBe(agentId)
    expect(result.analysisId.length).toBeLessThanOrEqual(200)
  })

  it('rejects agent IDs outside the HTTP path-parameter bound', async () => {
    const app = await makeFoundryApp()
    const response = await app.inject({
      method: 'GET',
      url: `/api/behavior/agents/${'a'.repeat(101)}/drift`,
    })
    expect(response.statusCode).toBe(414)
  })
})
