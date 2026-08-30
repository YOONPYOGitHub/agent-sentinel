import type { BaselineWindow, ObservationWindow, RuntimeObservation } from '@agent-sentinel/domain'

/**
 * Synthetic runtime observations for mock / demonstration mode.
 *
 * !! SYNTHETIC DATA — NOT CONNECTED TO ANY LIVE TELEMETRY SYSTEM !!
 *
 * These observations exist solely to demonstrate the behavior baseline and
 * drift-analysis engine. They are generated with fixed seeds so results are
 * fully deterministic and reproducible. They must never appear in live-mode
 * API responses.
 */

const TENANT = 'contoso-ai-lab'
const BASELINE_START = '2026-07-01T00:00:00.000Z'
const BASELINE_END = '2026-07-31T23:59:59.000Z'
const OBSERVED_START = '2026-08-01T00:00:00.000Z'
const OBSERVED_END = '2026-08-23T23:59:59.000Z'

// ---------------------------------------------------------------------------
// Sales Research Agent — medium latency drift + new tool added
// ---------------------------------------------------------------------------
// Baseline: 20 observations, latency ~1225ms median, MAD ~200ms, 100% success
// Observed: 20 observations, latency ~1975ms median, deviation ~3.75 MADs → MEDIUM

const SALES_BASELINE_LATENCIES = [
  800, 850, 900, 950, 1000, 1050, 1100, 1150, 1200, 1200, 1250, 1250, 1300, 1350, 1400, 1500, 1600,
  1700, 1800, 1900,
]

const SALES_OBSERVED_LATENCIES = [
  1500, 1550, 1600, 1650, 1700, 1750, 1800, 1850, 1900, 1950, 2000, 2000, 2050, 2100, 2150, 2200,
  2300, 2400, 2500, 2600,
]

function salesBaselineObs(): RuntimeObservation[] {
  return SALES_BASELINE_LATENCIES.map((latencyMs, i) => ({
    id: `mock-sales-baseline-${i + 1}`,
    tenantId: TENANT,
    agentId: 'sales-research-agent',
    environment: 'demo',
    source: 'mock-synthetic' as const,
    synthetic: true,
    observedAt: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00.000Z`,
    latencyMs,
    inputTokens: 380 + (i % 5) * 20,
    outputTokens: 290 + (i % 3) * 15,
    success: true,
    toolCallNames: ['crm_lookup', 'sharepoint_search', 'format_brief'],
  }))
}

function salesObservedObs(): RuntimeObservation[] {
  return SALES_OBSERVED_LATENCIES.map((latencyMs, i) => ({
    id: `mock-sales-observed-${i + 1}`,
    tenantId: TENANT,
    agentId: 'sales-research-agent',
    environment: 'demo',
    source: 'mock-synthetic' as const,
    synthetic: true,
    observedAt: `2026-08-${String(1 + (i % 22)).padStart(2, '0')}T11:00:00.000Z`,
    latencyMs,
    inputTokens: 390 + (i % 5) * 20,
    outputTokens: 300 + (i % 3) * 15,
    success: true,
    // New tool added in observed window — detected as tool-sequence drift
    toolCallNames: ['crm_lookup', 'sharepoint_search', 'format_brief', 'external_enrichment'],
  }))
}

export const salesBaselineWindow: ObservationWindow = {
  windowId: 'mock-baseline-window-sales-2026-07',
  tenantId: TENANT,
  agentId: 'sales-research-agent',
  environment: 'demo',
  source: 'mock-synthetic',
  windowStart: BASELINE_START,
  windowEnd: BASELINE_END,
  observations: salesBaselineObs(),
}

export const salesObservedWindow: ObservationWindow = {
  windowId: 'mock-observed-window-sales-2026-08',
  tenantId: TENANT,
  agentId: 'sales-research-agent',
  environment: 'demo',
  source: 'mock-synthetic',
  windowStart: OBSERVED_START,
  windowEnd: OBSERVED_END,
  observations: salesObservedObs(),
}

/** Pre-computed baseline for Sales Research Agent (derived from salesBaselineWindow). */
export const salesBaselineRecord: BaselineWindow = {
  baselineId: 'mock-baseline-sales-research-agent-2026-07',
  tenantId: TENANT,
  agentId: 'sales-research-agent',
  environment: 'demo',
  source: 'mock-synthetic',
  windowStart: BASELINE_START,
  windowEnd: BASELINE_END,
  sampleCount: 20,
  latencyMs: {
    median: 1225,
    mad: 200,
    min: 800,
    max: 1900,
    sampleCount: 20,
    zeroVariance: false,
  },
  inputTokens: {
    median: 420,
    mad: 20,
    min: 380,
    max: 460,
    sampleCount: 20,
    zeroVariance: false,
  },
  outputTokens: {
    median: 305,
    mad: 15,
    min: 290,
    max: 320,
    sampleCount: 20,
    zeroVariance: false,
  },
  successRate: 1,
  errorRate: 0,
  toolSequence: {
    uniqueTools: ['crm_lookup', 'format_brief', 'sharepoint_search'],
    sequencePatterns: ['crm_lookup → sharepoint_search → format_brief'],
    callCount: 60,
    sampleCount: 20,
  },
  evidenceId: 'behavior-baseline-ev-sales-research-agent-2026-07',
  computedAt: '2026-08-01T00:00:00.000Z',
}

// ---------------------------------------------------------------------------
// HR Policy Assistant — healthy baseline, no drift
// ---------------------------------------------------------------------------

function hrObs(prefix: string, month: string): RuntimeObservation[] {
  return Array.from({ length: 20 }, (_, i) => ({
    id: `mock-hr-${prefix}-${i + 1}`,
    tenantId: TENANT,
    agentId: 'hr-policy-agent',
    environment: 'production',
    source: 'mock-synthetic' as const,
    synthetic: true,
    observedAt: `2026-${month}-${String(1 + (i % 28)).padStart(2, '0')}T09:30:00.000Z`,
    latencyMs: 800 + (i % 5) * 20 - 40,
    inputTokens: 250 + (i % 3) * 10,
    outputTokens: 180 + (i % 3) * 8,
    success: true,
    toolCallNames: ['hr_policy_search', 'format_answer'],
  }))
}

export const hrBaselineWindow: ObservationWindow = {
  windowId: 'mock-baseline-window-hr-2026-07',
  tenantId: TENANT,
  agentId: 'hr-policy-agent',
  environment: 'production',
  source: 'mock-synthetic',
  windowStart: BASELINE_START,
  windowEnd: BASELINE_END,
  observations: hrObs('baseline', '07'),
}

export const hrObservedWindow: ObservationWindow = {
  windowId: 'mock-observed-window-hr-2026-08',
  tenantId: TENANT,
  agentId: 'hr-policy-agent',
  environment: 'production',
  source: 'mock-synthetic',
  windowStart: OBSERVED_START,
  windowEnd: OBSERVED_END,
  observations: hrObs('observed', '08'),
}

export const hrBaselineRecord: BaselineWindow = {
  baselineId: 'mock-baseline-hr-policy-agent-2026-07',
  tenantId: TENANT,
  agentId: 'hr-policy-agent',
  environment: 'production',
  source: 'mock-synthetic',
  windowStart: BASELINE_START,
  windowEnd: BASELINE_END,
  sampleCount: 20,
  latencyMs: {
    median: 800,
    mad: 20,
    min: 760,
    max: 840,
    sampleCount: 20,
    zeroVariance: false,
  },
  inputTokens: {
    median: 260,
    mad: 10,
    min: 250,
    max: 270,
    sampleCount: 20,
    zeroVariance: false,
  },
  outputTokens: {
    median: 188,
    mad: 8,
    min: 180,
    max: 196,
    sampleCount: 20,
    zeroVariance: false,
  },
  successRate: 1,
  errorRate: 0,
  toolSequence: {
    uniqueTools: ['format_answer', 'hr_policy_search'],
    sequencePatterns: ['hr_policy_search → format_answer'],
    callCount: 40,
    sampleCount: 20,
  },
  evidenceId: 'behavior-baseline-ev-hr-policy-agent-2026-07',
  computedAt: '2026-08-01T00:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Code Review Copilot — high error rate drift
// ---------------------------------------------------------------------------
// Baseline: 20 observations, 100% success
// Observed: 20 observations, 60% success (40% error) → HIGH severity

function crBaselineObs(): RuntimeObservation[] {
  return Array.from({ length: 20 }, (_, i) => ({
    id: `mock-cr-baseline-${i + 1}`,
    tenantId: TENANT,
    agentId: 'code-review-copilot',
    environment: 'development',
    source: 'mock-synthetic' as const,
    synthetic: true,
    observedAt: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}T14:00:00.000Z`,
    latencyMs: 1800 + (i % 5) * 40 - 80,
    inputTokens: 950 + (i % 4) * 50,
    outputTokens: 620 + (i % 3) * 30,
    success: true,
    toolCallNames: ['analyze_code', 'check_standards', 'write_review'],
  }))
}

function crObservedObs(): RuntimeObservation[] {
  return Array.from({ length: 20 }, (_, i) => ({
    id: `mock-cr-observed-${i + 1}`,
    tenantId: TENANT,
    agentId: 'code-review-copilot',
    environment: 'development',
    source: 'mock-synthetic' as const,
    synthetic: true,
    observedAt: `2026-08-${String(1 + (i % 22)).padStart(2, '0')}T14:30:00.000Z`,
    latencyMs: 1850 + (i % 5) * 40 - 80,
    inputTokens: 960 + (i % 4) * 50,
    outputTokens: 630 + (i % 3) * 30,
    // 8 of 20 fail → 40% error rate; baseline was 0% → HIGH drift
    success: i < 12,
    ...(i >= 12 ? { errorCode: 'CONTEXT_LIMIT_EXCEEDED' } : {}),
    toolCallNames: ['analyze_code', 'check_standards', 'write_review'],
  }))
}

export const crBaselineWindow: ObservationWindow = {
  windowId: 'mock-baseline-window-cr-2026-07',
  tenantId: TENANT,
  agentId: 'code-review-copilot',
  environment: 'development',
  source: 'mock-synthetic',
  windowStart: BASELINE_START,
  windowEnd: BASELINE_END,
  observations: crBaselineObs(),
}

export const crObservedWindow: ObservationWindow = {
  windowId: 'mock-observed-window-cr-2026-08',
  tenantId: TENANT,
  agentId: 'code-review-copilot',
  environment: 'development',
  source: 'mock-synthetic',
  windowStart: OBSERVED_START,
  windowEnd: OBSERVED_END,
  observations: crObservedObs(),
}

export const crBaselineRecord: BaselineWindow = {
  baselineId: 'mock-baseline-code-review-copilot-2026-07',
  tenantId: TENANT,
  agentId: 'code-review-copilot',
  environment: 'development',
  source: 'mock-synthetic',
  windowStart: BASELINE_START,
  windowEnd: BASELINE_END,
  sampleCount: 20,
  latencyMs: {
    median: 1800,
    mad: 40,
    min: 1720,
    max: 1880,
    sampleCount: 20,
    zeroVariance: false,
  },
  inputTokens: {
    median: 1025,
    mad: 50,
    min: 950,
    max: 1100,
    sampleCount: 20,
    zeroVariance: false,
  },
  outputTokens: {
    median: 650,
    mad: 30,
    min: 620,
    max: 680,
    sampleCount: 20,
    zeroVariance: false,
  },
  successRate: 1,
  errorRate: 0,
  toolSequence: {
    uniqueTools: ['analyze_code', 'check_standards', 'write_review'],
    sequencePatterns: ['analyze_code → check_standards → write_review'],
    callCount: 60,
    sampleCount: 20,
  },
  evidenceId: 'behavior-baseline-ev-code-review-copilot-2026-07',
  computedAt: '2026-08-01T00:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Convenience registry for API routes
// ---------------------------------------------------------------------------

export interface MockBehaviorWindows {
  readonly baseline: BaselineWindow
  readonly observed: ObservationWindow
  readonly observedEvidenceId: string
}

export const MOCK_BEHAVIOR_WINDOWS: Readonly<Record<string, MockBehaviorWindows>> = {
  'sales-research-agent': {
    baseline: salesBaselineRecord,
    observed: salesObservedWindow,
    observedEvidenceId: 'behavior-observed-ev-sales-research-agent-2026-08',
  },
  'hr-policy-agent': {
    baseline: hrBaselineRecord,
    observed: hrObservedWindow,
    observedEvidenceId: 'behavior-observed-ev-hr-policy-agent-2026-08',
  },
  'code-review-copilot': {
    baseline: crBaselineRecord,
    observed: crObservedWindow,
    observedEvidenceId: 'behavior-observed-ev-code-review-copilot-2026-08',
  },
}
