import { describe, expect, it, vi } from 'vitest'

import type { AgentConnector, ConnectorHealthReport } from '@agent-sentinel/connector-sdk'
import type { EstateSnapshot } from '@agent-sentinel/domain'
import { FOUNDRY_API_VERSION, mapAgentToSnapshot } from '@agent-sentinel/foundry-connector'
import {
  InMemoryExposureFindingRepository,
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

describe('IngestionService', () => {
  it('persists snapshots, preserves firstSeen on second run, and resolves absent findings', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const connector = makeConnector(fullSnapshot())
    const service = new IngestionService(connector, snapshots, exposures, {
      tenantId: 'tenant-demo',
      sourceMode: 'foundry',
      correlationIdFactory: () => '11111111-1111-4111-8111-111111111111',
    })

    const first = await service.run()
    expect(first.correlationId).toBe('11111111-1111-4111-8111-111111111111')
    expect(first.persisted).toBe(true)
    expect(first.findings.length).toBeGreaterThan(0)
    expect(first.newFindings.length).toBe(first.findings.length)
    const firstSeenA = first.findings[0]?.firstSeen
    const stored = await snapshots.findLatest('tenant-demo', 'validation')
    expect(stored).not.toBeNull()

    const second = await service.run()
    expect(second.newFindings.length).toBe(0)
    const persisted = await exposures.findById(first.findings[0]!.id, 'tenant-demo')
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
      tenantId: 'tenant-demo',
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
      { tenantId: 'tenant-demo', sourceMode: 'foundry' },
    )
    const complete = await completeService.run()
    const persistedFinding = await exposures.findById(complete.findings[0]!.id, 'tenant-demo')

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
    const partialService = new IngestionService(
      makeConnector(partialSnapshot, health),
      snapshots,
      exposures,
      { tenantId: 'tenant-demo', sourceMode: 'foundry', logger },
    )

    const partial = await partialService.run()
    expect(partial).toMatchObject({
      outcome: 'partially-succeeded',
      persisted: false,
      newFindings: [],
      resolvedFindings: [],
    })
    expect(await snapshots.list('tenant-demo')).toHaveLength(1)
    expect(await snapshots.findLatest('tenant-demo', 'validation')).toMatchObject({
      generatedAt: completeSnapshot.generatedAt,
    })
    expect(await exposures.findById(complete.findings[0]!.id, 'tenant-demo')).toEqual(
      persistedFinding,
    )
    expect(logger.warn).toHaveBeenCalledWith('ingestion.enrichment.degraded', {
      correlationId: expect.any(String),
      sources: ['microsoft-entra-service-principals'],
    })
  })

  it('rejects a discovered snapshot from another tenant', async () => {
    const snapshots = new InMemorySnapshotRepository()
    const exposures = new InMemoryExposureFindingRepository()
    const snapshot = { ...fullSnapshot(), tenantId: 'other-tenant' }
    const service = new IngestionService(makeConnector(snapshot), snapshots, exposures, {
      tenantId: 'tenant-demo',
      sourceMode: 'foundry',
    })

    await expect(service.run()).rejects.toThrow('does not match the configured ingestion tenant')
    expect(await snapshots.list('tenant-demo')).toHaveLength(0)
  })
})
