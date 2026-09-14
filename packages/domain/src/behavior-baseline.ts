import { z } from 'zod'

import { agentCorrelationsSchema } from './correlation.js'
import { azureApplicationInsightsResourceIdSchema } from './provider-resource.js'
import {
  MAX_RUNTIME_OTEL_OBSERVATIONS,
  MAX_RUNTIME_OTEL_QUALITY_RECORDS,
  OTEL_CLAIMS_PER_OBSERVATION,
  otelWindowQualitySchema,
  runtimeOtelProvenanceSchema,
  type OtelEvidenceCaveat,
  type OtelWindowQuality,
} from './otel-evidence.js'

// ---------------------------------------------------------------------------
// Identity & Source
// ---------------------------------------------------------------------------

/**
 * Originating data source for runtime observations.
 * `mock-synthetic` must never appear in live Foundry-mode responses.
 */
export const observationSourceSchema = z.enum(['azure-monitor-otel', 'mock-synthetic'])
export type ObservationSource = z.infer<typeof observationSourceSchema>

// ---------------------------------------------------------------------------
// Runtime Observations
// ---------------------------------------------------------------------------

/**
 * A single bounded runtime observation for one agent invocation.
 * `costUsd` MUST be omitted when not measured; it is never estimated.
 * `toolCallNames` is bounded to 50 to prevent unbounded payloads.
 */
export const runtimeObservationSchema = z.object({
  id: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200),
  agentId: z.string().min(1).max(200),
  environment: z.string().min(1).max(200),
  source: observationSourceSchema,
  observedAt: z.iso.datetime(),
  /** Agent-to-response wall-clock time in milliseconds. Bounded to 5 minutes. */
  latencyMs: z.number().int().min(0).max(300_000).optional(),
  inputTokens: z.number().int().min(0).max(1_000_000).optional(),
  outputTokens: z.number().int().min(0).max(1_000_000).optional(),
  /** Cost in USD. Never estimated — absent when the connector does not supply it. */
  costUsd: z.number().min(0).max(10_000).optional(),
  success: z.boolean(),
  errorCode: z.string().max(100).optional(),
  toolCallNames: z.array(z.string().min(1).max(200)).max(50).default([]),
  synthetic: z.boolean().default(false),
  correlations: agentCorrelationsSchema.optional(),
  otelProvenance: runtimeOtelProvenanceSchema.optional(),
})
export type RuntimeObservation = z.infer<typeof runtimeObservationSchema>

// ---------------------------------------------------------------------------
// Observation Window
// ---------------------------------------------------------------------------

/**
 * A bounded window of runtime observations for one agent in one environment.
 * Maximum 10,000 observations per window to prevent unbounded computation.
 */
export const observationWindowSchema = z.object({
  windowId: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200),
  agentId: z.string().min(1).max(200),
  environment: z.string().min(1).max(200),
  source: observationSourceSchema,
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  observations: z.array(runtimeObservationSchema).max(MAX_RUNTIME_OTEL_OBSERVATIONS),
  otelQuality: otelWindowQualitySchema.optional(),
})
export type ObservationWindow = z.infer<typeof observationWindowSchema>

export interface RuntimeOtelQualityAssessment {
  quality: OtelWindowQuality | undefined
  validObservationIds: string[]
}

export interface RuntimeOtelFreshnessContext {
  queriedAt: string
  maximumFreshnessHours: number
}

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

export function assessRuntimeOtelQuality(
  window: ObservationWindow,
  freshness?: RuntimeOtelFreshnessContext,
): RuntimeOtelQualityAssessment {
  if (window.source !== 'azure-monitor-otel') {
    return { quality: window.otelQuality, validObservationIds: [] }
  }

  const supplied = window.otelQuality
  const caveats = new Set<OtelEvidenceCaveat>(
    supplied?.caveats.filter((caveat) => freshness === undefined || caveat !== 'stale') ?? [],
  )
  const validObservationIds: string[] = []
  const classifications = new Set<'live' | 'synthetic'>()
  const windowStartMs = Date.parse(window.windowStart)
  const windowEndMs = Date.parse(window.windowEnd)
  const queriedAtMs = freshness === undefined ? Number.NaN : Date.parse(freshness.queriedAt)
  const maximumFreshnessMs =
    freshness === undefined ||
    !Number.isInteger(freshness.maximumFreshnessHours) ||
    freshness.maximumFreshnessHours < 1 ||
    freshness.maximumFreshnessHours > 24 * 31
      ? Number.NaN
      : freshness.maximumFreshnessHours * 60 * 60 * 1000
  const freshnessProvided = freshness !== undefined
  const trustedFreshness =
    freshnessProvided &&
    Number.isFinite(queriedAtMs) &&
    Number.isFinite(maximumFreshnessMs) &&
    Number.isFinite(windowStartMs) &&
    Number.isFinite(windowEndMs) &&
    windowEndMs > windowStartMs &&
    windowEndMs <= queriedAtMs
  if (freshnessProvided) {
    if (!trustedFreshness) caveats.add('invalid-record')
    else if (queriedAtMs - windowEndMs > maximumFreshnessMs) caveats.add('stale')
  }

  for (const observation of window.observations) {
    const parsed = runtimeOtelProvenanceSchema.safeParse(observation.otelProvenance)
    if (!parsed.success) {
      caveats.add('invalid-record')
      continue
    }

    const provenance = parsed.data
    let valid = true
    const invalidate = (caveat: OtelEvidenceCaveat): void => {
      caveats.add(caveat)
      valid = false
    }
    if (provenance.sampling.state === 'sampled') invalidate('sampled')
    else if (provenance.sampling.state !== 'complete' || provenance.sampling.rate !== 1) {
      invalidate('sampling-unknown')
    }
    if (provenance.aggregation.kind !== 'raw') invalidate('aggregated-metric')
    if (provenance.partial) invalidate('partial')
    if (
      !azureApplicationInsightsResourceIdSchema.safeParse(provenance.providerResourceId).success ||
      provenance.contract === undefined ||
      provenance.contract.version !== 1 ||
      provenance.contract.recordType !== 'agent_invocation' ||
      provenance.contract.requestName !== 'agent.invoke' ||
      provenance.contract.outcome !== (observation.success ? 'success' : 'error') ||
      provenance.providerInvocationId !== observation.id ||
      /^0+$/.test(provenance.traceId) ||
      /^0+$/.test(provenance.spanId)
    ) {
      invalidate('invalid-record')
    }

    const observedAtMs = Date.parse(observation.observedAt)
    if (
      provenance.observedAt !== observation.observedAt ||
      !Number.isFinite(observedAtMs) ||
      observedAtMs < windowStartMs ||
      observedAtMs >= windowEndMs
    ) {
      invalidate('invalid-record')
    }
    if (freshnessProvided) {
      if (!trustedFreshness) {
        invalidate('invalid-record')
      } else if (provenance.measuredAt !== freshness.queriedAt) {
        invalidate('invalid-record')
      } else if (observedAtMs > queriedAtMs) {
        invalidate('future-timestamp')
      } else if (windowEndMs - observedAtMs > maximumFreshnessMs) {
        invalidate('stale')
      }
    }
    const expectedClassification = observation.synthetic ? 'synthetic' : 'live'
    if (provenance.classification !== expectedClassification) {
      invalidate('mixed-classification')
    } else {
      classifications.add(provenance.classification)
    }
    if (
      provenance.evidenceIds.length !== 6 ||
      new Set(provenance.evidenceIds).size !== provenance.evidenceIds.length
    ) {
      invalidate('partial')
    }
    if (valid) {
      validObservationIds.push(observation.id)
    }
  }

  let classification: OtelWindowQuality['classification'] = 'unknown'
  if (classifications.size > 1) {
    classification = 'mixed'
    caveats.add('mixed-classification')
  } else if (classifications.has('synthetic')) {
    classification = 'synthetic'
  } else if (classifications.has('live')) {
    classification = 'live'
  }

  if (window.observations.length === 0) caveats.add('empty')
  if (supplied === undefined && window.observations.length > 0) caveats.add('invalid-record')
  if (
    supplied !== undefined &&
    classification !== 'unknown' &&
    supplied.classification !== classification
  ) {
    caveats.add('mixed-classification')
  }
  const wouldOtherwiseBecomeAvailable =
    supplied !== undefined &&
    (freshnessProvided || supplied.status === 'available') &&
    caveats.size === 0 &&
    validObservationIds.length === window.observations.length &&
    window.observations.length > 0
  if (wouldOtherwiseBecomeAvailable) {
    const expectedRecordCount = window.observations.length * 6
    if (
      supplied.recordsReceived !== expectedRecordCount ||
      supplied.recordsAccepted !== expectedRecordCount ||
      supplied.duplicatesRemoved !== 0 ||
      supplied.pagesProcessed < 1
    ) {
      caveats.add('invalid-record')
    }
  }

  const sortedCaveats = [...caveats].sort(compareCodeUnits)
  const suppliedStatusAllowsAvailability = freshnessProvided
    ? supplied !== undefined
    : supplied?.status === 'available'
  const status: OtelWindowQuality['status'] =
    suppliedStatusAllowsAvailability &&
    sortedCaveats.length === 0 &&
    validObservationIds.length === window.observations.length &&
    window.observations.length > 0
      ? 'available'
      : window.observations.length === 0 &&
          (supplied === undefined || supplied.status === 'unknown') &&
          sortedCaveats.length === 1 &&
          sortedCaveats[0] === 'empty'
        ? 'unknown'
        : 'degraded'

  return {
    quality: otelWindowQualitySchema.parse({
      status,
      classification,
      caveats: sortedCaveats,
      recordsReceived:
        supplied?.recordsReceived ??
        Math.min(
          window.observations.length * OTEL_CLAIMS_PER_OBSERVATION,
          MAX_RUNTIME_OTEL_QUALITY_RECORDS,
        ),
      recordsAccepted:
        supplied?.recordsAccepted ??
        Math.min(
          status === 'unknown' ? 0 : validObservationIds.length * OTEL_CLAIMS_PER_OBSERVATION,
          MAX_RUNTIME_OTEL_QUALITY_RECORDS,
        ),
      duplicatesRemoved: supplied?.duplicatesRemoved ?? 0,
      pagesProcessed: supplied?.pagesProcessed ?? 0,
    }),
    validObservationIds,
  }
}

// ---------------------------------------------------------------------------
// Analysis Status
// ---------------------------------------------------------------------------

/**
 * Status of a drift analysis pass.
 * - `ready`             — sufficient data; findings may be present.
 * - `insufficient-data` — fewer than MIN_SAMPLES in baseline or observed.
 * - `stale`             — observed window end exceeds the staleness threshold.
 * - `invalid`           — corrupt windows, absent connector, or unanalysable data.
 */
export const analysisStatusSchema = z.enum(['ready', 'insufficient-data', 'stale', 'invalid'])
export type AnalysisStatus = z.infer<typeof analysisStatusSchema>

// ---------------------------------------------------------------------------
// Distribution Statistics
// ---------------------------------------------------------------------------

/**
 * Robust distribution statistics using median + MAD.
 * MAD = Median Absolute Deviation; resists outlier influence.
 */
export const distributionStatsSchema = z.object({
  median: z.number(),
  mad: z.number().min(0),
  min: z.number(),
  max: z.number(),
  sampleCount: z.number().int().min(1),
  /** True when all values are identical (MAD = 0). Callers must not divide by MAD. */
  zeroVariance: z.boolean(),
})
export type DistributionStats = z.infer<typeof distributionStatsSchema>

/** Tool-call pattern summary for a single window. */
export const toolSequenceSummarySchema = z.object({
  /** Alphabetically sorted unique tool names for deterministic comparison. */
  uniqueTools: z.array(z.string()).max(100),
  /** Alphabetically sorted unique per-invocation call sequences. */
  sequencePatterns: z.array(z.string()).max(100),
  callCount: z.number().int().min(0),
  sampleCount: z.number().int().min(0),
})
export type ToolSequenceSummary = z.infer<typeof toolSequenceSummarySchema>

// ---------------------------------------------------------------------------
// Baseline Window (immutable reference period)
// ---------------------------------------------------------------------------

/**
 * Established reference baseline for one agent and environment.
 * Immutable once computed. `evidenceId` links to the backing evidence record.
 * `costUsd` is absent when no cost data was available. Never estimated.
 */
export const baselineWindowSchema = z.object({
  baselineId: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200),
  agentId: z.string().min(1).max(200),
  environment: z.string().min(1).max(200),
  source: observationSourceSchema,
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  sampleCount: z.number().int().min(0),
  latencyMs: distributionStatsSchema.optional(),
  inputTokens: distributionStatsSchema.optional(),
  outputTokens: distributionStatsSchema.optional(),
  totalTokens: distributionStatsSchema.optional(),
  costUsd: distributionStatsSchema.optional(),
  successRate: z.number().min(0).max(1).optional(),
  errorRate: z.number().min(0).max(1).optional(),
  toolSequence: toolSequenceSummarySchema.optional(),
  evidenceId: z.string().min(1).max(200),
  computedAt: z.iso.datetime(),
})
export type BaselineWindow = z.infer<typeof baselineWindowSchema>

// ---------------------------------------------------------------------------
// Drift Finding Types
// ---------------------------------------------------------------------------

export const driftDimensionSchema = z.enum([
  'latency',
  'input-tokens',
  'output-tokens',
  'cost',
  'error-rate',
  'tool-sequence',
])
export type DriftDimension = z.infer<typeof driftDimensionSchema>

export const driftSeveritySchema = z.enum(['low', 'medium', 'high', 'critical'])
export type DriftSeverity = z.infer<typeof driftSeveritySchema>

/** Tool-call set changes between baseline and observed window. */
export const toolSequenceChangeSchema = z.object({
  addedTools: z.array(z.string()).max(50),
  removedTools: z.array(z.string()).max(50),
  baselineTools: z.array(z.string()).max(100),
  observedTools: z.array(z.string()).max(100),
  addedSequences: z.array(z.string()).max(100),
  removedSequences: z.array(z.string()).max(100),
})
export type ToolSequenceChange = z.infer<typeof toolSequenceChangeSchema>

/** Evidence coverage summary for a drift analysis pass. */
export const evidenceCoverageSchema = z.object({
  baselineSamples: z.number().int().min(0),
  observedSamples: z.number().int().min(0),
  /**
   * 0–1 fraction of metric dimensions with sufficient data.
   * Severity and confidence scale with this value.
   */
  coverageScore: z.number().min(0).max(1),
  metricsWithData: z.array(driftDimensionSchema),
})
export type EvidenceCoverage = z.infer<typeof evidenceCoverageSchema>

/** Drift result for a single metric dimension. */
export const dimensionDriftResultSchema = z.object({
  dimension: driftDimensionSchema,
  drifted: z.boolean(),
  severity: driftSeveritySchema.optional(),
  baselineMedian: z.number().optional(),
  observedMedian: z.number().optional(),
  /** Number of baseline MADs the observed median deviates from the baseline median. */
  deviationMads: z.number().min(0).optional(),
  baselineRate: z.number().min(0).max(1).optional(),
  observedRate: z.number().min(0).max(1).optional(),
  absoluteDelta: z.number().optional(),
  toolSequenceChange: toolSequenceChangeSchema.optional(),
  /** Human-readable explanation citing thresholds and measured values. */
  explanation: z.string().min(1),
})
export type DimensionDriftResult = z.infer<typeof dimensionDriftResultSchema>

/**
 * Complete drift analysis result for one agent.
 *
 * **Mock mode:**  `status='ready'`,   `source='mock-synthetic'`, clearly labelled.
 * **Live, no OTel:** `status='invalid'`, `unavailableReason` set,
 *   `source='azure-monitor-otel'`, `dimensions=[]`.
 *
 * `unavailableReason` explains any unavailable analysis, including a malformed
 * or insufficient synthetic fixture. Live mode never substitutes synthetic data.
 */
export const driftAnalysisResultSchema = z.object({
  analysisId: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200),
  agentId: z.string().min(1).max(200),
  environment: z.string().min(1).max(200),
  source: observationSourceSchema,
  status: analysisStatusSchema,
  computedAt: z.iso.datetime(),
  baselineWindowId: z.string().min(1).max(200).optional(),
  observedWindowId: z.string().min(1).max(200).optional(),
  baselineEvidenceId: z.string().min(1).max(200).optional(),
  observedEvidenceId: z.string().min(1).max(200).optional(),
  dimensions: z.array(dimensionDriftResultSchema).max(10).default([]),
  coverage: evidenceCoverageSchema.optional(),
  anyDrift: z.boolean(),
  highestSeverity: driftSeveritySchema.optional(),
  /**
   * Set when the telemetry connector is absent or analysis data is unavailable.
   */
  unavailableReason: z.string().max(500).optional(),
})
export type DriftAnalysisResult = z.infer<typeof driftAnalysisResultSchema>
