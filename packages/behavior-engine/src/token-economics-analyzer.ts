import { createHash } from 'node:crypto'

import type {
  BaselineWindow,
  DistributionStats,
  ObservationWindow,
  TokenEconomicsAnomaly,
  TokenEconomicsAnomalyDimension,
  TokenEconomicsCoverage,
  TokenEconomicsReport,
} from '@agent-sentinel/domain'
import { tokenEconomicsReportSchema } from '@agent-sentinel/domain'

import { computeDistributionStats, deduplicateObservations } from './stats.js'
import {
  MADS_THRESHOLDS,
  MAX_CLOCK_SKEW_MINUTES,
  MAX_DUPLICATE_RATIO,
  MIN_SAMPLES,
  PCT_THRESHOLDS,
  STALE_WINDOW_HOURS,
} from './thresholds.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TokenEconomicsAnalysisOptions {
  clock?: () => Date
  observedEvidenceId?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reportId(observed: ObservationWindow): string {
  return (
    'te-' +
    createHash('sha256')
      .update(
        `${observed.tenantId}\0${observed.agentId}\0${observed.environment}\0${observed.source}\0${observed.windowId}`,
      )
      .digest('hex')
      .slice(0, 16)
  )
}

function anomalyId(reportIdValue: string, dimension: TokenEconomicsAnomalyDimension): string {
  return (
    'te-anom-' +
    createHash('sha256').update(`${reportIdValue}\0${dimension}`).digest('hex').slice(0, 12)
  )
}

type DriftSeverity = 'low' | 'medium' | 'high' | 'critical'

function severityFromMads(deviationMads: number): DriftSeverity | null {
  if (deviationMads >= MADS_THRESHOLDS.critical) return 'critical'
  if (deviationMads >= MADS_THRESHOLDS.high) return 'high'
  if (deviationMads >= MADS_THRESHOLDS.medium) return 'medium'
  if (deviationMads >= MADS_THRESHOLDS.low) return 'low'
  return null
}

function severityFromPct(observedMedian: number, baselineMedian: number): DriftSeverity | null {
  if (baselineMedian === 0) return observedMedian === 0 ? null : 'critical'
  const pct = Math.abs(observedMedian - baselineMedian) / Math.abs(baselineMedian)
  if (pct >= PCT_THRESHOLDS.critical) return 'critical'
  if (pct >= PCT_THRESHOLDS.high) return 'high'
  if (pct >= PCT_THRESHOLDS.medium) return 'medium'
  if (pct >= PCT_THRESHOLDS.low) return 'low'
  return null
}

function detectAnomaly(
  reportIdValue: string,
  dimension: TokenEconomicsAnomalyDimension,
  label: string,
  baseStats: DistributionStats,
  observedStats: DistributionStats,
  evidenceIds: readonly string[],
): TokenEconomicsAnomaly | null {
  const baselineMedian = baseStats.median
  const observedMedian = observedStats.median

  let severity: DriftSeverity | null
  let deviationMads: number | undefined

  if (baseStats.zeroVariance) {
    severity = severityFromPct(observedMedian, baselineMedian)
  } else {
    deviationMads = Math.abs(observedMedian - baselineMedian) / baseStats.mad
    severity = severityFromMads(deviationMads)
  }

  if (severity === null) return null

  const direction = observedMedian > baselineMedian ? 'increase' : 'decrease'
  const explanation =
    `Observed median ${label} (${observedMedian.toFixed(2)}) ` +
    `${direction}d from baseline median (${baselineMedian.toFixed(2)}).` +
    (deviationMads !== undefined ? ` Deviation: ${deviationMads.toFixed(2)} MADs.` : '')

  return {
    anomalyId: anomalyId(reportIdValue, dimension),
    dimension,
    severity,
    baselineMedian,
    observedMedian,
    ...(deviationMads !== undefined ? { deviationMads } : {}),
    evidenceIds: [...evidenceIds],
    explanation,
  }
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic token economics report from one observation window.
 *
 * When a baseline is supplied, token and cost anomalies are detected using the
 * same MAD-based thresholds as the drift-analysis engine.
 *
 * Cost is strictly from measured RuntimeObservation.costUsd fields.
 * Partial cost coverage is explicit; missing cost is never estimated.
 * costPerSuccessUsd is absent when the measured-cost population contains zero
 * successes or no cost data.
 */
export function analyzeTokenEconomics(
  observed: ObservationWindow,
  baseline?: BaselineWindow,
  options: TokenEconomicsAnalysisOptions = {},
): TokenEconomicsReport {
  const clock = options.clock ?? (() => new Date())
  const nowMs = clock().getTime()
  const computedAt = new Date(nowMs).toISOString()

  const rid = reportId(observed)

  // Validate window bounds
  const windowEndMs = new Date(observed.windowEnd).getTime()
  const windowStartMs = new Date(observed.windowStart).getTime()
  if (Number.isNaN(windowEndMs) || Number.isNaN(windowStartMs) || windowEndMs <= windowStartMs) {
    return tokenEconomicsReportSchema.parse({
      reportId: rid,
      tenantId: observed.tenantId,
      agentId: observed.agentId,
      environment: observed.environment,
      source: observed.source,
      windowStart: observed.windowStart,
      windowEnd: observed.windowEnd,
      computedAt,
      status: 'unavailable',
      unavailableReason: 'Observation window timestamps are invalid or out of order.',
    })
  }

  const invalidObservation = observed.observations.find((observation) => {
    const observedAt = new Date(observation.observedAt).getTime()
    return (
      observation.tenantId !== observed.tenantId ||
      observation.agentId !== observed.agentId ||
      observation.environment !== observed.environment ||
      observation.source !== observed.source ||
      Number.isNaN(observedAt) ||
      observedAt < windowStartMs ||
      observedAt > windowEndMs
    )
  })
  if (invalidObservation !== undefined) {
    return tokenEconomicsReportSchema.parse({
      reportId: rid,
      tenantId: observed.tenantId,
      agentId: observed.agentId,
      environment: observed.environment,
      source: observed.source,
      windowStart: observed.windowStart,
      windowEnd: observed.windowEnd,
      computedAt,
      status: 'unavailable',
      unavailableReason: `Observation ${invalidObservation.id} does not match its window binding or time range.`,
    })
  }

  if (
    baseline !== undefined &&
    (baseline.tenantId !== observed.tenantId ||
      baseline.agentId !== observed.agentId ||
      baseline.environment !== observed.environment ||
      baseline.source !== observed.source ||
      new Date(baseline.windowEnd).getTime() > windowStartMs)
  ) {
    return tokenEconomicsReportSchema.parse({
      reportId: rid,
      tenantId: observed.tenantId,
      agentId: observed.agentId,
      environment: observed.environment,
      source: observed.source,
      windowStart: observed.windowStart,
      windowEnd: observed.windowEnd,
      computedAt,
      status: 'unavailable',
      unavailableReason:
        'Baseline and observed windows must have matching bindings and non-overlapping time ranges.',
    })
  }
  if (baseline !== undefined && options.observedEvidenceId === undefined) {
    return tokenEconomicsReportSchema.parse({
      reportId: rid,
      tenantId: observed.tenantId,
      agentId: observed.agentId,
      environment: observed.environment,
      source: observed.source,
      windowStart: observed.windowStart,
      windowEnd: observed.windowEnd,
      computedAt,
      status: 'unavailable',
      unavailableReason: 'Baseline comparison requires an immutable observed evidence reference.',
    })
  }

  // Reject future windows (clock skew guard)
  if (windowEndMs > nowMs + MAX_CLOCK_SKEW_MINUTES * 60 * 1000) {
    return tokenEconomicsReportSchema.parse({
      reportId: rid,
      tenantId: observed.tenantId,
      agentId: observed.agentId,
      environment: observed.environment,
      source: observed.source,
      windowStart: observed.windowStart,
      windowEnd: observed.windowEnd,
      computedAt,
      status: 'unavailable',
      unavailableReason: 'Observation window end is in the future beyond the clock-skew tolerance.',
    })
  }

  // Stale window guard
  if (nowMs - windowEndMs > STALE_WINDOW_HOURS * 60 * 60 * 1000) {
    return tokenEconomicsReportSchema.parse({
      reportId: rid,
      tenantId: observed.tenantId,
      agentId: observed.agentId,
      environment: observed.environment,
      source: observed.source,
      windowStart: observed.windowStart,
      windowEnd: observed.windowEnd,
      computedAt,
      status: 'unavailable',
      unavailableReason: `Observation window ended more than ${STALE_WINDOW_HOURS}h ago.`,
    })
  }

  // Deduplication
  const { deduplicated, duplicatesRemoved } = deduplicateObservations(observed.observations)

  // Duplicate ratio guard
  if (observed.observations.length > 0) {
    const dupeRatio = duplicatesRemoved / observed.observations.length
    if (dupeRatio > MAX_DUPLICATE_RATIO) {
      return tokenEconomicsReportSchema.parse({
        reportId: rid,
        tenantId: observed.tenantId,
        agentId: observed.agentId,
        environment: observed.environment,
        source: observed.source,
        windowStart: observed.windowStart,
        windowEnd: observed.windowEnd,
        computedAt,
        status: 'unavailable',
        unavailableReason: `Duplicate observation ratio (${dupeRatio.toFixed(2)}) exceeds the ${MAX_DUPLICATE_RATIO} threshold.`,
      })
    }
  }

  // Minimum samples guard
  if (deduplicated.length < MIN_SAMPLES) {
    return tokenEconomicsReportSchema.parse({
      reportId: rid,
      tenantId: observed.tenantId,
      agentId: observed.agentId,
      environment: observed.environment,
      source: observed.source,
      windowStart: observed.windowStart,
      windowEnd: observed.windowEnd,
      computedAt,
      status: 'insufficient-data',
      unavailableReason: `Only ${deduplicated.length} unique observations; minimum is ${MIN_SAMPLES}.`,
    })
  }

  // Compute token stats
  const inputValues = deduplicated.flatMap((o) =>
    o.inputTokens !== undefined ? [o.inputTokens] : [],
  )
  const outputValues = deduplicated.flatMap((o) =>
    o.outputTokens !== undefined ? [o.outputTokens] : [],
  )
  const totalValues = deduplicated.flatMap((o) =>
    o.inputTokens !== undefined || o.outputTokens !== undefined
      ? [(o.inputTokens ?? 0) + (o.outputTokens ?? 0)]
      : [],
  )
  const costMeasuredObservations = deduplicated.filter((o) => o.costUsd !== undefined)
  const costValues = costMeasuredObservations.map((o) => o.costUsd!)
  const successCount = deduplicated.filter((o) => o.success).length
  const measuredSuccessCount = costMeasuredObservations.filter((o) => o.success).length
  const costMeasuredCount = costValues.length
  const costCoverage = deduplicated.length > 0 ? costMeasuredCount / deduplicated.length : 0

  const coverage: TokenEconomicsCoverage = {
    totalObservations: observed.observations.length,
    deduplicatedObservations: deduplicated.length,
    duplicatesRemoved,
    successCount,
    measuredSuccessCount,
    inputTokenMeasuredCount: inputValues.length,
    outputTokenMeasuredCount: outputValues.length,
    totalTokenMeasuredCount: totalValues.length,
    costMeasuredCount,
    costCoverage,
  }

  const inputStats = computeDistributionStats(inputValues)
  const outputStats = computeDistributionStats(outputValues)
  const totalStats = computeDistributionStats(totalValues)
  const costStats = computeDistributionStats(costValues)

  const totalInputTokens = inputValues.reduce((sum, v) => sum + v, 0)
  const totalOutputTokens = outputValues.reduce((sum, v) => sum + v, 0)
  const totalTokens = totalInputTokens + totalOutputTokens
  const measuredCostUsd = costValues.length > 0 ? costValues.reduce((s, v) => s + v, 0) : undefined
  const medianCostUsd = costStats?.median

  // Same-population denominator: measured cost / successful cost-measured calls.
  let costPerSuccessUsd: number | undefined
  if (measuredCostUsd !== undefined && measuredSuccessCount > 0) {
    costPerSuccessUsd = measuredCostUsd / measuredSuccessCount
  }

  // Anomaly detection (only when baseline is supplied)
  const anomalies: TokenEconomicsAnomaly[] = []
  const evidenceIds = [
    ...(baseline?.evidenceId ? [baseline.evidenceId] : []),
    ...(options.observedEvidenceId ? [options.observedEvidenceId] : []),
  ]
  if (baseline !== undefined) {
    if (
      baseline.inputTokens !== undefined &&
      baseline.inputTokens.sampleCount >= MIN_SAMPLES &&
      inputStats !== null &&
      inputStats.sampleCount >= MIN_SAMPLES
    ) {
      const a = detectAnomaly(
        rid,
        'input-tokens',
        'input tokens',
        baseline.inputTokens,
        inputStats,
        evidenceIds,
      )
      if (a !== null) anomalies.push(a)
    }
    if (
      baseline.outputTokens !== undefined &&
      baseline.outputTokens.sampleCount >= MIN_SAMPLES &&
      outputStats !== null &&
      outputStats.sampleCount >= MIN_SAMPLES
    ) {
      const a = detectAnomaly(
        rid,
        'output-tokens',
        'output tokens',
        baseline.outputTokens,
        outputStats,
        evidenceIds,
      )
      if (a !== null) anomalies.push(a)
    }
    if (
      baseline.totalTokens !== undefined &&
      baseline.totalTokens.sampleCount >= MIN_SAMPLES &&
      totalStats !== null &&
      totalStats.sampleCount >= MIN_SAMPLES
    ) {
      const a = detectAnomaly(
        rid,
        'total-tokens',
        'total tokens',
        baseline.totalTokens,
        totalStats,
        evidenceIds,
      )
      if (a !== null) anomalies.push(a)
    }
    if (
      baseline.costUsd !== undefined &&
      baseline.costUsd.sampleCount >= MIN_SAMPLES &&
      costStats !== null &&
      costStats.sampleCount >= MIN_SAMPLES
    ) {
      const a = detectAnomaly(
        rid,
        'cost',
        'cost (USD, measured)',
        baseline.costUsd,
        costStats,
        evidenceIds,
      )
      if (a !== null) anomalies.push(a)
    }
  }

  return tokenEconomicsReportSchema.parse({
    reportId: rid,
    tenantId: observed.tenantId,
    agentId: observed.agentId,
    environment: observed.environment,
    source: observed.source,
    windowStart: observed.windowStart,
    windowEnd: observed.windowEnd,
    computedAt,
    status: 'ready',
    coverage,
    ...(baseline?.evidenceId ? { baselineEvidenceId: baseline.evidenceId } : {}),
    ...(options.observedEvidenceId ? { observedEvidenceId: options.observedEvidenceId } : {}),
    ...(inputStats !== null ? { totalInputTokens, medianInputTokens: inputStats.median } : {}),
    ...(outputStats !== null ? { totalOutputTokens, medianOutputTokens: outputStats.median } : {}),
    ...(totalStats !== null ? { totalTokens, medianTotalTokens: totalStats.median } : {}),
    ...(measuredCostUsd !== undefined ? { measuredCostUsd } : {}),
    ...(medianCostUsd !== undefined ? { medianCostUsd } : {}),
    ...(costPerSuccessUsd !== undefined ? { costPerSuccessUsd } : {}),
    anomalies,
  })
}
