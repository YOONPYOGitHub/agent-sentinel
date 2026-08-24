import { z } from 'zod'

import { driftSeveritySchema, observationSourceSchema } from './behavior-baseline.js'

// ---------------------------------------------------------------------------
// Token Economics Analysis Status
// ---------------------------------------------------------------------------

/**
 * Analysis status for a token economics report.
 * - 'ready'                   - sufficient data; summary and anomalies populated.
 * - 'insufficient-data'       - fewer than MIN_SAMPLES unique observations.
 * - 'unavailable'             - window is stale or data is unanalysable.
 * - 'connector-not-connected' - live Foundry mode; no OTel connector present.
 *                               Never returns synthetic data in this state.
 */
export const tokenEconomicsAnalysisStatusSchema = z.enum([
  'ready',
  'insufficient-data',
  'unavailable',
  'connector-not-connected',
])
export type TokenEconomicsAnalysisStatus = z.infer<typeof tokenEconomicsAnalysisStatusSchema>

// ---------------------------------------------------------------------------
// Anomaly types
// ---------------------------------------------------------------------------

export const tokenEconomicsAnomalyDimensionSchema = z.enum([
  'input-tokens',
  'output-tokens',
  'total-tokens',
  'cost',
])
export type TokenEconomicsAnomalyDimension = z.infer<typeof tokenEconomicsAnomalyDimensionSchema>

/**
 * A single token/cost anomaly detected against the established baseline.
 * All fields are derived from measured observations only.
 * The deviationMads field is absent when the baseline MAD is zero (zero variance).
 */
export const tokenEconomicsAnomalySchema = z.object({
  anomalyId: z.string().min(1).max(200),
  dimension: tokenEconomicsAnomalyDimensionSchema,
  severity: driftSeveritySchema,
  baselineMedian: z.number(),
  observedMedian: z.number(),
  deviationMads: z.number().min(0).optional(),
  evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(2),
  explanation: z.string().min(1),
})
export type TokenEconomicsAnomaly = z.infer<typeof tokenEconomicsAnomalySchema>

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * Sample coverage summary for one token economics report.
 * costCoverage is a fraction 0-1; partial when only some observations carry measured cost.
 * Must never be used to extrapolate total estate cost.
 */
export const tokenEconomicsCoverageSchema = z
  .object({
    totalObservations: z.number().int().min(0),
    deduplicatedObservations: z.number().int().min(0),
    duplicatesRemoved: z.number().int().min(0),
    successCount: z.number().int().min(0),
    measuredSuccessCount: z.number().int().min(0),
    inputTokenMeasuredCount: z.number().int().min(0),
    outputTokenMeasuredCount: z.number().int().min(0),
    totalTokenMeasuredCount: z.number().int().min(0),
    costMeasuredCount: z.number().int().min(0),
    costCoverage: z.number().min(0).max(1),
  })
  .superRefine((coverage, context) => {
    const boundedCounts = [
      ['successCount', coverage.successCount],
      ['inputTokenMeasuredCount', coverage.inputTokenMeasuredCount],
      ['outputTokenMeasuredCount', coverage.outputTokenMeasuredCount],
      ['totalTokenMeasuredCount', coverage.totalTokenMeasuredCount],
      ['costMeasuredCount', coverage.costMeasuredCount],
    ] as const
    if (
      coverage.deduplicatedObservations > coverage.totalObservations ||
      coverage.duplicatesRemoved !== coverage.totalObservations - coverage.deduplicatedObservations
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Deduplicated and duplicate counts must reconcile with total observations.',
      })
    }
    for (const [field, value] of boundedCounts) {
      if (value > coverage.deduplicatedObservations) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} cannot exceed deduplicatedObservations.`,
        })
      }
    }
    if (
      coverage.measuredSuccessCount > coverage.successCount ||
      coverage.measuredSuccessCount > coverage.costMeasuredCount
    ) {
      context.addIssue({
        code: 'custom',
        path: ['measuredSuccessCount'],
        message: 'measuredSuccessCount must belong to both success and cost-measured populations.',
      })
    }
    const expectedCoverage =
      coverage.deduplicatedObservations === 0
        ? 0
        : coverage.costMeasuredCount / coverage.deduplicatedObservations
    if (Math.abs(coverage.costCoverage - expectedCoverage) > 1e-9) {
      context.addIssue({
        code: 'custom',
        path: ['costCoverage'],
        message: 'costCoverage must equal costMeasuredCount / deduplicatedObservations.',
      })
    }
  })
export type TokenEconomicsCoverage = z.infer<typeof tokenEconomicsCoverageSchema>

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Bounded token economics report for one agent in one observation window.
 *
 * Token and cost fields are only present when status is 'ready'.
 * measuredCostUsd is the sum of only those observations that carry costUsd.
 * Partial cost coverage is always explicit via coverage.costCoverage.
 * costPerSuccessUsd uses the measured-cost population only and is absent when
 * that population contains zero successes.
 * No currency conversion, estimated savings, ROI, or cost avoidance values.
 */
export const tokenEconomicsReportSchema = z
  .object({
    reportId: z.string().min(1).max(200),
    tenantId: z.string().min(1).max(200),
    agentId: z.string().min(1).max(200),
    environment: z.string().min(1).max(200),
    source: observationSourceSchema,
    windowStart: z.iso.datetime(),
    windowEnd: z.iso.datetime(),
    computedAt: z.iso.datetime(),
    status: tokenEconomicsAnalysisStatusSchema,
    unavailableReason: z.string().min(1).optional(),
    baselineEvidenceId: z.string().min(1).max(200).optional(),
    observedEvidenceId: z.string().min(1).max(200).optional(),
    coverage: tokenEconomicsCoverageSchema.optional(),
    totalInputTokens: z.number().int().min(0).optional(),
    totalOutputTokens: z.number().int().min(0).optional(),
    totalTokens: z.number().int().min(0).optional(),
    medianInputTokens: z.number().min(0).optional(),
    medianOutputTokens: z.number().min(0).optional(),
    medianTotalTokens: z.number().min(0).optional(),
    measuredCostUsd: z.number().min(0).optional(),
    medianCostUsd: z.number().min(0).optional(),
    costPerSuccessUsd: z.number().min(0).optional(),
    anomalies: z.array(tokenEconomicsAnomalySchema).max(20).optional(),
  })
  .superRefine((report, context) => {
    const hasAnyTokenTotal =
      report.totalInputTokens !== undefined ||
      report.totalOutputTokens !== undefined ||
      report.totalTokens !== undefined
    if (hasAnyTokenTotal) {
      const expectedTotal = (report.totalInputTokens ?? 0) + (report.totalOutputTokens ?? 0)
      if (report.totalTokens === undefined || report.totalTokens !== expectedTotal) {
        context.addIssue({
          code: 'custom',
          path: ['totalTokens'],
          message:
            'totalTokens must equal the sum of present input and output token totals, treating an absent dimension as zero.',
        })
      }
    }
    if (report.costPerSuccessUsd !== undefined) {
      if (
        report.measuredCostUsd === undefined ||
        report.coverage === undefined ||
        report.coverage.measuredSuccessCount === 0
      ) {
        context.addIssue({
          code: 'custom',
          path: ['costPerSuccessUsd'],
          message: 'costPerSuccessUsd requires measured cost and measured successes.',
        })
      } else {
        const expected = report.measuredCostUsd / report.coverage.measuredSuccessCount
        if (Math.abs(report.costPerSuccessUsd - expected) > 1e-9) {
          context.addIssue({
            code: 'custom',
            path: ['costPerSuccessUsd'],
            message: 'costPerSuccessUsd must use the measured-cost success population.',
          })
        }
      }
    }
    if ((report.anomalies?.length ?? 0) > 0) {
      if (report.baselineEvidenceId === undefined || report.observedEvidenceId === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['anomalies'],
          message: 'Anomalies require baseline and observed evidence references.',
        })
      } else if (
        report.anomalies?.some(
          (anomaly) =>
            !anomaly.evidenceIds.includes(report.baselineEvidenceId!) ||
            !anomaly.evidenceIds.includes(report.observedEvidenceId!),
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['anomalies'],
          message: 'Every anomaly must cite the report baseline and observed evidence.',
        })
      }
    }
  })
export type TokenEconomicsReport = z.infer<typeof tokenEconomicsReportSchema>
