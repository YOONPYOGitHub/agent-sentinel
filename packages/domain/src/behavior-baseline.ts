import { z } from 'zod'

import { agentCorrelationSchema } from './correlation.js'
import { otelWindowQualitySchema, runtimeOtelProvenanceSchema } from './otel-evidence.js'

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
  correlations: z
    .array(agentCorrelationSchema)
    .max(3)
    .refine(
      (correlations) =>
        new Set(correlations.map((correlation) => correlation.kind)).size === correlations.length,
      'Runtime observation correlation kinds must be unique.',
    )
    .optional(),
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
  observations: z.array(runtimeObservationSchema).max(10_000),
  otelQuality: otelWindowQualitySchema.optional(),
})
export type ObservationWindow = z.infer<typeof observationWindowSchema>

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
