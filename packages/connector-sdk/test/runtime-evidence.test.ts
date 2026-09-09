import { describe, expect, it } from 'vitest'

import {
  SOURCE_PROJECT_ID_MAX_LENGTH,
  estateSnapshotSchema,
  type EstateSnapshot,
  type RuntimeObservation,
} from '@agent-sentinel/domain'

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
          sourceOfTruth: 'true',
          sourceConnectorId: 'primary',
          sourceTenantId: 'source-tenant',
          sourceProjectId: 'project-a',
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
        metadata: {
          sourceOfTruth: 'true',
          estateTenantId: 'tenant-a',
          estateEnvironment: 'portfolio',
          sourceConnectorId: 'primary',
          sourceTenantId: 'source-tenant',
          sourceProjectId: 'project-a',
          sourceEnvironment: 'production',
          sourceObjectId: 'provider-agent-a',
        },
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
    maximumFreshnessHours: 48,
  })
}

function normalizedWindows() {
  const normalized = windows()
  normalized.provenance = {
    snapshotGeneratedAt: '2026-08-30T00:00:00.000Z',
    estateId: 'estate-a',
    estateTenantId: 'tenant-a',
    estateEnvironment: 'portfolio',
    sourceConnectorId: 'primary',
    sourceTenantId: 'source-tenant',
    sourceProjectId: 'project-a',
    sourceEnvironment: 'production',
    provider: 'azure-monitor-otel',
    providerResourceId: '/subscriptions/example/resource',
    providerAgentId: 'provider-agent-a',
  }
  normalized.baseline.observations = [
    {
      ...normalized.baseline.observations[0]!,
      latencyMs: 700,
      inputTokens: 280,
      outputTokens: 90,
      costUsd: 0.01,
      otelProvenance: {
        snapshotGeneratedAt: '2026-08-30T00:00:00.000Z',
        estateId: 'estate-a',
        estateTenantId: 'tenant-a',
        estateEnvironment: 'portfolio',
        sourceConnectorId: 'primary',
        sourceTenantId: 'source-tenant',
        sourceProjectId: 'project-a',
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
        snapshotGeneratedAt: '2026-08-30T00:00:00.000Z',
        estateId: 'estate-a',
        estateTenantId: 'tenant-a',
        estateEnvironment: 'portfolio',
        sourceConnectorId: 'primary',
        sourceTenantId: 'source-tenant',
        sourceProjectId: 'project-a',
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

function defaultBaselineBoundary() {
  const candidate = normalizedWindows()
  candidate.baseline.windowStart = '2026-09-01T06:00:00.000Z'
  candidate.baseline.windowEnd = '2026-09-08T06:00:00.000Z'
  candidate.baseline.observations[0]!.observedAt = candidate.baseline.windowStart
  candidate.baseline.observations[0]!.otelProvenance!.observedAt = candidate.baseline.windowStart
  candidate.observed.windowStart = candidate.baseline.windowEnd
  candidate.observed.windowEnd = '2026-09-09T06:00:00.000Z'
  candidate.observed.observations[0]!.observedAt = '2026-09-08T18:00:00.000Z'
  candidate.observed.observations[0]!.otelProvenance!.observedAt =
    candidate.observed.observations[0]!.observedAt
  candidate.queriedAt = candidate.observed.windowEnd
  candidate.maximumFreshnessHours = 168
  return candidate
}

function projectionRequest(estate: EstateSnapshot) {
  const request = runtimeTelemetryRequestForAgent(estate, estate.nodes[0]!, {
    id: 'estate-a',
    tenantId: estate.tenantId,
    environment: estate.environment,
  })
  if (request === undefined) {
    throw new Error('Expected an authoritative runtime telemetry request.')
  }
  return request
}

function trustedEstateContext(estate: EstateSnapshot) {
  return {
    id: 'estate-a',
    tenantId: estate.tenantId,
    environment: estate.environment,
  }
}

function project(estate: EstateSnapshot, candidate: ReturnType<typeof windows>) {
  return projectRuntimeEvidence(estate, candidate, projectionRequest(estate))
}

describe('runtime evidence projection', () => {
  it('uses the shared source project ID boundary in runtime provenance', () => {
    const sourceProjectId = 'p'.repeat(SOURCE_PROJECT_ID_MAX_LENGTH)
    const candidate = normalizedWindows()
    candidate.provenance = {
      ...candidate.provenance!,
      sourceProjectId: ` ${sourceProjectId} `,
    }

    expect(runtimeObservationWindowsSchema.parse(candidate).provenance?.sourceProjectId).toBe(
      sourceProjectId,
    )
    expect(
      runtimeObservationWindowsSchema.safeParse({
        ...candidate,
        provenance: {
          ...candidate.provenance,
          sourceProjectId: `${sourceProjectId}x`,
        },
      }).success,
    ).toBe(false)
  })

  it('builds an exact source-bound telemetry request', () => {
    const estate = snapshot()
    expect(runtimeTelemetryRequestForAgent(estate, estate.nodes[0]!)).toEqual({
      snapshotGeneratedAt: '2026-08-30T00:00:00.000Z',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      sourceConnectorId: 'primary',
      sourceTenantId: 'source-tenant',
      sourceProjectId: 'project-a',
      sourceAgentId: 'provider-agent-a',
      sourceEnvironment: 'production',
    })
  })

  it('allows authoritative supplemental evidence for the same exact agent binding', () => {
    const estate = snapshot()
    estate.nodes[0]!.evidenceIds.push('trust-evidence')
    estate.evidence.push({
      ...structuredClone(estate.evidence[0]!),
      id: 'trust-evidence',
      sourceObjectId: 'trust-record-a',
      evidenceTypes: ['observed_runtime'],
      metadata: {
        ...estate.evidence[0]!.metadata,
        sourceObjectId: 'trust-record-a',
        trustSubjectAgentId: 'provider-agent-a',
      },
    })

    expect(runtimeTelemetryRequestForAgent(estate, estate.nodes[0]!)).toMatchObject({
      sourceAgentId: 'provider-agent-a',
    })
    expect(project(estate, normalizedWindows()).addedEvidenceCount).toBe(2)
  })

  it.each([
    ['live', (candidate: ReturnType<typeof normalizedWindows>) => candidate],
    [
      'synthetic',
      (candidate: ReturnType<typeof normalizedWindows>) => {
        for (const window of [candidate.baseline, candidate.observed]) {
          for (const observation of window.observations) {
            observation.synthetic = true
            observation.otelProvenance = {
              ...observation.otelProvenance!,
              classification: 'synthetic',
            }
          }
          window.otelQuality = {
            ...window.otelQuality!,
            classification: 'synthetic',
          }
        }
        return candidate
      },
    ],
    [
      'degraded unknown',
      (candidate: ReturnType<typeof normalizedWindows>) => {
        for (const window of [candidate.baseline, candidate.observed]) {
          window.observations = []
          window.otelQuality = {
            status: 'degraded',
            classification: 'unknown',
            caveats: ['empty'],
            recordsReceived: 0,
            recordsAccepted: 0,
            duplicatesRemoved: 0,
            pagesProcessed: 1,
          }
        }
        return candidate
      },
    ],
  ])(
    'keeps declared-agent telemetry eligibility after %s runtime evidence is projected',
    (_label, makeCandidate) => {
      const estate = snapshot()
      const projected = project(estate, makeCandidate(normalizedWindows())).snapshot

      expect(
        runtimeTelemetryRequestForAgent(
          projected,
          projected.nodes[0]!,
          trustedEstateContext(projected),
        ),
      ).toMatchObject({
        sourceAgentId: 'provider-agent-a',
      })
    },
  )

  it.each([
    [
      'node authority',
      (estate: EstateSnapshot) => (estate.nodes[0]!.metadata.sourceOfTruth = 'false'),
    ],
    [
      'explicit node non-authority',
      (estate: EstateSnapshot) => (estate.nodes[0]!.metadata.isNonAuthoritative = 'true'),
    ],
    [
      'synthetic-only node marker',
      (estate: EstateSnapshot) => (estate.nodes[0]!.metadata.syntheticOnly = 'true'),
    ],
    [
      'synthetic trust marker',
      (estate: EstateSnapshot) =>
        (estate.nodes[0]!.metadata.trustAssessmentSourceMode = 'synthetic'),
    ],
    [
      'tested classification marker',
      (estate: EstateSnapshot) => (estate.nodes[0]!.metadata.classification = 'tested'),
    ],
    [
      'authoritative evidence',
      (estate: EstateSnapshot) => {
        estate.evidence[0]!.metadata!.sourceOfTruth = 'false'
      },
    ],
    [
      'explicit evidence non-authority',
      (estate: EstateSnapshot) => {
        estate.evidence[0]!.metadata!.isNonAuthoritative = 'true'
      },
    ],
    [
      'test-only evidence marker',
      (estate: EstateSnapshot) => {
        estate.evidence[0]!.metadata!.testOnly = 'true'
      },
    ],
    [
      'synthetic validation evidence',
      (estate: EstateSnapshot) => {
        estate.evidence[0]!.evidenceTypes = ['declared_configuration', 'synthetic_validation']
      },
    ],
    [
      'mixed authoritative and non-authoritative cited evidence',
      (estate: EstateSnapshot) => {
        estate.nodes[0]!.evidenceIds.push('manifest-evidence')
        estate.evidence.push({
          ...structuredClone(estate.evidence[0]!),
          id: 'manifest-evidence',
          evidenceTypes: ['declared_configuration'],
          metadata: {
            ...estate.evidence[0]!.metadata,
            sourceOfTruth: 'false',
            isNonAuthoritative: 'true',
          },
        })
      },
    ],
    [
      'an exact declared configuration',
      (estate: EstateSnapshot) => {
        estate.evidence[0]!.evidenceTypes = ['observed_runtime']
      },
    ],
    [
      'resolved cited evidence',
      (estate: EstateSnapshot) => {
        estate.nodes[0]!.evidenceIds.push('missing-evidence')
      },
    ],
    [
      'source connector evidence',
      (estate: EstateSnapshot) => {
        estate.evidence[0]!.metadata!.sourceConnectorId = 'other-source'
      },
    ],
    [
      'source tenant evidence',
      (estate: EstateSnapshot) => {
        estate.evidence[0]!.metadata!.sourceTenantId = 'other-tenant'
      },
    ],
    [
      'source project evidence',
      (estate: EstateSnapshot) => {
        estate.evidence[0]!.metadata!.sourceProjectId = 'other-project'
      },
    ],
    [
      'source environment evidence',
      (estate: EstateSnapshot) => {
        estate.evidence[0]!.metadata!.sourceEnvironment = 'other-environment'
      },
    ],
    [
      'source agent evidence',
      (estate: EstateSnapshot) => {
        estate.evidence[0]!.metadata!.sourceObjectId = 'other-agent'
      },
    ],
    [
      'estate tenant evidence',
      (estate: EstateSnapshot) => {
        estate.evidence[0]!.metadata!.estateTenantId = 'other-estate'
      },
    ],
    [
      'estate environment evidence',
      (estate: EstateSnapshot) => {
        estate.evidence[0]!.metadata!.estateEnvironment = 'other-estate'
      },
    ],
    [
      'agent environment',
      (estate: EstateSnapshot) => {
        estate.nodes[0]!.environment = 'staging'
      },
    ],
  ])('does not query runtime telemetry without exact %s', (_label, mutate) => {
    const estate = snapshot()
    mutate(estate)

    expect(runtimeTelemetryRequestForAgent(estate, estate.nodes[0]!)).toBeUndefined()
    expect(() =>
      projectRuntimeEvidence(estate, normalizedWindows(), trustedEstateContext(estate)),
    ).toThrow()
  })

  it('does not infer telemetry eligibility from names, owners, primary IDs, or tenant inventory', () => {
    const estate = snapshot()
    const agent = estate.nodes[0]!
    agent.name = 'provider-agent-a'
    agent.owner = 'source-tenant'
    agent.metadata = {
      sourceOfTruth: 'true',
      primaryId: 'provider-agent-a',
      tenantId: 'source-tenant',
    }

    expect(runtimeTelemetryRequestForAgent(estate, agent)).toBeUndefined()
  })

  it('does not infer telemetry eligibility from a RUNS_AS edge', () => {
    const estate = snapshot()
    estate.evidence[0]!.evidenceTypes = ['observed_runtime']
    estate.nodes.push({
      id: 'identity-a',
      kind: 'identity',
      name: 'Agent identity',
      description: 'Exact identity correlation.',
      environment: 'production',
      evidenceIds: ['declared-agent'],
      metadata: {
        sourceOfTruth: 'true',
        sourceTenantId: 'source-tenant',
        sourceObjectId: 'provider-agent-a',
      },
    })
    estate.edges.push({
      id: 'runs-as',
      from: 'agent-a',
      to: 'identity-a',
      relationship: 'RUNS_AS',
      evidenceIds: ['declared-agent'],
      active: true,
    })

    expect(runtimeTelemetryRequestForAgent(estate, estate.nodes[0]!)).toBeUndefined()
    expect(() =>
      projectRuntimeEvidence(estate, normalizedWindows(), trustedEstateContext(estate)),
    ).toThrow('authoritative discovered agent evidence')
  })

  it('adds exact estate identity only when the caller supplies it', () => {
    const estate = snapshot()
    expect(
      runtimeTelemetryRequestForAgent(estate, estate.nodes[0]!, {
        id: 'estate-a',
        tenantId: estate.tenantId,
        environment: estate.environment,
      }),
    ).toEqual({
      snapshotGeneratedAt: '2026-08-30T00:00:00.000Z',
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      sourceConnectorId: 'primary',
      sourceTenantId: 'source-tenant',
      sourceProjectId: 'project-a',
      sourceAgentId: 'provider-agent-a',
      sourceEnvironment: 'production',
    })
  })

  it('rejects a caller estate that does not match the authoritative snapshot estate', () => {
    const estate = snapshot()

    expect(
      runtimeTelemetryRequestForAgent(estate, estate.nodes[0]!, {
        id: 'estate-a',
        tenantId: estate.tenantId,
        environment: 'other-estate',
      }),
    ).toBeUndefined()
  })

  it('attaches measured evidence only to existing exact agent, tool, and edge matches', () => {
    const original = snapshot()
    const result = project(original, normalizedWindows())

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

  it('does not establish readiness without a configured freshness maximum', () => {
    const missingFreshness = normalizedWindows()
    delete missingFreshness.maximumFreshnessHours

    const estate = snapshot()
    const result = project(estate, missingFreshness)

    expect(result.dataState).toEqual({
      state: 'partial',
      reason: 'degraded-quality',
    })
    expect(
      result.snapshot.evidence
        .filter((item) => item.id.endsWith('-evidence'))
        .every((item) => item.otel?.quality.caveats.includes('invalid-record')),
    ).toBe(true)
  })

  it('recomputes stale evidence from queriedAt and maximumFreshnessHours', () => {
    const stale = normalizedWindows()
    stale.maximumFreshnessHours = 1

    const estate = snapshot()
    const result = project(estate, stale)

    expect(result.dataState).toEqual({ state: 'stale', reason: 'stale' })
    expect(
      result.snapshot.evidence
        .filter((item) => item.id.endsWith('-evidence'))
        .every(
          (item) =>
            item.freshness === 'stale' && item.otel?.quality.caveats.includes('stale') === true,
        ),
    ).toBe(true)
  })

  it('accepts the default 168-hour baseline boundary when queried 24 hours after its end', () => {
    const estate = snapshot()
    const result = project(estate, defaultBaselineBoundary())

    expect(result.dataState).toEqual({ state: 'complete' })
    expect(result.windows.baseline.observations.map((item) => item.id)).toEqual(['baseline-real'])
    expect(result.windows.baseline.otelQuality).toMatchObject({
      status: 'available',
      caveats: [],
    })
    expect(result.snapshot.evidence.find((item) => item.id === 'baseline-evidence')).toMatchObject({
      freshness: 'recent',
      confidence: 1,
      otel: {
        quality: {
          status: 'available',
          caveats: [],
        },
      },
    })
  })

  it('rejects a window whose query delay exceeds the freshness maximum by one millisecond', () => {
    const staleWindow = defaultBaselineBoundary()
    staleWindow.queriedAt = '2026-09-16T06:00:00.001Z'

    const estate = snapshot()
    const result = project(estate, staleWindow)

    expect(result.dataState).toEqual({ state: 'stale', reason: 'stale' })
    expect(result.windows.observed.otelQuality).toMatchObject({
      status: 'degraded',
      caveats: ['stale'],
    })
  })

  it('rejects an observation older than the freshness maximum relative to its window end', () => {
    const staleObservation = defaultBaselineBoundary()
    staleObservation.baseline.windowStart = '2026-09-01T05:00:00.000Z'
    staleObservation.baseline.observations[0]!.observedAt = '2026-09-01T05:59:59.999Z'
    staleObservation.baseline.observations[0]!.otelProvenance!.observedAt =
      staleObservation.baseline.observations[0]!.observedAt

    const estate = snapshot()
    const result = project(estate, staleObservation)

    expect(result.dataState).toEqual({ state: 'stale', reason: 'stale' })
    expect(result.windows.baseline.observations).toEqual([])
    expect(result.windows.baseline.otelQuality).toMatchObject({
      status: 'degraded',
      caveats: ['stale'],
    })
  })

  it('removes an unverified stale caveat when trusted timestamps are fresh', () => {
    const fresh = normalizedWindows()
    fresh.observed.otelQuality = {
      ...fresh.observed.otelQuality!,
      status: 'degraded',
      caveats: ['stale'],
    }

    const estate = snapshot()
    const result = project(estate, fresh)
    const observed = result.snapshot.evidence.find((item) => item.id === 'observed-evidence')

    expect(result.dataState).toEqual({ state: 'complete' })
    expect(observed).toMatchObject({
      freshness: 'live',
      confidence: 1,
      evidenceTypes: ['observed_runtime'],
      otel: {
        quality: {
          status: 'available',
          caveats: [],
        },
      },
    })
  })

  it.each([
    ['zero received records', { recordsReceived: 0, recordsAccepted: 0 }],
    ['zero accepted records', { recordsAccepted: 0 }],
    ['unexplained duplicate records', { recordsReceived: 61, duplicatesRemoved: 1 }],
    ['zero processed pages', { pagesProcessed: 0 }],
  ])('does not make stale degraded evidence available with %s', (_label, qualityOverride) => {
    const fresh = normalizedWindows()
    fresh.observed.otelQuality = {
      ...fresh.observed.otelQuality!,
      status: 'degraded',
      caveats: ['stale'],
      ...qualityOverride,
    }

    const estate = snapshot()
    const result = project(estate, fresh)
    const observed = result.snapshot.evidence.find((item) => item.id === 'observed-evidence')

    expect(result.dataState).toEqual({ state: 'partial', reason: 'degraded-quality' })
    expect(result.windows.observed.otelQuality).toMatchObject({
      status: 'degraded',
      caveats: ['invalid-record'],
    })
    expect(observed).toMatchObject({
      confidence: 0,
      evidenceTypes: ['unknown'],
      metadata: { evidenceStatus: 'degraded' },
    })
  })

  it('rejects runtime evidence outside the estate boundary', () => {
    const mismatched = windows()
    mismatched.observed.environment = 'staging'
    mismatched.baseline.environment = 'staging'
    const estate = snapshot()
    expect(() => project(estate, mismatched)).toThrow(
      'does not match the estate tenant and agent environment',
    )
  })

  it('rejects consistently wrong outer and nested estate identity', () => {
    const estate = snapshot()
    const mismatched = normalizedWindows()
    mismatched.provenance!.estateId = 'estate-b'
    for (const window of [mismatched.baseline, mismatched.observed]) {
      for (const observation of window.observations) {
        observation.otelProvenance!.estateId = 'estate-b'
      }
    }

    expect(() => projectRuntimeEvidence(estate, mismatched, projectionRequest(estate))).toThrow(
      'exact authoritative telemetry request',
    )
  })

  it('rejects a baseline-only observation agent mismatch', () => {
    const estate = snapshot()
    const mismatched = normalizedWindows()
    mismatched.baseline.observations[0]!.agentId = 'agent-b'

    expect(() => projectRuntimeEvidence(estate, mismatched, projectionRequest(estate))).toThrow(
      'selected authoritative agent',
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

    const estate = snapshot()
    const result = project(estate, empty)
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
    normalized.observed.observations[0]!.correlations = [
      { kind: 'agent-run-id', value: 'run-observed-real' },
      { kind: 'correlation-id', value: 'correlation-observed-real' },
      { kind: 'agent-version', value: '17' },
    ]
    normalized.observed.observations[0]!.toolCallNames = [
      'knowledge_search',
      'undeclared_tool',
      'knowledge_search',
    ]

    const estate = snapshot()
    const result = project(estate, normalized)
    expect(result.snapshot.evidence.find((item) => item.id === 'observed-evidence')?.otel).toEqual({
      quality: normalized.observed.otelQuality,
      invocations: [
        expect.objectContaining({
          id: 'observed-real',
          success: true,
          agentRunId: 'run-observed-real',
          correlationId: 'correlation-observed-real',
          agentVersion: '17',
          toolCallNames: ['knowledge_search', 'knowledge_search'],
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

  it('treats persisted runtime correlation and matched tool fields as immutable evidence', () => {
    const mutations: Array<(observation: RuntimeObservation) => void> = [
      (observation) => {
        observation.correlations![0]!.value = 'run-observed-real-other'
      },
      (observation) => {
        observation.correlations![1]!.value = 'correlation-observed-real-other'
      },
      (observation) => {
        observation.correlations![2]!.value = '18'
      },
      (observation) => {
        observation.toolCallNames.push('knowledge_search')
      },
    ]

    for (const mutate of mutations) {
      const normalized = normalizedWindows()
      normalized.observed.observations[0]!.correlations = [
        { kind: 'agent-run-id', value: 'run-observed-real' },
        { kind: 'correlation-id', value: 'correlation-observed-real' },
        { kind: 'agent-version', value: '17' },
      ]
      const estate = snapshot()
      const first = project(estate, normalized)
      const conflicting = structuredClone(normalized)
      mutate(conflicting.observed.observations[0]!)

      expect(() => project(first.snapshot, conflicting)).toThrow(
        'Runtime evidence ID collides with existing evidence: observed-evidence',
      )
    }
  })

  it('degrades telemetry bound to a different snapshot generation', () => {
    const normalized = normalizedWindows()
    normalized.provenance!.snapshotGeneratedAt = '2026-08-29T00:00:00.000Z'

    const estate = snapshot()
    const result = project(estate, normalized)

    expect(result.dataState).toEqual({
      state: 'partial',
      reason: 'degraded-quality',
    })
    expect(result.windows.observed.observations).toEqual([])
    expect(result.windows.observed.otelQuality?.caveats).toContain('invalid-record')
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
      const estate = snapshot()
      const result = project(estate, normalized)
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
      'sourceProjectId',
      'sourceEnvironment',
      'providerResourceId',
      'providerAgentId',
      'observedAt',
      'classification',
    ] as const) {
      const normalized = normalizedWindows()
      const provenance = normalized.observed.observations[0]!.otelProvenance!
      delete (provenance as Partial<typeof provenance>)[field]
      const estate = snapshot()
      const result = project(estate, normalized)
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

      const estate = snapshot()
      const result = project(estate, normalized)
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
      const estate = snapshot()
      const result = project(estate, normalized)
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
      const estate = snapshot()
      const result = project(estate, normalized)
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

    const estate = snapshot()
    const result = project(estate, normalized)
    const evidence = result.snapshot.evidence.find((item) => item.id === 'observed-evidence')

    expect(evidence).toMatchObject({
      confidence: 0,
      evidenceTypes: ['unknown'],
      metadata: { evidenceStatus: 'degraded' },
    })
    expect(evidence?.otel?.invocations).toEqual([])
  })

  it('rejects direct projection for a non-authoritative discovered agent', () => {
    const estate = snapshot()
    estate.evidence[0]!.metadata!.sourceOfTruth = 'false'

    expect(() =>
      projectRuntimeEvidence(estate, normalizedWindows(), trustedEstateContext(estate)),
    ).toThrow('authoritative discovered agent evidence')
  })
})
