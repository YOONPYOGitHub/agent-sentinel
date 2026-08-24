import type {
  DistributionStats,
  RuntimeObservation,
  ToolSequenceSummary,
} from '@agent-sentinel/domain'

// ---------------------------------------------------------------------------
// Median and MAD
// ---------------------------------------------------------------------------

/** Return the median of an already-sorted numeric array (length >= 1). */
function medianOfSorted(sorted: readonly number[]): number {
  const n = sorted.length
  if (n === 0) return 0
  const mid = Math.floor(n / 2)
  if (n % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/**
 * Compute robust distribution statistics for a numeric sample.
 * Returns `null` for empty arrays — callers must not assume data exists.
 *
 * Handles:
 * - Zero-variance (all identical) → MAD = 0, `zeroVariance = true`.
 * - Single sample → MAD = 0, `zeroVariance = true`.
 * - Negative values → supported (e.g. deltas).
 */
export function computeDistributionStats(values: readonly number[]): DistributionStats | null {
  if (values.length === 0) return null

  const sorted = [...values].sort((a, b) => a - b)
  const median = medianOfSorted(sorted)

  const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b)
  const mad = medianOfSorted(deviations)

  return {
    median,
    mad,
    min: sorted[0] ?? median,
    max: sorted[sorted.length - 1] ?? median,
    sampleCount: values.length,
    zeroVariance: mad === 0,
  }
}

// ---------------------------------------------------------------------------
// Tool-call patterns
// ---------------------------------------------------------------------------

/**
 * Summarise tool-call patterns from per-invocation sequences.
 * Produces sorted unique tools for deterministic comparison.
 */
export function computeToolSequenceSummary(
  toolCallSequences: readonly string[][],
): ToolSequenceSummary {
  const allTools = new Set<string>()
  const sequencePatterns = new Set<string>()
  let totalCalls = 0

  for (const sequence of toolCallSequences) {
    if (sequence.length > 0) sequencePatterns.add(sequence.join(' → '))
    for (const tool of sequence) {
      allTools.add(tool)
      totalCalls++
    }
  }

  return {
    uniqueTools: [...allTools].sort(),
    sequencePatterns: [...sequencePatterns].sort(),
    callCount: totalCalls,
    sampleCount: toolCallSequences.length,
  }
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Deduplicate runtime observations by `id`, preserving first occurrence.
 * Returns the deduplicated array and the count of removed duplicates.
 */
export function deduplicateObservations(observations: readonly RuntimeObservation[]): {
  deduplicated: RuntimeObservation[]
  duplicatesRemoved: number
} {
  const seen = new Set<string>()
  const deduplicated: RuntimeObservation[] = []

  for (const obs of observations) {
    if (seen.has(obs.id)) continue
    seen.add(obs.id)
    deduplicated.push(obs)
  }

  return { deduplicated, duplicatesRemoved: observations.length - deduplicated.length }
}
