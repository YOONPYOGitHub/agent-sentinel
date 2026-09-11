import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  ConnectorSourceDefinition,
  ConnectorSourceRepository,
  EstateContext,
  EstateSnapshot,
  SnapshotRepository,
} from '@agent-sentinel/domain'
import { agentSentinelStateSchema } from '@agent-sentinel/domain'
import {
  computeManifestHash,
  type AgentConnector,
  ManifestIngestionSourceLimitError,
  MAX_MANIFEST_SOURCES,
  manifestIngestionRecordSchema,
  projectRuntimeEvidence,
  runtimeObservationWindowsSchema,
  runtimeTelemetryRequestForAgent,
} from '@agent-sentinel/connector-sdk'
import type { ManifestIngestionRepository } from '@agent-sentinel/connector-sdk'
import { MockAgentConnector } from '@agent-sentinel/mock-connector'
import { resolveAgent365Runtime } from '@agent-sentinel/connector-runtime'
import { InMemoryConnectorHealthRepository } from '@agent-sentinel/persistence'

import { createApp } from '../src/app.js'
import { DemoService } from '../src/demo-service.js'
import { buildEstateRegistry } from '../src/estate-config.js'
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

function authorizeRuntimeAgent(
  snapshot: EstateSnapshot,
  agent: EstateSnapshot['nodes'][number],
  sourceObjectId = 'provider-agent-id',
): void {
  agent.environment = snapshot.environment
  Object.assign(agent.metadata, {
    sourceOfTruth: 'true',
    sourceConnectorId: 'primary',
    sourceTenantId: snapshot.tenantId,
    sourceProjectId: 'test',
    sourceObjectId,
    sourceEnvironment: snapshot.environment,
  })
  const evidence = snapshot.evidence.find((item) => agent.evidenceIds.includes(item.id))
  if (evidence === undefined) throw new Error('Expected authoritative agent evidence.')
  evidence.evidenceTypes = ['declared_configuration']
  evidence.sourceObjectId = sourceObjectId
  evidence.metadata = {
    ...evidence.metadata,
    sourceOfTruth: 'true',
    estateTenantId: snapshot.tenantId,
    estateEnvironment: snapshot.environment,
    sourceConnectorId: 'primary',
    sourceTenantId: snapshot.tenantId,
    sourceProjectId: 'test',
    sourceEnvironment: snapshot.environment,
    sourceObjectId,
  }
}

function legacyRuntimeSnapshot(): EstateSnapshot {
  const snapshot = {
    tenantId: 'tenant-demo',
    environment: 'validation',
    generatedAt: '2026-09-09T00:00:00.000Z',
    nodes: [
      {
        id: 'agent-a',
        kind: 'agent',
        name: 'Agent A',
        description: 'Authoritative agent.',
        environment: 'validation',
        evidenceIds: ['declared-agent', 'runtime-observed'],
        metadata: {
          sourceOfTruth: 'true',
          sourceConnectorId: 'primary',
          sourceTenantId: 'tenant-demo',
          sourceProjectId: 'validation',
          sourceObjectId: 'provider-agent-a',
          sourceEnvironment: 'validation',
        },
      },
    ],
    edges: [],
    evidence: [
      {
        id: 'declared-agent',
        source: 'Foundry',
        sourceObjectId: 'provider-agent-a',
        observedAt: '2026-09-09T00:00:00.000Z',
        freshness: 'live',
        confidence: 1,
        evidenceTypes: ['declared_configuration'],
        summary: 'Declared agent.',
        metadata: {
          sourceOfTruth: 'true',
          estateTenantId: 'tenant-demo',
          estateEnvironment: 'validation',
          sourceConnectorId: 'primary',
          sourceTenantId: 'tenant-demo',
          sourceProjectId: 'validation',
          sourceEnvironment: 'validation',
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
        metadata: { sourceConnector: 'azure-monitor-otel', windowKind: 'observed' },
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
                estateId: 'default',
                estateTenantId: 'tenant-demo',
                estateEnvironment: 'validation',
                sourceConnectorId: 'primary',
                sourceTenantId: 'tenant-demo',
                sourceEnvironment: 'validation',
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
  return snapshot as EstateSnapshot
}

function runtimeManifestRecord(snapshot: EstateSnapshot, agent: EstateSnapshot['nodes'][number]) {
  const sourceBinding = {
    sourceConnectorId: agent.metadata['sourceConnectorId']!,
    sourceTenantId: agent.metadata['sourceTenantId']!,
    sourceObjectId: agent.metadata['sourceObjectId']!,
    sourceEnvironment: agent.metadata['sourceEnvironment']!,
  }
  const envelope = {
    schemaVersion: '1.0' as const,
    manifestId: 'runtime-manifest',
    tenantId: snapshot.tenantId,
    environmentId: snapshot.environment,
    producedAt: snapshot.generatedAt,
    producer: { name: 'Runtime manifest producer' },
    capabilities: {
      supportsDiscovery: true,
      evidenceDepth: 'deep' as const,
      supportsRuntimeTelemetry: true,
      supportsActions: 'none' as const,
    },
    agents: [{ id: sourceBinding.sourceObjectId, displayName: agent.name }],
    tools: [],
    identities: [],
    dataSources: [],
    mcpDependencies: [],
    edges: [],
    evidence: [
      {
        id: 'runtime-claim',
        subjectId: sourceBinding.sourceObjectId,
        evidenceType: 'runtime_observed' as const,
        confidence: 0.8,
        observedAt: snapshot.generatedAt,
        sourceBinding,
        claims: {},
      },
    ],
    metadata: {},
  }
  return manifestIngestionRecordSchema.parse({
    tenantId: snapshot.tenantId,
    environmentId: snapshot.environment,
    manifestId: envelope.manifestId,
    manifestHash: computeManifestHash(envelope),
    ingestedAt: snapshot.generatedAt,
    ingestedBySubject: 'administrator',
    envelope,
    snapshot: {
      tenantId: snapshot.tenantId,
      environment: snapshot.environment,
      generatedAt: snapshot.generatedAt,
      nodes: [],
      edges: [],
      evidence: [],
    },
  })
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()))
  delete process.env['AGENT_SENTINEL_CONNECTOR']
  delete process.env['FOUNDRY_PROJECT_ENDPOINT']
  delete process.env['FOUNDRY_TENANT_ID']
  delete process.env['FOUNDRY_ENVIRONMENT']
})

describe('live product read model', () => {
  it('joins current Agent 365 failure health into retained package state evidence', async () => {
    const estate: EstateContext = {
      id: 'default',
      tenantId: '11111111-1111-4111-8111-111111111111',
      environment: 'production',
    }
    const snapshot: EstateSnapshot = {
      tenantId: estate.tenantId,
      environment: estate.environment,
      generatedAt: '2026-09-09T00:00:00.000Z',
      nodes: [
        {
          id: 'agent365-package',
          kind: 'agent',
          name: 'Retained Agent 365 package',
          description: 'Retained authoritative package observation.',
          environment: estate.environment,
          evidenceIds: ['agent365-package-evidence'],
          metadata: {
            sourceConnector: 'agent365-package-catalog',
            sourceConnectorId: 'deployment',
            sourceTenantId: estate.tenantId,
            sourceEnvironment: estate.environment,
            sourceProviderObjectId: 'P_1',
          },
        },
      ],
      edges: [],
      evidence: [
        {
          id: 'agent365-package-evidence',
          source: 'Microsoft Graph v1.0 Agent 365 package catalog',
          sourceObjectId: 'deployment:P_1',
          observedAt: '2026-09-09T00:00:00.000Z',
          freshness: 'live',
          confidence: 1,
          evidenceTypes: ['declared_configuration'],
          summary: 'Retained authoritative Agent 365 package observation.',
          metadata: {
            sourceConnector: 'agent365-package-catalog',
            sourceConnectorId: 'deployment',
            sourceTenantId: estate.tenantId,
            sourceEnvironment: estate.environment,
            sourceProviderObjectId: 'P_1',
          },
        },
      ],
    }
    configureFoundryFor(snapshot)
    const source: ConnectorSourceDefinition = {
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      sourceId: 'agent365-deployment',
      connectorType: 'agent365',
      displayName: 'Deployment Agent 365',
      enabled: true,
      origin: 'deployment',
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
      runtimeBinding: { bindingSourceId: 'deployment' },
      testStatus: { status: 'not-tested' },
      version: 1,
      etag: 'deployment-etag',
      createdBy: { type: 'deployment', id: 'deployment-json' },
      updatedBy: { type: 'deployment', id: 'deployment-json' },
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z',
    }
    const sourceRepository: ConnectorSourceRepository = {
      create: () => Promise.reject(new Error('not used')),
      findById: () => Promise.resolve(source),
      list: () => Promise.resolve([source]),
      update: () => Promise.reject(new Error('not used')),
      delete: () => Promise.reject(new Error('not used')),
      listAudit: () => Promise.resolve([]),
    }
    const runtime = await resolveAgent365Runtime(sourceRepository, estate)
    const healthRepository = new InMemoryConnectorHealthRepository()
    await healthRepository.save(estate, {
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      connectorId: 'azure-ai-foundry-agent-service',
      sourceSetFingerprint: runtime.sourceSetFingerprint,
      measuredAt: '2026-09-09T00:05:00.000Z',
      health: {
        overall: 'degraded',
        partial: true,
        sourceSetFingerprint: runtime.sourceSetFingerprint,
        sources: [
          {
            id: 'agent365:deployment',
            name: 'Deployment Agent 365',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'authorization-required',
            dataState: 'failed',
            checkedAt: '2026-09-09T00:05:00.000Z',
            reason: 'authorization',
            provenance: {
              estateTenantId: estate.tenantId,
              estateEnvironment: estate.environment,
              sourceConnectorId: 'deployment',
              sourceTenantId: estate.tenantId,
              sourceEnvironment: estate.environment,
              provider: 'microsoft-graph-agent365-package-catalog',
              providerObjectId: '/v1.0/copilot/admin/catalog/packages',
            },
          },
        ],
      },
    })
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        estateRegistry: buildEstateRegistry({}, estate),
        snapshotRepository: snapshotRepository(snapshot).repository,
        connectorSourceRepository: sourceRepository,
        connectorHealthRepository: healthRepository,
        runtimeTelemetryConnector: null,
        connectorHealthClock: () => new Date('2026-09-09T00:05:01.000Z'),
      },
    )
    apps.push(app)

    const state = agentSentinelStateSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/demo/state' })).json(),
    )

    expect(state.snapshot.evidence[0]).toMatchObject({
      freshness: 'stale',
      evidenceTypes: ['declared_configuration', 'unknown'],
      sourceStatus: {
        status: 'stale',
        sourceId: 'deployment',
        readiness: 'authorization-required',
        dataState: 'failed',
        reason: 'authorization',
      },
    })
  })

  it('uses an independently resolved custom estate for live authority checks', async () => {
    const configuredEstate: EstateContext = {
      id: 'custom-estate',
      tenantId: '99999999-9999-4999-8999-999999999999',
      environment: 'portfolio',
    }
    const snapshot = liveRunsAsSnapshot({
      ...configuredEstate,
      id: 'default',
    })
    const connector: AgentConnector = {
      descriptor: {
        id: 'fixture',
        name: 'Fixture',
        apiVersion: 'v1',
        releaseStatus: 'mock',
        capabilities: ['discovery'],
        requiredPermissions: [],
        blindSpots: [],
      },
      testConnection: () =>
        Promise.resolve({
          ok: true,
          checkedAt: snapshot.generatedAt,
          message: 'ok',
        }),
      discover: () => Promise.resolve(snapshot),
      getEvidence: (evidenceId) =>
        Promise.resolve(
          snapshot.evidence.find((item) => item.id === evidenceId) ?? snapshot.evidence[0]!,
        ),
    }
    const service = new DemoService(configuredEstate, connector, 'foundry')

    await expect(service.getState()).resolves.toMatchObject({ findings: [] })
  })

  it('authorizes the selected fixture with exact live declared configuration evidence', async () => {
    const snapshot = await new MockAgentConnector().discover()
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')

    authorizeRuntimeAgent(snapshot, agent)

    const evidence = snapshot.evidence.find((item) => agent.evidenceIds.includes(item.id))
    expect(evidence?.evidenceTypes).toEqual(['declared_configuration'])
    expect(evidence?.evidenceTypes).not.toContain('synthetic_validation')
    expect(
      runtimeTelemetryRequestForAgent(snapshot, agent, {
        id: 'default',
        tenantId: snapshot.tenantId,
        environment: snapshot.environment,
      }),
    ).toMatchObject({
      sourceAgentId: 'provider-agent-id',
      sourceEnvironment: agent.environment,
    })
  })

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

  it('hydrates a jobs-persisted legacy OTel invocation before serving the live snapshot', async () => {
    const snapshot = legacyRuntimeSnapshot()
    configureFoundryFor(snapshot)
    const { repository } = snapshotRepository(snapshot)
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
    const state = agentSentinelStateSchema.parse(response.json())

    expect(response.statusCode).toBe(200)
    expect(state.snapshot.evidence[1]?.otel?.invocations[0]).toMatchObject({
      toolCallNames: [],
      provenance: {
        sourceProjectId: 'validation',
        snapshotGeneratedAt: snapshot.generatedAt,
      },
    })
  })

  it('uses the configured custom estate ID for persisted live reads', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const { repository, findLatest } = snapshotRepository(snapshot)
    const estateRegistry = buildEstateRegistry(
      {
        AGENT_SENTINEL_ESTATES_JSON: JSON.stringify([
          {
            id: 'custom-estate',
            name: 'Custom estate',
            tenantId: snapshot.tenantId,
            environment: snapshot.environment,
            isDefault: true,
            allowedAuthTenantIds: [],
          },
        ]),
      },
      {
        id: 'unused',
        tenantId: snapshot.tenantId,
        environment: snapshot.environment,
      },
    )
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        estateRegistry,
        snapshotRepository: repository,
        runtimeTelemetryConnector: null,
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })

    expect(response.statusCode).toBe(200)
    expect(findLatest).toHaveBeenCalledWith({
      id: 'custom-estate',
      tenantId: snapshot.tenantId,
      environment: snapshot.environment,
    })
  })

  it('rejects a persisted candidate outside the configured estate boundary', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const candidate = {
      ...snapshot,
      tenantId: 'other-tenant',
    }
    const { repository } = snapshotRepository(candidate)
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
    expect(response.statusCode).toBe(503)
    const body = response.json<{ error: string; message: string }>()
    expect(body.error).toBe('read_model_unavailable')
    expect(body.message).toMatch(/independently configured estate boundary/i)
  })

  function liveRunsAsSnapshot(authorityEstate: EstateContext): EstateSnapshot {
    const generatedAt = new Date().toISOString()
    const principalId = '11111111-1111-4111-8111-111111111111'
    const agentAuthority = {
      estateId: authorityEstate.id,
      sourceId: 'foundry:project-a',
      tenantId: authorityEstate.tenantId,
      environment: 'production',
      provider: 'azure-ai-foundry-agent-service' as const,
      sourceObjectId: 'project-a',
      providerObjectId: 'agent-a',
      snapshotGeneratedAt: generatedAt,
      sourceRelease: 'v1',
    }
    const identityAuthority = {
      estateId: authorityEstate.id,
      sourceId: 'entra:directory-a',
      tenantId: authorityEstate.tenantId,
      environment: 'directory',
      provider: 'microsoft-entra' as const,
      sourceObjectId: authorityEstate.tenantId,
      providerObjectId: principalId,
      snapshotGeneratedAt: generatedAt,
      sourceRelease: 'v1.0',
    }
    return {
      tenantId: authorityEstate.tenantId,
      environment: authorityEstate.environment,
      generatedAt,
      nodes: [
        {
          id: 'input',
          kind: 'input',
          name: 'Input',
          description: 'Untrusted input.',
          environment: authorityEstate.environment,
          trust: 'untrusted',
          evidenceIds: ['foundry-evidence'],
          metadata: {},
        },
        {
          id: 'agent',
          kind: 'agent',
          name: 'Agent',
          description: 'Foundry agent.',
          environment: 'production',
          evidenceIds: ['foundry-evidence'],
          metadata: {
            sourceOfTruth: 'true',
            estateId: authorityEstate.id,
            sourceId: agentAuthority.sourceId,
            sourceTenantId: agentAuthority.tenantId,
            sourceEnvironment: agentAuthority.environment,
            sourceProjectId: agentAuthority.sourceObjectId,
            provider: agentAuthority.provider,
            providerObjectId: agentAuthority.providerObjectId,
            snapshotGeneratedAt: generatedAt,
            sourceRelease: agentAuthority.sourceRelease,
            servicePrincipalId: principalId,
          },
        },
        {
          id: 'identity',
          kind: 'identity',
          name: 'Identity',
          description: 'Entra identity.',
          environment: 'directory',
          evidenceIds: ['entra-evidence'],
          metadata: {
            sourceOfTruth: 'true',
            estateId: authorityEstate.id,
            sourceId: identityAuthority.sourceId,
            sourceTenantId: identityAuthority.tenantId,
            sourceEnvironment: identityAuthority.environment,
            sourceInventoryObjectId: identityAuthority.sourceObjectId,
            provider: identityAuthority.provider,
            providerObjectId: principalId,
            snapshotGeneratedAt: generatedAt,
            sourceRelease: identityAuthority.sourceRelease,
            directoryObjectId: principalId,
          },
        },
        {
          id: 'mcp',
          kind: 'mcp',
          name: 'External MCP',
          description: 'Untrusted MCP.',
          environment: authorityEstate.environment,
          trust: 'untrusted',
          evidenceIds: ['entra-evidence'],
          metadata: {},
        },
      ],
      edges: [
        {
          id: 'input-agent',
          from: 'input',
          to: 'agent',
          relationship: 'TRIGGERS',
          evidenceIds: ['foundry-evidence'],
          active: true,
          removable: false,
        },
        {
          id: 'runs-as',
          from: 'agent',
          to: 'identity',
          relationship: 'RUNS_AS',
          evidenceIds: ['foundry-evidence', 'entra-evidence'],
          active: true,
          removable: false,
          runsAsBinding: {
            agent: agentAuthority,
            identity: identityAuthority,
            identifier: { kind: 'object-id', value: principalId },
          },
        },
        {
          id: 'identity-mcp',
          from: 'identity',
          to: 'mcp',
          relationship: 'CAN_EXFILTRATE_TO',
          evidenceIds: ['entra-evidence'],
          active: true,
          removable: true,
        },
      ],
      evidence: [
        {
          id: 'foundry-evidence',
          source: 'Foundry',
          sourceObjectId: 'project-a:agent-a',
          observedAt: generatedAt,
          freshness: 'live',
          confidence: 1,
          evidenceTypes: ['declared_configuration'],
          summary: 'Foundry evidence.',
          authority: agentAuthority,
        },
        {
          id: 'entra-evidence',
          source: 'Entra',
          sourceObjectId: `directory-a:${principalId}`,
          observedAt: generatedAt,
          freshness: 'live',
          confidence: 1,
          evidenceTypes: ['declared_configuration'],
          summary: 'Entra evidence.',
          authority: identityAuthority,
        },
      ],
    }
  }

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
    authorizeRuntimeAgent(snapshot, agent)
    const declaredEvidenceId = agent.evidenceIds[0]
    if (declaredEvidenceId === undefined) throw new Error('Expected declared agent evidence.')
    snapshot.nodes.push({
      id: 'runtime-knowledge-search',
      kind: 'tool',
      name: 'knowledge_search',
      description: 'Declared runtime search tool.',
      environment: agent.environment,
      evidenceIds: [declaredEvidenceId],
      metadata: {},
    })
    snapshot.edges.push({
      id: 'runtime-knowledge-search-edge',
      from: agent.id,
      to: 'runtime-knowledge-search',
      relationship: 'CAN_CALL',
      evidenceIds: [declaredEvidenceId],
      active: true,
      removable: false,
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
          sourceProjectId: 'test',
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
    expect(
      state.snapshot.evidence.find((evidence) => evidence.id === 'otel-observed-evidence')?.otel
        ?.invocations[0],
    ).toMatchObject({
      agentRunId: 'observed-0-run',
      correlationId: 'observed-0-correlation',
      agentVersion: '17',
      toolCallNames: ['knowledge_search'],
    })
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

  it('does not query a non-authoritative manifest-style agent with exact-looking identifiers', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    authorizeRuntimeAgent(snapshot, agent)
    agent.metadata['sourceOfTruth'] = 'false'
    const evidence = snapshot.evidence.find((item) => agent.evidenceIds.includes(item.id))
    if (evidence === undefined) throw new Error('Expected agent evidence.')
    evidence.metadata = { ...evidence.metadata, sourceOfTruth: 'false' }
    const readObservationWindows = vi.fn()
    const { repository } = snapshotRepository(snapshot)
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        snapshotRepository: repository,
        runtimeTelemetryConnector: {
          id: 'azure-monitor-otel',
          readObservationWindows,
        },
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    const state = agentSentinelStateSchema.parse(response.json())

    expect(response.statusCode).toBe(200)
    expect(state.runtimeEvidence).toMatchObject({
      status: 'unavailable',
      eligibleAgentCount: 0,
      queriedAgentCount: 0,
      enrichedAgentCount: 0,
      evidenceCount: 0,
      sources: [],
      failures: [],
    })
    expect(readObservationWindows).not.toHaveBeenCalled()
  })

  it('surfaces telemetry projection failures without hiding the persisted estate', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    authorizeRuntimeAgent(snapshot, agent)
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
          sourceProjectId: 'test',
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
    authorizeRuntimeAgent(snapshot, agent)
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
            const emptyQuality = {
              status: 'unknown' as const,
              classification: 'unknown' as const,
              caveats: ['empty'] as const,
              recordsReceived: 0,
              recordsAccepted: 0,
              duplicatesRemoved: 0,
              pagesProcessed: 1,
            }
            return runtimeObservationWindowsSchema.parse({
              ...windows,
              baseline: { ...windows.baseline, observations: [], otelQuality: emptyQuality },
              observed: { ...windows.observed, observations: [], otelQuality: emptyQuality },
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

  it('removes prior exact-source runtime evidence before manifest verification of an empty result', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    authorizeRuntimeAgent(snapshot, agent)
    const request = runtimeTelemetryRequestForAgent(snapshot, agent, {
      id: 'default',
      tenantId: snapshot.tenantId,
      environment: snapshot.environment,
    })
    if (request === undefined) throw new Error('Expected a runtime request.')
    const fixture = createRuntimeTelemetryFixture(snapshot.environment)
    const prior = projectRuntimeEvidence(
      snapshot,
      await fixture.readObservationWindows(request),
      request,
    ).snapshot
    const unrelated = structuredClone(
      prior.evidence.find((evidence) => evidence.id === 'otel-observed-evidence')!,
    )
    unrelated.id = 'unrelated-runtime-evidence'
    unrelated.metadata = {
      ...unrelated.metadata,
      sourceConnectorId: 'secondary',
      sourceProjectId: 'other-project',
      sourceAgentId: 'other-agent',
    }
    for (const invocation of unrelated.otel?.invocations ?? []) {
      invocation.provenance.sourceConnectorId = 'secondary'
      invocation.provenance.sourceProjectId = 'other-project'
      invocation.provenance.providerAgentId = 'other-agent'
    }
    prior.evidence.push(unrelated)
    const manifestIngestionRepository: ManifestIngestionRepository = {
      save: vi.fn(),
      listLatest: () => Promise.resolve([runtimeManifestRecord(prior, agent)]),
    }
    const { repository } = snapshotRepository(prior)
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        snapshotRepository: repository,
        manifestIngestionRepository,
        runtimeTelemetryConnector: {
          id: fixture.id,
          async readObservationWindows(currentRequest, options) {
            const windows = await fixture.readObservationWindows(currentRequest, options)
            const emptyQuality = {
              status: 'unknown' as const,
              classification: 'unknown' as const,
              caveats: ['empty'] as const,
              recordsReceived: 0,
              recordsAccepted: 0,
              duplicatesRemoved: 0,
              pagesProcessed: 1,
            }
            return runtimeObservationWindowsSchema.parse({
              ...windows,
              baseline: { ...windows.baseline, observations: [], otelQuality: emptyQuality },
              observed: { ...windows.observed, observations: [], otelQuality: emptyQuality },
            })
          },
        },
      },
    )
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    const state = agentSentinelStateSchema.parse(response.json())

    expect(response.statusCode).toBe(200)
    expect(
      state.snapshot.evidence.filter((evidence) =>
        ['otel-baseline-evidence', 'otel-observed-evidence'].includes(evidence.id),
      ),
    ).toEqual([])
    expect(state.snapshot.evidence).toContainEqual(
      expect.objectContaining({ id: 'unrelated-runtime-evidence' }),
    )
    expect(state.manifestRuntimeVerification?.claims).toEqual([
      expect.objectContaining({
        status: 'no-observation',
        reason: 'no-non-synthetic-runtime-observation',
      }),
    ])
  })

  it('rejects wrong-estate runtime telemetry before projecting evidence', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    authorizeRuntimeAgent(snapshot, agent)
    const persistedEvidence = structuredClone(snapshot.evidence)
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
            windows.provenance!.estateId = 'wrong-estate'
            for (const window of [windows.baseline, windows.observed]) {
              for (const observation of window.observations) {
                observation.otelProvenance!.estateId = 'wrong-estate'
              }
            }
            return windows
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
      queriedAgentCount: 0,
      enrichedAgentCount: 0,
      evidenceCount: 0,
      failures: [{ agentId: agent.id, reason: 'query-failed' }],
      sources: [
        {
          agentId: agent.id,
          state: 'failed',
          evidenceIds: [],
          observationIds: [],
          reason: 'query-failed',
        },
      ],
    })
    expect(state.snapshot.evidence).toEqual(persistedEvidence)
  })

  it.each([
    ['sampled', ['sampled'] as const],
    ['conflicting', ['conflicting-duplicate'] as const],
    ['incomplete', ['incomplete-pagination'] as const],
    ['mismatched', ['invalid-record'] as const],
  ])('preserves %s all-rejected telemetry as degraded', async (_label, caveats) => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    authorizeRuntimeAgent(snapshot, agent)
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
            const rejectedQuality = {
              status: 'degraded' as const,
              classification: 'unknown' as const,
              caveats: [...caveats],
              recordsReceived: 60,
              recordsAccepted: 0,
              duplicatesRemoved: caveats.some((caveat) => caveat === 'conflicting-duplicate')
                ? 10
                : 0,
              pagesProcessed: 1,
            }
            return runtimeObservationWindowsSchema.parse({
              ...windows,
              baseline: {
                ...windows.baseline,
                observations: [],
                otelQuality: rejectedQuality,
              },
              observed: {
                ...windows.observed,
                observations: [],
                otelQuality: rejectedQuality,
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
      evidenceCount: 2,
      failures: [],
      sources: [
        {
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

  it('retains stale telemetry as stale without reporting complete live coverage', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    authorizeRuntimeAgent(snapshot, agent)
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
              status: 'available' as const,
              classification: 'live' as const,
              caveats: [],
              recordsReceived: 60,
              recordsAccepted: 60,
              duplicatesRemoved: 0,
              pagesProcessed: 1,
            }
            return runtimeObservationWindowsSchema.parse({
              ...windows,
              maximumFreshnessHours: 1,
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

  it('rejects runtime evidence with mismatched nested provenance', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    authorizeRuntimeAgent(snapshot, agent)
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
      status: 'unavailable',
      queriedAgentCount: 0,
      enrichedAgentCount: 0,
      sources: [
        {
          sourceConnectorId: 'primary',
          agentId: agent.id,
          state: 'failed',
          observationIds: [],
          evidenceIds: [],
          reason: 'query-failed',
        },
      ],
    })
    expect(state.snapshot.evidence.filter((evidence) => evidence.id.startsWith('otel-'))).toEqual(
      [],
    )
  })

  it('keeps synthetic telemetry explicit and never counts it as live-ready', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    authorizeRuntimeAgent(snapshot, agent)
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
    authorizeRuntimeAgent(snapshot, agent)
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

  it('does not promote persisted synthetic RUNS_AS evidence to a live finding', async () => {
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
    expect(first.findings).toHaveLength(0)
    expect(second.findings).toHaveLength(0)
    expect(second.snapshot.generatedAt).toBe(nextSnapshot.generatedAt)
  })

  it('does not let an injected live service bypass the persisted read model', async () => {
    const snapshot = await new MockAgentConnector().discover()
    configureFoundryFor(snapshot)
    const { repository } = snapshotRepository(null)
    const injected = new DemoService(
      {
        id: 'default',
        tenantId: snapshot.tenantId,
        environment: snapshot.environment,
      },
      new MockAgentConnector(),
      'mock',
    )
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
