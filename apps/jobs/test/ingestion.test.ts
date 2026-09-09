import { describe, expect, it, vi } from 'vitest'

import type {
  AgentConnector,
  ConnectorHealthReport,
  ManifestIngestionRecord,
  ManifestIngestionRepository,
  RuntimeTelemetryConnector,
  RuntimeTelemetryRequest,
} from '@agent-sentinel/connector-sdk'
import {
  projectRuntimeEvidence,
  runtimeObservationWindowsSchema,
  runtimeTelemetryRequestForAgent,
} from '@agent-sentinel/connector-sdk'
import {
  agentSentinelStateSchema,
  type EstateSnapshot,
  type OtelWindowQuality,
} from '@agent-sentinel/domain'
import {
  FOUNDRY_API_VERSION,
  FoundryPortfolioIncompleteError,
  MultiFoundryConnector,
  mapAgentToSnapshot,
  type FoundryConnectorOptions,
  type FoundryDiscoveryFailureReason,
} from '@agent-sentinel/foundry-connector'
import { ManifestConnector } from '@agent-sentinel/manifest-connector'
import { createLiveGraphTraversalContextForSnapshot } from '@agent-sentinel/graph-engine'
import {
  InMemoryConnectorHealthRepository,
  InMemoryExposureFindingRepository,
  InMemoryManifestIngestionRepository,
  InMemorySnapshotRepository,
} from '@agent-sentinel/persistence'
import { foundryManifest } from '@agent-sentinel/scenarios'
import { DefenderCloudAppsCompositionConnector } from '@agent-sentinel/defender-cloud-apps-connector'
import { PurviewCompositionConnector } from '@agent-sentinel/purview-connector'
import { AzureResourceGraphCompositionConnector } from '@agent-sentinel/azure-resource-graph-connector'
import { TeamsDistributionCompositionConnector } from '@agent-sentinel/teams-distribution-connector'

import { createApp } from '../../api/src/app.js'
import { createRuntimeTelemetryFixture } from '../../api/test/runtime-telemetry-fixture.js'
import { IngestionService } from '../src/ingestion-service.js'

function makeConnector(snapshot: EstateSnapshot, health?: ConnectorHealthReport): AgentConnector {
  return {
    descriptor: {
      id: 'fake',
      name: 'fake',
      apiVersion: 'v1',
      releaseStatus: 'mock',
      capabilities: ['discovery'],
      requiredPermissions: [],
      blindSpots: [],
    },
    testConnection: () =>
      Promise.resolve({ ok: true, checkedAt: new Date().toISOString(), message: 'ok' }),
    discover: () => Promise.resolve(structuredClone(snapshot)),
    getEvidence: () => Promise.reject(new Error('nope')),
    ...(health !== undefined ? { getConnectorHealth: () => structuredClone(health) } : {}),
  }
}

function fullSnapshot(): EstateSnapshot {
  return mapAgentToSnapshot(
    foundryManifest.agents.map((agent) => ({
      id: agent.name,
      name: agent.displayName,
      version: agent.version,
      description: agent.description,
      model: agent.modelDeployment,
      instructions: agent.instructions,
      tools: agent.functions.map((fn) => ({
        type: 'function',
        function: { name: fn.name, description: fn.description, parameters: fn.parameters },
      })),
      metadata: {
        owner: agent.owner,
        environment: agent.environment,
        approvalRequired: agent.approvalRequired ? 'true' : 'false',
        lifecycle: agent.lifecycle,
        version: agent.version,
      },
    })),
    FOUNDRY_API_VERSION,
    { tenantId: 'tenant-demo', environment: 'validation' },
  )
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

const testEstate = {
  id: 'default',
  tenantId: 'tenant-demo',
  environment: 'validation',
}

function authorizeRuntimeAgent(
  snapshot: EstateSnapshot,
  agent: EstateSnapshot['nodes'][number],
  sourceObjectId = 'provider-agent-id',
): void {
  Object.assign(agent.metadata, {
    sourceOfTruth: 'true',
    sourceConnectorId: 'primary',
    sourceTenantId: testEstate.tenantId,
    sourceProjectId: 'validation',
    sourceObjectId,
    sourceEnvironment: testEstate.environment,
  })
  const evidence = snapshot.evidence.find((item) => agent.evidenceIds.includes(item.id))
  if (evidence === undefined) throw new Error('Expected authoritative agent evidence.')
  evidence.sourceObjectId = sourceObjectId
  evidence.metadata = {
    ...evidence.metadata,
    sourceOfTruth: 'true',
    estateTenantId: testEstate.tenantId,
    estateEnvironment: testEstate.environment,
    sourceConnectorId: 'primary',
    sourceTenantId: testEstate.tenantId,
    sourceProjectId: 'validation',
    sourceEnvironment: testEstate.environment,
    sourceObjectId,
  }
}

function emptyRuntimeWindows(
  request: RuntimeTelemetryRequest,
  quality: OtelWindowQuality,
  estateId = request.estateId!,
) {
  return runtimeObservationWindowsSchema.parse({
    baseline: {
      windowId: 'baseline-window',
      tenantId: request.tenantId,
      agentId: request.agentId,
      environment: request.sourceEnvironment!,
      source: 'azure-monitor-otel',
      windowStart: '2026-09-04T00:00:00.000Z',
      windowEnd: '2026-09-05T00:00:00.000Z',
      observations: [],
      otelQuality: quality,
    },
    observed: {
      windowId: 'observed-window',
      tenantId: request.tenantId,
      agentId: request.agentId,
      environment: request.sourceEnvironment!,
      source: 'azure-monitor-otel',
      windowStart: '2026-09-05T00:00:00.000Z',
      windowEnd: '2026-09-06T00:00:00.000Z',
      observations: [],
      otelQuality: quality,
    },
    baselineEvidenceId: 'baseline-evidence',
    observedEvidenceId: 'observed-evidence',
    queriedAt: '2026-09-06T00:00:00.000Z',
    provenance: {
      snapshotGeneratedAt: request.snapshotGeneratedAt!,
      estateId,
      estateTenantId: request.tenantId,
      estateEnvironment: request.estateEnvironment!,
      sourceConnectorId: request.sourceConnectorId!,
      sourceTenantId: request.sourceTenantId!,
      sourceProjectId: request.sourceProjectId!,
      sourceEnvironment: request.sourceEnvironment!,
      provider: 'azure-monitor-otel',
      providerResourceId: '/subscriptions/example/resource',
      providerAgentId: request.sourceAgentId!,
    },
  })
}

const liveFoundryPortfolio = {
  estateTenantId: testEstate.tenantId,
  estateEnvironment: testEstate.environment,
  sources: [
    {
      id: 'primary',
      name: 'Validation project',
      projectEndpoint: 'https://example.services.ai.azure.com/api/projects/validation',
      tenantId: testEstate.tenantId,
      environment: testEstate.environment,
    },
  ],
}

function liveFoundryConnector(fetcher: typeof fetch, options: FoundryConnectorOptions = {}) {
  return new MultiFoundryConnector(
    liveFoundryPortfolio,
    () => ({
      getToken: () =>
        Promise.resolve({ token: 'test-token', expiresOnTimestamp: Date.now() + 60_000 }),
    }),
    [],
    { ...options, fetch: fetcher },
  )
}

async function expectFailedDiscoveryNotPromoted(
  connector: MultiFoundryConnector,
  reason: FoundryDiscoveryFailureReason,
): Promise<void> {
  const snapshots = new InMemorySnapshotRepository()
  const exposures = new InMemoryExposureFindingRepository()
  const baseline = fullSnapshot()
  baseline.generatedAt = '2026-09-05T08:00:00.000Z'
  await snapshots.save(testEstate, baseline)
  const service = new IngestionService(connector, snapshots, exposures, {
    estate: testEstate,
    sourceMode: 'foundry',
  })

  await expect(service.run()).rejects.toBeInstanceOf(FoundryPortfolioIncompleteError)
  expect(await snapshots.list(testEstate)).toEqual([baseline])
  expect(connector.getConnectorHealth()).toMatchObject({
    overall: reason === 'authentication-or-access' ? 'unavailable' : 'degraded',
    partial: false,
    sources: [
      {
        id: 'foundry:primary',
        readiness: reason === 'authentication-or-access' ? 'unavailable' : 'degraded',
        reason,
        provenance: {
          estateTenantId: testEstate.tenantId,
          estateEnvironment: testEstate.environment,
          sourceConnectorId: 'primary',
          sourceTenantId: testEstate.tenantId,
          sourceEnvironment: testEstate.environment,
          provider: 'azure-ai-foundry-agent-service',
          providerObjectId: 'validation',
        },
      },
    ],
  })
}

async function manifestRecord(): Promise<ManifestIngestionRecord> {
  const connector = new ManifestConnector({
    tenantId: 'tenant-demo',
    environmentId: 'validation',
    manifestContent: {
      schemaVersion: '1.0',
      manifestId: 'partner-agents',
      tenantId: 'tenant-demo',
      environmentId: 'validation',
      producedAt: '2026-08-28T00:00:00.000Z',
      producer: { name: 'Partner Registry' },
      capabilities: {
        supportsDiscovery: true,
        evidenceDepth: 'shallow',
        supportsRuntimeTelemetry: false,
        supportsActions: 'none',
      },
      agents: [
        {
          id: 'partner-agent',
          displayName: 'Partner Mutation Agent',
          approvalRequired: false,
        },
      ],
      tools: [{ id: 'send', displayName: 'send_message', toolType: 'action' }],
      identities: [],
      dataSources: [],
      mcpDependencies: [],
      edges: [
        {
          from: { kind: 'agent', id: 'partner-agent' },
          to: { kind: 'tool', id: 'send' },
          relationship: 'CAN_CALL',
        },
      ],
      evidence: [],
      metadata: {},
    },
  })
  const [envelope, manifestHash, snapshot] = await Promise.all([
    connector.getEnvelope(),
    connector.getManifestHash(),
    connector.discover(),
  ])
  return {
    tenantId: 'tenant-demo',
    environmentId: 'validation',
    manifestId: envelope.manifestId,
    manifestHash,
    ingestedAt: '2026-08-28T00:05:00.000Z',
    ingestedBySubject: 'administrator-subject',
    envelope,
    snapshot,
  }
}

function countAuthorityReads(snapshot: EstateSnapshot): () => number {
  let reads = 0
  for (const item of snapshot.evidence) {
    const authority = item.authority
    Object.defineProperty(item, 'authority', {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1
        return authority
      },
    })
  }
  return () => reads
}

describe('IngestionService', () => {
  it('rejects duplicate live graph IDs before persistence', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const candidate = fullSnapshot()
    candidate.nodes.push({ ...candidate.nodes[0]! })
    const service = new IngestionService(makeConnector(candidate), snapshots, exposures, {
      estate: testEstate,
      sourceMode: 'foundry',
    })

    await expect(service.run()).rejects.toThrow(/duplicate graph node id/i)
    await expect(snapshots.list(testEstate)).resolves.toEqual([])
  })

  it('validates live snapshot authority once before policy evaluation and persistence', async () => {
    const control = fullSnapshot()
    const controlReads = countAuthorityReads(control)
    createLiveGraphTraversalContextForSnapshot(control, {
      estate: testEstate,
      clock: () => new Date(Date.parse(control.generatedAt) + 60_000),
    })
    const expectedBoundaryReads = controlReads()

    const candidate = fullSnapshot()
    const candidateReads = countAuthorityReads(candidate)
    const connector = {
      ...makeConnector(candidate),
      discover: () => Promise.resolve(candidate),
    }
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const save = snapshots.save.bind(snapshots)
    let authorityReadsAtSave = -1
    vi.spyOn(snapshots, 'save').mockImplementation(async (estate, snapshot) => {
      authorityReadsAtSave = candidateReads()
      await save(estate, snapshot)
    })
    const service = new IngestionService(connector, snapshots, exposures, {
      estate: testEstate,
      sourceMode: 'foundry',
      clock: () => new Date(Date.parse(candidate.generatedAt) + 60_000),
    })

    await service.run()

    expect(authorityReadsAtSave).toBe(expectedBoundaryReads)
  })

  it('persists snapshots, preserves firstSeen on second run, and resolves absent findings', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const connector = makeConnector(fullSnapshot())
    const service = new IngestionService(connector, snapshots, exposures, {
      estate: testEstate,
      sourceMode: 'foundry',
      correlationIdFactory: () => '11111111-1111-4111-8111-111111111111',
    })

    const first = await service.run()
    expect(first.correlationId).toBe('11111111-1111-4111-8111-111111111111')
    expect(first.persisted).toBe(true)
    expect(first.findings.length).toBeGreaterThan(0)
    expect(first.newFindings.length).toBe(first.findings.length)
    const firstSeenA = first.findings[0]?.firstSeen
    const stored = await snapshots.findLatest(testEstate)
    expect(stored).not.toBeNull()

    const second = await service.run()
    expect(second.newFindings.length).toBe(0)
    const persisted = await exposures.findById(first.findings[0]!.id, testEstate)
    expect(persisted?.firstSeen).toBe(firstSeenA)

    // Now simulate a snapshot with no findings (only safe agents).
    const safeSnapshot = fullSnapshot()
    safeSnapshot.nodes = safeSnapshot.nodes.filter(
      (node) =>
        node.kind !== 'agent' ||
        node.id === 'foundry-agent-customer-support-safe' ||
        node.id === 'foundry-agent-incident-triage-readonly',
    )
    safeSnapshot.edges = safeSnapshot.edges.filter((edge) =>
      safeSnapshot.nodes.some((node) => node.id === edge.from),
    )
    const safeConnector = makeConnector(safeSnapshot)
    const safeService = new IngestionService(safeConnector, snapshots, exposures, {
      estate: testEstate,
      sourceMode: 'foundry',
    })
    const third = await safeService.run()
    expect(third.findings.length).toBe(0)
    expect(third.resolvedFindings.length).toBeGreaterThan(0)
  })

  it('does not persist or reconcile a partial enrichment snapshot', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const completeSnapshot = fullSnapshot()
    completeSnapshot.generatedAt = '2026-08-27T08:00:00.000Z'
    const completeService = new IngestionService(
      makeConnector(completeSnapshot),
      snapshots,
      exposures,
      { estate: testEstate, sourceMode: 'foundry' },
    )
    const complete = await completeService.run()
    const persistedFinding = await exposures.findById(complete.findings[0]!.id, testEstate)

    const partialSnapshot = fullSnapshot()
    partialSnapshot.generatedAt = '2026-08-27T08:05:00.000Z'
    partialSnapshot.nodes = partialSnapshot.nodes.filter(
      (node) =>
        node.kind !== 'agent' ||
        node.id === 'foundry-agent-customer-support-safe' ||
        node.id === 'foundry-agent-incident-triage-readonly',
    )
    partialSnapshot.edges = partialSnapshot.edges.filter((edge) =>
      partialSnapshot.nodes.some((node) => node.id === edge.from),
    )
    const health: ConnectorHealthReport = {
      overall: 'degraded',
      partial: true,
      sources: [
        {
          id: 'fake',
          name: 'fake',
          role: 'discovery',
          enabled: true,
          configured: true,
          readiness: 'ready',
        },
        {
          id: 'microsoft-entra-service-principals',
          name: 'Microsoft Entra service principals',
          role: 'enrichment',
          enabled: true,
          configured: true,
          readiness: 'degraded',
          reason: 'unavailable',
        },
      ],
    }
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const connectorHealth = new InMemoryConnectorHealthRepository()
    const partialService = new IngestionService(
      makeConnector(partialSnapshot, health),
      snapshots,
      exposures,
      {
        estate: testEstate,
        sourceMode: 'foundry',
        logger,
        clock: () => new Date('2026-09-04T13:00:00.000Z'),
        connectorHealthRepository: connectorHealth,
      },
    )

    const partial = await partialService.run()
    expect(partial).toMatchObject({
      outcome: 'partially-succeeded',
      persisted: false,
      newFindings: [],
      resolvedFindings: [],
    })

    expect(await snapshots.list(testEstate)).toHaveLength(1)
    expect(await snapshots.findLatest(testEstate)).toMatchObject({
      generatedAt: completeSnapshot.generatedAt,
    })
    expect(await exposures.findById(complete.findings[0]!.id, testEstate)).toEqual(persistedFinding)
    await expect(connectorHealth.findLatest(testEstate, 'fake')).resolves.toEqual({
      estateId: testEstate.id,
      tenantId: testEstate.tenantId,
      environment: testEstate.environment,
      connectorId: 'fake',
      measuredAt: '2026-09-04T13:00:00.000Z',
      health,
    })
    expect(logger.warn).toHaveBeenCalledWith('ingestion.enrichment.degraded', {
      correlationId: expect.any(String),
      sources: [
        {
          id: 'microsoft-entra-service-principals',
          readiness: 'degraded',
          reason: 'unavailable',
        },
      ],
    })
  })

  it('persists stable inventory while reporting optional-only degradation', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const connectorHealth = new InMemoryConnectorHealthRepository()
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const health: ConnectorHealthReport = {
      overall: 'degraded',
      partial: false,
      sources: [
        {
          id: 'fake',
          name: 'fake',
          role: 'discovery',
          enabled: true,
          configured: true,
          readiness: 'ready',
        },
        {
          id: 'entra:primary',
          name: 'Primary Microsoft Entra',
          role: 'enrichment',
          enabled: true,
          configured: true,
          readiness: 'degraded',
          reason: 'authorization (403)',
          diagnostics: {
            kind: 'exact-identity-correlation',
            provider: 'microsoft-entra',
            sourceId: 'primary',
            sourceTenantId: 'tenant-demo',
            sourceEnvironment: 'validation',
            authoritativeAgentsConsidered: 6,
            exactObjectIdMatches: 0,
            exactApplicationIdMatches: 0,
            exactAgentIdentityMatches: 0,
            unmatched: 6,
            ambiguous: 0,
            runsAsEdgesEmitted: 0,
            ownerCoverage: { status: 'disabled', evidenceReferences: [] },
            appRoleCoverage: { status: 'disabled', evidenceReferences: [] },
            previewCoverage: {
              status: 'authorization-required',
              reason: 'authorization (403)',
              evidenceReferences: [],
            },
            evidenceReferences: ['foundry-evidence-agent-1'],
          },
        },
      ],
    }
    const service = new IngestionService(
      makeConnector(fullSnapshot(), health),
      snapshots,
      exposures,
      {
        estate: testEstate,
        sourceMode: 'foundry',
        logger,
        clock: () => new Date('2026-09-04T13:05:00.000Z'),
        connectorHealthRepository: connectorHealth,
      },
    )

    const result = await service.run()

    expect(result).toMatchObject({
      outcome: 'partially-succeeded',
      persisted: true,
      connectorHealth: health,
    })
    expect(await snapshots.list(testEstate)).toHaveLength(1)
    await expect(connectorHealth.findLatest(testEstate, 'fake')).resolves.toEqual({
      estateId: testEstate.id,
      tenantId: testEstate.tenantId,
      environment: testEstate.environment,
      connectorId: 'fake',
      measuredAt: '2026-09-04T13:05:00.000Z',
      health,
    })
    expect(logger.warn).toHaveBeenCalledWith('ingestion.enrichment.degraded', {
      correlationId: expect.any(String),
      persisted: true,
      sources: [
        {
          id: 'entra:primary',
          readiness: 'degraded',
          reason: 'authorization (403)',
        },
      ],
    })
  })

  it.each([
    {
      name: 'repeated continuation',
      reason: 'repeated-continuation' as const,
      create: () =>
        liveFoundryConnector(
          vi.fn<typeof fetch>(() =>
            Promise.resolve(Response.json({ data: [], continuationToken: 'same-token' })),
          ),
        ),
    },
    {
      name: 'oversized page',
      reason: 'item-limit-exceeded' as const,
      create: () =>
        liveFoundryConnector(
          vi.fn<typeof fetch>().mockResolvedValue(
            Response.json({
              data: [
                { id: 'agent-a', name: 'Agent A' },
                { id: 'agent-b', name: 'Agent B' },
              ],
            }),
          ),
          { limits: { maxItems: 1 } },
        ),
    },
    {
      name: 'oversized body',
      reason: 'response-too-large' as const,
      create: () =>
        liveFoundryConnector(
          vi.fn<typeof fetch>().mockResolvedValue(
            Response.json({
              data: [{ id: 'agent-a', name: 'Agent A', description: 'x'.repeat(200) }],
            }),
          ),
          { limits: { maxResponseBytes: 100, maxTotalResponseBytes: 200 } },
        ),
    },
    {
      name: 'request timeout',
      reason: 'request-timeout' as const,
      create: () =>
        liveFoundryConnector(
          vi.fn<typeof fetch>(
            (_input, init) =>
              new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal
                if (signal === undefined || signal === null) {
                  reject(new Error('Missing request abort signal.'))
                  return
                }
                signal.addEventListener('abort', () => reject(new Error('Request aborted.')), {
                  once: true,
                })
              }),
          ),
          { limits: { requestTimeoutMs: 10 } },
        ),
    },
    {
      name: 'explicit abort',
      reason: 'request-aborted' as const,
      create: () => {
        const abortController = new AbortController()
        abortController.abort()
        return liveFoundryConnector(vi.fn<typeof fetch>(), {
          signal: abortController.signal,
        })
      },
    },
    {
      name: 'partial second-page failure',
      reason: 'provider-request-failed' as const,
      create: () =>
        liveFoundryConnector(
          vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
              Response.json({
                data: [{ id: 'agent-a', name: 'Agent A' }],
                continuationToken: 'second-page',
              }),
            )
            .mockResolvedValueOnce(
              Response.json({ error: { message: 'Service unavailable' } }, { status: 503 }),
            ),
        ),
    },
  ])('does not promote prior-page inventory after $name', async ({ create, reason }) => {
    await expectFailedDiscoveryNotPromoted(create(), reason)
  })

  it('preserves the durable snapshot when one configured Foundry source fails', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const connectorHealth = new InMemoryConnectorHealthRepository()
    const baseline = fullSnapshot()
    baseline.generatedAt = '2026-09-05T08:00:00.000Z'
    await snapshots.save(testEstate, baseline)
    const connector = new MultiFoundryConnector(
      {
        ...liveFoundryPortfolio,
        sources: [
          liveFoundryPortfolio.sources[0]!,
          {
            id: 'secondary',
            name: 'Secondary validation project',
            projectEndpoint: 'https://secondary.services.ai.azure.com/api/projects/validation-b',
            tenantId: testEstate.tenantId,
            environment: testEstate.environment,
          },
        ],
      },
      () => ({
        getToken: () =>
          Promise.resolve({ token: 'test-token', expiresOnTimestamp: Date.now() + 60_000 }),
      }),
      [],
      {
        fetch: vi.fn<typeof fetch>((input) => {
          const url = new URL(input instanceof Request ? input.url : input.toString())
          return Promise.resolve(
            url.hostname.startsWith('secondary.')
              ? Response.json({ error: { message: 'Forbidden' } }, { status: 403 })
              : Response.json({ data: [{ id: 'new-agent', name: 'New agent' }], has_more: false }),
          )
        }),
      },
    )
    await connectorHealth.save(testEstate, {
      estateId: testEstate.id,
      tenantId: testEstate.tenantId,
      environment: testEstate.environment,
      connectorId: connector.descriptor.id,
      measuredAt: '2026-09-05T08:00:00.000Z',
      health: {
        overall: 'ready',
        partial: false,
        sources: [
          {
            id: 'foundry:primary',
            name: 'Validation project',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
            dataState: 'complete',
          },
          {
            id: 'foundry:secondary',
            name: 'Secondary validation project',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
            dataState: 'complete',
          },
        ],
      },
    })
    const service = new IngestionService(connector, snapshots, exposures, {
      estate: testEstate,
      sourceMode: 'foundry',
      clock: () => new Date('2026-09-05T08:05:00.000Z'),
      connectorHealthRepository: connectorHealth,
    })

    await expect(service.run()).rejects.toBeInstanceOf(FoundryPortfolioIncompleteError)
    expect(await snapshots.list(testEstate)).toEqual([baseline])
    const currentHealth = connector.getConnectorHealth()
    expect(currentHealth).toMatchObject({
      overall: 'degraded',
      partial: true,
      sources: [
        {
          id: 'foundry:primary',
          readiness: 'ready',
          provenance: { sourceConnectorId: 'primary', providerObjectId: 'validation' },
        },
        {
          id: 'foundry:secondary',
          readiness: 'unavailable',
          reason: 'authentication-or-access',
          provenance: { sourceConnectorId: 'secondary', providerObjectId: 'validation-b' },
        },
      ],
    })
    await expect(connectorHealth.findLatest(testEstate, connector.descriptor.id)).resolves.toEqual({
      estateId: testEstate.id,
      tenantId: testEstate.tenantId,
      environment: testEstate.environment,
      connectorId: connector.descriptor.id,
      measuredAt: '2026-09-05T08:05:00.000Z',
      health: currentHealth,
    })
  })

  it('promotes only a successful discovery completed within every bound', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: 'agent-a', name: 'Agent A' }],
          continuationToken: 'second-page',
        }),
      )
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'agent-b', name: 'Agent B' }] }))
    const connector = liveFoundryConnector(fetcher, {
      limits: {
        maxPages: 2,
        maxItems: 2,
        maxResponseBytes: 1_024,
        maxTotalResponseBytes: 2_048,
      },
    })
    const service = new IngestionService(connector, snapshots, exposures, {
      estate: testEstate,
      sourceMode: 'foundry',
    })

    const result = await service.run()
    expect(result).toMatchObject({ outcome: 'succeeded', persisted: true })
    expect(result.snapshot.nodes.filter((node) => node.kind === 'agent')).toHaveLength(2)
    expect(result.snapshot.nodes[0]?.metadata).toMatchObject({
      sourceConnectorId: 'primary',
      sourceTenantId: testEstate.tenantId,
      sourceEnvironment: testEstate.environment,
      sourceProjectId: 'validation',
      sourceObjectId: 'agent-a',
    })
    expect(await snapshots.list(testEstate)).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(connector.getConnectorHealth()).toMatchObject({
      overall: 'ready',
      partial: false,
      sources: [{ readiness: 'ready' }],
    })
  })

  it('persists aggregate Agent 365 health metadata through every outer composition wrapper', async () => {
    const sourceSetFingerprint = 'a'.repeat(64)
    const measuredAt = '2026-09-09T00:05:00.000Z'
    const connector = postAgent365Composition(
      makeConnector(fullSnapshot(), {
        overall: 'ready',
        partial: false,
        sourceSetFingerprint,
        sources: [
          {
            id: 'agent365:primary',
            name: 'Primary Agent 365',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
            dataState: 'complete',
            pages: 2,
            records: 25,
            checkedAt: measuredAt,
          },
        ],
      }),
    )
    const connectorHealth = new InMemoryConnectorHealthRepository()
    const service = new IngestionService(
      connector,
      new InMemorySnapshotRepository(),
      new InMemoryExposureFindingRepository(),
      {
        estate: testEstate,
        sourceMode: 'foundry',
        clock: () => new Date(measuredAt),
        connectorHealthRepository: connectorHealth,
      },
    )

    await service.run()

    await expect(
      connectorHealth.findLatest(testEstate, connector.descriptor.id),
    ).resolves.toMatchObject({
      sourceSetFingerprint,
      health: {
        sourceSetFingerprint,
        overall: 'degraded',
        partial: true,
      },
    })
  })

  it('rejects a discovered snapshot from another tenant', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const snapshot = { ...fullSnapshot(), tenantId: 'other-tenant' }
    const service = new IngestionService(makeConnector(snapshot), snapshots, exposures, {
      estate: testEstate,
      sourceMode: 'foundry',
    })

    await expect(service.run()).rejects.toThrow('does not match the configured ingestion tenant')
    expect(await snapshots.list(testEstate)).toHaveLength(0)
  })

  it('rejects a discovered snapshot from another environment', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const snapshot = { ...fullSnapshot(), environment: 'production' }
    const service = new IngestionService(makeConnector(snapshot), snapshots, exposures, {
      estate: testEstate,
      sourceMode: 'foundry',
    })

    await expect(service.run()).rejects.toThrow('does not match the configured ingestion estate')
    expect(await snapshots.list(testEstate)).toHaveLength(0)
  })

  it('rejects wrong-estate runtime telemetry before persisting the projected snapshot', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const discovered = fullSnapshot()
    const agent = discovered.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    authorizeRuntimeAgent(discovered, agent)
    const runtimeTelemetryConnector: RuntimeTelemetryConnector = {
      id: 'azure-monitor-otel',
      readObservationWindows(request) {
        return Promise.resolve(
          emptyRuntimeWindows(
            request,
            {
              status: 'unknown',
              classification: 'unknown',
              caveats: ['empty'],
              recordsReceived: 0,
              recordsAccepted: 0,
              duplicatesRemoved: 0,
              pagesProcessed: 1,
            },
            'wrong-estate',
          ),
        )
      },
    }
    const service = new IngestionService(makeConnector(discovered), snapshots, exposures, {
      estate: testEstate,
      sourceMode: 'foundry',
      runtimeTelemetryConnector,
    })

    const result = await service.run()

    expect(result).toMatchObject({ outcome: 'partially-succeeded', persisted: true })
    const persisted = await snapshots.findLatest(testEstate)
    expect(persisted?.evidence.some((evidence) => evidence.id === 'observed-evidence')).toBe(false)
  })

  it('persists all-rejected runtime telemetry only as degraded unknown evidence', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const discovered = fullSnapshot()
    const agent = discovered.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    authorizeRuntimeAgent(discovered, agent)
    const runtimeTelemetryConnector: RuntimeTelemetryConnector = {
      id: 'azure-monitor-otel',
      readObservationWindows(request) {
        return Promise.resolve(
          emptyRuntimeWindows(request, {
            status: 'degraded',
            classification: 'unknown',
            caveats: ['sampled'],
            recordsReceived: 60,
            recordsAccepted: 0,
            duplicatesRemoved: 0,
            pagesProcessed: 1,
          }),
        )
      },
    }
    const service = new IngestionService(makeConnector(discovered), snapshots, exposures, {
      estate: testEstate,
      sourceMode: 'foundry',
      runtimeTelemetryConnector,
    })

    const result = await service.run()

    expect(result).toMatchObject({ outcome: 'partially-succeeded', persisted: true })
    const persisted = await snapshots.findLatest(testEstate)
    const runtimeEvidence = persisted?.evidence.filter((evidence) =>
      ['baseline-evidence', 'observed-evidence'].includes(evidence.id),
    )
    expect(runtimeEvidence).toHaveLength(2)
    expect(
      runtimeEvidence?.every(
        (evidence) =>
          evidence.confidence === 0 &&
          evidence.evidenceTypes.length === 1 &&
          evidence.evidenceTypes[0] === 'unknown' &&
          evidence.otel?.quality.status === 'degraded',
      ),
    ).toBe(true)
  })

  it('replaces prior exact-source runtime evidence with the current empty result', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const discovered = fullSnapshot()
    const agent = discovered.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    authorizeRuntimeAgent(discovered, agent)
    const request = runtimeTelemetryRequestForAgent(discovered, agent, testEstate)
    if (request === undefined) throw new Error('Expected a runtime telemetry request.')
    const fixture = createRuntimeTelemetryFixture(testEstate.environment)
    const prior = projectRuntimeEvidence(
      discovered,
      await fixture.readObservationWindows(request),
      request,
    ).snapshot
    const service = new IngestionService(makeConnector(prior), snapshots, exposures, {
      estate: testEstate,
      sourceMode: 'foundry',
      runtimeTelemetryConnector: {
        id: fixture.id,
        readObservationWindows(currentRequest) {
          return Promise.resolve(
            emptyRuntimeWindows(currentRequest, {
              status: 'unknown',
              classification: 'unknown',
              caveats: ['empty'],
              recordsReceived: 0,
              recordsAccepted: 0,
              duplicatesRemoved: 0,
              pagesProcessed: 1,
            }),
          )
        },
      },
    })

    await service.run()

    const persisted = await snapshots.findLatest(testEstate)
    expect(
      persisted?.evidence.filter((evidence) =>
        ['otel-baseline-evidence', 'otel-observed-evidence'].includes(evidence.id),
      ),
    ).toEqual([])
  })

  it('refreshes API telemetry from a jobs-persisted snapshot with degraded projected evidence', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const discovered = fullSnapshot()
    const agent = discovered.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    authorizeRuntimeAgent(discovered, agent)
    const fixture = createRuntimeTelemetryFixture(testEstate.environment)
    const jobsRuntimeTelemetryConnector: RuntimeTelemetryConnector = {
      id: fixture.id,
      async readObservationWindows(request, options) {
        const windows = await fixture.readObservationWindows(request, options)
        return runtimeObservationWindowsSchema.parse({
          ...windows,
          baselineEvidenceId: 'jobs-baseline-degraded',
          observedEvidenceId: 'jobs-observed-degraded',
          baseline: {
            ...windows.baseline,
            observations: [],
            otelQuality: {
              status: 'degraded',
              classification: 'unknown',
              caveats: ['empty'],
              recordsReceived: 0,
              recordsAccepted: 0,
              duplicatesRemoved: 0,
              pagesProcessed: 1,
            },
          },
          observed: {
            ...windows.observed,
            observations: [],
            otelQuality: {
              status: 'degraded',
              classification: 'unknown',
              caveats: ['empty'],
              recordsReceived: 0,
              recordsAccepted: 0,
              duplicatesRemoved: 0,
              pagesProcessed: 1,
            },
          },
        })
      },
    }
    const service = new IngestionService(makeConnector(discovered), snapshots, exposures, {
      estate: testEstate,
      sourceMode: 'foundry',
      runtimeTelemetryConnector: jobsRuntimeTelemetryConnector,
    })

    await service.run()
    const persisted = await snapshots.findLatest(testEstate)
    expect(
      persisted?.evidence.filter((evidence) =>
        ['jobs-baseline-degraded', 'jobs-observed-degraded'].includes(evidence.id),
      ),
    ).toEqual([
      expect.objectContaining({ evidenceTypes: ['unknown'] }),
      expect.objectContaining({ evidenceTypes: ['unknown'] }),
    ])
    const persistedAgent = persisted?.nodes.find((node) => node.id === agent.id)
    if (persisted === null || persistedAgent === undefined) {
      throw new Error('Expected the jobs-persisted authoritative agent.')
    }
    expect(runtimeTelemetryRequestForAgent(persisted, persistedAgent, testEstate)).toMatchObject({
      sourceAgentId: 'provider-agent-id',
    })

    const readObservationWindows = vi.fn(fixture.readObservationWindows.bind(fixture))
    process.env['AGENT_SENTINEL_CONNECTOR'] = 'foundry'
    process.env['FOUNDRY_PROJECT_ENDPOINT'] =
      'https://example.services.ai.azure.com/api/projects/validation'
    process.env['FOUNDRY_TENANT_ID'] = testEstate.tenantId
    process.env['FOUNDRY_ENVIRONMENT'] = testEstate.environment
    let app: Awaited<ReturnType<typeof createApp>> | undefined
    try {
      app = await createApp(
        undefined,
        { mode: 'disabled' },
        {
          dataMode: 'live',
          snapshotRepository: snapshots,
          runtimeTelemetryConnector: { id: fixture.id, readObservationWindows },
        },
      )
      const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
      const state = agentSentinelStateSchema.parse(response.json())

      expect(response.statusCode).toBe(200)
      expect(state.runtimeEvidence).toMatchObject({
        eligibleAgentCount: 1,
        queriedAgentCount: 1,
      })
      expect(readObservationWindows).toHaveBeenCalledTimes(1)
    } finally {
      await app?.close()
      delete process.env['AGENT_SENTINEL_CONNECTOR']
      delete process.env['FOUNDRY_PROJECT_ENDPOINT']
      delete process.env['FOUNDRY_TENANT_ID']
      delete process.env['FOUNDRY_ENVIRONMENT']
    }
  })

  it('does not query runtime telemetry for non-authoritative manifest-style agents', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const discovered = fullSnapshot()
    const agent = discovered.nodes.find((node) => node.kind === 'agent')
    if (agent === undefined) throw new Error('Expected an agent fixture.')
    authorizeRuntimeAgent(discovered, agent)
    agent.metadata['sourceOfTruth'] = 'false'
    const evidence = discovered.evidence.find((item) => agent.evidenceIds.includes(item.id))
    if (evidence === undefined) throw new Error('Expected agent evidence.')
    evidence.metadata = { ...evidence.metadata, sourceOfTruth: 'false' }
    const readObservationWindows = vi.fn()
    const service = new IngestionService(makeConnector(discovered), snapshots, exposures, {
      estate: testEstate,
      sourceMode: 'foundry',
      runtimeTelemetryConnector: {
        id: 'azure-monitor-otel',
        readObservationWindows,
      },
    })

    const result = await service.run()

    expect(result).toMatchObject({ outcome: 'succeeded', persisted: true })
    expect(readObservationWindows).not.toHaveBeenCalled()
    expect(result.snapshot.evidence.some((item) => item.id === 'observed-evidence')).toBe(false)
  })

  it('merges latest non-authoritative manifests and preserves finding provenance', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const manifestIngestions = new InMemoryManifestIngestionRepository('tenant-demo')
    await manifestIngestions.save(await manifestRecord())
    const service = new IngestionService(makeConnector(fullSnapshot()), snapshots, exposures, {
      estate: testEstate,
      sourceMode: 'foundry',
      manifestIngestions,
    })

    const result = await service.run()
    expect(
      result.snapshot.nodes.find((node) => node.name === 'Partner Mutation Agent'),
    ).toMatchObject({
      trust: 'conditional',
      metadata: {
        source: 'custom-manifest-adapter',
        sourceOfTruth: 'false',
      },
    })
    expect(
      result.findings.find((finding) => finding.affectedAgentName === 'Partner Mutation Agent'),
    ).toMatchObject({
      policyId: 'AS-POL-003',
      sourceMode: 'manifest',
    })
  })

  it('preserves authoritative ingestion when manifest persistence is unavailable', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const availableManifests = new InMemoryManifestIngestionRepository('tenant-demo')
    await availableManifests.save(await manifestRecord())
    const initialService = new IngestionService(
      makeConnector(fullSnapshot()),
      snapshots,
      exposures,
      {
        estate: testEstate,
        sourceMode: 'foundry',
        manifestIngestions: availableManifests,
      },
    )
    const initial = await initialService.run()
    const manifestFinding = initial.findings.find((finding) => finding.sourceMode === 'manifest')
    if (manifestFinding === undefined) throw new Error('Manifest finding was not generated.')

    const manifestIngestions: ManifestIngestionRepository = {
      save: () => Promise.reject(new Error('not used')),
      listLatest: () => Promise.reject(new Error('Cosmos unavailable')),
    }
    const service = new IngestionService(makeConnector(fullSnapshot()), snapshots, exposures, {
      estate: testEstate,
      sourceMode: 'foundry',
      manifestIngestions,
    })

    const result = await service.run()
    expect(result).toMatchObject({
      outcome: 'partially-succeeded',
      persisted: true,
      manifestIngestion: {
        status: 'degraded',
        count: 0,
        reason: 'repository-unavailable',
      },
    })
    expect(await snapshots.list(testEstate)).toHaveLength(2)
    await expect(exposures.findById(manifestFinding.id, testEstate)).resolves.toMatchObject({
      status: 'open',
      sourceMode: 'manifest',
    })
  })
})
