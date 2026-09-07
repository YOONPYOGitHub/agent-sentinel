import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SnapshotRepository } from '@agent-sentinel/domain'
import { agentSentinelStateSchema } from '@agent-sentinel/domain'
import {
  ManifestIngestionSourceLimitError,
  MAX_MANIFEST_SOURCES,
  runtimeObservationWindowsSchema,
} from '@agent-sentinel/connector-sdk'
import type { ManifestIngestionRepository } from '@agent-sentinel/connector-sdk'
import { MockAgentConnector } from '@agent-sentinel/mock-connector'

import { createApp } from '../src/app.js'
import { DemoService } from '../src/demo-service.js'
import {
  createMixedRuntimeTelemetryFixture,
  createRuntimeTelemetryFixture,
  createSyntheticCanaryTelemetryFixture,
} from './runtime-telemetry-fixture.js'

const apps: Awaited<ReturnType<typeof createApp>>[] = []

function snapshotRepository(snapshot: Awaited<ReturnType<MockAgentConnector['discover']>> | null): {
  repository: SnapshotRepository
  findLatest: ReturnType<typeof vi.fn>
} {
  const findLatest = vi.fn<SnapshotRepository['findLatest']>().mockResolvedValue(snapshot)
  return {
    repository: {
      save: vi.fn(),
      findLatest,
      findById: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue(snapshot === null ? [] : [snapshot]),
    },
    findLatest,
  }
}

function configureFoundryFor(snapshot: Awaited<ReturnType<MockAgentConnector['discover']>>) {
  process.env['AGENT_SENTINEL_CONNECTOR'] = 'foundry'
  process.env['FOUNDRY_PROJECT_ENDPOINT'] =
    'https://example.services.ai.azure.com/api/projects/test'
  process.env['FOUNDRY_TENANT_ID'] = snapshot.tenantId
  process.env['FOUNDRY_ENVIRONMENT'] = snapshot.environment
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()))
  delete process.env['AGENT_SENTINEL_CONNECTOR']
  delete process.env['FOUNDRY_PROJECT_ENDPOINT']
  delete process.env['FOUNDRY_TENANT_ID']
  delete process.env['FOUNDRY_ENVIRONMENT']
})

describe('live product read model', () => {
  it('serves the latest jobs-persisted snapshot for the configured boundary', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const { repository, findLatest } = snapshotRepository(snapshot)
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        snapshotRepository: repository,
        runtimeTelemetryConnector: null,
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    expect(response.statusCode).toBe(200)
    expect(agentSentinelStateSchema.parse(response.json()).snapshot).toEqual(snapshot)
    expect(findLatest).toHaveBeenCalledWith({
      id: 'default',
      tenantId: snapshot.tenantId,
      environment: snapshot.environment,
    })
  })

  it('reports manifest runtime verification separately from the persisted snapshot', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const { repository } = snapshotRepository(snapshot)
    const listLatest = vi.fn<ManifestIngestionRepository['listLatest']>().mockResolvedValue([])
    const manifestIngestionRepository: ManifestIngestionRepository = {
      save: vi.fn(),
      listLatest,
    }
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        snapshotRepository: repository,
        runtimeTelemetryConnector: null,
        manifestIngestionRepository,
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    const state = agentSentinelStateSchema.parse(response.json())

    expect(state.manifestRuntimeVerification).toMatchObject({
      status: 'no-claims',
      counts: {
        verified: 0,
        noObservation: 0,
        ambiguous: 0,
        notCorrelatable: 0,
        unavailable: 0,
      },
      claims: [],
    })
    expect(state.manifestConfigurationReconciliation).toMatchObject({
      status: 'no-claims',
      counts: {
        matched: 0,
        ambiguous: 0,
        notCorrelatable: 0,
        valueMatched: 0,
        valueMismatched: 0,
        valueUnavailable: 0,
        freeFormUnverified: 0,
      },
      claims: [],
    })

    expect(listLatest).toHaveBeenCalledWith(snapshot.environment, MAX_MANIFEST_SOURCES)
    expect(state.snapshot).toEqual(snapshot)
  })

  it('distinguishes the manifest source cap from a repository outage', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const { repository } = snapshotRepository(snapshot)
    const manifestIngestionRepository: ManifestIngestionRepository = {
      save: vi.fn(),
      listLatest: () => Promise.reject(new ManifestIngestionSourceLimitError(500)),
    }
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        snapshotRepository: repository,
        runtimeTelemetryConnector: null,
        manifestIngestionRepository,
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    const state = agentSentinelStateSchema.parse(response.json())

    expect(response.statusCode).toBe(200)
    expect(state.manifestRuntimeVerification).toMatchObject({
      status: 'unavailable',
      reason: 'source-limit-exceeded',
    })
    expect(state.manifestConfigurationReconciliation).toMatchObject({
      status: 'unavailable',
      reason: 'source-limit-exceeded',
    })
  })

  it('projects measured runtime evidence without mutating the persisted snapshot', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    Object.assign(agent.metadata, {
      sourceConnectorId: 'primary',
      sourceTenantId: snapshot.tenantId,
      sourceObjectId: 'provider-agent-id',
      sourceEnvironment: snapshot.environment,
    })
    const persisted = structuredClone(snapshot)
    const { repository } = snapshotRepository(snapshot)
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        snapshotRepository: repository,
        runtimeTelemetryConnector: createRuntimeTelemetryFixture(snapshot.environment),
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    const state = agentSentinelStateSchema.parse(response.json())

    expect(response.statusCode).toBe(200)
    expect(state.runtimeEvidence).toMatchObject({
      status: 'partial',
      eligibleAgentCount: 1,
      queriedAgentCount: 1,
      enrichedAgentCount: 1,
      evidenceCount: 2,
      failures: [],
      sources: [
        {
          estateId: 'default',
          estateTenantId: snapshot.tenantId,
          estateEnvironment: snapshot.environment,
          sourceConnectorId: 'primary',
          sourceTenantId: snapshot.tenantId,
          sourceEnvironment: snapshot.environment,
          sourceAgentId: 'provider-agent-id',
          agentId: agent.id,
          state: 'complete',
          windowIds: ['baseline-window', 'observed-window'],
          evidenceIds: ['otel-baseline-evidence', 'otel-observed-evidence'],
          providerResourceIds: ['/subscriptions/example/resource'],
        },
      ],
    })
    expect(state.snapshot.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'otel-observed-evidence',
          evidenceTypes: ['observed_runtime'],
        }),
      ]),
    )
    expect(state.snapshot.nodes.find((node) => node.id === agent.id)?.evidenceIds).toContain(
      'otel-observed-evidence',
    )
    expect(snapshot).toEqual(persisted)
  })

  it('returns typed unavailable runtime coverage when no agent has an exact source binding', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const { repository } = snapshotRepository(snapshot)
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        snapshotRepository: repository,
        runtimeTelemetryConnector: createRuntimeTelemetryFixture(snapshot.environment),
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    const state = agentSentinelStateSchema.parse(response.json())

    expect(response.statusCode).toBe(200)
    expect(state.runtimeEvidence).toMatchObject({
      status: 'unavailable',
      agentCount: snapshot.nodes.filter((node) => node.kind === 'agent').length,
      eligibleAgentCount: 0,
      queriedAgentCount: 0,
      enrichedAgentCount: 0,
      evidenceCount: 0,
      sources: [],
      failures: [],
    })
  })

  it('surfaces telemetry projection failures without hiding the persisted estate', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    Object.assign(agent.metadata, {
      sourceConnectorId: 'primary',
      sourceTenantId: snapshot.tenantId,
      sourceObjectId: 'provider-agent-id',
      sourceEnvironment: snapshot.environment,
    })
    const { repository } = snapshotRepository(snapshot)
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        snapshotRepository: repository,
        runtimeTelemetryConnector: {
          id: 'azure-monitor-otel',
          readObservationWindows: () => Promise.reject(new Error('private provider detail')),
        },
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    const state = agentSentinelStateSchema.parse(response.json())

    expect(response.statusCode).toBe(200)
    expect(state.snapshot).toEqual(snapshot)
    expect(state.runtimeEvidence).toMatchObject({
      status: 'unavailable',
      eligibleAgentCount: 1,
      queriedAgentCount: 0,
      enrichedAgentCount: 0,
      evidenceCount: 0,
      failures: [{ agentId: agent.id, reason: 'query-failed' }],
      sources: [
        {
          estateId: 'default',
          estateTenantId: snapshot.tenantId,
          estateEnvironment: snapshot.environment,
          sourceConnectorId: 'primary',
          sourceTenantId: snapshot.tenantId,
          sourceEnvironment: snapshot.environment,
          sourceAgentId: 'provider-agent-id',
          agentId: agent.id,
          state: 'failed',
          evidenceIds: [],
          windowIds: [],
          observationIds: [],
          reason: 'query-failed',
        },
      ],
    })
    expect(response.body).not.toContain('private provider detail')
  })

  it('retains empty telemetry as empty without creating live evidence', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    Object.assign(agent.metadata, {
      sourceConnectorId: 'primary',
      sourceTenantId: snapshot.tenantId,
      sourceObjectId: 'provider-agent-id',
      sourceEnvironment: snapshot.environment,
    })
    const { repository } = snapshotRepository(snapshot)
    const fixture = createRuntimeTelemetryFixture(snapshot.environment)
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        snapshotRepository: repository,
        runtimeTelemetryConnector: {
          id: fixture.id,
          async readObservationWindows(request, options) {
            const windows = await fixture.readObservationWindows(request, options)
            return runtimeObservationWindowsSchema.parse({
              ...windows,
              baseline: { ...windows.baseline, observations: [] },
              observed: { ...windows.observed, observations: [] },
            })
          },
        },
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    const state = agentSentinelStateSchema.parse(response.json())

    expect(response.statusCode).toBe(200)
    expect(state.runtimeEvidence).toMatchObject({
      status: 'unavailable',
      queriedAgentCount: 1,
      enrichedAgentCount: 0,
      evidenceCount: 0,
      failures: [],
      sources: [
        {
          sourceConnectorId: 'primary',
          agentId: agent.id,
          state: 'empty',
          windowIds: ['baseline-window', 'observed-window'],
          evidenceIds: [],
          observationIds: [],
          reason: 'empty',
        },
      ],
    })
    expect(state.snapshot.evidence).toEqual(snapshot.evidence)
  })

  it('retains stale telemetry as stale without reporting complete live coverage', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    Object.assign(agent.metadata, {
      sourceConnectorId: 'primary',
      sourceTenantId: snapshot.tenantId,
      sourceObjectId: 'provider-agent-id',
      sourceEnvironment: snapshot.environment,
    })
    const { repository } = snapshotRepository(snapshot)
    const fixture = createRuntimeTelemetryFixture(snapshot.environment)
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        snapshotRepository: repository,
        runtimeTelemetryConnector: {
          id: fixture.id,
          async readObservationWindows(request, options) {
            const windows = await fixture.readObservationWindows(request, options)
            const staleQuality = {
              status: 'degraded' as const,
              classification: 'live' as const,
              caveats: ['stale' as const],
              recordsReceived: 60,
              recordsAccepted: 60,
              duplicatesRemoved: 0,
              pagesProcessed: 1,
            }
            return runtimeObservationWindowsSchema.parse({
              ...windows,
              baseline: { ...windows.baseline, otelQuality: staleQuality },
              observed: { ...windows.observed, otelQuality: staleQuality },
            })
          },
        },
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    const state = agentSentinelStateSchema.parse(response.json())

    expect(response.statusCode).toBe(200)
    expect(state.runtimeEvidence).toMatchObject({
      status: 'partial',
      queriedAgentCount: 1,
      sources: [
        {
          sourceConnectorId: 'primary',
          agentId: agent.id,
          state: 'stale',
          reason: 'stale',
        },
      ],
    })
    expect(state.snapshot.evidence.filter((evidence) => evidence.id.startsWith('otel-'))).toEqual([
      expect.objectContaining({ freshness: 'stale', evidenceTypes: ['unknown'] }),
      expect.objectContaining({ freshness: 'stale', evidenceTypes: ['unknown'] }),
    ])
  })

  it('classifies runtime evidence after exact nested provenance validation', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    Object.assign(agent.metadata, {
      sourceConnectorId: 'primary',
      sourceTenantId: snapshot.tenantId,
      sourceObjectId: 'provider-agent-id',
      sourceEnvironment: snapshot.environment,
    })
    const { repository } = snapshotRepository(snapshot)
    const fixture = createRuntimeTelemetryFixture(snapshot.environment)
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        snapshotRepository: repository,
        runtimeTelemetryConnector: {
          id: fixture.id,
          async readObservationWindows(request, options) {
            const windows = await fixture.readObservationWindows(request, options)
            return runtimeObservationWindowsSchema.parse({
              ...windows,
              baseline: {
                ...windows.baseline,
                observations: windows.baseline.observations.map((observation) => ({
                  ...observation,
                  otelProvenance: {
                    ...observation.otelProvenance!,
                    sourceConnectorId: 'wrong-source',
                  },
                })),
              },
              observed: {
                ...windows.observed,
                observations: windows.observed.observations.map((observation) => ({
                  ...observation,
                  otelProvenance: {
                    ...observation.otelProvenance!,
                    sourceConnectorId: 'wrong-source',
                  },
                })),
              },
            })
          },
        },
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    const state = agentSentinelStateSchema.parse(response.json())

    expect(response.statusCode).toBe(200)
    expect(state.runtimeEvidence).toMatchObject({
      status: 'partial',
      queriedAgentCount: 1,
      enrichedAgentCount: 1,
      sources: [
        {
          sourceConnectorId: 'primary',
          agentId: agent.id,
          state: 'partial',
          observationIds: [],
          reason: 'degraded-quality',
        },
      ],
    })
    expect(
      state.snapshot.evidence
        .filter((evidence) => evidence.id.startsWith('otel-'))
        .every(
          (evidence) =>
            evidence.confidence === 0 &&
            evidence.evidenceTypes.length === 1 &&
            evidence.evidenceTypes[0] === 'unknown',
        ),
    ).toBe(true)
  })

  it('keeps synthetic telemetry explicit and never counts it as live-ready', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    Object.assign(agent.metadata, {
      sourceConnectorId: 'primary',
      sourceTenantId: snapshot.tenantId,
      sourceObjectId: 'provider-agent-id',
      sourceEnvironment: snapshot.environment,
    })
    const { repository } = snapshotRepository(snapshot)
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        snapshotRepository: repository,
        runtimeTelemetryConnector: createSyntheticCanaryTelemetryFixture(snapshot.environment),
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    const state = agentSentinelStateSchema.parse(response.json())

    expect(response.statusCode).toBe(200)
    expect(state.runtimeEvidence).toMatchObject({
      status: 'unavailable',
      queriedAgentCount: 1,
      sources: [
        {
          sourceConnectorId: 'primary',
          agentId: agent.id,
          state: 'unsupported',
          evidenceIds: ['otel-baseline-evidence-synthetic', 'otel-observed-evidence-synthetic'],
          reason: 'synthetic-only',
        },
      ],
    })
    const projectedEvidence = state.snapshot.evidence.filter((evidence) =>
      evidence.id.startsWith('otel-'),
    )
    expect(projectedEvidence).toHaveLength(2)
    expect(
      projectedEvidence.every((evidence) =>
        evidence.evidenceTypes.includes('synthetic_validation'),
      ),
    ).toBe(true)
  })

  it('reports all projected live and synthetic runtime evidence IDs', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    Object.assign(agent.metadata, {
      sourceConnectorId: 'primary',
      sourceTenantId: snapshot.tenantId,
      sourceObjectId: 'provider-agent-id',
      sourceEnvironment: snapshot.environment,
    })
    const { repository } = snapshotRepository(snapshot)
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        snapshotRepository: repository,
        runtimeTelemetryConnector: createMixedRuntimeTelemetryFixture(snapshot.environment),
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    const state = agentSentinelStateSchema.parse(response.json())

    expect(response.statusCode).toBe(200)
    expect(state.runtimeEvidence?.sources?.[0]?.evidenceIds).toEqual([
      'otel-baseline-evidence',
      'otel-baseline-evidence-synthetic',
      'otel-observed-evidence',
      'otel-observed-evidence-synthetic',
    ])
  })

  it('returns explicit unavailability instead of rediscovering or falling back to mock', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const { repository } = snapshotRepository(null)
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        snapshotRepository: repository,
        runtimeTelemetryConnector: null,
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    expect(response.statusCode).toBe(503)
    const body: unknown = response.json()
    expect(body).toEqual({
      error: 'read_model_unavailable',
      message:
        'No persisted estate snapshot is available for the configured tenant and environment.',
    })
  })

  it('recomputes legacy summary findings from each persisted snapshot', async () => {
    const snapshot = await new MockAgentConnector().discover()
    const nextSnapshot = {
      ...snapshot,
      generatedAt: '2026-08-27T14:30:00.000Z',
      nodes: [],
      edges: [],
      evidence: [],
    }
    configureFoundryFor(snapshot)
    const { repository, findLatest } = snapshotRepository(snapshot)
    findLatest.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(nextSnapshot)
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        snapshotRepository: repository,
        runtimeTelemetryConnector: null,
      },
    )
    apps.push(app)

    const first = agentSentinelStateSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/demo/state' })).json(),
    )
    const second = agentSentinelStateSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/demo/state' })).json(),
    )
    expect(first.findings).toHaveLength(1)
    expect(second.findings).toHaveLength(0)
    expect(second.snapshot.generatedAt).toBe(nextSnapshot.generatedAt)
  })

  it('does not let an injected live service bypass the persisted read model', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const { repository } = snapshotRepository(null)
    const injected = new DemoService(new MockAgentConnector(), 'mock')
    const app = await createApp(
      injected,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        snapshotRepository: repository,
        runtimeTelemetryConnector: null,
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    expect(response.statusCode).toBe(503)
  })

  it('does not fall back to discovery when a live snapshot repository is not injected', async () => {
    process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        exposureRepository: {
          upsert: vi.fn(),
          findById: vi.fn().mockResolvedValue(null),
          listByTenant: vi.fn().mockResolvedValue({ items: [], total: 0 }),
          getFacets: vi.fn().mockResolvedValue({ severity: {}, status: {}, policyId: {} }),
          resolveAbsent: vi.fn().mockResolvedValue([]),
        },
        runtimeTelemetryConnector: null,
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    expect(response.statusCode).toBe(503)
    const body: unknown = response.json()
    expect(body).toEqual({
      error: 'read_model_unavailable',
      message: 'The persisted estate read model is not configured for this live deployment.',
    })
  })
})
