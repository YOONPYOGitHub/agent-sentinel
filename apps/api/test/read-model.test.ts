import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SnapshotRepository } from '@agent-sentinel/domain'
import { agentSentinelStateSchema } from '@agent-sentinel/domain'
import { MockAgentConnector } from '@agent-sentinel/mock-connector'

import { createApp } from '../src/app.js'
import { DemoService } from '../src/demo-service.js'
import { createRuntimeTelemetryFixture } from './runtime-telemetry-fixture.js'

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
    expect(findLatest).toHaveBeenCalledWith(snapshot.tenantId, snapshot.environment)
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
    })
    expect(response.body).not.toContain('private provider detail')
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
