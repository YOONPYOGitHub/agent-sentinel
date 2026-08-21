import type { AgentSentinelState, ExposureFinding, GraphNode } from '@agent-sentinel/domain'

export type ScorecardPosture = 'healthy' | 'attention' | 'critical' | 'unknown'
export type ScorecardCoverage = 'observed' | 'derived' | 'unknown'
export type ScorecardDimensionId =
  'security' | 'governance' | 'lifecycle' | 'quality' | 'reliability' | 'cost'
export type ExposureLoadState = 'loading' | 'error'

export interface ScorecardDimension {
  id: ScorecardDimensionId
  label: string
  posture: ScorecardPosture
  coverage: ScorecardCoverage
  explanation: string
  findingIds: string[]
  missingConnector?: string
}

export interface AgentScorecard {
  agentId: string
  dimensions: ScorecardDimension[]
}

export interface LifecycleReadiness {
  checks: ReadonlyArray<boolean | 'unknown'>
  readinessChecks: number
  unknownChecks: number
  total: number
  readinessStatus: 'complete' | 'attention'
}

export function agentLifecycleReadiness(
  agent: GraphNode,
  state: AgentSentinelState,
  liveExposures: ExposureFinding[] | ExposureLoadState = 'loading',
): LifecycleReadiness {
  const evidenceById = new Map(state.snapshot.evidence.map((item) => [item.id, item]))
  const evidence = agent.evidenceIds
    .map((id) => evidenceById.get(id))
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
  const relatedFindingIds = new Set(
    state.findings.filter((f) => f.path.nodeIds.includes(agent.id)).map((f) => f.id),
  )
  const validationRuns = state.validations.filter((v) => relatedFindingIds.has(v.findingId))
  const version = agent.metadata.version || undefined
  const staleEvidence = evidence.filter((item) => item.freshness === 'stale').length

  // Tri-state: 'unknown' when live exposure data is not yet available
  const noActiveExposureCheck: boolean | 'unknown' = Array.isArray(liveExposures)
    ? !liveExposures.some((f) => f.affectedAgentId === agent.id && isActiveExposure(f))
    : 'unknown'

  const checks: ReadonlyArray<boolean | 'unknown'> = [
    agent.owner !== undefined,
    version !== undefined,
    evidence.length > 0 && staleEvidence === 0,
    noActiveExposureCheck,
    validationRuns.some((v) => v.status === 'validated'),
  ]

  const readinessChecks = checks.filter((c) => c === true).length
  const unknownChecks = checks.filter((c) => c === 'unknown').length

  return {
    checks,
    readinessChecks,
    unknownChecks,
    total: checks.length,
    readinessStatus: readinessChecks === checks.length ? 'complete' : 'attention',
  }
}

function lifecyclePosture(readinessChecks: number, total: number): ScorecardPosture {
  if (readinessChecks === total) return 'healthy'
  if (readinessChecks <= 2) return 'critical'
  return 'attention'
}

function isActiveExposure(finding: ExposureFinding): boolean {
  return finding.status === 'open' || finding.status === 'validated'
}

export function buildAgentScorecard(
  agent: GraphNode,
  state: AgentSentinelState,
  exposureEvidence: ExposureFinding[] | ExposureLoadState = 'loading',
): AgentScorecard {
  const liveActiveExposures = Array.isArray(exposureEvidence)
    ? exposureEvidence.filter(
        (finding) => finding.affectedAgentId === agent.id && isActiveExposure(finding),
      )
    : []
  const exposuresAvailable = Array.isArray(exposureEvidence)
  const readiness = agentLifecycleReadiness(agent, state, exposureEvidence)

  let securityPosture: ScorecardPosture = 'unknown'
  let securityCoverage: ScorecardCoverage = 'unknown'
  let securityExplanation =
    exposureEvidence === 'error'
      ? 'Live exposure data could not be loaded, so the security posture is unknown. Check connector health.'
      : 'Live exposure evidence is loading, so the security posture is unknown.'
  if (exposuresAvailable) {
    securityCoverage = 'derived'
    securityPosture = liveActiveExposures.some((finding) => finding.severity === 'critical')
      ? 'critical'
      : liveActiveExposures.length > 0
        ? 'attention'
        : 'healthy'
    securityExplanation =
      liveActiveExposures.length > 0
        ? `${liveActiveExposures.length} active exposure${liveActiveExposures.length === 1 ? ' affects' : 's affect'} this agent. Highest finding risk score: ${Math.max(...liveActiveExposures.map((finding) => finding.riskScore))}/100. This is a risk score, not an assurance score.`
        : 'No active exposures in connected evidence affect this agent.'
  }

  let governancePosture: ScorecardPosture
  if (!exposuresAvailable) {
    // Trust and ownership are static evidence; exposure status is not yet known
    if (agent.trust === 'untrusted') {
      governancePosture = 'critical'
    } else if (agent.trust !== 'trusted' || agent.owner === undefined) {
      governancePosture = 'attention'
    } else {
      governancePosture = 'unknown'
    }
  } else if (agent.trust === 'untrusted' || liveActiveExposures.length > 0) {
    governancePosture = 'critical'
  } else if (agent.trust !== 'trusted' || agent.owner === undefined) {
    governancePosture = 'attention'
  } else {
    governancePosture = 'healthy'
  }

  const dimensions: ScorecardDimension[] = [
    {
      id: 'security',
      label: 'Security',
      posture: securityPosture,
      coverage: securityCoverage,
      explanation: securityExplanation,
      findingIds: exposuresAvailable ? liveActiveExposures.map((finding) => finding.id) : [],
    },
    {
      id: 'governance',
      label: 'Governance / Compliance',
      posture: governancePosture,
      coverage: exposuresAvailable ? 'derived' : 'unknown',
      explanation: exposuresAvailable
        ? 'Owner, declared trust metadata, and connected exposure findings inform this posture. Microsoft Agent 365 remains authoritative for all admin and entitlement decisions.'
        : 'Owner and declared trust metadata are available, but exposure evidence is unavailable. Microsoft Agent 365 remains authoritative for all admin and entitlement decisions.',
      findingIds: exposuresAvailable ? liveActiveExposures.map((finding) => finding.id) : [],
    },
    {
      id: 'lifecycle',
      label: 'Lifecycle',
      posture:
        readiness.unknownChecks > 0
          ? 'unknown'
          : lifecyclePosture(readiness.readinessChecks, readiness.total),
      coverage: readiness.unknownChecks > 0 ? 'unknown' : 'derived',
      explanation: `${readiness.readinessChecks} of ${readiness.total} readiness checks are evidenced${readiness.unknownChecks > 0 ? ' (' + String(readiness.unknownChecks) + ' unknown)' : ''}: owner, version, nonempty fresh evidence, no active live exposure, and a validated run.`,
      findingIds: [],
    },
    {
      id: 'quality',
      label: 'Quality',
      posture: 'unknown',
      coverage: 'unknown',
      explanation: 'Evaluation results are not connected, so no quality posture is inferred.',
      findingIds: [],
      missingConnector: 'Azure AI Foundry Evaluation telemetry',
    },
    {
      id: 'reliability',
      label: 'Reliability',
      posture: 'unknown',
      coverage: 'unknown',
      explanation:
        'Runtime availability and failure telemetry are not connected, so no reliability posture is inferred.',
      findingIds: [],
      missingConnector: 'Azure Monitor runtime telemetry',
    },
    {
      id: 'cost',
      label: 'Cost / Efficiency',
      posture: 'unknown',
      coverage: 'unknown',
      explanation:
        'Agent-level token usage and cost telemetry are not connected, so no efficiency posture is inferred.',
      findingIds: [],
      missingConnector: 'Microsoft Cost Management usage telemetry',
    },
  ]

  return { agentId: agent.id, dimensions }
}
