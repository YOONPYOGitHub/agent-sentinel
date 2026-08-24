import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  tokenEconomicsReportSchema,
  type BaselineWindow,
  type ObservationWindow,
  type RuntimeObservation,
} from '@agent-sentinel/domain'
import { analyzeTokenEconomics } from '../src/token-economics-analyzer.js'
import { MIN_SAMPLES } from '../src/thresholds.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT = 'test-tenant'
const AGENT = 'test-agent'
const ENV = 'test'
const SOURCE = 'mock-synthetic' as const
const NOW = new Date('2026-08-23T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

function makeObs(id: string, overrides: Partial<RuntimeObservation> = {}): RuntimeObservation {
  return {
    id,
    tenantId: TENANT,
    agentId: AGENT,
    environment: ENV,
    source: SOURCE,
    observedAt: '2026-08-10T10:00:00.000Z',
    latencyMs: 800,
    inputTokens: 300,
    outputTokens: 200,
    success: true,
    toolCallNames: [],
    ...overrides,
  }
}

function makeWindow(
  obs: RuntimeObservation[],
  overrides: Partial<ObservationWindow> = {},
): ObservationWindow {
  return {
    windowId: 'win-1',
    tenantId: TENANT,
    agentId: AGENT,
    environment: ENV,
    source: SOURCE,
    windowStart: '2026-08-01T00:00:00.000Z',
    windowEnd: '2026-08-20T23:59:59.000Z',
    observations: obs,
    ...overrides,
  }
}

function enoughObs(n: number, overrides: Partial<RuntimeObservation> = {}): RuntimeObservation[] {
  return Array.from({ length: n }, (_, i) =>
    makeObs(`obs-${i}`, {
      observedAt: `2026-08-${String(1 + (i % 20)).padStart(2, '0')}T10:00:00.000Z`,
      ...overrides,
    }),
  )
}

function makeBaseline(overrides: Partial<BaselineWindow> = {}): BaselineWindow {
  return {
    baselineId: 'baseline-1',
    tenantId: TENANT,
    agentId: AGENT,
    environment: ENV,
    source: SOURCE,
    windowStart: '2026-07-01T00:00:00.000Z',
    windowEnd: '2026-07-31T23:59:59.000Z',
    sampleCount: 20,
    inputTokens: { median: 300, mad: 20, min: 280, max: 320, sampleCount: 20, zeroVariance: false },
    outputTokens: {
      median: 200,
      mad: 15,
      min: 185,
      max: 215,
      sampleCount: 20,
      zeroVariance: false,
    },
    totalTokens: {
      median: 500,
      mad: 25,
      min: 465,
      max: 535,
      sampleCount: 20,
      zeroVariance: false,
    },
    evidenceId: 'ev-baseline',
    computedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('analyzeTokenEconomics', () => {
  it('returns insufficient-data when fewer than MIN_SAMPLES observations', () => {
    const window = makeWindow(enoughObs(MIN_SAMPLES - 1))
    const result = analyzeTokenEconomics(window)
    expect(result.status).toBe('insufficient-data')
    expect(result.unavailableReason).toContain(String(MIN_SAMPLES - 1))
    expect(result.coverage).toBeUndefined()
    expect(result.totalInputTokens).toBeUndefined()
  })

  it('returns ready status and correct token totals for healthy window', () => {
    const obs = enoughObs(MIN_SAMPLES, { inputTokens: 300, outputTokens: 200 })
    const result = analyzeTokenEconomics(makeWindow(obs))
    expect(result.status).toBe('ready')
    expect(result.totalInputTokens).toBe(300 * MIN_SAMPLES)
    expect(result.totalOutputTokens).toBe(200 * MIN_SAMPLES)
    expect(result.totalTokens).toBe(500 * MIN_SAMPLES)
    expect(result.medianInputTokens).toBe(300)
    expect(result.medianOutputTokens).toBe(200)
    expect(result.coverage?.deduplicatedObservations).toBe(MIN_SAMPLES)
  })

  it('deduplicates observations and reports duplicatesRemoved', () => {
    const unique = enoughObs(MIN_SAMPLES)
    const dupe = unique[0]
    const obs = [...unique, dupe!] // one duplicate
    const result = analyzeTokenEconomics(makeWindow(obs))
    expect(result.status).toBe('ready')
    expect(result.coverage?.duplicatesRemoved).toBe(1)
    expect(result.coverage?.deduplicatedObservations).toBe(MIN_SAMPLES)
  })

  it('returns unavailable when duplicate ratio exceeds threshold', () => {
    // All observations have the same id -> all duplicates
    const obs: RuntimeObservation[] = Array.from({ length: 20 }, () => makeObs('same-id'))
    const result = analyzeTokenEconomics(makeWindow(obs))
    expect(result.status).toBe('unavailable')
    expect(result.unavailableReason).toMatch(/duplicate/i)
  })

  it('returns unavailable for stale window', () => {
    const staleObservations = enoughObs(MIN_SAMPLES).map((observation, index) => ({
      ...observation,
      observedAt: `2024-12-${String(1 + index).padStart(2, '0')}T10:00:00.000Z`,
    }))
    const window = makeWindow(staleObservations, {
      windowStart: '2024-12-01T00:00:00.000Z',
      windowEnd: '2025-01-01T00:00:00.000Z',
    })
    const result = analyzeTokenEconomics(window)
    expect(result.status).toBe('unavailable')
    expect(result.unavailableReason).toMatch(/stale|ago/i)
  })

  it('rejects observation binding and time-range mismatches', () => {
    const wrongTenant = enoughObs(MIN_SAMPLES)
    wrongTenant[0] = { ...wrongTenant[0]!, tenantId: 'other-tenant' }
    expect(analyzeTokenEconomics(makeWindow(wrongTenant)).unavailableReason).toMatch(
      /binding|time range/i,
    )

    const outsideWindow = enoughObs(MIN_SAMPLES)
    outsideWindow[0] = {
      ...outsideWindow[0]!,
      observedAt: '2026-07-01T00:00:00.000Z',
    }
    expect(analyzeTokenEconomics(makeWindow(outsideWindow)).unavailableReason).toMatch(
      /binding|time range/i,
    )
  })

  it('rejects mismatched or overlapping baselines', () => {
    const observed = makeWindow(enoughObs(MIN_SAMPLES))
    expect(
      analyzeTokenEconomics(observed, makeBaseline({ tenantId: 'other-tenant' })).unavailableReason,
    ).toMatch(/matching bindings/i)
    expect(
      analyzeTokenEconomics(observed, makeBaseline({ windowEnd: '2026-08-02T00:00:00.000Z' }))
        .unavailableReason,
    ).toMatch(/non-overlapping/i)
  })

  it('omits measuredCostUsd and costPerSuccessUsd when no costUsd present', () => {
    const obs = enoughObs(MIN_SAMPLES)
    const result = analyzeTokenEconomics(makeWindow(obs))
    expect(result.measuredCostUsd).toBeUndefined()
    expect(result.medianCostUsd).toBeUndefined()
    expect(result.costPerSuccessUsd).toBeUndefined()
    expect(result.coverage?.costMeasuredCount).toBe(0)
    expect(result.coverage?.costCoverage).toBe(0)
  })

  it('computes measuredCostUsd only from cost-carrying observations (partial coverage)', () => {
    const obs = enoughObs(MIN_SAMPLES)
    // Add cost to half the observations
    const half = Math.floor(MIN_SAMPLES / 2)
    for (let i = 0; i < half; i++) {
      obs[i] = { ...obs[i]!, costUsd: 0.02 }
    }
    const result = analyzeTokenEconomics(makeWindow(obs))
    expect(result.status).toBe('ready')
    expect(result.measuredCostUsd).toBeCloseTo(0.02 * half, 6)
    expect(result.coverage?.costMeasuredCount).toBe(half)
    expect(result.coverage?.costCoverage).toBeCloseTo(half / MIN_SAMPLES, 6)
    // Must NOT extrapolate - totalOutputTokens uses all obs, measuredCost uses only covered
    expect(result.totalInputTokens).toBe(300 * MIN_SAMPLES)
  })

  it('sets costPerSuccessUsd from the measured-cost population', () => {
    const obs = enoughObs(MIN_SAMPLES, { costUsd: 0.04, success: true })
    const result = analyzeTokenEconomics(makeWindow(obs))
    expect(result.costPerSuccessUsd).toBeCloseTo((0.04 * MIN_SAMPLES) / MIN_SAMPLES, 6)
  })

  it('uses only cost-measured successes in the cost-per-success denominator', () => {
    const obs = enoughObs(MIN_SAMPLES)
    for (let index = 0; index < 4; index += 1) {
      obs[index] = { ...obs[index]!, costUsd: 0.25, success: index >= 2 }
    }
    const result = analyzeTokenEconomics(makeWindow(obs))
    expect(result.measuredCostUsd).toBe(1)
    expect(result.coverage?.successCount).toBe(MIN_SAMPLES - 2)
    expect(result.coverage?.measuredSuccessCount).toBe(2)
    expect(result.costPerSuccessUsd).toBe(0.5)
  })

  it('keeps totalTokens equal to input plus output totals with partial dimensions', () => {
    const obs = enoughObs(MIN_SAMPLES)
    obs[0] = { ...obs[0]!, outputTokens: undefined }
    obs[1] = { ...obs[1]!, inputTokens: undefined }
    const result = analyzeTokenEconomics(makeWindow(obs))
    expect(result.totalTokens).toBe(
      (result.totalInputTokens ?? 0) + (result.totalOutputTokens ?? 0),
    )
    expect(result.coverage).toMatchObject({
      inputTokenMeasuredCount: MIN_SAMPLES - 1,
      outputTokenMeasuredCount: MIN_SAMPLES - 1,
      totalTokenMeasuredCount: MIN_SAMPLES,
    })
    expect(
      tokenEconomicsReportSchema.safeParse({
        ...result,
        totalTokens: (result.totalTokens ?? 0) + 1,
      }).success,
    ).toBe(false)
  })

  it('omits costPerSuccessUsd when zero successes', () => {
    const obs = enoughObs(MIN_SAMPLES, { costUsd: 0.04, success: false })
    const result = analyzeTokenEconomics(makeWindow(obs))
    expect(result.costPerSuccessUsd).toBeUndefined()
    expect(result.coverage?.successCount).toBe(0)
  })

  it('detects input-token anomaly against baseline', () => {
    // Observed median is 600 vs baseline median 300 with MAD 20 -> large deviation
    const obs = enoughObs(MIN_SAMPLES, { inputTokens: 600, outputTokens: 200 })
    const baseline = makeBaseline()
    const result = analyzeTokenEconomics(makeWindow(obs), baseline, {
      observedEvidenceId: 'ev-observed',
    })

    expect(result.anomalies?.some((a) => a.dimension === 'input-tokens')).toBe(true)
    const anomaly = result.anomalies?.find((a) => a.dimension === 'input-tokens')
    expect(anomaly?.severity).toMatch(/medium|high|critical/)
    expect(anomaly?.baselineMedian).toBe(300)
    expect(anomaly?.observedMedian).toBe(600)
    expect(anomaly?.deviationMads).toBeGreaterThan(0)
    expect(anomaly?.evidenceIds).toEqual(['ev-baseline', 'ev-observed'])
  })

  it('requires an immutable observed evidence reference for baseline comparisons', () => {
    const result = analyzeTokenEconomics(
      makeWindow(enoughObs(MIN_SAMPLES, { inputTokens: 600 })),
      makeBaseline(),
    )
    expect(result.status).toBe('unavailable')
    expect(result.unavailableReason).toMatch(/observed evidence reference/i)
    expect(result.anomalies).toBeUndefined()
  })

  it('uses the measured baseline total-token distribution for total-token anomalies', () => {
    const result = analyzeTokenEconomics(
      makeWindow(enoughObs(MIN_SAMPLES, { inputTokens: 500, outputTokens: 300 })),
      makeBaseline(),
      { observedEvidenceId: 'ev-observed' },
    )
    const anomaly = result.anomalies?.find((item) => item.dimension === 'total-tokens')
    expect(anomaly).toMatchObject({
      baselineMedian: 500,
      observedMedian: 800,
      evidenceIds: ['ev-baseline', 'ev-observed'],
    })
  })

  it('detects cost anomaly against baseline with cost stats', () => {
    const obs = enoughObs(MIN_SAMPLES, { costUsd: 0.5 }) // much higher than baseline
    const baseline = makeBaseline({
      costUsd: {
        median: 0.02,
        mad: 0.002,
        min: 0.018,
        max: 0.022,
        sampleCount: 20,
        zeroVariance: false,
      },
    })
    const result = analyzeTokenEconomics(makeWindow(obs), baseline, {
      observedEvidenceId: 'ev-observed',
    })
    const anomaly = result.anomalies?.find((a) => a.dimension === 'cost')
    expect(anomaly).toBeDefined()
    expect(anomaly?.severity).toMatch(/high|critical/)
  })

  it('handles zero-variance baseline with PCT thresholds', () => {
    const obs = enoughObs(MIN_SAMPLES, { inputTokens: 450 }) // 50% above baseline
    const baseline = makeBaseline({
      inputTokens: { median: 300, mad: 0, min: 300, max: 300, sampleCount: 20, zeroVariance: true },
    })
    const result = analyzeTokenEconomics(makeWindow(obs), baseline, {
      observedEvidenceId: 'ev-observed',
    })
    const anomaly = result.anomalies?.find((a) => a.dimension === 'input-tokens')
    expect(anomaly).toBeDefined()
    expect(anomaly?.deviationMads).toBeUndefined() // zero variance -> no deviationMads
  })

  it('produces no anomalies when no baseline supplied', () => {
    const obs = enoughObs(MIN_SAMPLES)
    const result = analyzeTokenEconomics(makeWindow(obs))
    expect(result.anomalies).toEqual([])
  })

  it('produces deterministic reportId for same agentId+windowId', () => {
    const obs = enoughObs(MIN_SAMPLES)
    const r1 = analyzeTokenEconomics(makeWindow(obs))
    const r2 = analyzeTokenEconomics(makeWindow(obs))
    expect(r1.reportId).toBe(r2.reportId)
  })

  it('produces deterministic anomaly ids', () => {
    const obs = enoughObs(MIN_SAMPLES, { inputTokens: 600 })
    const baseline = makeBaseline()
    const r1 = analyzeTokenEconomics(makeWindow(obs), baseline, {
      observedEvidenceId: 'ev-observed',
    })
    const r2 = analyzeTokenEconomics(makeWindow(obs), baseline, {
      observedEvidenceId: 'ev-observed',
    })
    const id1 = r1.anomalies?.find((a) => a.dimension === 'input-tokens')?.anomalyId
    const id2 = r2.anomalies?.find((a) => a.dimension === 'input-tokens')?.anomalyId
    expect(id1).toBeDefined()
    expect(id1).toBe(id2)
  })
})
