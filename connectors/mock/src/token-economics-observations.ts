import type { BaselineWindow, ObservationWindow, RuntimeObservation } from '@agent-sentinel/domain'

/**
 * !! SYNTHETIC DATA - NOT CONNECTED TO ANY LIVE TELEMETRY SYSTEM !!
 *
 * Synthetic measured-cost observations for mock / demonstration mode.
 * Three scenarios are provided:
 *   - hr-policy-agent: healthy, all observations carry measuredcostUsd
 *   - code-review-copilot: cost anomaly (spike vs baseline), 60% success
 *   - sales-research-agent: no costUsd (missing-cost example)
 *
 * Clock is fixed to 2026-08-23T23:59:59.000Z for deterministic analysis.
 */

const TENANT = 'contoso-ai-lab'
const WINDOW_START = '2026-08-01T00:00:00.000Z'
const WINDOW_END = '2026-08-23T23:59:59.000Z'
const BASELINE_START = '2026-07-01T00:00:00.000Z'
const BASELINE_END = '2026-07-31T23:59:59.000Z'

// ---------------------------------------------------------------------------
// HR Policy Assistant - healthy, all cost measured
// ---------------------------------------------------------------------------
// Scenario: All 20 observations have costUsd ~ $0.020-0.024. No anomaly.

function hrTeCostObs(): RuntimeObservation[] {
  return Array.from({ length: 20 }, (_, i) => ({
    id: `mock-te-hr-${i + 1}`,
    tenantId: TENANT,
    agentId: 'hr-policy-agent',
    environment: 'production',
    source: 'mock-synthetic' as const,
    synthetic: true,
    observedAt: `2026-08-${String(1 + (i % 22)).padStart(2, '0')}T09:30:00.000Z`,
    latencyMs: 800 + (i % 5) * 20,
    inputTokens: 250 + (i % 3) * 10,
    outputTokens: 180 + (i % 3) * 8,
    costUsd: 0.02 + (i % 3) * 0.002, // $0.020, $0.022, $0.024 – measured
    success: true,
    toolCallNames: ['hr_policy_search', 'format_answer'],
  }))
}

export const hrTeObservedWindow: ObservationWindow = {
  windowId: 'mock-te-observed-window-hr-2026-08',
  tenantId: TENANT,
  agentId: 'hr-policy-agent',
  environment: 'production',
  source: 'mock-synthetic',
  windowStart: WINDOW_START,
  windowEnd: WINDOW_END,
  observations: hrTeCostObs(),
}

export const hrTeBaselineRecord: BaselineWindow = {
  baselineId: 'mock-te-baseline-hr-policy-agent-2026-07',
  tenantId: TENANT,
  agentId: 'hr-policy-agent',
  environment: 'production',
  source: 'mock-synthetic',
  windowStart: BASELINE_START,
  windowEnd: BASELINE_END,
  sampleCount: 20,
  inputTokens: { median: 260, mad: 10, min: 250, max: 270, sampleCount: 20, zeroVariance: false },
  outputTokens: { median: 188, mad: 8, min: 180, max: 196, sampleCount: 20, zeroVariance: false },
  totalTokens: { median: 448, mad: 18, min: 430, max: 466, sampleCount: 20, zeroVariance: false },
  costUsd: {
    median: 0.022,
    mad: 0.002,
    min: 0.02,
    max: 0.024,
    sampleCount: 20,
    zeroVariance: false,
  },
  successRate: 1,
  errorRate: 0,
  evidenceId: 'te-baseline-ev-hr-policy-agent-2026-07',
  computedAt: '2026-08-01T00:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Code Review Copilot - cost anomaly (spike), 60% success
// ---------------------------------------------------------------------------
// Scenario: 20 observations, costUsd spikes 3-4x above baseline.
// baseline.costUsd.median = $0.08, baseline.costUsd.mad = $0.005
// observed costUsd = $0.24-0.28 -> deviation >> critical

function crTeCostObs(): RuntimeObservation[] {
  return Array.from({ length: 20 }, (_, i) => ({
    id: `mock-te-cr-${i + 1}`,
    tenantId: TENANT,
    agentId: 'code-review-copilot',
    environment: 'development',
    source: 'mock-synthetic' as const,
    synthetic: true,
    observedAt: `2026-08-${String(1 + (i % 22)).padStart(2, '0')}T14:30:00.000Z`,
    latencyMs: 1850 + (i % 5) * 40,
    inputTokens: 960 + (i % 4) * 50,
    outputTokens: 630 + (i % 3) * 30,
    costUsd: 0.24 + (i % 3) * 0.02, // $0.240-$0.280 – spiked vs $0.08 baseline
    success: i < 12, // 60% success
    ...(i >= 12 ? { errorCode: 'CONTEXT_LIMIT_EXCEEDED' } : {}),
    toolCallNames: ['analyze_code', 'check_standards', 'write_review'],
  }))
}

export const crTeObservedWindow: ObservationWindow = {
  windowId: 'mock-te-observed-window-cr-2026-08',
  tenantId: TENANT,
  agentId: 'code-review-copilot',
  environment: 'development',
  source: 'mock-synthetic',
  windowStart: WINDOW_START,
  windowEnd: WINDOW_END,
  observations: crTeCostObs(),
}

export const crTeBaselineRecord: BaselineWindow = {
  baselineId: 'mock-te-baseline-code-review-copilot-2026-07',
  tenantId: TENANT,
  agentId: 'code-review-copilot',
  environment: 'development',
  source: 'mock-synthetic',
  windowStart: BASELINE_START,
  windowEnd: BASELINE_END,
  sampleCount: 20,
  inputTokens: { median: 1025, mad: 50, min: 950, max: 1100, sampleCount: 20, zeroVariance: false },
  outputTokens: { median: 650, mad: 30, min: 620, max: 680, sampleCount: 20, zeroVariance: false },
  totalTokens: {
    median: 1675,
    mad: 50,
    min: 1570,
    max: 1780,
    sampleCount: 20,
    zeroVariance: false,
  },
  costUsd: {
    median: 0.08,
    mad: 0.005,
    min: 0.075,
    max: 0.085,
    sampleCount: 20,
    zeroVariance: false,
  },
  successRate: 1,
  errorRate: 0,
  evidenceId: 'te-baseline-ev-code-review-copilot-2026-07',
  computedAt: '2026-08-01T00:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Sales Research Agent - no costUsd (missing-cost example)
// ---------------------------------------------------------------------------
// Scenario: Observations have inputTokens/outputTokens but no costUsd.

function salesTeNoCostObs(): RuntimeObservation[] {
  return Array.from({ length: 20 }, (_, i) => ({
    id: `mock-te-sales-${i + 1}`,
    tenantId: TENANT,
    agentId: 'sales-research-agent',
    environment: 'demo',
    source: 'mock-synthetic' as const,
    synthetic: true,
    observedAt: `2026-08-${String(1 + (i % 22)).padStart(2, '0')}T11:00:00.000Z`,
    latencyMs: 1975 + (i % 5) * 40,
    inputTokens: 390 + (i % 5) * 20,
    outputTokens: 300 + (i % 3) * 15,
    // NO costUsd - connector does not supply it
    success: true,
    toolCallNames: ['crm_lookup', 'sharepoint_search', 'format_brief'],
  }))
}

export const salesTeObservedWindow: ObservationWindow = {
  windowId: 'mock-te-observed-window-sales-2026-08',
  tenantId: TENANT,
  agentId: 'sales-research-agent',
  environment: 'demo',
  source: 'mock-synthetic',
  windowStart: WINDOW_START,
  windowEnd: WINDOW_END,
  observations: salesTeNoCostObs(),
}

export const salesTeBaselineRecord: BaselineWindow = {
  baselineId: 'mock-te-baseline-sales-research-agent-2026-07',
  tenantId: TENANT,
  agentId: 'sales-research-agent',
  environment: 'demo',
  source: 'mock-synthetic',
  windowStart: BASELINE_START,
  windowEnd: BASELINE_END,
  sampleCount: 20,
  inputTokens: { median: 420, mad: 20, min: 380, max: 460, sampleCount: 20, zeroVariance: false },
  outputTokens: { median: 305, mad: 15, min: 290, max: 320, sampleCount: 20, zeroVariance: false },
  totalTokens: {
    median: 727.5,
    mad: 22.5,
    min: 670,
    max: 780,
    sampleCount: 20,
    zeroVariance: false,
  },
  // No costUsd on baseline - connector never supplied it
  successRate: 1,
  errorRate: 0,
  evidenceId: 'te-baseline-ev-sales-research-agent-2026-07',
  computedAt: '2026-08-01T00:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface MockTokenEconomicsWindows {
  readonly observed: ObservationWindow
  readonly baseline: BaselineWindow
  readonly observedEvidenceId: string
  readonly clock: () => Date
}

/** Fixed clock for deterministic analysis - always at the observed window end. */
const FIXED_CLOCK = () => new Date(WINDOW_END)

export const MOCK_TOKEN_ECONOMICS_WINDOWS: Readonly<Record<string, MockTokenEconomicsWindows>> = {
  'hr-policy-agent': {
    observed: hrTeObservedWindow,
    baseline: hrTeBaselineRecord,
    observedEvidenceId: 'te-observed-ev-hr-policy-agent-2026-08',
    clock: FIXED_CLOCK,
  },
  'code-review-copilot': {
    observed: crTeObservedWindow,
    baseline: crTeBaselineRecord,
    observedEvidenceId: 'te-observed-ev-code-review-copilot-2026-08',
    clock: FIXED_CLOCK,
  },
  'sales-research-agent': {
    observed: salesTeObservedWindow,
    baseline: salesTeBaselineRecord,
    observedEvidenceId: 'te-observed-ev-sales-research-agent-2026-08',
    clock: FIXED_CLOCK,
  },
}
