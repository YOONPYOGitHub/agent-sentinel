// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, expect, it } from 'vitest'

import type {
  AgentSentinelState,
  ExposureFinding,
  GraphNode,
  TokenEconomicsReport,
} from '@agent-sentinel/domain'

import { governancePostureFixture, salesExposureFinding, testState } from './test-fixture'
import { agentLifecycleReadiness, buildAgentScorecard, type ExposureLoadState } from './scorecard'

const salesAgent = testState.snapshot.nodes.find((node) => node.id === 'sales-research-agent')!
const hrAgent = testState.snapshot.nodes.find((node) => node.id === 'hr-policy-agent')!

function withAgent(agent: GraphNode, state: AgentSentinelState = testState): AgentSentinelState {
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      nodes: state.snapshot.nodes.map((node) => (node.id === agent.id ? agent : node)),
    },
  }
}

function mitigatedState(state: AgentSentinelState = testState): AgentSentinelState {
  return {
    ...state,
    findings: state.findings.map((finding) => ({
      ...finding,
      path: { ...finding.path, status: 'mitigated' as const },
    })),
  }
}

function withValidatedRun(state: AgentSentinelState): AgentSentinelState {
  return {
    ...state,
    validations: [
      {
        id: 'validation-scorecard',
        findingId: 'finding-1',
        status: 'validated',
        startedAt: '2026-08-19T09:00:00.000Z',
        syntheticCanary: 'scorecard-canary',
        trace: [],
      },
    ],
  }
}

function dimension(
  agent: GraphNode,
  state: AgentSentinelState,
  id: string,
  exposures: ExposureFinding[] | ExposureLoadState = 'loading',
  tokenEconomicsReport?: TokenEconomicsReport,
) {
  return buildAgentScorecard(agent, state, exposures, tokenEconomicsReport).dimensions.find(
    (item) => item.id === id,
  )!
}

function readyTokenEconomics(overrides: Partial<TokenEconomicsReport> = {}): TokenEconomicsReport {
  return {
    reportId: 'te-scorecard',
    tenantId: testState.snapshot.tenantId,
    agentId: hrAgent.id,
    environment: hrAgent.environment,
    source: 'mock-synthetic',
    windowStart: '2026-08-01T00:00:00.000Z',
    windowEnd: '2026-08-23T23:59:59.000Z',
    computedAt: '2026-08-23T23:59:59.000Z',
    status: 'ready',
    baselineEvidenceId: 'te-baseline-evidence',
    observedEvidenceId: 'te-observed-evidence',
    coverage: {
      totalObservations: 20,
      deduplicatedObservations: 20,
      duplicatesRemoved: 0,
      successCount: 20,
      measuredSuccessCount: 20,
      inputTokenMeasuredCount: 20,
      outputTokenMeasuredCount: 20,
      totalTokenMeasuredCount: 20,
      costMeasuredCount: 20,
      costCoverage: 1,
    },
    totalInputTokens: 5200,
    totalOutputTokens: 3760,
    totalTokens: 8960,
    medianInputTokens: 260,
    medianOutputTokens: 188,
    medianTotalTokens: 448,
    measuredCostUsd: 0.44,
    medianCostUsd: 0.022,
    costPerSuccessUsd: 0.022,
    anomalies: [],
    ...overrides,
  }
}

describe('agentLifecycleReadiness', () => {
  it('passes all five checks for a complete agent with a validated run', () => {
    const readiness = agentLifecycleReadiness(salesAgent, withValidatedRun(mitigatedState()), [])

    expect(readiness.checks).toEqual([true, true, true, true, true])
    expect(readiness).toMatchObject({
      readinessChecks: 5,
      total: 5,
      unknownChecks: 0,
      readinessStatus: 'complete',
    })
  })

  it('fails the owner and version checks when they are missing', () => {
    const agent = {
      ...salesAgent,
      owner: undefined,
      metadata: { ...salesAgent.metadata, version: '' },
    }
    const readiness = agentLifecycleReadiness(
      agent,
      withAgent(agent, withValidatedRun(mitigatedState())),
      [],
    )

    expect(readiness.checks).toEqual([false, false, true, true, true])
    expect(readiness.readinessChecks).toBe(3)
  })

  it('fails the evidence check when evidence is stale', () => {
    const state = withValidatedRun({
      ...mitigatedState(),
      snapshot: {
        ...testState.snapshot,
        evidence: testState.snapshot.evidence.map((item) =>
          item.id === 'evidence-sales' ? { ...item, freshness: 'stale' as const } : item,
        ),
      },
    })

    expect(agentLifecycleReadiness(salesAgent, state, []).checks[2]).toBe(false)
  })

  it('fails the findings check for an active live exposure', () => {
    expect(agentLifecycleReadiness(salesAgent, testState, [salesExposureFinding]).checks[3]).toBe(
      false,
    )
  })

  it('returns true for the exposure check when no live exposures are active', () => {
    expect(agentLifecycleReadiness(salesAgent, mitigatedState(), []).checks[3]).toBe(true)
  })

  it("returns 'unknown' for the exposure check when live exposures are loading", () => {
    expect(agentLifecycleReadiness(salesAgent, testState, 'loading').checks[3]).toBe('unknown')
  })

  it("returns 'unknown' for the exposure check when live exposures failed", () => {
    const readiness = agentLifecycleReadiness(salesAgent, testState, 'error')
    expect(readiness.checks[3]).toBe('unknown')
    expect(readiness.unknownChecks).toBe(1)
    expect(readiness.readinessStatus).toBe('attention')
  })
})

describe('buildAgentScorecard', () => {
  it('keeps Security unknown while live exposures are loading', () => {
    expect(dimension(salesAgent, testState, 'security', 'loading')).toMatchObject({
      posture: 'unknown',
      coverage: 'unknown',
      explanation: 'Live exposure evidence is loading, so the security posture is unknown.',
      findingIds: [],
    })
  })

  it('keeps Security unknown when live exposures fail to load', () => {
    expect(dimension(salesAgent, testState, 'security', 'error')).toMatchObject({
      posture: 'unknown',
      coverage: 'unknown',
      explanation:
        'Live exposure data could not be loaded, so the security posture is unknown. Check connector health.',
      findingIds: [],
    })
  })

  it('derives Security only from active live exposures for the affected agent', () => {
    const unrelated = { ...salesExposureFinding, id: 'unrelated', affectedAgentId: 'other-agent' }
    const resolved = { ...salesExposureFinding, id: 'resolved', status: 'resolved' as const }
    const high = {
      ...salesExposureFinding,
      id: 'high-exposure',
      severity: 'high' as const,
      status: 'validated' as const,
      riskScore: 67,
    }
    const security = dimension(salesAgent, testState, 'security', [unrelated, resolved, high])

    expect(security).toMatchObject({
      posture: 'attention',
      coverage: 'derived',
      findingIds: ['high-exposure'],
      explanation:
        '1 active exposure affects this agent. Highest finding risk score: 67/100. This is a risk score, not an assurance score.',
    })
  })

  it('marks Security critical for the fixture active critical finding', () => {
    const security = dimension(salesAgent, testState, 'security', [salesExposureFinding])

    expect(security.posture).toBe('critical')
    expect(security.findingIds).toEqual([salesExposureFinding.id])
  })

  it('uses derived coverage for Security when live exposures are loaded', () => {
    expect(dimension(salesAgent, testState, 'security', [salesExposureFinding]).coverage).toBe(
      'derived',
    )
  })

  it('uses the healthy Security explanation when the agent has no active exposures', () => {
    expect(dimension(hrAgent, testState, 'security', [])).toMatchObject({
      posture: 'healthy',
      coverage: 'derived',
      explanation: 'No active exposures in connected evidence affect this agent.',
    })
  })

  it('marks Security healthy when all findings are mitigated', () => {
    expect(dimension(salesAgent, mitigatedState(), 'security', []).posture).toBe('healthy')
  })

  it('marks Governance healthy for a trusted agent with an owner', () => {
    const governance = dimension(hrAgent, testState, 'governance', [])

    expect(governance.posture).toBe('healthy')
    expect(governance.explanation).toContain(
      'Microsoft Agent 365 remains authoritative for all admin and entitlement decisions',
    )
    expect(governancePostureFixture.policies.length).toBeGreaterThan(0)
  })

  it('marks Governance attention for conditional trust without active findings', () => {
    expect(dimension(salesAgent, mitigatedState(), 'governance', []).posture).toBe('attention')
  })

  it('marks Governance critical for untrusted agents or active findings', () => {
    const untrusted = { ...hrAgent, trust: 'untrusted' as const }

    expect(dimension(untrusted, withAgent(untrusted), 'governance', []).posture).toBe('critical')
    expect(dimension(salesAgent, testState, 'governance', [salesExposureFinding]).posture).toBe(
      'critical',
    )
  })

  it('uses derived coverage for Governance', () => {
    expect(dimension(hrAgent, testState, 'governance', []).coverage).toBe('derived')
  })

  it('links active live exposure finding IDs to Governance', () => {
    expect(
      dimension(salesAgent, testState, 'governance', [salesExposureFinding]).findingIds,
    ).toEqual([salesExposureFinding.id])
  })

  it('keeps Governance unknown while live exposures are loading for a trusted+owned agent', () => {
    expect(dimension(hrAgent, testState, 'governance', 'loading')).toMatchObject({
      posture: 'unknown',
      coverage: 'unknown',
    })
  })

  it('keeps Governance unknown when live exposures fail for a trusted+owned agent', () => {
    expect(dimension(hrAgent, testState, 'governance', 'error')).toMatchObject({
      posture: 'unknown',
      coverage: 'unknown',
    })
  })

  it('keeps Lifecycle unknown while the exposure readiness check is unavailable', () => {
    expect(dimension(hrAgent, testState, 'lifecycle', 'loading')).toMatchObject({
      posture: 'unknown',
      coverage: 'unknown',
    })
  })

  it('still marks Governance critical for untrusted agents while exposures are loading', () => {
    const untrusted = { ...hrAgent, trust: 'untrusted' as const }
    expect(dimension(untrusted, withAgent(untrusted), 'governance', 'loading').posture).toBe(
      'critical',
    )
  })

  it('maps lifecycle check counts to healthy, attention, and critical', () => {
    const complete = withValidatedRun(mitigatedState())
    const incompleteAgent = {
      ...salesAgent,
      owner: undefined,
      metadata: { ...salesAgent.metadata, version: '' },
    }
    const criticalState = withAgent(incompleteAgent, {
      ...testState,
      snapshot: {
        ...testState.snapshot,
        evidence: testState.snapshot.evidence.map((item) =>
          item.id === 'evidence-sales' ? { ...item, freshness: 'stale' as const } : item,
        ),
      },
    })

    expect(dimension(salesAgent, complete, 'lifecycle', []).posture).toBe('healthy')
    expect(dimension(salesAgent, testState, 'lifecycle', []).posture).toBe('attention')
    expect(dimension(incompleteAgent, criticalState, 'lifecycle', []).posture).toBe('critical')
  })

  it('keeps Quality, Reliability, and Cost unknown with connector requirements', () => {
    const scorecard = buildAgentScorecard(hrAgent, testState, [])

    for (const id of ['quality', 'reliability', 'cost']) {
      const item = scorecard.dimensions.find((candidate) => candidate.id === id)
      expect(item).toMatchObject({ posture: 'unknown', coverage: 'unknown' })
      expect(item?.missingConnector).toBeTruthy()
    }
  })

  it('derives a healthy Cost posture from a fully measured validated report', () => {
    const cost = dimension(hrAgent, testState, 'cost', [], readyTokenEconomics())

    expect(cost).toMatchObject({
      posture: 'healthy',
      coverage: 'derived',
    })

    expect(cost.missingConnector).toBeUndefined()
    expect(cost.explanation).toContain('[SYNTHETIC]')
    expect(cost.explanation).toContain('20 of 20 calls')
    expect(cost.explanation).toContain('No token or cost anomaly')
  })

  it('uses observed coverage for a ready live measured-cost report', () => {
    const cost = dimension(
      hrAgent,
      testState,
      'cost',
      [],
      readyTokenEconomics({ source: 'azure-monitor-otel' }),
    )
    expect(cost).toMatchObject({ posture: 'healthy', coverage: 'observed' })
    expect(cost.explanation).toContain('Measured runtime observations')
  })

  it('maps measured token or cost anomalies to attention and critical postures', () => {
    const anomaly = {
      anomalyId: 'te-anomaly',
      dimension: 'cost' as const,
      severity: 'high' as const,
      baselineMedian: 0.02,
      observedMedian: 0.08,
      deviationMads: 12,
      evidenceIds: ['te-baseline-evidence', 'te-observed-evidence'],
      explanation: 'Measured cost increased.',
    }
    expect(
      dimension(hrAgent, testState, 'cost', [], readyTokenEconomics({ anomalies: [anomaly] }))
        .posture,
    ).toBe('attention')
    expect(
      dimension(
        hrAgent,
        testState,
        'cost',
        [],
        readyTokenEconomics({
          anomalies: [{ ...anomaly, severity: 'critical' }],
        }),
      ).posture,
    ).toBe('critical')
  })

  it('keeps Cost unknown for partial, unmeasured, unavailable, or mismatched reports', () => {
    const partial = readyTokenEconomics({
      coverage: {
        ...readyTokenEconomics().coverage!,
        costMeasuredCount: 10,
        measuredSuccessCount: 10,
        costCoverage: 0.5,
      },
      measuredCostUsd: 0.22,
      costPerSuccessUsd: 0.022,
    })
    expect(dimension(hrAgent, testState, 'cost', [], partial)).toMatchObject({
      posture: 'unknown',
      coverage: 'unknown',
    })
    expect(dimension(hrAgent, testState, 'cost', [], partial).explanation).toContain('50%')

    const unavailable = readyTokenEconomics({
      source: 'azure-monitor-otel',
      status: 'connector-not-connected',
      unavailableReason: 'Runtime telemetry connector is not connected.',
      coverage: undefined,
      measuredCostUsd: undefined,
      medianCostUsd: undefined,
      costPerSuccessUsd: undefined,
    })
    expect(dimension(hrAgent, testState, 'cost', [], unavailable)).toMatchObject({
      posture: 'unknown',
      coverage: 'unknown',
      missingConnector: 'Azure Monitor & measured cost telemetry',
    })

    const mismatched = readyTokenEconomics({ tenantId: 'other-tenant' })
    expect(dimension(hrAgent, testState, 'cost', [], mismatched).posture).toBe('unknown')
  })

  it('keeps Cost unknown when evidence references are incomplete', () => {
    const report = readyTokenEconomics({ observedEvidenceId: undefined })
    const cost = dimension(hrAgent, testState, 'cost', [], report)
    expect(cost.posture).toBe('unknown')
    expect(cost.explanation).toContain('evidence references are incomplete')
  })

  it('labels the finding risk score and does not present it as assurance', () => {
    const explanation = dimension(salesAgent, testState, 'security', [
      salesExposureFinding,
    ]).explanation

    expect(explanation).toContain('finding risk score: 82/100')
    expect(explanation).toContain('not an assurance score')
  })
})
