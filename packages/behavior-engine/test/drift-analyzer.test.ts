import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { analyzeDrift, computeBaseline } from '../src/drift-analyzer.js'
import type { BaselineWindow, ObservationWindow, RuntimeObservation } from '@agent-sentinel/domain'
import { MIN_SAMPLES } from '../src/thresholds.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TENANT = 'test-tenant'
const AGENT = 'test-agent'
const ENV = 'test'
const SOURCE = 'mock-synthetic' as const
const ANALYSIS_NOW = new Date('2026-08-23T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(ANALYSIS_NOW)
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
    synthetic: true,
    observedAt: '2026-08-10T10:00:00.000Z',
    latencyMs: 1000,
    inputTokens: 400,
    outputTokens: 300,
    success: true,
    toolCallNames: ['tool_a', 'tool_b'],
    ...overrides,
  }
}

function makeWindow(
  windowId: string,
  observations: RuntimeObservation[],
  overrides: Partial<ObservationWindow> = {},
): ObservationWindow {
  return {
    windowId,
    tenantId: TENANT,
    agentId: AGENT,
    environment: ENV,
    source: SOURCE,
    windowStart: '2026-08-01T00:00:00.000Z',
    windowEnd: '2026-08-20T23:59:59.000Z', // recent enough to not be stale
    observations,
    ...overrides,
  }
}

// Generate N healthy observations around latencyMs with same tools
function healthyObs(n: number, latencyMs = 1000): RuntimeObservation[] {
  return Array.from({ length: n }, (_, i) =>
    makeObs(`obs-${i}`, {
      latencyMs: latencyMs + (i % 5) * 20 - 40, // small spread
      observedAt: `2026-08-${String(10 + (i % 10)).padStart(2, '0')}T10:00:00.000Z`,
    }),
  )
}

function makeBaseline(
  observations: RuntimeObservation[],
  overrides: Partial<BaselineWindow> = {},
): BaselineWindow {
  const baselineObservations = observations.map((observation, index) => ({
    ...observation,
    observedAt: `2026-07-${String(1 + (index % 28)).padStart(2, '0')}T10:00:00.000Z`,
  }))
  const result = computeBaseline(
    makeWindow('baseline-win', baselineObservations, {
      windowStart: '2026-07-01T00:00:00.000Z',
      windowEnd: '2026-07-31T23:59:59.000Z',
    }),
    'ev-baseline',
  )
  if ('error' in result) throw new Error(result.reason)
  return { ...result.baseline, ...overrides }
}

// ---------------------------------------------------------------------------
// computeBaseline tests
// ---------------------------------------------------------------------------

describe('computeBaseline', () => {
  it('returns insufficient-data when window has fewer than MIN_SAMPLES observations', () => {
    const window = makeWindow(
      'w1',
      Array.from({ length: MIN_SAMPLES - 1 }, (_, i) => makeObs(`o${i}`)),
    )
    const result = computeBaseline(window, 'ev-1')
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toBe('insufficient-data')
      expect(result.reason).toMatch(/minimum required/)
    }
  })

  it('returns invalid when window end is before window start', () => {
    const window = makeWindow('w-invalid', healthyObs(MIN_SAMPLES), {
      windowStart: '2026-08-20T00:00:00.000Z',
      windowEnd: '2026-08-01T00:00:00.000Z', // end before start
    })
    const result = computeBaseline(window, 'ev-1')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toBe('invalid')
  })

  it('returns invalid when duplicate ratio exceeds threshold', () => {
    const obs = makeObs('dup-id')
    const window = makeWindow('w-dup', [
      obs,
      obs,
      obs,
      obs,
      obs,
      obs, // 6 duplicates
      makeObs('unique-1'),
      makeObs('unique-2'), // 2 unique
    ])
    const result = computeBaseline(window, 'ev-1')
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toBe('invalid')
  })

  it('produces a valid baseline from sufficient observations', () => {
    const observations = healthyObs(MIN_SAMPLES + 5)
    const window = makeWindow('w-ok', observations)
    const result = computeBaseline(window, 'ev-ok')
    expect('baseline' in result).toBe(true)
    if ('baseline' in result) {
      expect(result.baseline.sampleCount).toBe(observations.length)
      expect(result.baseline.latencyMs).toBeDefined()
      expect(result.baseline.successRate).toBe(1)
      expect(result.baseline.errorRate).toBe(0)
      expect(result.baseline.evidenceId).toBe('ev-ok')
    }
  })

  it('excludes cost when no observation has costUsd', () => {
    const window = makeWindow('w-no-cost', healthyObs(MIN_SAMPLES))
    const result = computeBaseline(window, 'ev-1')
    expect('baseline' in result).toBe(true)
    if ('baseline' in result) {
      expect(result.baseline.costUsd).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// analyzeDrift tests
// ---------------------------------------------------------------------------

describe('analyzeDrift', () => {
  it('returns ready status with no drift for identical distributions', () => {
    const observations = healthyObs(MIN_SAMPLES + 5)
    const baseline = makeBaseline(observations)
    const observed = makeWindow('obs-win', healthyObs(MIN_SAMPLES + 5))
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.status).toBe('ready')
    expect(result.anyDrift).toBe(false)
    expect(result.highestSeverity).toBeUndefined()
  })

  it('detects medium latency drift using MAD threshold', () => {
    // Baseline: stable ~1000ms, MAD ~20ms
    // Observed: elevated ~1100ms → deviation > 3.5 MADs
    const baselineObs = Array.from(
      { length: 15 },
      (_, i) => makeObs(`b${i}`, { latencyMs: 1000 + (i % 3) * 10 - 10 }), // tight distribution
    )
    const obsObs = Array.from(
      { length: 15 },
      (_, i) => makeObs(`o${i}`, { latencyMs: 2000 + (i % 3) * 10 - 10 }), // elevated by ~1000ms
    )
    const baseline = makeBaseline(baselineObs)
    // Baseline latencyMs.mad should be ~10ms; deviation = 1000ms >> 3.5 MADs
    const observed = makeWindow('obs-high-lat', obsObs)
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.status).toBe('ready')
    const latDim = result.dimensions.find((d) => d.dimension === 'latency')
    expect(latDim?.drifted).toBe(true)
    expect(['medium', 'high', 'critical']).toContain(latDim?.severity)
  })

  it('detects high error rate drift', () => {
    // Baseline: 0% errors (all success)
    // Observed: 40% errors
    const baselineObs = Array.from({ length: 15 }, (_, i) => makeObs(`b${i}`, { success: true }))
    const obsObs = Array.from(
      { length: 15 },
      (_, i) => makeObs(`o${i}`, { success: i < 9 }), // 9 success, 6 error → 40% error rate
    )
    const baseline = makeBaseline(baselineObs)
    const observed = makeWindow('obs-errors', obsObs)
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.status).toBe('ready')
    const errDim = result.dimensions.find((d) => d.dimension === 'error-rate')
    expect(errDim?.drifted).toBe(true)
    expect(['medium', 'high', 'critical']).toContain(errDim?.severity)
    expect(result.anyDrift).toBe(true)
  })

  it('detects tool sequence drift for new tools', () => {
    const baselineObs = Array.from({ length: 15 }, (_, i) =>
      makeObs(`b${i}`, { toolCallNames: ['tool_a', 'tool_b'] }),
    )
    const obsObs = Array.from(
      { length: 15 },
      (_, i) => makeObs(`o${i}`, { toolCallNames: ['tool_a', 'tool_b', 'tool_c'] }), // new tool
    )
    const baseline = makeBaseline(baselineObs)
    const observed = makeWindow('obs-tools', obsObs)
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.status).toBe('ready')
    const toolDim = result.dimensions.find((d) => d.dimension === 'tool-sequence')
    expect(toolDim?.drifted).toBe(true)
    expect(toolDim?.toolSequenceChange?.addedTools).toContain('tool_c')
    expect(toolDim?.toolSequenceChange?.removedTools).toHaveLength(0)
  })

  it('detects a pure tool-order change without set changes', () => {
    const baseline = makeBaseline(
      Array.from({ length: 15 }, (_, i) =>
        makeObs(`b${i}`, { toolCallNames: ['tool_a', 'tool_b'] }),
      ),
    )
    const observed = makeWindow(
      'obs-order',
      Array.from({ length: 15 }, (_, i) =>
        makeObs(`o${i}`, { toolCallNames: ['tool_b', 'tool_a'] }),
      ),
    )
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    const toolDim = result.dimensions.find((dimension) => dimension.dimension === 'tool-sequence')
    expect(toolDim).toMatchObject({ drifted: true, severity: 'low' })
    expect(toolDim?.toolSequenceChange?.addedTools).toEqual([])
    expect(toolDim?.toolSequenceChange?.removedTools).toEqual([])
    expect(toolDim?.toolSequenceChange?.addedSequences).toContain('tool_b → tool_a')
  })

  it('does not classify a partial equal-count tool swap above its removed-tool ratio', () => {
    const baseline = makeBaseline(
      Array.from({ length: 15 }, (_, i) =>
        makeObs(`b${i}`, { toolCallNames: ['a', 'b', 'c', 'd', 'e'] }),
      ),
    )
    const observed = makeWindow(
      'obs-swap',
      Array.from({ length: 15 }, (_, i) =>
        makeObs(`o${i}`, { toolCallNames: ['a', 'b', 'f', 'g', 'h'] }),
      ),
    )
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    const toolDim = result.dimensions.find((dimension) => dimension.dimension === 'tool-sequence')
    expect(toolDim?.severity).toBe('high')
  })

  it('detects high severity when tools are removed', () => {
    const baselineObs = Array.from({ length: 15 }, (_, i) =>
      makeObs(`b${i}`, { toolCallNames: ['tool_a', 'tool_b', 'tool_c'] }),
    )
    const obsObs = Array.from(
      { length: 15 },
      (_, i) => makeObs(`o${i}`, { toolCallNames: ['tool_a'] }), // 2 tools removed
    )
    const baseline = makeBaseline(baselineObs)
    const observed = makeWindow('obs-rm-tools', obsObs)
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    const toolDim = result.dimensions.find((d) => d.dimension === 'tool-sequence')
    expect(toolDim?.drifted).toBe(true)
    expect(['medium', 'high', 'critical']).toContain(toolDim?.severity)
    expect(toolDim?.toolSequenceChange?.removedTools.length).toBeGreaterThan(0)
  })

  it('returns insufficient-data when observed window has too few samples', () => {
    const baselineObs = healthyObs(MIN_SAMPLES + 5)
    const baseline = makeBaseline(baselineObs)
    const observed = makeWindow(
      'obs-sparse',
      Array.from({ length: MIN_SAMPLES - 1 }, (_, i) => makeObs(`o${i}`)),
    )
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.status).toBe('insufficient-data')
    expect(result.anyDrift).toBe(false)
    expect(result.unavailableReason).toMatch(/minimum required/)
  })

  it('returns stale when observed window end is more than STALE_WINDOW_HOURS ago', () => {
    const baselineObs = healthyObs(MIN_SAMPLES + 5)
    const baseline = makeBaseline(baselineObs)
    const staleDate = new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString()
    const staleStart = new Date(Date.now() - 210 * 60 * 60 * 1000).toISOString()
    const staleObservations = Array.from({ length: MIN_SAMPLES + 5 }, (_, i) =>
      makeObs(`o${i}`, {
        observedAt: new Date(new Date(staleStart).getTime() + i * 60_000).toISOString(),
      }),
    )
    const observed = makeWindow('obs-stale', staleObservations, {
      windowStart: staleStart,
      windowEnd: staleDate,
    })
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.status).toBe('stale')
    expect(result.anyDrift).toBe(false)
  })

  it('returns invalid for corrupted window boundaries', () => {
    const baselineObs = healthyObs(MIN_SAMPLES + 5)
    const baseline = makeBaseline(baselineObs)
    const observed = makeWindow('obs-invalid', healthyObs(MIN_SAMPLES + 5), {
      windowStart: '2026-08-20T00:00:00.000Z',
      windowEnd: '2026-08-01T00:00:00.000Z', // end before start
    })
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.status).toBe('invalid')
  })

  it('returns invalid when the observed window overlaps the baseline', () => {
    const baseline = makeBaseline(healthyObs(MIN_SAMPLES + 5))
    const observed = makeWindow('obs-overlap', healthyObs(MIN_SAMPLES + 5), {
      windowStart: '2026-07-31T12:00:00.000Z',
    })
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result).toMatchObject({ status: 'invalid', anyDrift: false })
    expect(result.unavailableReason).toMatch(/overlap/i)
  })

  it('returns invalid when tenant, agent, environment, or source bindings differ', () => {
    const baseline = makeBaseline(healthyObs(MIN_SAMPLES + 5))
    const observed = makeWindow('obs-binding', healthyObs(MIN_SAMPLES + 5), {
      tenantId: 'other-tenant',
    })
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.status).toBe('invalid')
    expect(result.unavailableReason).toMatch(/binding/i)
  })

  it('returns invalid when an observation falls outside its window', () => {
    const baseline = makeBaseline(healthyObs(MIN_SAMPLES + 5))
    const observations = healthyObs(MIN_SAMPLES + 5)
    observations[0] = { ...observations[0]!, observedAt: '2026-07-01T00:00:00.000Z' }
    const observed = makeWindow('obs-outside', observations)
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.status).toBe('invalid')
    expect(result.unavailableReason).toMatch(/time range/i)
  })

  it('returns invalid when the observed window exceeds clock-skew tolerance', () => {
    const baseline = makeBaseline(healthyObs(MIN_SAMPLES + 5))
    const futureStart = new Date(ANALYSIS_NOW.getTime() + 6 * 60_000).toISOString()
    const futureEnd = new Date(ANALYSIS_NOW.getTime() + 16 * 60_000).toISOString()
    const observations = healthyObs(MIN_SAMPLES + 5).map((observation, index) => ({
      ...observation,
      observedAt: new Date(new Date(futureStart).getTime() + index * 1_000).toISOString(),
    }))
    const observed = makeWindow('obs-future', observations, {
      windowStart: futureStart,
      windowEnd: futureEnd,
    })
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.status).toBe('invalid')
    expect(result.unavailableReason).toMatch(/analysis clock/i)
  })

  it('returns invalid when duplicate ratio exceeds threshold', () => {
    const baselineObs = healthyObs(MIN_SAMPLES + 5)
    const baseline = makeBaseline(baselineObs)
    const dupObs = makeObs('dup')
    const observed = makeWindow('obs-dup', [
      dupObs,
      dupObs,
      dupObs,
      dupObs,
      dupObs,
      dupObs, // 6 same IDs
      makeObs('u1'),
      makeObs('u2'),
      makeObs('u3'), // 3 unique
    ])
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.status).toBe('invalid')
  })

  it('does not estimate cost when cost is absent', () => {
    const observations = healthyObs(MIN_SAMPLES + 5) // no costUsd
    const baseline = makeBaseline(observations)
    const observed = makeWindow('obs-no-cost', healthyObs(MIN_SAMPLES + 5))
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.status).toBe('ready')
    expect(result.dimensions.some((dimension) => dimension.dimension === 'cost')).toBe(false)
    expect(baseline.costUsd).toBeUndefined()
  })

  it('analyzes measured cost without estimating missing values', () => {
    const baseline = makeBaseline(
      healthyObs(15).map((observation, index) => ({
        ...observation,
        costUsd: 0.1 + (index % 3) * 0.01,
      })),
    )
    const observed = makeWindow(
      'obs-cost',
      healthyObs(15).map((observation, index) => ({
        ...observation,
        costUsd: 0.3 + (index % 3) * 0.01,
      })),
    )
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.dimensions.find((dimension) => dimension.dimension === 'cost')).toMatchObject({
      drifted: true,
    })
  })

  it('uses stored token MAD rather than a reconstructed zero-variance baseline', () => {
    const baseline = makeBaseline(healthyObs(15), {
      inputTokens: {
        median: 390,
        mad: 20,
        min: 350,
        max: 450,
        sampleCount: 15,
        zeroVariance: false,
      },
    })
    const observed = makeWindow(
      'obs-input-mad',
      healthyObs(15).map((observation) => ({ ...observation, inputTokens: 430 })),
    )
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(
      result.dimensions.find((dimension) => dimension.dimension === 'input-tokens'),
    ).toMatchObject({ drifted: true, severity: 'low', deviationMads: 2 })
  })

  it('omits a metric dimension when its baseline sample count is insufficient', () => {
    const baseline = makeBaseline(healthyObs(15), {
      inputTokens: {
        median: 390,
        mad: 20,
        min: 350,
        max: 450,
        sampleCount: MIN_SAMPLES - 1,
        zeroVariance: false,
      },
    })
    const observed = makeWindow(
      'obs-partial-input',
      healthyObs(15).map((observation) => ({ ...observation, inputTokens: 800 })),
    )
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.dimensions.some((dimension) => dimension.dimension === 'input-tokens')).toBe(
      false,
    )
  })

  it('produces a valid evidence coverage report', () => {
    const observations = healthyObs(MIN_SAMPLES + 5)
    const baseline = makeBaseline(observations)
    const observed = makeWindow('obs-cov', healthyObs(MIN_SAMPLES + 5))
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.coverage).toBeDefined()
    expect(result.coverage!.coverageScore).toBeGreaterThan(0)
    expect(result.coverage!.coverageScore).toBeLessThanOrEqual(1)
    expect(result.coverage!.baselineSamples).toBeGreaterThanOrEqual(MIN_SAMPLES)
    expect(result.coverage!.observedSamples).toBeGreaterThanOrEqual(MIN_SAMPLES)
  })

  it('is deterministic — same inputs always produce same drift outputs', () => {
    const obs1 = healthyObs(15)
    const obs2 = Array.from({ length: 15 }, (_, i) => makeObs(`o${i}`, { latencyMs: 2000 }))
    const baseline = makeBaseline(obs1)
    const observed = makeWindow('obs-det', obs2)
    const r1 = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    const r2 = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    // computedAt will differ by a few ms; ignore it for comparison
    expect({ ...r1, computedAt: 'x', analysisId: 'x' }).toEqual({
      ...r2,
      computedAt: 'x',
      analysisId: 'x',
    })
  })

  it('sets baselineWindowId, observedWindowId, and evidenceIds when status is ready', () => {
    const baseline = makeBaseline(healthyObs(MIN_SAMPLES + 5))
    const observed = makeWindow('obs-w-ids', healthyObs(MIN_SAMPLES + 5))
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-observed-ref' })
    expect(result.status).toBe('ready')
    expect(result.baselineWindowId).toBe(baseline.baselineId)
    expect(result.observedWindowId).toBe('obs-w-ids')
    expect(result.baselineEvidenceId).toBe(baseline.evidenceId)
    expect(result.observedEvidenceId).toBe('ev-observed-ref')
  })

  it('preserves the original baseline observation-window id when supplied', () => {
    const baseline = makeBaseline(healthyObs(MIN_SAMPLES + 5))
    const observed = makeWindow('obs-w-source-id', healthyObs(MIN_SAMPLES + 5))
    const result = analyzeDrift(baseline, observed, {
      baselineWindowId: 'baseline-observation-window',
      observedEvidenceId: 'ev-observed-source-id',
    })

    expect(result.status).toBe('ready')
    expect(result.baselineWindowId).toBe('baseline-observation-window')
  })

  it('zero-variance baseline does not cause division-by-zero', () => {
    // All observations have exactly the same latency → MAD = 0
    const stableObs = Array.from({ length: 15 }, (_, i) => makeObs(`b${i}`, { latencyMs: 1000 }))
    const elevatedObs = Array.from(
      { length: 15 },
      (_, i) => makeObs(`o${i}`, { latencyMs: 1800 }), // 80% above baseline
    )
    const baseline = makeBaseline(stableObs)
    expect(baseline.latencyMs?.zeroVariance).toBe(true)
    const observed = makeWindow('obs-zero-var', elevatedObs)
    // Should not throw, should use percentage fallback
    expect(() => analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })).not.toThrow()
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.status).toBe('ready')
    const latDim = result.dimensions.find((d) => d.dimension === 'latency')
    expect(latDim?.drifted).toBe(true)
  })

  it('never sets unavailableReason alongside synthetic data', () => {
    const baseline = makeBaseline(healthyObs(MIN_SAMPLES + 5))
    const observed = makeWindow('obs-syn', healthyObs(MIN_SAMPLES + 5))
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    expect(result.status).toBe('ready')
    expect(result.unavailableReason).toBeUndefined()
  })

  it('respects minSamples override option', () => {
    const baseline = makeBaseline(healthyObs(12), { sampleCount: 12 })
    const tinyObs = Array.from({ length: 5 }, (_, i) => makeObs(`o${i}`))
    const observed = makeWindow('obs-tiny', tinyObs)
    // With default MIN_SAMPLES=10, should be insufficient
    const result = analyzeDrift(baseline, observed, {
      observedEvidenceId: 'ev-obs',
    })
    expect(result.status).toBe('insufficient-data')
    // With custom minSamples=3, should be ready
    const resultLow = analyzeDrift(baseline, observed, {
      observedEvidenceId: 'ev-obs',
      minSamples: 3,
    })
    expect(resultLow.status).toBe('ready')
  })

  it('all dimension results have non-empty explanations', () => {
    const obs1 = healthyObs(15)
    const obs2 = Array.from({ length: 15 }, (_, i) => makeObs(`o${i}`, { success: i < 10 }))
    const baseline = makeBaseline(obs1)
    const observed = makeWindow('obs-exp', obs2)
    const result = analyzeDrift(baseline, observed, { observedEvidenceId: 'ev-obs' })
    for (const dim of result.dimensions) {
      expect(dim.explanation.length).toBeGreaterThan(0)
    }
  })
})
