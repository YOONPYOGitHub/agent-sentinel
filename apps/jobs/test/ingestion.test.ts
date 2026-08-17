import { describe, expect, it } from 'vitest'

import type { AgentConnector } from '@agent-sentinel/connector-sdk'
import type { EstateSnapshot } from '@agent-sentinel/domain'
import { FOUNDRY_API_VERSION, mapAgentToSnapshot } from '@agent-sentinel/foundry-connector'
import {
  InMemoryExposureFindingRepository,
  InMemorySnapshotRepository,
} from '@agent-sentinel/persistence'
import { foundryManifest } from '@agent-sentinel/scenarios'

import { IngestionService } from '../src/ingestion-service.js'

function makeConnector(snapshot: EstateSnapshot): AgentConnector {
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
    expect(first.findings.length).toBeGreaterThan(0)
    expect(first.newFindings.length).toBe(first.findings.length)
    const firstSeenA = first.findings[0]?.firstSeen
    const stored = await snapshots.findLatest('tenant-demo', 'validation')
    expect(stored).not.toBeNull()

    const second = await service.run()
    expect(second.newFindings.length).toBe(0)
    const persisted = await exposures.findById(first.findings[0]!.id)
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
})
