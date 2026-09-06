import { createHash } from 'node:crypto'

import type {
  AnalysisStatus,
  BaselineWindow,
  DimensionDriftResult,
  DistributionStats,
  DriftAnalysisResult,
  DriftDimension,
  DriftSeverity,
  EvidenceCoverage,
  ObservationWindow,
  ToolSequenceChange,
} from '@agent-sentinel/domain'
import {
  computeDistributionStats,
  computeToolSequenceSummary,
  deduplicateObservations,
} from './stats.js'
import {
  MADS_THRESHOLDS,
  MAX_CLOCK_SKEW_MINUTES,
  MAX_DUPLICATE_RATIO,
  MIN_SAMPLES,
  PCT_THRESHOLDS,
  RATE_THRESHOLDS,
  STALE_WINDOW_HOURS,
} from './thresholds.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function severityFromMads(deviationMads: number): DriftSeverity | null {
  if (deviationMads >= MADS_THRESHOLDS.critical) return 'critical'
  if (deviationMads >= MADS_THRESHOLDS.high) return 'high'
  if (deviationMads >= MADS_THRESHOLDS.medium) return 'medium'
  if (deviationMads >= MADS_THRESHOLDS.low) return 'low'
  return null
}

function severityFromPct(observedMedian: number, baselineMedian: number): DriftSeverity | null {
  // When baseline median is zero, any change is capped at critical.
  if (baselineMedian === 0) return observedMedian === 0 ? null : 'critical'
  const pct = Math.abs(observedMedian - baselineMedian) / Math.abs(baselineMedian)
  if (pct >= PCT_THRESHOLDS.critical) return 'critical'
  if (pct >= PCT_THRESHOLDS.high) return 'high'
  if (pct >= PCT_THRESHOLDS.medium) return 'medium'
  if (pct >= PCT_THRESHOLDS.low) return 'low'
  return null
}

function severityFromRateDelta(absoluteDelta: number): DriftSeverity | null {
  if (absoluteDelta >= RATE_THRESHOLDS.critical) return 'critical'
  if (absoluteDelta >= RATE_THRESHOLDS.high) return 'high'
  if (absoluteDelta >= RATE_THRESHOLDS.medium) return 'medium'
  if (absoluteDelta >= RATE_THRESHOLDS.low) return 'low'
  return null
}

function severityFromToolChange(
  added: string[],
  removed: string[],
  baselineToolCount: number,
): DriftSeverity | null {
  if (added.length === 0 && removed.length === 0) return null
  const removedRatio = baselineToolCount > 0 ? removed.length / baselineToolCount : 0
  // At least 80% of baseline tools disappeared → critical.
  if (removedRatio >= 0.8) return 'critical'
  if (removedRatio >= 0.5) return 'high'
  // 3+ removed → high
  if (removed.length >= 3) return 'high'
  // Any removal or 3+ additions → medium
  if (removed.length >= 1 || added.length >= 3) return 'medium'
  // 1–2 additions, nothing removed → low
  return 'low'
}

function highestSeverity(dims: readonly DimensionDriftResult[]): DriftSeverity | undefined {
  const order: DriftSeverity[] = ['critical', 'high', 'medium', 'low']
  for (const level of order) {
    if (dims.some((d) => d.severity === level)) return level
  }
  return undefined
}

function isStale(windowEnd: string, nowMs: number): boolean {
  const endMs = new Date(windowEnd).getTime()
  if (Number.isNaN(endMs)) return true
  return nowMs - endMs > STALE_WINDOW_HOURS * 60 * 60 * 1000
}

// ---------------------------------------------------------------------------
// Metric-dimension analysis helpers
// ---------------------------------------------------------------------------

function analyseMetricDimension(
  dimension: DriftDimension,
  label: string,
  baseStats: DistributionStats,
  observedValues: readonly number[],
): DimensionDriftResult | null {
  const obsStats = computeDistributionStats(observedValues)
  if (obsStats === null) return null

  const deviation = Math.abs(obsStats.median - baseStats.median)

  let severity: DriftSeverity | null
  let deviationMads: number | undefined

  if (!baseStats.zeroVariance && baseStats.mad > 0) {
    // Guard: mad > 0 already checked above, no division-by-zero possible.
    const mads = deviation / baseStats.mad
    deviationMads = Math.round(mads * 100) / 100
    severity = severityFromMads(mads)
  } else {
    // Zero-variance baseline: fall back to percentage change.
    severity = severityFromPct(obsStats.median, baseStats.median)
  }

  const drifted = severity !== null

  const explanation = drifted
    ? `${label} drift detected. Baseline median: ${baseStats.median} (MAD: ${baseStats.mad}), ` +
      `observed median: ${obsStats.median}.` +
      (deviationMads !== undefined
        ? ` Deviation: ${deviationMads} MADs (threshold for ${severity ?? '?'}: ${
            severity === 'critical'
              ? MADS_THRESHOLDS.critical
              : severity === 'high'
                ? MADS_THRESHOLDS.high
                : severity === 'medium'
                  ? MADS_THRESHOLDS.medium
                  : MADS_THRESHOLDS.low
          } MADs).`
        : ` Zero-variance baseline; percentage thresholds applied.`)
    : `${label} within baseline range. Baseline median: ${baseStats.median} (MAD: ${baseStats.mad}), ` +
      `observed median: ${obsStats.median}.`

  return {
    dimension,
    drifted,
    ...(severity !== null ? { severity } : {}),
    baselineMedian: baseStats.median,
    observedMedian: obsStats.median,
    ...(deviationMads !== undefined ? { deviationMads } : {}),
    explanation,
  }
}

function analyseRateDimension(
  dimension: 'error-rate',
  label: string,
  baselineRate: number | undefined,
  observedRate: number | undefined,
): DimensionDriftResult | null {
  if (baselineRate === undefined || observedRate === undefined) return null

  const absoluteDelta = Math.abs(observedRate - baselineRate)
  const severity = severityFromRateDelta(absoluteDelta)
  const drifted = severity !== null

  const explanation = drifted
    ? `${label} drift detected. Baseline rate: ${(baselineRate * 100).toFixed(1)}%, ` +
      `observed rate: ${(observedRate * 100).toFixed(1)}%. ` +
      `Absolute delta: ${(absoluteDelta * 100).toFixed(1)}% ` +
      `(threshold for ${severity ?? '?'}: ${
        severity === 'critical'
          ? RATE_THRESHOLDS.critical * 100
          : severity === 'high'
            ? RATE_THRESHOLDS.high * 100
            : severity === 'medium'
              ? RATE_THRESHOLDS.medium * 100
              : RATE_THRESHOLDS.low * 100
      }%).`
    : `${label} within baseline range. Baseline: ${(baselineRate * 100).toFixed(1)}%, ` +
      `observed: ${(observedRate * 100).toFixed(1)}%.`

  return {
    dimension,
    drifted,
    ...(severity !== null ? { severity } : {}),
    baselineRate,
    observedRate,
    absoluteDelta,
    explanation,
  }
}

function analyseToolSequence(
  baselineSummary: ReturnType<typeof computeToolSequenceSummary>,
  observedSummary: ReturnType<typeof computeToolSequenceSummary>,
): DimensionDriftResult | null {
  if (baselineSummary.sampleCount === 0 && observedSummary.sampleCount === 0) return null

  const baselineSet = new Set(baselineSummary.uniqueTools)
  const observedSet = new Set(observedSummary.uniqueTools)
  const baselineSequences = new Set(baselineSummary.sequencePatterns)
  const observedSequences = new Set(observedSummary.sequencePatterns)

  const addedTools = [...observedSet].filter((t) => !baselineSet.has(t)).sort()
  const removedTools = [...baselineSet].filter((t) => !observedSet.has(t)).sort()
  const addedSequences = [...observedSequences]
    .filter((value) => !baselineSequences.has(value))
    .sort()
  const removedSequences = [...baselineSequences]
    .filter((value) => !observedSequences.has(value))
    .sort()

  const change: ToolSequenceChange = {
    addedTools,
    removedTools,
    baselineTools: [...baselineSummary.uniqueTools].sort(),
    observedTools: [...observedSummary.uniqueTools].sort(),
    addedSequences,
    removedSequences,
  }

  const setSeverity = severityFromToolChange(addedTools, removedTools, baselineSet.size)
  const severity =
    setSeverity ?? (addedSequences.length > 0 || removedSequences.length > 0 ? 'low' : null)
  const drifted = severity !== null

  const explanation = drifted
    ? `Tool sequence drift detected. ` +
      (addedTools.length > 0 ? `Added tools: ${addedTools.join(', ')}. ` : '') +
      (removedTools.length > 0 ? `Removed tools: ${removedTools.join(', ')}. ` : '') +
      (addedSequences.length > 0 || removedSequences.length > 0
        ? `Call order changed. Added sequences: ${addedSequences.join(', ') || '(none)'}. ` +
          `Removed sequences: ${removedSequences.join(', ') || '(none)'}. `
        : '') +
      `Baseline: ${change.baselineTools.join(', ') || '(none)'}. ` +
      `Observed: ${change.observedTools.join(', ') || '(none)'}.`
    : `Tool sequence matches baseline. Tools: ${change.baselineTools.join(', ') || '(none)'}.`

  return {
    dimension: 'tool-sequence',
    drifted,
    ...(severity !== null ? { severity } : {}),
    toolSequenceChange: change,
    explanation,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DriftAnalysisOptions {
  /** Override the minimum sample count. Defaults to MIN_SAMPLES. */
  minSamples?: number
  /** Original observation-window ID backing the computed baseline. */
  baselineWindowId?: string
  /** Evidence ID for the observed window. Required for immutable evidence reference. */
  observedEvidenceId: string
  /** Injectable clock for deterministic tests and fixed synthetic demonstrations. */
  clock?: () => Date
}

/**
 * Analyse drift between a baseline window and an observed window.
 *
 * Deterministic: same inputs always produce the same outputs.
 * Fail-closed: any data quality issue produces status != 'ready'.
 *
 * Cost stays unknown if the baseline has no costUsd stats — it is never
 * estimated or inferred from other metrics.
 */
export function analyzeDrift(
  baseline: BaselineWindow,
  observed: ObservationWindow,
  opts: DriftAnalysisOptions,
): DriftAnalysisResult {
  const minSamples = opts.minSamples ?? MIN_SAMPLES
  const now = opts.clock?.() ?? new Date()
  const computedAt = now.toISOString()
  const analysisHash = createHash('sha256')
    .update(`${baseline.baselineId}\0${observed.windowId}\0${opts.observedEvidenceId}`)
    .digest('hex')
    .slice(0, 16)
  const analysisId = `drift-${observed.agentId}-${analysisHash}`

  function unavailable(status: AnalysisStatus, reason: string): DriftAnalysisResult {
    return {
      analysisId,
      tenantId: observed.tenantId,
      agentId: observed.agentId,
      environment: observed.environment,
      source: observed.source,
      status,
      computedAt,
      dimensions: [],
      anyDrift: false,
      unavailableReason: reason,
    }
  }

  if (observed.otelQuality !== undefined && observed.otelQuality.status !== 'available') {
    return unavailable(
      observed.otelQuality.status === 'unknown' ? 'insufficient-data' : 'invalid',
      `OpenTelemetry evidence is ${observed.otelQuality.status}: ${observed.otelQuality.caveats.join(', ')}.`,
    )
  }

  // ── 1. Validate window boundaries ────────────────────────────────────────
  const baselineStartMs = new Date(baseline.windowStart).getTime()
  const baselineEndMs = new Date(baseline.windowEnd).getTime()
  const obsStartMs = new Date(observed.windowStart).getTime()
  const obsEndMs = new Date(observed.windowEnd).getTime()

  if (
    Number.isNaN(baselineStartMs) ||
    Number.isNaN(baselineEndMs) ||
    Number.isNaN(obsStartMs) ||
    Number.isNaN(obsEndMs)
  ) {
    return unavailable('invalid', 'One or more window timestamps are not valid ISO 8601 datetimes.')
  }
  if (baselineEndMs <= baselineStartMs) {
    return unavailable('invalid', 'Baseline window end must be after baseline window start.')
  }
  if (obsEndMs <= obsStartMs) {
    return unavailable('invalid', 'Observed window end must be after observed window start.')
  }
  if (obsStartMs < baselineEndMs) {
    return unavailable(
      'invalid',
      'Observed window must not overlap with or precede the baseline window.',
    )
  }
  if (obsEndMs > now.getTime() + MAX_CLOCK_SKEW_MINUTES * 60 * 1000) {
    return unavailable(
      'invalid',
      `Observed window end exceeds the analysis clock by more than ${MAX_CLOCK_SKEW_MINUTES} minutes.`,
    )
  }
  if (
    baseline.tenantId !== observed.tenantId ||
    baseline.agentId !== observed.agentId ||
    baseline.environment !== observed.environment ||
    baseline.source !== observed.source
  ) {
    return unavailable(
      'invalid',
      'Baseline and observed windows must have identical tenant, agent, environment, and source bindings.',
    )
  }
  const invalidObservation = observed.observations.find((observation) => {
    const observedAt = new Date(observation.observedAt).getTime()
    return (
      observation.tenantId !== observed.tenantId ||
      observation.agentId !== observed.agentId ||
      observation.environment !== observed.environment ||
      observation.source !== observed.source ||
      Number.isNaN(observedAt) ||
      observedAt < obsStartMs ||
      observedAt > obsEndMs
    )
  })
  if (invalidObservation !== undefined) {
    return unavailable(
      'invalid',
      `Observation ${invalidObservation.id} does not match the observed window binding or time range.`,
    )
  }

  // ── 2. Deduplicate and check for excessive duplicates ────────────────────
  const { deduplicated: dedupObs, duplicatesRemoved } = deduplicateObservations(
    observed.observations,
  )
  if (
    observed.observations.length > 0 &&
    duplicatesRemoved / observed.observations.length > MAX_DUPLICATE_RATIO
  ) {
    return unavailable(
      'invalid',
      `More than ${MAX_DUPLICATE_RATIO * 100}% of observations are duplicates. ` +
        'Check your telemetry pipeline for replay errors.',
    )
  }

  // ── 3. Check stale observed window ───────────────────────────────────────
  if (isStale(observed.windowEnd, now.getTime())) {
    return unavailable(
      'stale',
      `Observed window ended more than ${STALE_WINDOW_HOURS}h ago. ` +
        'Refresh the observed window before analysis.',
    )
  }

  // ── 4. Check minimum sample counts ───────────────────────────────────────
  if (baseline.sampleCount < minSamples) {
    return unavailable(
      'insufficient-data',
      `Baseline window has ${baseline.sampleCount} samples; ` +
        `minimum required is ${minSamples}.`,
    )
  }
  if (dedupObs.length < minSamples) {
    return unavailable(
      'insufficient-data',
      `Observed window has ${dedupObs.length} unique samples after deduplication; ` +
        `minimum required is ${minSamples}.`,
    )
  }

  // ── 5. Extract metric arrays ──────────────────────────────────────────────
  const extractLatency = (obs: typeof dedupObs) =>
    obs.flatMap((o) => (o.latencyMs !== undefined ? [o.latencyMs] : []))
  const extractInput = (obs: typeof dedupObs) =>
    obs.flatMap((o) => (o.inputTokens !== undefined ? [o.inputTokens] : []))
  const extractOutput = (obs: typeof dedupObs) =>
    obs.flatMap((o) => (o.outputTokens !== undefined ? [o.outputTokens] : []))
  const extractCost = (obs: typeof dedupObs) =>
    obs.flatMap((o) => (o.costUsd !== undefined ? [o.costUsd] : []))
  const extractTools = (obs: typeof dedupObs) => obs.map((o) => o.toolCallNames)

  // For baseline comparison we use the statistical summary already stored
  // (median + MAD) rather than re-inflating raw samples.
  const obsLatency = extractLatency(dedupObs)
  const obsInput = extractInput(dedupObs)
  const obsOutput = extractOutput(dedupObs)
  const obsCost = extractCost(dedupObs)

  // Success/error rates from raw observations
  const totalObs = dedupObs.length
  const successCount = dedupObs.filter((o) => o.success).length
  const errorCount = totalObs - successCount
  const obsErrorRate = totalObs > 0 ? errorCount / totalObs : undefined

  const obsToolSummary = computeToolSequenceSummary(extractTools(dedupObs))

  // ── 6. Compute dimension results ─────────────────────────────────────────
  const dimensions: DimensionDriftResult[] = []

  // Metrics: compare observed medians against immutable baseline summaries.
  if (
    baseline.latencyMs !== undefined &&
    baseline.latencyMs.sampleCount >= minSamples &&
    obsLatency.length >= minSamples
  ) {
    const result = analyseMetricDimension('latency', 'Latency (ms)', baseline.latencyMs, obsLatency)
    if (result !== null) dimensions.push(result)
  }

  // Input tokens
  if (
    baseline.inputTokens !== undefined &&
    baseline.inputTokens.sampleCount >= minSamples &&
    obsInput.length >= minSamples
  ) {
    const result = analyseMetricDimension(
      'input-tokens',
      'Input token count',
      baseline.inputTokens,
      obsInput,
    )
    if (result !== null) dimensions.push(result)
  }

  // Output tokens
  if (
    baseline.outputTokens !== undefined &&
    baseline.outputTokens.sampleCount >= minSamples &&
    obsOutput.length >= minSamples
  ) {
    const result = analyseMetricDimension(
      'output-tokens',
      'Output token count',
      baseline.outputTokens,
      obsOutput,
    )
    if (result !== null) dimensions.push(result)
  }

  if (
    baseline.costUsd !== undefined &&
    baseline.costUsd.sampleCount >= minSamples &&
    obsCost.length >= minSamples
  ) {
    const result = analyseMetricDimension('cost', 'Measured cost (USD)', baseline.costUsd, obsCost)
    if (result !== null) dimensions.push(result)
  }

  // Reliability is represented once as error-rate; success-rate is its exact complement.
  const errResult = analyseRateDimension(
    'error-rate',
    'Error rate',
    baseline.errorRate,
    obsErrorRate,
  )
  if (errResult !== null) dimensions.push(errResult)

  // Tool sequence
  if (baseline.toolSequence !== undefined) {
    const result = analyseToolSequence(baseline.toolSequence, obsToolSummary)
    if (result !== null) dimensions.push(result)
  }

  // ── 7. Coverage ───────────────────────────────────────────────────────────
  const allDimensions: DriftDimension[] = [
    'latency',
    'input-tokens',
    'output-tokens',
    'cost',
    'error-rate',
    'tool-sequence',
  ]
  const metricsWithData = dimensions.map((d) => d.dimension)
  const coverageScore = allDimensions.length > 0 ? metricsWithData.length / allDimensions.length : 0

  const coverage: EvidenceCoverage = {
    baselineSamples: baseline.sampleCount,
    observedSamples: dedupObs.length,
    coverageScore: Math.round(coverageScore * 100) / 100,
    metricsWithData,
  }

  const driftedDimensions = dimensions.filter((d) => d.drifted)
  const anyDrift = driftedDimensions.length > 0
  const topSeverity = highestSeverity(driftedDimensions)

  return {
    analysisId,
    tenantId: observed.tenantId,
    agentId: observed.agentId,
    environment: observed.environment,
    source: observed.source,
    status: 'ready',
    computedAt,
    baselineWindowId: opts.baselineWindowId ?? baseline.baselineId,
    observedWindowId: observed.windowId,
    baselineEvidenceId: baseline.evidenceId,
    observedEvidenceId: opts.observedEvidenceId,
    dimensions,
    coverage,
    anyDrift,
    ...(topSeverity !== undefined ? { highestSeverity: topSeverity } : {}),
  }
}

/**
 * Compute a BaselineWindow from an ObservationWindow.
 * Returns `null` with a reason string when data is insufficient or invalid.
 */
export function computeBaseline(
  window: ObservationWindow,
  evidenceId: string,
  opts: { minSamples?: number } = {},
): { baseline: BaselineWindow } | { error: AnalysisStatus; reason: string } {
  const minSamples = opts.minSamples ?? MIN_SAMPLES

  if (window.otelQuality !== undefined && window.otelQuality.status !== 'available') {
    return {
      error: window.otelQuality.status === 'unknown' ? 'insufficient-data' : 'invalid',
      reason: `OpenTelemetry evidence is ${window.otelQuality.status}: ${window.otelQuality.caveats.join(', ')}.`,
    }
  }

  const startMs = new Date(window.windowStart).getTime()
  const endMs = new Date(window.windowEnd).getTime()
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return { error: 'invalid', reason: 'Window end must be after window start.' }
  }
  const invalidObservation = window.observations.find((observation) => {
    const observedAt = new Date(observation.observedAt).getTime()
    return (
      observation.tenantId !== window.tenantId ||
      observation.agentId !== window.agentId ||
      observation.environment !== window.environment ||
      observation.source !== window.source ||
      Number.isNaN(observedAt) ||
      observedAt < startMs ||
      observedAt > endMs
    )
  })
  if (invalidObservation !== undefined) {
    return {
      error: 'invalid',
      reason: `Observation ${invalidObservation.id} does not match its window binding or time range.`,
    }
  }

  const { deduplicated, duplicatesRemoved } = deduplicateObservations(window.observations)
  if (
    window.observations.length > 0 &&
    duplicatesRemoved / window.observations.length > MAX_DUPLICATE_RATIO
  ) {
    return {
      error: 'invalid',
      reason: `More than ${MAX_DUPLICATE_RATIO * 100}% of observations are duplicates.`,
    }
  }

  if (deduplicated.length < minSamples) {
    return {
      error: 'insufficient-data',
      reason: `Window has ${deduplicated.length} unique samples; minimum required is ${minSamples}.`,
    }
  }

  const latencyValues = deduplicated.flatMap((o) =>
    o.latencyMs !== undefined ? [o.latencyMs] : [],
  )
  const inputValues = deduplicated.flatMap((o) =>
    o.inputTokens !== undefined ? [o.inputTokens] : [],
  )
  const outputValues = deduplicated.flatMap((o) =>
    o.outputTokens !== undefined ? [o.outputTokens] : [],
  )
  const totalTokenValues = deduplicated.flatMap((o) =>
    o.inputTokens !== undefined || o.outputTokens !== undefined
      ? [(o.inputTokens ?? 0) + (o.outputTokens ?? 0)]
      : [],
  )
  const costValues = deduplicated.flatMap((o) => (o.costUsd !== undefined ? [o.costUsd] : []))

  const totalObs = deduplicated.length
  const successCount = deduplicated.filter((o) => o.success).length

  const toolSummary = computeToolSequenceSummary(deduplicated.map((o) => o.toolCallNames))

  const latencyStats = computeDistributionStats(latencyValues)
  const inputStats = computeDistributionStats(inputValues)
  const outputStats = computeDistributionStats(outputValues)
  const totalTokenStats = computeDistributionStats(totalTokenValues)
  const costStats = computeDistributionStats(costValues)

  const baseline: BaselineWindow = {
    baselineId: `baseline-${window.windowId}`,
    tenantId: window.tenantId,
    agentId: window.agentId,
    environment: window.environment,
    source: window.source,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    sampleCount: deduplicated.length,
    ...(latencyStats !== null ? { latencyMs: latencyStats } : {}),
    ...(inputStats !== null ? { inputTokens: inputStats } : {}),
    ...(outputStats !== null ? { outputTokens: outputStats } : {}),
    ...(totalTokenStats !== null ? { totalTokens: totalTokenStats } : {}),
    ...(costStats !== null ? { costUsd: costStats } : {}),
    successRate: totalObs > 0 ? successCount / totalObs : undefined,
    errorRate: totalObs > 0 ? (totalObs - successCount) / totalObs : undefined,
    toolSequence: toolSummary,
    evidenceId,
    computedAt: new Date().toISOString(),
  }

  return { baseline }
}
