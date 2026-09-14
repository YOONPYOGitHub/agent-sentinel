import { describe, expect, it } from 'vitest'

import { observationWindowSchema, type ObservationWindow } from '@agent-sentinel/domain'

import { analyzeDrift, analyzeTokenEconomics, computeBaseline } from '../src/index.js'

function window(
  kind: 'baseline' | 'observed',
  quality: 'available' | 'unknown' | 'degraded',
): ObservationWindow {
  const startDay = kind === 'baseline' ? '04' : '05'
  const endDay = kind === 'baseline' ? '05' : '06'
  const observations =
    quality === 'unknown'
      ? []
      : Array.from({ length: 10 }, (_, index) => ({
          id: `${kind}-${index}`,
          tenantId: 'tenant-a',
          agentId: 'agent-a',
          environment: 'production',
          source: 'azure-monitor-otel' as const,
          observedAt: `2026-09-${startDay}T${String(index + 1).padStart(2, '0')}:00:00.000Z`,
          latencyMs: 100 + index,
          inputTokens: 20,
          outputTokens: 10,
          costUsd: 0.01,
          success: true,
          toolCallNames: [],
          synthetic: false,
          otelProvenance: {
            snapshotGeneratedAt: '2026-09-06T00:00:00.000Z',
            estateId: 'estate-a',
            estateTenantId: 'tenant-a',
            estateEnvironment: 'portfolio',
            sourceConnectorId: 'source-a',
            sourceTenantId: 'tenant-a',
            sourceProjectId: 'project-a',
            sourceEnvironment: 'production',
            provider: 'azure-monitor-otel' as const,
            providerResourceId:
              '/subscriptions/11111111-1111-4111-8111-111111111111/resourcegroups/rg-test/providers/microsoft.insights/components/app-test',
            providerAgentId: 'provider-agent-a',
            providerInvocationId: `${kind}-${index}`,
            sourceSetFingerprint: 'f'.repeat(64),
            measuredAt: '2026-09-06T01:00:00.000Z',
            traceId: (index + 1).toString(16).padStart(32, '0'),
            spanId: (index + 1).toString(16).padStart(16, '0'),
            observedAt: `2026-09-${startDay}T${String(index + 1).padStart(2, '0')}:00:00.000Z`,
            classification: 'live' as const,
            sampling:
              quality === 'degraded'
                ? ({ state: 'sampled', rate: 0.5 } as const)
                : ({ state: 'complete', rate: 1 } as const),
            aggregation: { kind: 'raw' as const },
            contract: {
              version: 1 as const,
              recordType: 'agent_invocation' as const,
              applicationRoleName: 'agent-runtime',
              requestName: 'agent.invoke' as const,
              outcome: 'success' as const,
            },
            partial: false,
            evidenceIds: [
              `${kind}-${index}-invocation`,
              `${kind}-${index}-latency`,
              `${kind}-${index}-error`,
              `${kind}-${index}-input`,
              `${kind}-${index}-output`,
              `${kind}-${index}-cost`,
            ],
          },
        }))
  return observationWindowSchema.parse({
    windowId: `${kind}-window`,
    tenantId: 'tenant-a',
    agentId: 'agent-a',
    environment: 'production',
    source: 'azure-monitor-otel',
    windowStart: `2026-09-${startDay}T00:00:00.000Z`,
    windowEnd: `2026-09-${endDay}T00:00:00.000Z`,
    observations,
    otelQuality: {
      status: quality,
      classification: quality === 'unknown' ? 'unknown' : 'live',
      caveats: quality === 'available' ? [] : quality === 'unknown' ? ['empty'] : ['sampled'],
      recordsReceived: quality === 'unknown' ? 0 : 60,
      recordsAccepted: quality === 'unknown' ? 0 : 60,
      duplicatesRemoved: 0,
      pagesProcessed: 1,
    },
  })
}

describe('OpenTelemetry quality analysis gates', () => {
  it('does not compute a baseline from sampled representative evidence', () => {
    const result = computeBaseline(window('baseline', 'degraded'), 'sampled-evidence')
    expect(result).toEqual({
      error: 'invalid',
      reason: 'OpenTelemetry evidence is degraded: sampled.',
    })
  })

  it('keeps degraded drift and token economics unavailable', () => {
    const baselineResult = computeBaseline(window('baseline', 'available'), 'baseline-evidence')
    if (!('baseline' in baselineResult)) throw new Error('Expected a complete baseline.')
    const observed = window('observed', 'degraded')

    const drift = analyzeDrift(baselineResult.baseline, observed, {
      observedEvidenceId: 'observed-evidence',
      clock: () => new Date('2026-09-06T01:00:00.000Z'),
    })
    const economics = analyzeTokenEconomics(observed, baselineResult.baseline, {
      observedEvidenceId: 'observed-evidence',
      clock: () => new Date('2026-09-06T01:00:00.000Z'),
    })

    expect(drift.status).toBe('invalid')
    expect(drift.anyDrift).toBe(false)
    expect(drift.dimensions).toEqual([])
    expect(economics.status).toBe('unavailable')
    expect(economics.measuredCostUsd).toBeUndefined()
    expect(economics.coverage).toBeUndefined()
  })

  it('does not upgrade connector-degraded quality without an explicit freshness recomputation', () => {
    const degraded = window('baseline', 'available')
    degraded.otelQuality = {
      ...degraded.otelQuality!,
      status: 'degraded',
      caveats: [],
    }

    expect(() => computeBaseline(degraded, 'degraded-evidence')).toThrow(
      'Unknown or degraded OpenTelemetry evidence must explain its caveats.',
    )
  })

  it('keeps empty representative evidence insufficient instead of ready', () => {
    const empty = window('observed', 'unknown')
    const baseline = computeBaseline(empty, 'empty-evidence')
    const economics = analyzeTokenEconomics(empty, undefined, {
      clock: () => new Date('2026-09-06T01:00:00.000Z'),
    })

    expect(baseline).toEqual({
      error: 'insufficient-data',
      reason: 'OpenTelemetry evidence is unknown: empty.',
    })
    expect(economics.status).toBe('insufficient-data')
  })

  it('blocks ready analysis when nested provenance contradicts available quality', () => {
    const cases: Array<{
      mutate: (observed: ObservationWindow) => void
      caveat: string
    }> = [
      {
        mutate: (observed) => {
          observed.observations[0]!.otelProvenance!.observedAt = '2026-09-03T23:59:59.000Z'
        },
        caveat: 'invalid-record',
      },
      {
        mutate: (observed) => {
          observed.observations[0]!.observedAt = '2026-09-06T00:00:01.000Z'
          observed.observations[0]!.otelProvenance!.observedAt = '2026-09-06T00:00:01.000Z'
        },
        caveat: 'invalid-record',
      },
      {
        mutate: (observed) => {
          observed.observations[0]!.otelProvenance!.sampling = {
            state: 'complete',
          }
        },
        caveat: 'sampling-unknown',
      },
      {
        mutate: (observed) => {
          observed.observations[0]!.otelProvenance!.aggregation = { kind: 'cumulative' }
        },
        caveat: 'aggregated-metric',
      },
      {
        mutate: (observed) => {
          observed.observations[0]!.otelProvenance!.partial = true
        },
        caveat: 'partial',
      },
      {
        mutate: (observed) => {
          observed.observations[0]!.otelProvenance!.classification = 'synthetic'
        },
        caveat: 'mixed-classification',
      },
    ]

    for (const { mutate, caveat } of cases) {
      const observed = window('observed', 'available')
      mutate(observed)

      const baseline = computeBaseline(observed, 'observed-evidence')
      const economics = analyzeTokenEconomics(observed, undefined, {
        clock: () => new Date('2026-09-06T01:00:00.000Z'),
      })

      expect(baseline).toMatchObject({ error: 'invalid' })
      expect('reason' in baseline ? baseline.reason : '').toContain(caveat)
      expect(economics.status).toBe('unavailable')
      expect(economics.unavailableReason).toBeDefined()
    }
  })

  it('blocks ready analysis when caller-supplied quality contradicts complete provenance', () => {
    const observed = window('observed', 'available')
    observed.otelQuality!.classification = 'synthetic'

    const baseline = computeBaseline(observed, 'observed-evidence')
    const economics = analyzeTokenEconomics(observed, undefined, {
      clock: () => new Date('2026-09-06T01:00:00.000Z'),
    })

    expect(baseline).toMatchObject({ error: 'invalid' })
    expect(economics.status).toBe('unavailable')
  })
})
