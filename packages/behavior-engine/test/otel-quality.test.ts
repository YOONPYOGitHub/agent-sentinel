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
      caveats:
        quality === 'available' ? [] : quality === 'unknown' ? ['empty'] : ['sampled'],
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
})
