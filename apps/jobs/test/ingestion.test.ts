import { describe, expect, it, vi } from 'vitest'

import type {
  AgentConnector,
  ConnectorHealthReport,
  ManifestIngestionRecord,
  ManifestIngestionRepository,
} from '@agent-sentinel/connector-sdk'
import type { EstateSnapshot } from '@agent-sentinel/domain'
import { FOUNDRY_API_VERSION, mapAgentToSnapshot } from '@agent-sentinel/foundry-connector'
import { ManifestConnector } from '@agent-sentinel/manifest-connector'
import {
  InMemoryConnectorHealthRepository,
  InMemoryExposureFindingRepository,
  InMemoryManifestIngestionRepository,
  InMemorySnapshotRepository,
} from '@agent-sentinel/persistence'
import { foundryManifest } from '@agent-sentinel/scenarios'

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
const testEstate = {
  id: 'default',
  tenantId: 'tenant-demo',
  environment: 'validation',
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

describe('IngestionService', () => {
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
