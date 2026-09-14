import { describe, expect, it, vi } from 'vitest'

import {
  assertPersistableEstateSnapshot,
  sourceProjectIdSchema,
  type EstateContext,
  type EstateSnapshot,
} from '../src/index.js'

const estate: EstateContext = {
  id: 'estate-a',
  tenantId: 'tenant-a',
  environment: 'portfolio',
}

const generatedAt = '2026-09-10T00:00:00.000Z'

function runtimeEvidence(
  evidenceIndex: number,
  invocationCount: number,
): EstateSnapshot['evidence'][number] {
  const suffix = String(evidenceIndex)
  const sourceProjectId = `project-${suffix}`
  const providerAgentId = `provider-agent-${suffix}`
  return {
    id: `runtime-${suffix}`,
    source: 'Azure Monitor OpenTelemetry',
    sourceObjectId: `observed-window-${suffix}`,
    observedAt: generatedAt,
    freshness: 'live',
    confidence: 1,
    evidenceTypes: ['observed_runtime'],
    summary: `${invocationCount} measured invocations.`,
    metadata: {
      sourceConnector: 'azure-monitor-otel',
      estateId: estate.id,
      estateTenantId: estate.tenantId,
      estateEnvironment: estate.environment,
      sourceConnectorId: 'primary',
      sourceTenantId: estate.tenantId,
      sourceProjectId,
      sourceEnvironment: 'production',
      sourceAgentId: providerAgentId,
    },
    otel: {
      quality: {
        status: 'available',
        classification: 'live',
        caveats: [],
        recordsReceived: invocationCount,
        recordsAccepted: invocationCount,
        duplicatesRemoved: 0,
        pagesProcessed: 1,
      },
      invocations: Array.from({ length: invocationCount }, (_, invocationIndex) => ({
        id: `invocation-${suffix}-${String(invocationIndex)}`,
        observedAt: generatedAt,
        latencyMs: 42,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
        success: true,
        toolCallNames: [],
        provenance: {
          snapshotGeneratedAt: generatedAt,
          estateId: estate.id,
          estateTenantId: estate.tenantId,
          estateEnvironment: estate.environment,
          sourceConnectorId: 'primary',
          sourceTenantId: estate.tenantId,
          sourceProjectId,
          sourceEnvironment: 'production',
          provider: 'azure-monitor-otel',
          providerResourceId:
            '/subscriptions/11111111-1111-4111-8111-111111111111/resourcegroups/rg-test/providers/microsoft.insights/components/app-test',
          providerAgentId,
          providerInvocationId: `invocation-${suffix}-${String(invocationIndex)}`,
          sourceSetFingerprint: 'f'.repeat(64),
          measuredAt: generatedAt,
          traceId: (invocationIndex + 1).toString(16).padStart(32, '0'),
          spanId: (invocationIndex + 1).toString(16).padStart(16, '0'),
          observedAt: generatedAt,
          classification: 'live',
          sampling: { state: 'complete', rate: 1 },
          aggregation: { kind: 'raw' },
          contract: {
            version: 1,
            recordType: 'agent_invocation',
            applicationRoleName: 'test-agent',
            requestName: 'agent.invoke',
            outcome: 'success',
          },
          partial: false,
          evidenceIds: ['invocation', 'latency', 'error', 'input-tokens', 'output-tokens'],
        },
      })),
    },
  }
}

function declaredEvidence(evidenceIndex: number): EstateSnapshot['evidence'][number] {
  const suffix = String(evidenceIndex)
  return {
    id: `declared-${suffix}`,
    source: 'Foundry',
    sourceObjectId: `provider-agent-${suffix}`,
    observedAt: generatedAt,
    freshness: 'live',
    confidence: 1,
    evidenceTypes: ['declared_configuration'],
    summary: 'Authoritative agent declaration.',
    metadata: {
      sourceOfTruth: 'true',
      estateTenantId: estate.tenantId,
      estateEnvironment: estate.environment,
      sourceConnectorId: 'primary',
      sourceTenantId: estate.tenantId,
      sourceProjectId: `project-${suffix}`,
      sourceEnvironment: 'production',
      sourceObjectId: `provider-agent-${suffix}`,
    },
  }
}

function snapshotWithRuntimeEvidence(invocationsPerEvidence = 250): EstateSnapshot {
  const runtimeEvidenceRecords = [0, 1].map((index) =>
    runtimeEvidence(index, invocationsPerEvidence),
  )
  const declarations = [0, 1].map(declaredEvidence)
  const unrelatedEvidence: EstateSnapshot['evidence'][number] = {
    id: 'unrelated',
    source: 'Inventory',
    sourceObjectId: 'unrelated',
    observedAt: generatedAt,
    freshness: 'live',
    confidence: 1,
    evidenceTypes: ['unknown'],
    summary: 'Unrelated inventory evidence.',
  }
  return {
    tenantId: estate.tenantId,
    environment: estate.environment,
    generatedAt,
    nodes: [
      ...[0, 1].map((index) => ({
        id: `agent-${String(index)}`,
        kind: 'agent' as const,
        name: `Agent ${String(index)}`,
        description: 'Authoritative agent.',
        environment: 'production',
        evidenceIds: [`declared-${String(index)}`, `runtime-${String(index)}`],
        metadata: {
          sourceOfTruth: 'true',
          sourceConnectorId: 'primary',
          sourceTenantId: estate.tenantId,
          sourceProjectId: `project-${String(index)}`,
          sourceObjectId: `provider-agent-${String(index)}`,
          sourceEnvironment: 'production',
        },
      })),
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `unrelated-${String(index)}`,
        kind: 'data' as const,
        name: `Unrelated ${String(index)}`,
        description: 'Unrelated node.',
        environment: 'production',
        evidenceIds: ['unrelated'],
        metadata: {
          sourceProjectId: 'not-an-authoritative-agent-project',
        },
      })),
    ],
    edges: [],
    evidence: [...declarations, ...runtimeEvidenceRecords, unrelatedEvidence],
  }
}

function invocationAt(snapshot: EstateSnapshot, evidenceIndex: number, invocationIndex: number) {
  const invocation = snapshot.evidence[evidenceIndex]?.otel?.invocations[invocationIndex]
  if (invocation === undefined) throw new Error('Expected runtime invocation fixture.')
  return invocation
}

describe('contextual OpenTelemetry snapshot validation', () => {
  it('parses relevant agent project authority once for 500 invocations across evidence records', () => {
    const snapshot = snapshotWithRuntimeEvidence()
    const projectParse = vi.spyOn(sourceProjectIdSchema, 'safeParse')

    try {
      expect(assertPersistableEstateSnapshot(estate, snapshot)).toEqual(snapshot)
      expect(projectParse).toHaveBeenCalledTimes(2)
    } finally {
      projectParse.mockRestore()
    }
  })

  it('retains the exact diagnostic for a late invocation source mismatch', () => {
    const snapshot = snapshotWithRuntimeEvidence()
    invocationAt(snapshot, 3, 249).provenance.sourceProjectId = 'other-project'

    expect(() => assertPersistableEstateSnapshot(estate, snapshot)).toThrow(
      'OpenTelemetry invocation provenance does not match the target estate and snapshot source binding: runtime-1/invocation-1-249',
    )
  })

  it('rejects ambiguous project authority associated with one runtime evidence record', () => {
    const snapshot = snapshotWithRuntimeEvidence(1)
    snapshot.evidence.push({
      ...declaredEvidence(1),
      id: 'declared-ambiguous',
      metadata: {
        ...declaredEvidence(1).metadata,
        sourceProjectId: 'project-ambiguous',
      },
    })
    snapshot.nodes.push({
      id: 'agent-ambiguous',
      kind: 'agent',
      name: 'Ambiguous Agent',
      description: 'Conflicting exact project authority.',
      environment: 'production',
      evidenceIds: ['declared-ambiguous', 'runtime-1'],
      metadata: {
        sourceOfTruth: 'true',
        sourceConnectorId: 'primary',
        sourceTenantId: estate.tenantId,
        sourceProjectId: 'project-ambiguous',
        sourceObjectId: 'provider-agent-1',
        sourceEnvironment: 'production',
      },
    })

    expect(() => assertPersistableEstateSnapshot(estate, snapshot)).toThrow(
      'OpenTelemetry invocation provenance does not match the target estate and snapshot source binding: runtime-1/invocation-1-0',
    )
  })
})
