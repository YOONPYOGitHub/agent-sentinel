import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jose = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => ({ mocked: 'jwks' })),
  jwtVerify: vi.fn(),
}))

vi.mock('jose', () => jose)

import { createApp } from '../src/app.js'
import { buildConnectorsCollection, connectorBaseCatalog } from '../src/connectors-catalog.js'
import { DemoService } from '../src/demo-service.js'
import { buildEstateRegistry } from '../src/estate-config.js'
import { MockAgentConnector } from '@agent-sentinel/mock-connector'
import type { AuthConfig } from '../src/auth.js'
import type {
  AgentConnector,
  ConnectorHealthReport,
  RuntimeTelemetryConnector,
} from '@agent-sentinel/connector-sdk'
import { DefenderCloudAppsCompositionConnector } from '@agent-sentinel/defender-cloud-apps-connector'
import { PurviewCompositionConnector } from '@agent-sentinel/purview-connector'
import { AzureResourceGraphCompositionConnector } from '@agent-sentinel/azure-resource-graph-connector'
import { TeamsDistributionCompositionConnector } from '@agent-sentinel/teams-distribution-connector'
import {
  InMemoryConnectorHealthRepository,
  InMemoryExposureFindingRepository,
  InMemorySnapshotRepository,
} from '@agent-sentinel/persistence'
import { resolveAgent365Runtime } from '@agent-sentinel/connector-runtime'
import type {
  ConnectorSourceDefinition,
  ConnectorSourceRepository,
  EstateContext,
} from '@agent-sentinel/domain'

const apps: Awaited<ReturnType<typeof createApp>>[] = []
const mockEstate = {
  id: 'default',
  tenantId: 'contoso-ai-lab',
  environment: 'Demo / Korea Central',
}

beforeEach(() => {
  jose.jwtVerify.mockReset()
  process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
})

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()))
  delete process.env['AGENT_SENTINEL_CONNECTOR']
  delete process.env['AGENT_SENTINEL_WRITE_ENABLED']
})

const jwtConfig: AuthConfig = {
  mode: 'jwt',
  tenantId: 'auth-tenant',
  audience: 'api://agent-sentinel',
  issuer: 'https://login.microsoftonline.com/auth-tenant/v2.0',
  jwksUri: 'https://login.microsoftonline.com/auth-tenant/discovery/v2.0/keys',
  allowedScopes: { read: ['AgentSentinel.Read'], write: ['AgentSentinel.Write'] },
  spaConfig: {
    tenantId: 'auth-tenant',
    clientId: 'spa-client-id',
    authority: 'https://login.microsoftonline.com/auth-tenant',
    scopes: ['api://agent-sentinel/AgentSentinel.Read'],
    redirectUri: 'https://sentinel.example/auth/callback',
    postLogoutRedirectUri: 'https://sentinel.example/',
  },
}

const estateRegistry = buildEstateRegistry(
  {
    AGENT_SENTINEL_ESTATES_JSON: JSON.stringify([
      {
        id: 'default',
        name: 'Default',
        tenantId: 'data-default',
        environment: 'production',
        isDefault: true,
        allowedAuthTenantIds: ['auth-tenant'],
      },
      {
        id: 'lab',
        name: 'Lab',
        tenantId: 'data-lab',
        environment: 'validation',
        isDefault: false,
        allowedAuthTenantIds: ['auth-tenant'],
      },
    ]),
  },
  {
    id: 'default',
    tenantId: 'unused',
    environment: 'unused',
    authTenantId: 'auth-tenant',
  },
)

function persistedHealth(sourceId: string, readiness: 'ready' | 'degraded'): ConnectorHealthReport {
  return {
    overall: readiness,
    partial: readiness === 'degraded',
    sources: [
      {
        id: `entra:${sourceId}`,
        name: `Entra ${sourceId}`,
        role: 'enrichment',
        enabled: true,
        configured: true,
        readiness,
        diagnostics: {
          kind: 'exact-identity-correlation',
          provider: 'microsoft-entra',
          sourceId,
          sourceTenantId: sourceId === 'default' ? 'data-default' : 'data-lab',
          sourceEnvironment: sourceId === 'default' ? 'production' : 'validation',
          authoritativeAgentsConsidered: 1,
          exactObjectIdMatches: readiness === 'ready' ? 1 : 0,
          exactApplicationIdMatches: 0,
          exactAgentIdentityMatches: 0,
          unmatched: readiness === 'ready' ? 0 : 1,
          ambiguous: 0,
          runsAsEdgesEmitted: readiness === 'ready' ? 1 : 0,
          ownerCoverage: { status: 'disabled', evidenceReferences: [] },
          appRoleCoverage: { status: 'disabled', evidenceReferences: [] },
          previewCoverage: { status: 'disabled', evidenceReferences: [] },
          evidenceReferences: [`evidence-${sourceId}`],
        },
      },
    ],
  }
}

const agent365Estate: EstateContext = {
  id: 'agent365-estate',
  tenantId: '11111111-1111-4111-8111-111111111111',
  environment: 'production',
}

const agent365EstateRegistry = buildEstateRegistry(
  {
    AGENT_SENTINEL_ESTATES_JSON: JSON.stringify([
      {
        ...agent365Estate,
        name: 'Agent 365 estate',
        isDefault: true,
        allowedAuthTenantIds: ['auth-tenant'],
      },
    ]),
  },
  { ...agent365Estate, authTenantId: 'auth-tenant' },
)

function agent365Source(etag = 'etag-current'): ConnectorSourceDefinition {
  return {
    estateId: agent365Estate.id,
    tenantId: agent365Estate.tenantId,
    environment: agent365Estate.environment,
    sourceId: 'agent365-current',
    connectorType: 'agent365',
    displayName: 'Current Agent 365',
    enabled: true,
    origin: 'user',
    configuration: {
      type: 'agent365',
      graphBaseUrl: 'https://graph.microsoft.com',
      limits: {
        maxPages: 3,
        maxItems: 500,
        requestTimeoutMs: 5_000,
        maxRetries: 1,
        maxRetryAfterMs: 1_000,
        maxResponseBytes: 50_000,
      },
    },
    credential: {
      mode: 'managed-identity',
      managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
    },
    testStatus: { status: 'not-tested' },
    version: 2,
    etag,
    createdBy: { type: 'service-principal', id: 'configuration-api' },
    updatedBy: { type: 'service-principal', id: 'configuration-api' },
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  }
}

function sourceRepository(values: readonly ConnectorSourceDefinition[]): ConnectorSourceRepository {
  return {
    create: () => Promise.reject(new Error('not used')),
    findById: (_estate, sourceId) =>
      Promise.resolve(values.find((source) => source.sourceId === sourceId) ?? null),
    list: (_estate, limit = 100, cursor) =>
      Promise.resolve(
        values
          .filter((source) => cursor === undefined || source.sourceId > cursor)
          .toSorted((left, right) => left.sourceId.localeCompare(right.sourceId))
          .slice(0, limit),
      ),
    update: () => Promise.reject(new Error('not used')),
    delete: () => Promise.reject(new Error('not used')),
    listAudit: () => Promise.resolve([]),
  }
}

function measuredAgent365Health(
  sourceSetFingerprint: string,
  measuredAt: string,
): ConnectorHealthReport {
  return {
    overall: 'ready',
    partial: false,
    sourceSetFingerprint,
    sources: [
      {
        id: 'agent365:agent365-old',
        name: 'Old Agent 365',
        role: 'discovery',
        enabled: true,
        configured: true,
        readiness: 'ready',
        dataState: 'complete',
        pages: 2,
        records: 25,
        checkedAt: measuredAt,
        provenance: {
          estateTenantId: agent365Estate.tenantId,
          estateEnvironment: agent365Estate.environment,
          sourceConnectorId: 'agent365-old',
          sourceTenantId: agent365Estate.tenantId,
          sourceEnvironment: agent365Estate.environment,
          provider: 'microsoft-graph-agent365-package-catalog',
          providerObjectId: '/v1.0/copilot/admin/catalog/packages',
        },
      },
    ],
  }
}

function postAgent365Composition(base: AgentConnector): AgentConnector {
  return new TeamsDistributionCompositionConnector(
    new AzureResourceGraphCompositionConnector(
      new PurviewCompositionConnector(
        new DefenderCloudAppsCompositionConnector(base, undefined),
        undefined,
      ),
      undefined,
    ),
    undefined,
  )
}

describe('GET /api/connectors', () => {
  it('returns 200 with active connector and catalog', async () => {
    const app = await createApp()
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/connectors' })
    expect(response.statusCode).toBe(200)
    const body: { active: unknown; catalog: unknown[] } = response.json()
    expect(body).toMatchObject({
      active: { mode: 'mock', source: 'mock', lifecycleState: 'connected' },
    })
    const { catalog } = body
    expect(Array.isArray(catalog)).toBe(true)
    expect(catalog.length).toBeGreaterThan(0)
  })

  it('marks Azure AI Foundry as available-to-configure in mock mode', async () => {
    const app = await createApp()
    apps.push(app)
    const body: { catalog: Array<{ id: string; lifecycleState: string }> } = (
      await app.inject({ method: 'GET', url: '/api/connectors' })
    ).json()
    const foundry = body.catalog.find((e) => e.id === 'azure-ai-foundry')
    expect(foundry?.lifecycleState).toBe('available-to-configure')
  })

  it('marks Agent 365 as authorization-required', async () => {
    const app = await createApp()
    apps.push(app)
    const body: { catalog: Array<{ id: string; lifecycleState: string }> } = (
      await app.inject({ method: 'GET', url: '/api/connectors' })
    ).json()
    const agent365 = body.catalog.find((e) => e.id === 'm365-agent-registry')
    expect(agent365?.lifecycleState).toBe('authorization-required')
  })

  it('does not expose secrets or credentials in the response', async () => {
    const app = await createApp()
    apps.push(app)
    const raw = (await app.inject({ method: 'GET', url: '/api/connectors' })).body
    const forbidden = ['password', 'client_secret', 'private_key', 'access_key', 'api_key']
    for (const term of forbidden) {
      expect(raw.toLowerCase()).not.toContain(term)
    }
  })

  it('keeps /api/connector/status backward compatible', async () => {
    const app = await createApp()
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/connector/status' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      source: 'mock',
      connectorId: 'mock-agent-estate',
      mode: 'mock',
    })
  })

  it('serves only the latest persisted health for the authorized estate', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: {
        sub: 'viewer',
        tid: 'auth-tenant',
        roles: ['AgentSentinel.Viewer'],
      },
    })
    const connector = new MockAgentConnector()
    const testConnection = vi
      .spyOn(connector, 'testConnection')
      .mockRejectedValue(new Error('live route must not probe the provider'))
    const getRuntimeHealth = vi.fn((): ConnectorHealthReport => ({
      overall: 'ready',
      partial: false,
      sources: [
        {
          id: 'otel:process-local',
          name: 'Process-local runtime state',
          role: 'enrichment',
          enabled: true,
          configured: true,
          readiness: 'ready',
        },
      ],
    }))
    const runtimeTelemetryConnector: RuntimeTelemetryConnector = {
      id: 'azure-monitor-otel',
      readObservationWindows: () => Promise.reject(new Error('not used')),
      getConnectorHealth: getRuntimeHealth,
    }
    const connectorHealth = new InMemoryConnectorHealthRepository()
    const connectorId = connector.descriptor.id
    const defaultEstate = {
      id: 'default',
      tenantId: 'data-default',
      environment: 'production',
    }
    const labEstate = {
      id: 'lab',
      tenantId: 'data-lab',
      environment: 'validation',
    }
    await connectorHealth.save(defaultEstate, {
      estateId: defaultEstate.id,
      tenantId: defaultEstate.tenantId,
      environment: defaultEstate.environment,
      connectorId,
      measuredAt: '2026-09-04T12:55:00.000Z',
      health: persistedHealth('stale-default', 'degraded'),
    })
    await connectorHealth.save(defaultEstate, {
      estateId: defaultEstate.id,
      tenantId: defaultEstate.tenantId,
      environment: defaultEstate.environment,
      connectorId,
      measuredAt: '2026-09-04T13:00:00.000Z',
      health: persistedHealth('default', 'ready'),
    })
    await connectorHealth.save(labEstate, {
      estateId: labEstate.id,
      tenantId: labEstate.tenantId,
      environment: labEstate.environment,
      connectorId,
      measuredAt: '2026-09-04T13:05:00.000Z',
      health: persistedHealth('lab', 'degraded'),
    })
    await connectorHealth.save(defaultEstate, {
      estateId: defaultEstate.id,
      tenantId: defaultEstate.tenantId,
      environment: defaultEstate.environment,
      connectorId: 'another-connector',
      measuredAt: '2026-09-04T13:10:00.000Z',
      health: persistedHealth('wrong-connector', 'degraded'),
    })
    const app = await createApp(
      new DemoService(
        defaultEstate,
        connector,
        'foundry',
        'https://default-estate.services.ai.azure.com/api/projects/default',
      ),
      jwtConfig,
      {
        dataMode: 'live',
        estateRegistry,
        connectorHealthRepository: connectorHealth,
        exposureRepository: new InMemoryExposureFindingRepository(),
        snapshotRepository: new InMemorySnapshotRepository(),
        runtimeTelemetryConnector,
        businessOutcomeConnector: null,
        connectorHealthClock: () => new Date('2026-09-04T13:10:00.000Z'),
      },
    )
    apps.push(app)

    const defaultResponse = await app.inject({
      method: 'GET',
      url: '/api/connectors',
      headers: { authorization: ['Bearer', 'valid-token'].join(' ') },
    })
    const labResponse = await app.inject({
      method: 'GET',
      url: '/api/connectors',
      headers: {
        authorization: ['Bearer', 'valid-token'].join(' '),
        'x-agent-sentinel-estate-id': 'lab',
      },
    })

    expect(defaultResponse.statusCode).toBe(200)
    expect(defaultResponse.json()).toMatchObject({
      active: { lifecycleState: 'connected' },
      health: {
        sources: [
          {
            id: 'entra:default',
            diagnostics: {
              sourceId: 'default',
              evidenceReferences: ['evidence-default'],
            },
          },
        ],
      },
    })
    expect(labResponse.statusCode).toBe(200)
    expect(labResponse.json()).toMatchObject({
      active: { lifecycleState: 'degraded' },
      health: {
        sources: [
          {
            id: 'entra:lab',
            diagnostics: {
              sourceId: 'lab',
              evidenceReferences: ['evidence-lab'],
            },
          },
        ],
      },
    })
    expect(labResponse.body).not.toContain('evidence-default')
    expect(labResponse.body).not.toContain('default-estate.services.ai.azure.com')
    expect(defaultResponse.body).not.toContain('evidence-stale-default')
    expect(defaultResponse.body).not.toContain('evidence-wrong-connector')
    expect(defaultResponse.body).not.toContain('otel:process-local')
    expect(
      defaultResponse
        .json<{ catalog: Array<{ id: string; lifecycleState: string }> }>()
        .catalog.find((entry) => entry.id === 'azure-monitor-otel')?.lifecycleState,
    ).toBe('unavailable')
    expect(testConnection).not.toHaveBeenCalled()
    expect(getRuntimeHealth).not.toHaveBeenCalled()
  })

  it('reports unavailable when live connector health has not been measured', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: {
        sub: 'viewer',
        tid: 'auth-tenant',
        roles: ['AgentSentinel.Viewer'],
      },
    })
    const connector = new MockAgentConnector()
    const testConnection = vi
      .spyOn(connector, 'testConnection')
      .mockRejectedValue(new Error('live route must not probe the provider'))
    const app = await createApp(new DemoService(mockEstate, connector, 'foundry'), jwtConfig, {
      dataMode: 'live',
      estateRegistry,
      connectorHealthRepository: new InMemoryConnectorHealthRepository(),
      exposureRepository: new InMemoryExposureFindingRepository(),
      snapshotRepository: new InMemorySnapshotRepository(),
      runtimeTelemetryConnector: null,
      businessOutcomeConnector: null,
    })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/api/connectors',
      headers: { authorization: ['Bearer', 'valid-token'].join(' ') },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      active: { lifecycleState: 'unavailable' },
    })
    expect(response.json()).not.toHaveProperty('health')
    expect(testConnection).not.toHaveBeenCalled()
  })

  it('synthesizes authorization-required health for an enabled Agent 365 source without UAMI', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: {
        sub: 'viewer',
        tid: 'auth-tenant',
        roles: ['AgentSentinel.Viewer'],
      },
    })
    const connector = new MockAgentConnector()
    const sourceWithoutUami: ConnectorSourceDefinition = {
      ...agent365Source(),
      credential: { mode: 'default' },
    }
    const app = await createApp(new DemoService(agent365Estate, connector, 'foundry'), jwtConfig, {
      dataMode: 'live',
      estateRegistry: agent365EstateRegistry,
      connectorSourceRepository: sourceRepository([sourceWithoutUami]),
      connectorHealthRepository: new InMemoryConnectorHealthRepository(),
      exposureRepository: new InMemoryExposureFindingRepository(),
      snapshotRepository: new InMemorySnapshotRepository(),
      runtimeTelemetryConnector: null,
      businessOutcomeConnector: null,
    })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/api/connectors',
      headers: { authorization: ['Bearer', 'valid-token'].join(' ') },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      active: { lifecycleState: string }
      catalog: Array<{ id: string; lifecycleState: string }>
      health: ConnectorHealthReport
    }>()
    expect(body.active.lifecycleState).toBe('unavailable')
    expect(body.health).toMatchObject({
      overall: 'unavailable',
      partial: true,
      sources: [
        {
          id: 'agent365:agent365-current',
          enabled: true,
          configured: false,
          readiness: 'authorization-required',
          dataState: 'unsupported',
          reason: 'dedicated-workload-identity-required',
        },
      ],
    })
    expect(body.catalog.find((entry) => entry.id === 'm365-agent-registry')?.lifecycleState).toBe(
      'authorization-required',
    )
    expect(body.health.sources.some((source) => source.readiness === 'ready')).toBe(false)
  })

  it('synthesizes unavailable health for an active Agent 365 source without a measurement', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: {
        sub: 'viewer',
        tid: 'auth-tenant',
        roles: ['AgentSentinel.Viewer'],
      },
    })
    const connector = new MockAgentConnector()
    const app = await createApp(new DemoService(agent365Estate, connector, 'foundry'), jwtConfig, {
      dataMode: 'live',
      estateRegistry: agent365EstateRegistry,
      connectorSourceRepository: sourceRepository([agent365Source()]),
      connectorHealthRepository: new InMemoryConnectorHealthRepository(),
      exposureRepository: new InMemoryExposureFindingRepository(),
      snapshotRepository: new InMemorySnapshotRepository(),
      runtimeTelemetryConnector: null,
      businessOutcomeConnector: null,
    })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/api/connectors',
      headers: { authorization: ['Bearer', 'valid-token'].join(' ') },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      catalog: Array<{ id: string; lifecycleState: string }>
      health: ConnectorHealthReport
    }>()
    expect(body.health).toMatchObject({
      overall: 'unavailable',
      partial: true,
      sources: [
        {
          id: 'agent365:agent365-current',
          enabled: true,
          configured: true,
          readiness: 'unavailable',
          reason: 'not-measured',
        },
      ],
    })
    expect(body.catalog.find((entry) => entry.id === 'm365-agent-registry')?.lifecycleState).toBe(
      'unavailable',
    )
    expect(body.health.sources.some((source) => source.readiness === 'ready')).toBe(false)
  })

  it.each([
    {
      name: 'source generation changed',
      measuredAt: '2026-09-09T00:00:00.000Z',
      fingerprint: '0'.repeat(64),
      now: new Date('2026-09-09T00:05:00.000Z'),
      reason: 'source-set-changed',
    },
    {
      name: 'measurement expired',
      measuredAt: '2026-09-07T00:00:00.000Z',
      fingerprint: undefined,
      now: new Date('2026-09-09T00:00:00.001Z'),
      reason: 'measurement-expired',
    },
  ])(
    'degrades persisted Agent 365 health when the $name',
    async ({ measuredAt, fingerprint, now, reason }) => {
      jose.jwtVerify.mockResolvedValue({
        payload: {
          sub: 'viewer',
          tid: 'auth-tenant',
          roles: ['AgentSentinel.Viewer'],
        },
      })
      const sources = sourceRepository([agent365Source()])
      const currentRuntime = await resolveAgent365Runtime(sources, agent365Estate)
      const measuredFingerprint = fingerprint ?? currentRuntime.sourceSetFingerprint
      const connector = new MockAgentConnector()
      const connectorHealth = new InMemoryConnectorHealthRepository()
      const health = measuredAgent365Health(measuredFingerprint, measuredAt)
      await connectorHealth.save(agent365Estate, {
        estateId: agent365Estate.id,
        tenantId: agent365Estate.tenantId,
        environment: agent365Estate.environment,
        connectorId: connector.descriptor.id,
        sourceSetFingerprint: measuredFingerprint,
        measuredAt,
        health,
      })
      const app = await createApp(
        new DemoService(agent365Estate, connector, 'foundry'),
        jwtConfig,
        {
          dataMode: 'live',
          estateRegistry: agent365EstateRegistry,
          connectorSourceRepository: sources,
          connectorHealthRepository: connectorHealth,
          exposureRepository: new InMemoryExposureFindingRepository(),
          snapshotRepository: new InMemorySnapshotRepository(),
          runtimeTelemetryConnector: null,
          businessOutcomeConnector: null,
          connectorHealthClock: () => now,
        },
      )
      apps.push(app)

      const response = await app.inject({
        method: 'GET',
        url: '/api/connectors',
        headers: { authorization: ['Bearer', 'valid-token'].join(' ') },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json<{
        active: { lifecycleState: string }
        health: ConnectorHealthReport
      }>()
      expect(body.active.lifecycleState).toBe('degraded')
      expect(body.health).toMatchObject({
        overall: 'degraded',
        partial: true,
      })
      expect(
        body.health.sources.find((source) => source.id === 'agent365:agent365-old'),
      ).toMatchObject({
        readiness: 'degraded',
        dataState: 'stale',
        pages: 2,
        records: 25,
        checkedAt: measuredAt,
        reason,
        provenance: {
          sourceConnectorId: 'agent365-old',
          provider: 'microsoft-graph-agent365-package-catalog',
        },
      })
    },
  )

  it('serves aggregate Agent 365 health metadata persisted after every outer composition wrapper', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: {
        sub: 'viewer',
        tid: 'auth-tenant',
        roles: ['AgentSentinel.Viewer'],
      },
    })
    const measuredAt = '2026-09-09T00:05:00.000Z'
    const sources = sourceRepository([agent365Source()])
    const runtime = await resolveAgent365Runtime(sources, agent365Estate)
    const baseHealth = measuredAgent365Health(runtime.sourceSetFingerprint, measuredAt)
    const base: AgentConnector = {
      descriptor: {
        id: 'composed-agent365',
        name: 'Composed Agent 365',
        apiVersion: 'v1',
        releaseStatus: 'ga',
        capabilities: ['discovery'],
        requiredPermissions: [],
        blindSpots: [],
      },
      testConnection: () =>
        Promise.resolve({ ok: true, checkedAt: measuredAt, message: 'Connected.' }),
      discover: () => Promise.reject(new Error('not used')),
      getEvidence: () => Promise.reject(new Error('not used')),
      getConnectorHealth: () => structuredClone(baseHealth),
    }
    const connector = postAgent365Composition(base)
    const connectorHealth = new InMemoryConnectorHealthRepository()
    const health = connector.getConnectorHealth?.()
    if (health === undefined) throw new Error('Expected composed connector health.')

    expect(health.sourceSetFingerprint).toBe(runtime.sourceSetFingerprint)
    await connectorHealth.save(agent365Estate, {
      estateId: agent365Estate.id,
      tenantId: agent365Estate.tenantId,
      environment: agent365Estate.environment,
      connectorId: connector.descriptor.id,
      sourceSetFingerprint: runtime.sourceSetFingerprint,
      measuredAt,
      health,
    })
    const app = await createApp(new DemoService(agent365Estate, connector, 'foundry'), jwtConfig, {
      dataMode: 'live',
      estateRegistry: agent365EstateRegistry,
      connectorSourceRepository: sources,
      connectorHealthRepository: connectorHealth,
      exposureRepository: new InMemoryExposureFindingRepository(),
      snapshotRepository: new InMemorySnapshotRepository(),
      runtimeTelemetryConnector: null,
      businessOutcomeConnector: null,
      connectorHealthClock: () => new Date(measuredAt),
    })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/api/connectors',
      headers: { authorization: ['Bearer', 'valid-token'].join(' ') },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ health: ConnectorHealthReport }>().health).toMatchObject({
      sourceSetFingerprint: runtime.sourceSetFingerprint,
      overall: 'degraded',
      partial: true,
    })
  })
})

describe('buildConnectorsCollection', () => {
  it('marks Foundry as connected in foundry mode', () => {
    const result = buildConnectorsCollection('foundry', { connectorId: 'foundry-connector' })
    const foundry = result.catalog.find((e) => e.id === 'azure-ai-foundry')
    expect(foundry?.lifecycleState).toBe('connected')
  })

  it('marks Foundry as available-to-configure in mock mode', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const foundry = result.catalog.find((e) => e.id === 'azure-ai-foundry')
    expect(foundry?.lifecycleState).toBe('available-to-configure')
  })

  it('active connector always shows lifecycleState connected', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    expect(result.active.lifecycleState).toBe('connected')
  })

  it('keeps configured Azure Monitor OTel unavailable until measured health is supplied', () => {
    const unavailable = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-connector',
    })

    const configured = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-connector',
      runtimeTelemetryConfigured: true,
    })
    expect(
      unavailable.catalog.find((entry) => entry.id === 'azure-monitor-otel')?.lifecycleState,
    ).toBe('available-to-configure')
    expect(
      configured.catalog.find((entry) => entry.id === 'azure-monitor-otel')?.lifecycleState,
    ).toBe('unavailable')
  })

  it('exposes measured multi-source OTel readiness', () => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-connector',
      runtimeTelemetryConfigured: true,
      runtimeTelemetryHealth: {
        overall: 'degraded',
        partial: false,
        sources: [
          {
            id: 'otel:project-a',
            name: 'Project A Azure Monitor',
            role: 'enrichment',
            enabled: true,
            configured: true,
            readiness: 'degraded',
            reason: 'not-queried',
          },
        ],
      },
    })
    expect(result.catalog.find((entry) => entry.id === 'azure-monitor-otel')?.lifecycleState).toBe(
      'degraded',
    )
    expect(result.health?.sources).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'otel:project-a' })]),
    )
  })

  it('Entra inventory is implemented, authorization-required, and distinct from Foundry auth', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const entra = result.catalog.find((e) => e.id === 'entra-agent-id')
    expect(entra?.lifecycleState).toBe('authorization-required')
    expect(entra?.capabilities).toContain('identity')
    expect(entra?.capabilities).toContain('entitlement')
    expect(entra?.prerequisiteNote).toContain('Application.Read.All')
  })

  it('describes the unsupported unattended Power Platform authorization boundary', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const powerPlatform = result.catalog.find((entry) => entry.id === 'copilot-studio')
    expect(powerPlatform).toMatchObject({
      lifecycleState: 'authorization-required',
      sourceOfTruth: true,
      ownershipModel: 'consumes',
    })
    expect(powerPlatform?.description).toContain('Microsoft 365 Copilot Agent Builder')
    expect(powerPlatform?.description).toContain('preview')
    expect(powerPlatform?.prerequisiteNote).toContain('ResourceQuery.Resources.Read')
    expect(powerPlatform?.prerequisiteNote).toContain('No supported unattended authorization path')
    expect(powerPlatform?.prerequisiteNote).not.toContain('requires Power Platform Reader')
  })

  it('maps enabled Power Platform source health without degrading Foundry catalog state', () => {
    const base = {
      connectorId: 'azure-ai-foundry-agent-service',
      connectorHealth: {
        overall: 'degraded' as const,
        partial: true,
        sources: [
          {
            id: 'foundry:primary',
            name: 'Foundry',
            role: 'discovery' as const,
            enabled: true,
            configured: true,
            readiness: 'ready' as const,
          },
          {
            id: 'power-platform:studio',
            name: 'Studio',
            role: 'discovery' as const,
            enabled: true,
            configured: true,
            readiness: 'authorization-required' as const,
            reason: 'authorization',
          },
        ],
      },
    }
    const authorizationRequired = buildConnectorsCollection('foundry', base)
    expect(
      authorizationRequired.catalog.find((entry) => entry.id === 'copilot-studio')?.lifecycleState,
    ).toBe('authorization-required')
    expect(
      authorizationRequired.catalog.find((entry) => entry.id === 'azure-ai-foundry')
        ?.lifecycleState,
    ).toBe('connected')

    const connected = buildConnectorsCollection('foundry', {
      ...base,
      connectorHealth: {
        overall: 'ready',
        partial: false,
        sources: [
          base.connectorHealth.sources[0]!,
          { ...base.connectorHealth.sources[1]!, readiness: 'ready' as const },
        ],
      },
    })
    expect(connected.catalog.find((entry) => entry.id === 'copilot-studio')?.lifecycleState).toBe(
      'connected',
    )

    const degraded = buildConnectorsCollection('foundry', {
      ...base,
      connectorHealth: {
        ...base.connectorHealth,
        sources: [
          base.connectorHealth.sources[0]!,
          { ...base.connectorHealth.sources[1]!, readiness: 'degraded' as const },
        ],
      },
    })
    expect(degraded.catalog.find((entry) => entry.id === 'copilot-studio')?.lifecycleState).toBe(
      'degraded',
    )

    const unavailable = buildConnectorsCollection('foundry', {
      ...base,
      connectorHealth: {
        ...base.connectorHealth,
        sources: [
          base.connectorHealth.sources[0]!,
          {
            ...base.connectorHealth.sources[1]!,
            readiness: 'unavailable' as const,
            reason: 'network',
          },
        ],
      },
    })
    expect(unavailable.catalog.find((entry) => entry.id === 'copilot-studio')?.lifecycleState).toBe(
      'unavailable',
    )
  })

  it('maps measured Entra health without hiding partial readiness', () => {
    const diagnostics = {
      kind: 'exact-identity-correlation' as const,
      provider: 'microsoft-entra' as const,
      sourceId: 'primary',
      sourceTenantId: '11111111-1111-4111-8111-111111111111',
      sourceEnvironment: 'validation',
      authoritativeAgentsConsidered: 6,
      exactObjectIdMatches: 0,
      exactApplicationIdMatches: 0,
      exactAgentIdentityMatches: 0,
      unmatched: 6,
      ambiguous: 0,
      runsAsEdgesEmitted: 0,
      ownerCoverage: { status: 'disabled' as const, evidenceReferences: [] },
      appRoleCoverage: { status: 'disabled' as const, evidenceReferences: [] },
      previewCoverage: { status: 'disabled' as const, evidenceReferences: [] },
      evidenceReferences: ['foundry-evidence-agent-1'],
    }
    const health = {
      overall: 'degraded' as const,
      partial: false,
      sourceSetFingerprint: 'a'.repeat(64),
      sources: [
        {
          id: 'microsoft-entra-service-principals',
          name: 'Microsoft Entra service principals',
          role: 'enrichment' as const,
          enabled: true,
          configured: true,
          readiness: 'degraded' as const,
          reason: 'unavailable',
          diagnostics,
        },
      ],
    }
    const degraded = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-connector',
      connectorHealth: health,
    })

    expect(degraded.health).toEqual(health)
    expect(degraded.catalog.find((entry) => entry.id === 'entra-agent-id')?.lifecycleState).toBe(
      'degraded',
    )
    expect(degraded.health?.sources[0]?.diagnostics).toEqual(diagnostics)

    const ready = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-connector',
      connectorHealth: {
        ...health,
        overall: 'ready',
        partial: false,
        sources: [{ ...health.sources[0]!, readiness: 'ready' }],
      },
    })
    expect(ready.catalog.find((entry) => entry.id === 'entra-agent-id')?.lifecycleState).toBe(
      'connected',
    )
  })

  it('reports partially reachable Foundry sources as degraded', () => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'azure-ai-foundry-agent-service',
      connectionOk: false,
      connectorHealth: {
        overall: 'degraded',
        partial: true,
        sources: [
          {
            id: 'project-a',
            name: 'Project A',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
          },
          {
            id: 'project-b',
            name: 'Project B',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'unavailable',
            reason: 'authentication-or-access',
          },
        ],
      },
    })

    expect(result.active.lifecycleState).toBe('degraded')
    expect(result.catalog.find((entry) => entry.id === 'azure-ai-foundry')?.lifecycleState).toBe(
      'degraded',
    )
  })

  it('reports partial multi-tenant Entra authorization as degraded', () => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'azure-ai-foundry-agent-service',
      connectorHealth: {
        overall: 'degraded',
        partial: true,
        sources: [
          {
            id: 'foundry:project-a',
            name: 'Project A',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
          },
          {
            id: 'entra:project-a',
            name: 'Project A Entra',
            role: 'enrichment',
            enabled: true,
            configured: true,
            readiness: 'ready',
          },
          {
            id: 'entra:project-b',
            name: 'Project B Entra',
            role: 'enrichment',
            enabled: true,
            configured: false,
            readiness: 'authorization-required',
          },
        ],
      },
    })
    expect(result.catalog.find((entry) => entry.id === 'entra-agent-id')?.lifecycleState).toBe(
      'degraded',
    )
  })

  it('custom manifest adapter is configurable but never a source of truth', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const manifest = result.catalog.find((e) => e.id === 'custom-manifest-adapter')
    expect(manifest?.lifecycleState).toBe('available-to-configure')
    expect(manifest?.sourceOfTruth).toBe(false)
    expect(manifest?.capabilities).toContain('discovery')
    expect(manifest?.prerequisiteNote).toContain('non-authoritative evidence')
    expect(manifest?.settingsPath).toBeUndefined()
  })

  it('Agent 365 has sourceOfTruth and requires authorization', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const agent365 = result.catalog.find((e) => e.id === 'm365-agent-registry')
    expect(agent365?.sourceOfTruth).toBe(true)
    expect(agent365?.lifecycleState).toBe('authorization-required')
    expect(agent365?.prerequisiteNote).toBeTruthy()
  })

  it('describes Defender for Cloud Apps as read-only unattributed OAuth evidence', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const defender = result.catalog.find((entry) => entry.id === 'defender-for-cloud-apps')
    expect(defender).toMatchObject({
      lifecycleState: 'authorization-required',
      capabilities: ['security-alerts'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
      unlocksScorecard: [],
    })

    expect(defender?.description).toContain('unattributed')
    expect(defender?.prerequisiteNote).toContain('Investigation.Read')
    expect(defender?.prerequisiteNote).toContain('Legacy API tokens are not accepted')
  })

  it('describes Purview as a read-only Global Graph label catalog without usage claims', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const purview = result.catalog.find((entry) => entry.id === 'purview')
    expect(purview).toMatchObject({
      lifecycleState: 'authorization-required',
      capabilities: ['data-governance'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
      unlocksScorecard: [],
    })
    expect(purview?.description).toContain('v1.0')
    expect(purview?.description).toContain('unattributed')
    expect(purview?.prerequisiteNote).toContain('SensitivityLabel.Read')
    expect(purview?.prerequisiteNote).toContain('Global Graph')
    expect(purview?.prerequisiteNote).toContain('no activity/usage evidence')
  })

  it('describes Azure Resource Graph as read-only unattributed resource evidence', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const resourceGraph = result.catalog.find((entry) => entry.id === 'azure-resource-graph')
    expect(resourceGraph).toMatchObject({
      lifecycleState: 'available-to-configure',
      capabilities: ['discovery'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
      unlocksScorecard: [],
    })
    expect(resourceGraph?.description).toContain('unattributed')
    expect(resourceGraph?.description).toContain('never classified as agents')
    expect(resourceGraph?.prerequisiteNote).toContain('Reader')
    expect(resourceGraph?.prerequisiteNote).toContain('does not require M365 E5')
  })

  it.each([
    ['ready', 'connected'],
    ['degraded', 'degraded'],
    ['authorization-required', 'authorization-required'],
    ['unavailable', 'unavailable'],
  ] as const)('maps enabled Azure Resource Graph %s health to %s', (readiness, lifecycle) => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      connectorHealth: {
        overall: readiness === 'ready' ? 'ready' : 'degraded',
        partial: readiness !== 'ready',
        sources: [
          {
            id: 'foundry:primary',
            name: 'Foundry',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
          },
          {
            id: 'azure-resource-graph:primary',
            name: 'Azure subscription',
            role: 'enrichment',
            enabled: true,
            configured: true,
            readiness,
          },
        ],
      },
    })
    expect(
      result.catalog.find((entry) => entry.id === 'azure-resource-graph')?.lifecycleState,
    ).toBe(lifecycle)
  })

  it.each([
    ['ready', 'connected'],
    ['degraded', 'degraded'],
    ['authorization-required', 'authorization-required'],
    ['unavailable', 'unavailable'],
  ] as const)('maps enabled Purview %s health to %s', (readiness, lifecycle) => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      connectorHealth: {
        overall: readiness === 'ready' ? 'ready' : 'degraded',
        partial: readiness !== 'ready',
        sources: [
          {
            id: 'foundry:primary',
            name: 'Foundry',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
          },
          {
            id: 'purview:tenant-a',
            name: 'Purview Tenant A',
            role: 'enrichment',
            enabled: true,
            configured: true,
            readiness,
          },
        ],
      },
    })
    expect(result.catalog.find((entry) => entry.id === 'purview')?.lifecycleState).toBe(lifecycle)
    expect(result.catalog.find((entry) => entry.id === 'azure-ai-foundry')?.lifecycleState).toBe(
      'connected',
    )
  })

  it('describes Teams distribution as tenant catalog evidence without installation claims', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const teams = result.catalog.find((entry) => entry.id === 'teams-distribution')
    expect(teams).toMatchObject({
      lifecycleState: 'authorization-required',
      capabilities: ['discovery'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
      unlocksScorecard: [],
    })
    expect(teams?.description).toContain('organization app catalog')
    expect(teams?.description).toContain('does not prove an agent')
    expect(teams?.description).toContain('installation')
    expect(teams?.prerequisiteNote).toContain('AppCatalog.Read.All')
    expect(teams?.prerequisiteNote).toContain('Global Graph')
  })

  it.each([
    ['ready', 'connected'],
    ['degraded', 'degraded'],
    ['authorization-required', 'authorization-required'],
    ['unavailable', 'unavailable'],
  ] as const)('maps enabled Teams distribution %s health to %s', (readiness, lifecycle) => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      connectorHealth: {
        overall: readiness === 'ready' ? 'ready' : 'degraded',
        partial: readiness !== 'ready',
        sources: [
          {
            id: 'foundry:primary',
            name: 'Foundry',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
          },
          {
            id: 'teams-distribution:tenant-a',
            name: 'Teams Tenant A',
            role: 'enrichment',
            enabled: true,
            configured: true,
            readiness,
          },
        ],
      },
    })
    expect(result.catalog.find((entry) => entry.id === 'teams-distribution')?.lifecycleState).toBe(
      lifecycle,
    )
    expect(result.catalog.find((entry) => entry.id === 'azure-ai-foundry')?.lifecycleState).toBe(
      'connected',
    )
  })

  it.each([
    ['ready', 'connected'],
    ['degraded', 'degraded'],
    ['authorization-required', 'authorization-required'],
    ['unavailable', 'unavailable'],
  ] as const)('maps enabled Defender for Cloud Apps %s health to %s', (readiness, lifecycle) => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      connectorHealth: {
        overall: readiness === 'ready' ? 'ready' : 'degraded',
        partial: readiness !== 'ready',
        sources: [
          {
            id: 'foundry:primary',
            name: 'Foundry',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
          },
          {
            id: 'defender-cloud-apps:tenant-a',
            name: 'MDCA Tenant A',
            role: 'enrichment',
            enabled: true,
            configured: true,
            readiness,
          },
        ],
      },
    })
    expect(
      result.catalog.find((entry) => entry.id === 'defender-for-cloud-apps')?.lifecycleState,
    ).toBe(lifecycle)
    expect(result.catalog.find((entry) => entry.id === 'azure-ai-foundry')?.lifecycleState).toBe(
      'connected',
    )
  })

  it.each([
    ['ready', 'connected'],
    ['degraded', 'degraded'],
    ['authorization-required', 'authorization-required'],
    ['unavailable', 'unavailable'],
  ] as const)('maps enabled Agent 365 %s health to %s', (readiness, lifecycle) => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      connectorHealth: {
        overall: readiness === 'ready' ? 'ready' : 'degraded',
        partial: readiness !== 'ready',
        sources: [
          {
            id: 'foundry:primary',
            name: 'Foundry',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
          },
          {
            id: 'agent365:tenant-a',
            name: 'Agent 365 Tenant A',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness,
            ...(readiness === 'ready' ? { dataState: 'complete' as const } : {}),
          },
        ],
      },
    })
    expect(result.catalog.find((entry) => entry.id === 'm365-agent-registry')?.lifecycleState).toBe(
      lifecycle,
    )
    expect(
      result.catalog.find((entry) => entry.id === 'm365-sharepoint-agents')?.lifecycleState,
    ).toBe(lifecycle)
    expect(result.catalog.find((entry) => entry.id === 'azure-ai-foundry')?.lifecycleState).toBe(
      'connected',
    )
  })

  it.each(['partial', 'stale', 'failed', 'cancelled', 'empty'] as const)(
    'keeps successfully probed Agent 365 %s data degraded instead of connected',
    (dataState) => {
      const result = buildConnectorsCollection('foundry', {
        connectorId: 'foundry-test',
        connectorHealth: {
          overall: 'degraded',
          partial: true,
          sources: [
            {
              id: 'foundry:primary',
              name: 'Foundry',
              role: 'discovery',
              enabled: true,
              configured: true,
              readiness: 'ready',
            },
            {
              id: 'agent365:tenant-a',
              name: 'Agent 365 Tenant A',
              role: 'discovery',
              enabled: true,
              configured: true,
              readiness: 'ready',
              dataState,
            },
          ],
        },
      })

      expect(
        result.catalog.find((entry) => entry.id === 'm365-agent-registry')?.lifecycleState,
      ).toBe('degraded')
      expect(
        result.catalog.find((entry) => entry.id === 'm365-sharepoint-agents')?.lifecycleState,
      ).toBe('degraded')
    },
  )

  it('marks mixed Agent 365 source health degraded and documents read-only prerequisites', () => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      connectorHealth: {
        overall: 'degraded',
        partial: true,
        sources: [
          {
            id: 'foundry:primary',
            name: 'Foundry',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
          },
          {
            id: 'agent365:a',
            name: 'A',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
          },
          {
            id: 'agent365:b',
            name: 'B',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'authorization-required',
          },
        ],
      },
    })
    const entry = result.catalog.find((item) => item.id === 'm365-agent-registry')
    expect(entry?.lifecycleState).toBe('degraded')
    expect(entry?.description).toContain('v1.0')
    expect(entry?.description).toContain('read-only')
    expect(entry?.prerequisiteNote).toContain('Microsoft Agent 365 licensing')
    expect(entry?.prerequisiteNote).toContain('CopilotPackages.Read.All')
    expect(entry?.capabilities).not.toContain('lifecycle-admin')
    const sharePoint = result.catalog.find((item) => item.id === 'm365-sharepoint-agents')
    expect(sharePoint?.lifecycleState).toBe('degraded')
    expect(sharePoint?.prerequisiteNote).toContain('CopilotPackages.Read.All')
    expect(sharePoint?.description).toContain('without duplicating package evidence')
  })
  it('includes expected capability kinds for all entries', () => {
    const validCapabilities = new Set([
      'discovery',
      'identity',
      'entitlement',
      'runtime-telemetry',
      'business-outcomes',
      'security-alerts',
      'data-governance',
      'lifecycle-admin',
      'write-remediation',
    ])
    for (const entry of connectorBaseCatalog) {
      for (const cap of entry.capabilities as string[]) {
        expect(validCapabilities).toContain(cap)
      }
    }
  })

  it('no catalog entry exposes secrets or tenant-private fields', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const json = JSON.stringify(result)
    const forbidden = ['password', 'client_secret', 'private_key', 'access_key', 'api_key']
    for (const term of forbidden) {
      expect(json.toLowerCase()).not.toContain(term)
    }
  })

  it('propagates writeEnabled and projectEndpoint when provided', () => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      connectionOk: true,
      writeEnabled: false,
      projectEndpoint: 'https://example.services.ai.azure.com/api/projects/test',
    })
    expect(result.active.writeEnabled).toBe(false)
    expect(result.active.projectEndpoint).toBe(
      'https://example.services.ai.azure.com/api/projects/test',
    )
  })

  it('marks configured Foundry unavailable when its connection test fails', () => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      connectionOk: false,
    })
    expect(result.active.lifecycleState).toBe('unavailable')
    expect(result.catalog.find((entry) => entry.id === 'azure-ai-foundry')?.lifecycleState).toBe(
      'unavailable',
    )
  })

  it('catalogs business outcomes without claiming an unconfigured live source', () => {
    const unconfigured = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
    }).catalog.find((entry) => entry.id === 'business-outcome-source')
    const configured = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      businessOutcomeConfigured: true,
    }).catalog.find((entry) => entry.id === 'business-outcome-source')

    expect(unconfigured?.lifecycleState).toBe('available-to-configure')
    expect(configured?.lifecycleState).toBe('connected')
    expect(configured?.capabilities).toContain('business-outcomes')
  })
})

describe('connector write status', () => {
  it('keeps mock simulation enabled by default', async () => {
    const service = new DemoService(mockEstate, new MockAgentConnector(), 'mock')
    await expect(service.getConnectorStatus()).resolves.toMatchObject({ writeEnabled: true })
  })

  it('fails closed for Foundry unless writes are explicitly enabled', async () => {
    const service = new DemoService(mockEstate, new MockAgentConnector(), 'foundry')
    await expect(service.getConnectorStatus()).resolves.toMatchObject({ writeEnabled: false })

    process.env['AGENT_SENTINEL_WRITE_ENABLED'] = 'true'
    await expect(service.getConnectorStatus()).resolves.toMatchObject({ writeEnabled: true })
  })

  it('rejects execution when a connector method exists without execution capability', async () => {
    const base = new MockAgentConnector()
    const connector = {
      descriptor: {
        ...base.descriptor,
        capabilities: ['discovery', 'evidence'] as const,
      },
      testConnection: base.testConnection.bind(base),
      discover: base.discover.bind(base),
      getEvidence: base.getEvidence.bind(base),
      execute: base.execute.bind(base),
    }
    const service = new DemoService(mockEstate, connector, 'mock')
    const initial = await service.getState()
    const findingId = initial.findings[0]?.id
    if (findingId === undefined) throw new Error('Expected a mock finding.')
    await service.validateFinding(findingId)
    const proposed = await service.proposeRemediation(findingId)
    const remediationId = proposed.remediations[0]?.id
    if (remediationId === undefined) throw new Error('Expected a proposed remediation.')
    await service.approveRemediation(
      remediationId,
      'approver',
      'Reviewed validated evidence and approved the reversible plan.',
    )

    const app = await createApp(service, { mode: 'disabled' }, { dataMode: 'mock' })
    apps.push(app)
    const response = await app.inject({
      method: 'POST',
      url: `/api/demo/remediations/${remediationId}/execute`,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({
      error: 'operation_rejected',
      message: 'The selected connector does not support remediation execution.',
    })
  })
})
