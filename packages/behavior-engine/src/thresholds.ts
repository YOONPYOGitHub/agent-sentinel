/**
 * Deterministic thresholds for the behavior baseline and drift-analysis engine.
 * All values are explicit constants; no threshold is inferred from data.
 */

/** Minimum number of unique observations required for a valid window. */
export const MIN_SAMPLES = 10

/** Hours after a window's end before it is considered stale. */
export const STALE_WINDOW_HOURS = 168

/** Maximum tolerated future clock skew for an observed window. */
export const MAX_CLOCK_SKEW_MINUTES = 5

/**
 * MAD (Median Absolute Deviation) multiplier thresholds for metric drift.
 * Applied when baseline MAD > 0.
 */
export const MADS_THRESHOLDS = {
  low: 2.0,
  medium: 3.5,
  high: 6.0,
  critical: 10.0,
} as const

/**
 * Fraction-of-median thresholds used when baseline MAD is zero (zero variance).
 * Prevents division-by-zero and gives a meaningful bound for stable metrics.
 */
export const PCT_THRESHOLDS = {
  low: 0.2,
  medium: 0.5,
  high: 1.0,
  critical: 2.0,
} as const

/**
 * Absolute rate delta thresholds for success/error rate drift.
 * Expressed as a fraction (0–1) of total invocations.
 */
export const RATE_THRESHOLDS = {
  low: 0.1,
  medium: 0.2,
  high: 0.35,
  critical: 0.5,
} as const

/**
 * Maximum ratio of duplicate observation IDs before a window is flagged invalid.
 * Guards against log pipeline bugs that replay the same span many times.
 */
export const MAX_DUPLICATE_RATIO = 0.5
