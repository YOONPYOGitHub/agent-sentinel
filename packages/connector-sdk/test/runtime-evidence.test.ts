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

function normalizedWindows() {
  const normalized = windows()
  normalized.baseline.observations = [
    {
      ...normalized.baseline.observations[0]!,
      latencyMs: 700,
      inputTokens: 280,
      outputTokens: 90,
      costUsd: 0.01,
      otelProvenance: {
        estateId: 'estate-a',
        estateTenantId: 'tenant-a',
        estateEnvironment: 'portfolio',
        sourceConnectorId: 'primary',
        sourceTenantId: 'source-tenant',
        sourceEnvironment: 'production',
        provider: 'azure-monitor-otel',
        providerResourceId: '/subscriptions/example/resource',
        providerAgentId: 'provider-agent-a',
        traceId: '22222222222222222222222222222222',
        spanId: 'bbbbbbbbbbbbbbbb',
        observedAt: '2026-08-28T12:00:00.000Z',
        classification: 'live',
        sampling: { state: 'complete', rate: 1 },
        aggregation: { kind: 'raw' },
        partial: false,
        evidenceIds: ['invocation', 'latency', 'error', 'input-tokens', 'output-tokens', 'cost'],
      },
    },
  ]
  normalized.baseline.otelQuality = {
    status: 'available',
    classification: 'live',
    caveats: [],
    recordsReceived: 6,
    recordsAccepted: 6,
    duplicatesRemoved: 0,
    pagesProcessed: 1,
  }
  normalized.observed.observations = [
    {
      ...normalized.observed.observations[0]!,
      latencyMs: 820,
      inputTokens: 320,
      outputTokens: 110,
      costUsd: 0.012,
      otelProvenance: {
        estateId: 'estate-a',
        estateTenantId: 'tenant-a',
        estateEnvironment: 'portfolio',
        sourceConnectorId: 'primary',
        sourceTenantId: 'source-tenant',
        sourceEnvironment: 'production',
        provider: 'azure-monitor-otel',
        providerResourceId: '/subscriptions/example/resource',
        providerAgentId: 'provider-agent-a',
        traceId: '11111111111111111111111111111111',
        spanId: 'aaaaaaaaaaaaaaaa',
        observedAt: '2026-08-29T12:00:00.000Z',
        classification: 'live',
        sampling: { state: 'complete', rate: 1 },
        aggregation: { kind: 'raw' },
        partial: false,
        evidenceIds: ['invocation', 'latency', 'error', 'input-tokens', 'output-tokens', 'cost'],
      },
    },
  ]
  normalized.observed.otelQuality = {
    status: 'available',
    classification: 'live',
    caveats: [],
    recordsReceived: 6,
    recordsAccepted: 6,
    duplicatesRemoved: 0,
    pagesProcessed: 1,
  }
  return normalized
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
    const result = projectRuntimeEvidence(original, normalizedWindows())

    expect(original.evidence).toHaveLength(1)
    expect(result.snapshot.nodes).toHaveLength(original.nodes.length)
    expect(result.snapshot.edges).toHaveLength(original.edges.length)
    expect(result.addedEvidenceCount).toBe(2)
    expect(result.unmatchedToolCallNames).toEqual(['undeclared_tool'])
    expect(result.snapshot.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'observed-evidence',
          evidenceTypes: ['observed_runtime'],
        }),
      ]),
    )
    expect(result.snapshot.nodes.find((node) => node.id === 'tool-search')?.evidenceIds).toEqual(
      expect.arrayContaining(['baseline-evidence', 'observed-evidence']),
    )
    expect(result.snapshot.edges[0]?.evidenceIds).toEqual(
      expect.arrayContaining(['baseline-evidence', 'observed-evidence']),
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

  it('projects empty representative telemetry as unknown evidence, not runtime success', () => {
    const empty = windows()
    for (const window of [empty.baseline, empty.observed]) {
      window.observations = []
      window.otelQuality = {
        status: 'unknown',
        classification: 'unknown',
        caveats: ['empty'],
        recordsReceived: 0,
        recordsAccepted: 0,
        duplicatesRemoved: 0,
        pagesProcessed: 1,
      }
    }

    const result = projectRuntimeEvidence(snapshot(), empty)
    expect(result.addedEvidenceCount).toBe(2)
    expect(
      result.snapshot.evidence
        .filter((item) => item.metadata?.sourceConnector === 'azure-monitor-otel')
        .map((item) => item.evidenceTypes),
    ).toEqual([['unknown'], ['unknown']])
    expect(
      result.snapshot.evidence
        .filter((item) => item.metadata?.sourceConnector === 'azure-monitor-otel')
        .every((item) => item.confidence === 0),
    ).toBe(true)
  })

  it('retains exact normalized invocation provenance in projected evidence', () => {
    const normalized = normalizedWindows()

    const result = projectRuntimeEvidence(snapshot(), normalized)
    expect(result.snapshot.evidence.find((item) => item.id === 'observed-evidence')?.otel).toEqual({
      quality: normalized.observed.otelQuality,
      invocations: [
        expect.objectContaining({
          id: 'observed-real',
          success: true,
          provenance: expect.objectContaining({
            providerAgentId: 'provider-agent-a',
            providerResourceId: '/subscriptions/example/resource',
            traceId: '11111111111111111111111111111111',
            spanId: 'aaaaaaaaaaaaaaaa',
          }),
        }),
      ],
    })
  })

  it('degrades contradictory outer and nested provenance before projection', () => {
    const mutations: Array<(normalized: ReturnType<typeof normalizedWindows>) => void> = [
      (normalized) => {
        normalized.observed.observations[0]!.tenantId = 'tenant-b'
      },
      (normalized) => {
        normalized.observed.observations[0]!.environment = 'staging'
      },
      (normalized) => {
        normalized.observed.observations[0]!.source = 'mock-synthetic'
      },
      (normalized) => {
        normalized.observed.observations[0]!.observedAt = '2026-08-29T12:00:01.000Z'
      },
      (normalized) => {
        normalized.observed.observations[0]!.synthetic = true
      },
      (normalized) => {
        normalized.observed.observations[0]!.otelProvenance!.sourceConnectorId = 'secondary'
      },
      (normalized) => {
        normalized.observed.observations[0]!.otelProvenance!.providerAgentId = 'provider-agent-b'
      },
    ]

    for (const mutate of mutations) {
      const normalized = normalizedWindows()
      mutate(normalized)
      const result = projectRuntimeEvidence(snapshot(), normalized)
      const evidence = result.snapshot.evidence.find((item) => item.id === 'observed-evidence')

      expect(evidence).toMatchObject({
        confidence: 0,
        evidenceTypes: ['unknown'],
        metadata: {
          evidenceStatus: 'degraded',
        },
      })
      expect(evidence?.otel?.quality.caveats).toContain('invalid-record')
      expect(evidence?.otel?.invocations).toEqual([])
    }
  })

  it('degrades missing exact provenance fields before projection', () => {
    for (const field of [
      'estateId',
      'estateTenantId',
      'estateEnvironment',
      'sourceConnectorId',
      'sourceTenantId',
      'sourceEnvironment',
      'providerResourceId',
      'providerAgentId',
      'observedAt',
      'classification',
    ] as const) {
      const normalized = normalizedWindows()
      const provenance = normalized.observed.observations[0]!.otelProvenance!
      delete (provenance as Partial<typeof provenance>)[field]
      const result = projectRuntimeEvidence(snapshot(), normalized)
      const evidence = result.snapshot.evidence.find((item) => item.id === 'observed-evidence')

      expect(evidence).toMatchObject({
        confidence: 0,
        evidenceTypes: ['unknown'],
        metadata: {
          evidenceStatus: 'degraded',
        },
      })
      expect(evidence?.otel?.quality.caveats).toContain('invalid-record')
      expect(evidence?.otel?.invocations).toEqual([])
    }
  })

  it('degrades conflicting estate and provider resource provenance without a winner', () => {
    for (const field of ['estateId', 'providerResourceId'] as const) {
      const normalized = normalizedWindows()
      const first = normalized.observed.observations[0]!
      normalized.observed.observations.push({
        ...structuredClone(first),
        id: 'observed-real-2',
      })
      first.otelProvenance![field] = `${first.otelProvenance![field]}-other`

      const result = projectRuntimeEvidence(snapshot(), normalized)
      const evidence = result.snapshot.evidence.find((item) => item.id === 'observed-evidence')
      expect(evidence).toMatchObject({
        confidence: 0,
        evidenceTypes: ['unknown'],
      })
      expect(evidence?.otel?.quality.caveats).toContain('invalid-record')
      expect(evidence?.otel?.invocations).toEqual([])
    }
  })

  it('recomputes quality from nested timestamp, sampling, aggregation, and partiality', () => {
    const cases: Array<{
      mutate: (normalized: ReturnType<typeof normalizedWindows>) => void
      caveat: string
    }> = [
      {
        mutate: (normalized) => {
          normalized.observed.observations[0]!.otelProvenance!.observedAt =
            '2026-08-29T12:00:01.000Z'
        },
        caveat: 'invalid-record',
      },
      {
        mutate: (normalized) => {
          normalized.observed.observations[0]!.observedAt = '2026-08-30T00:00:01.000Z'
          normalized.observed.observations[0]!.otelProvenance!.observedAt =
            '2026-08-30T00:00:01.000Z'
        },
        caveat: 'invalid-record',
      },
      {
        mutate: (normalized) => {
          normalized.observed.observations[0]!.otelProvenance!.sampling = {
            state: 'sampled',
            rate: 0.5,
          }
        },
        caveat: 'sampled',
      },
      {
        mutate: (normalized) => {
          normalized.observed.observations[0]!.otelProvenance!.sampling = {
            state: 'complete',
          }
        },
        caveat: 'sampling-unknown',
      },
      {
        mutate: (normalized) => {
          normalized.observed.observations[0]!.otelProvenance!.aggregation = {
            kind: 'delta',
          }
        },
        caveat: 'aggregated-metric',
      },
      {
        mutate: (normalized) => {
          normalized.observed.observations[0]!.otelProvenance!.partial = true
        },
        caveat: 'partial',
      },
    ]

    for (const { mutate, caveat } of cases) {
      const normalized = normalizedWindows()
      mutate(normalized)
      const result = projectRuntimeEvidence(snapshot(), normalized)
      const evidence = result.snapshot.evidence.find((item) => item.id === 'observed-evidence')

      expect(evidence).toMatchObject({
        confidence: 0,
        evidenceTypes: ['unknown'],
        metadata: { evidenceStatus: 'degraded' },
      })
      expect(evidence?.otel?.quality.caveats).toContain(caveat)
      expect(evidence?.otel?.invocations).toEqual([])
    }
  })

  it('does not trust caller-supplied available quality when nested evidence contradicts it', () => {
    const cases: Array<(normalized: ReturnType<typeof normalizedWindows>) => void> = [
      (normalized) => {
        delete normalized.observed.otelQuality
      },
      (normalized) => {
        normalized.observed.otelQuality!.classification = 'synthetic'
      },
      (normalized) => {
        normalized.observed.otelQuality!.recordsAccepted = 5
      },
      (normalized) => {
        normalized.observed.otelQuality!.pagesProcessed = 0
      },
    ]

    for (const mutate of cases) {
      const normalized = normalizedWindows()
      mutate(normalized)
      const result = projectRuntimeEvidence(snapshot(), normalized)
      const evidence = result.snapshot.evidence.find((item) => item.id === 'observed-evidence')

      expect(evidence).toMatchObject({
        confidence: 0,
        evidenceTypes: ['unknown'],
        metadata: { evidenceStatus: 'degraded' },
      })
    }
  })

  it('does not default missing nested partiality to successful runtime evidence', () => {
    const normalized = normalizedWindows()
    const provenance = normalized.observed.observations[0]!.otelProvenance!
    delete (provenance as Partial<typeof provenance>).partial

    const result = projectRuntimeEvidence(snapshot(), normalized)
    const evidence = result.snapshot.evidence.find((item) => item.id === 'observed-evidence')

    expect(evidence).toMatchObject({
      confidence: 0,
      evidenceTypes: ['unknown'],
      metadata: { evidenceStatus: 'degraded' },
    })
    expect(evidence?.otel?.invocations).toEqual([])
  })
})
