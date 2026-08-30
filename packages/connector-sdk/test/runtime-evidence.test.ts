import { describe, expect, it } from 'vitest'

import { estateSnapshotSchema, type EstateSnapshot } from '@agent-sentinel/domain'

import {
  projectRuntimeEvidence,
  runtimeObservationWindowsSchema,
  runtimeTelemetryRequestForAgent,
  withoutSyntheticObservations,
} from '../src/index.js'

function snapshot(): EstateSnapshot {
  return estateSnapshotSchema.parse({
    tenantId: 'tenant-a',
    environment: 'portfolio',
    generatedAt: '2026-08-30T00:00:00.000Z',
    nodes: [
      {
        id: 'agent-a',
        kind: 'agent',
        name: 'Agent A',
        description: 'Declared agent.',
        environment: 'production',
        evidenceIds: ['declared-agent'],
        metadata: {
          sourceConnectorId: 'primary',
          sourceTenantId: 'source-tenant',
          sourceObjectId: 'provider-agent-a',
          sourceEnvironment: 'production',
        },
      },
      {
        id: 'tool-search',
        kind: 'tool',
        name: 'knowledge_search',
        description: 'Declared search tool.',
        environment: 'production',
        evidenceIds: ['declared-agent'],
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'edge-search',
        from: 'agent-a',
        to: 'tool-search',
        relationship: 'CAN_CALL',
        evidenceIds: ['declared-agent'],
        active: true,
      },
    ],
    evidence: [
      {
        id: 'declared-agent',
        source: 'Azure AI Foundry Agent Service',
        sourceObjectId: 'provider-agent-a',
        observedAt: '2026-08-30T00:00:00.000Z',
        freshness: 'live',
        confidence: 1,
        evidenceTypes: ['declared_configuration'],
        summary: 'Declared configuration.',
      },
    ],
  })
}

function windows() {
  return runtimeObservationWindowsSchema.parse({
    baseline: {
      windowId: 'baseline-window',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      environment: 'production',
      source: 'azure-monitor-otel',
      windowStart: '2026-08-28T00:00:00.000Z',
      windowEnd: '2026-08-29T00:00:00.000Z',
      observations: [
        {
          id: 'baseline-real',
          tenantId: 'tenant-a',
          agentId: 'agent-a',
          environment: 'production',
          source: 'azure-monitor-otel',
          observedAt: '2026-08-28T12:00:00.000Z',
          success: true,
          toolCallNames: ['knowledge_search', 'undeclared_tool'],
        },
      ],
    },
    observed: {
      windowId: 'observed-window',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      environment: 'production',
      source: 'azure-monitor-otel',
      windowStart: '2026-08-29T00:00:00.000Z',
      windowEnd: '2026-08-30T00:00:00.000Z',
      observations: [
        {
          id: 'observed-real',
          tenantId: 'tenant-a',
          agentId: 'agent-a',
          environment: 'production',
          source: 'azure-monitor-otel',
          observedAt: '2026-08-29T12:00:00.000Z',
          success: true,
          toolCallNames: ['knowledge_search'],
        },
        {
          id: 'observed-synthetic',
          tenantId: 'tenant-a',
          agentId: 'agent-a',
          environment: 'production',
          source: 'azure-monitor-otel',
          observedAt: '2026-08-29T13:00:00.000Z',
          success: false,
          toolCallNames: ['knowledge_search'],
          synthetic: true,
        },
      ],
    },
    baselineEvidenceId: 'baseline-evidence',
    observedEvidenceId: 'observed-evidence',
    queriedAt: '2026-08-30T00:00:00.000Z',
  })
}

describe('runtime evidence projection', () => {
  it('builds an exact source-bound telemetry request', () => {
    const estate = snapshot()
    expect(runtimeTelemetryRequestForAgent(estate, estate.nodes[0]!)).toEqual({
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      sourceConnectorId: 'primary',
      sourceTenantId: 'source-tenant',
      sourceAgentId: 'provider-agent-a',
      sourceEnvironment: 'production',
    })
  })

  it('attaches measured evidence only to existing exact agent, tool, and edge matches', () => {
    const original = snapshot()
    const result = projectRuntimeEvidence(original, windows())

    expect(original.evidence).toHaveLength(1)
    expect(result.snapshot.nodes).toHaveLength(original.nodes.length)
    expect(result.snapshot.edges).toHaveLength(original.edges.length)
    expect(result.addedEvidenceCount).toBe(3)
    expect(result.unmatchedToolCallNames).toEqual(['undeclared_tool'])
    expect(result.snapshot.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'observed-evidence',
          evidenceTypes: ['observed_runtime'],
        }),
        expect.objectContaining({
          id: 'observed-evidence-synthetic',
          evidenceTypes: ['synthetic_validation'],
        }),
      ]),
    )
    expect(result.snapshot.nodes.find((node) => node.id === 'tool-search')?.evidenceIds).toEqual(
      expect.arrayContaining([
        'baseline-evidence',
        'observed-evidence',
        'observed-evidence-synthetic',
      ]),
    )
    expect(result.snapshot.edges[0]?.evidenceIds).toEqual(
      expect.arrayContaining([
        'baseline-evidence',
        'observed-evidence',
        'observed-evidence-synthetic',
      ]),
    )
  })

  it('removes synthetic canaries from real behavior analysis windows', () => {
    const measured = withoutSyntheticObservations(windows())
    expect(measured.observed.observations.map((item) => item.id)).toEqual(['observed-real'])
  })

  it('rejects runtime evidence outside the estate boundary', () => {
    const mismatched = windows()
    mismatched.observed.environment = 'staging'
    mismatched.baseline.environment = 'staging'
    expect(() => projectRuntimeEvidence(snapshot(), mismatched)).toThrow(
      'does not match the estate tenant and agent environment',
    )
  })
})
