import {
  driftAnalysisResultSchema,
  tokenEconomicsReportSchema,
  type AgentSentinelState,
  type DriftAnalysisResult,
  type ExposureFinding,
  type GraphNode,
  type TokenEconomicsReport,
} from '@agent-sentinel/domain'

export type ScorecardPosture = 'healthy' | 'attention' | 'critical' | 'unknown'
export type ScorecardCoverage = 'observed' | 'derived' | 'unknown'
export type ScorecardDimensionId =
  'security' | 'governance' | 'lifecycle' | 'quality' | 'reliability' | 'cost'
export type ExposureLoadState = 'loading' | 'error'
const MIN_RELIABILITY_SAMPLES = 10
const CRITICAL_OBSERVED_ERROR_RATE = 0.5

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

function unknownCostDimension(explanation: string, missingConnector?: string): ScorecardDimension {
  return {
    id: 'cost',
    label: 'Cost / Efficiency',
    posture: 'unknown',
    coverage: 'unknown',
    explanation,
    findingIds: [],
    ...(missingConnector !== undefined ? { missingConnector } : {}),
  }
}

function costDimensionFromTokenEconomics(
  agent: GraphNode,
  state: AgentSentinelState,
  report: TokenEconomicsReport | undefined,
): ScorecardDimension {
  if (report === undefined) {
    return unknownCostDimension(
      'Agent-level token usage and cost telemetry are not connected, so no efficiency posture is inferred.',
      'Azure Monitor & measured cost telemetry',
    )
  }

  const parsed = tokenEconomicsReportSchema.safeParse(report)
  if (!parsed.success) {
    return unknownCostDimension(
      'The token economics report failed contract validation, so the efficiency posture is unknown.',
    )
  }

  const validated = parsed.data
  if (
    validated.tenantId !== state.snapshot.tenantId ||
    validated.agentId !== agent.id ||
    validated.environment !== agent.environment
  ) {
    return unknownCostDimension(
      'The token economics report does not match this agent, tenant, or environment, so it was rejected.',
    )
  }

  if (validated.status !== 'ready') {
    return unknownCostDimension(
      validated.unavailableReason ??
        'Token economics analysis is not ready, so no efficiency posture is inferred.',
      validated.status === 'connector-not-connected'
        ? 'Azure Monitor & measured cost telemetry'
        : undefined,
    )
  }

  const coverage = validated.coverage
  const completeCostCoverage =
    coverage !== undefined &&
    coverage.deduplicatedObservations > 0 &&
    coverage.costCoverage === 1 &&
    coverage.costMeasuredCount === coverage.deduplicatedObservations
  if (
    !completeCostCoverage ||
    validated.measuredCostUsd === undefined ||
    validated.medianCostUsd === undefined
  ) {
    const coveragePercent = Math.round((coverage?.costCoverage ?? 0) * 100)
    return unknownCostDimension(
      `Measured cost coverage is ${coveragePercent}%. Complete per-observation cost coverage is required before deriving a Cost / Efficiency posture; missing values are never estimated.`,
    )
  }

  if (validated.baselineEvidenceId === undefined || validated.observedEvidenceId === undefined) {
    return unknownCostDimension(
      'Measured cost is present, but baseline and observed evidence references are incomplete, so no posture is inferred.',
    )
  }

  const anomalies = validated.anomalies ?? []
  if (
    anomalies.some(
      (anomaly) =>
        !anomaly.evidenceIds.includes(validated.baselineEvidenceId!) ||
        !anomaly.evidenceIds.includes(validated.observedEvidenceId!),
    )
  ) {
    return unknownCostDimension(
      'One or more token economics anomalies do not cite the report baseline and observed evidence, so no posture is inferred.',
    )
  }
  const highestSeverity = ['critical', 'high', 'medium', 'low'].find((severity) =>
    anomalies.some((anomaly) => anomaly.severity === severity),
  )
  const posture: ScorecardPosture =
    highestSeverity === 'critical'
      ? 'critical'
      : highestSeverity !== undefined
        ? 'attention'
        : 'healthy'
  const provenance =
    validated.source === 'mock-synthetic'
      ? '[SYNTHETIC] Measured mock observations'
      : 'Measured runtime observations'
  const costPerSuccess =
    validated.costPerSuccessUsd === undefined
      ? ''
      : ` Cost per measured success: $${validated.costPerSuccessUsd.toFixed(4)}.`
  const explanation =
    anomalies.length === 0
      ? `${provenance} cover ${coverage.costMeasuredCount} of ${coverage.deduplicatedObservations} calls. Measured window cost: $${validated.measuredCostUsd.toFixed(4)}; median: $${validated.medianCostUsd.toFixed(4)}.${costPerSuccess} No token or cost anomaly crossed a deterministic threshold.`
      : `${provenance} cover ${coverage.costMeasuredCount} of ${coverage.deduplicatedObservations} calls. ${anomalies.length} token/cost anomal${anomalies.length === 1 ? 'y' : 'ies'} crossed deterministic thresholds; highest severity: ${highestSeverity}.${costPerSuccess}`

  return {
    id: 'cost',
    label: 'Cost / Efficiency',
    posture,
    coverage: validated.source === 'azure-monitor-otel' ? 'observed' : 'derived',
    explanation,
    findingIds: [],
  }
}

function unknownReliabilityDimension(
  explanation: string,
  missingConnector?: string,
): ScorecardDimension {
  return {
    id: 'reliability',
    label: 'Reliability',
    posture: 'unknown',
    coverage: 'unknown',
    explanation,
    findingIds: [],
    ...(missingConnector !== undefined ? { missingConnector } : {}),
  }
}

function reliabilityDimensionFromDrift(
  agent: GraphNode,
  state: AgentSentinelState,
  result: DriftAnalysisResult | null | undefined,
): ScorecardDimension {
  if (result === undefined) {
    return unknownReliabilityDimension(
      'Runtime availability and failure telemetry are not connected, so no reliability posture is inferred.',
      'Azure Monitor runtime telemetry',
    )
  }
  if (result === null) {
    return unknownReliabilityDimension(
      'Live runtime reliability evidence is loading or could not be loaded, so no reliability posture is inferred.',
    )
  }

  const parsed = driftAnalysisResultSchema.safeParse(result)
  if (!parsed.success) {
    return unknownReliabilityDimension(
      'The runtime drift result failed contract validation, so the reliability posture is unknown.',
    )
  }

  const validated = parsed.data
  const snapshotAgent = state.snapshot.nodes.find(
    (node) => node.kind === 'agent' && node.id === agent.id,
  )
  if (snapshotAgent === undefined) {
    return unknownReliabilityDimension(
      'The runtime drift result cannot be matched to exactly one agent in the estate snapshot, so no reliability posture is inferred.',
    )
  }
  const expectedEnvironment = snapshotAgent.metadata.sourceEnvironment ?? snapshotAgent.environment
  if (
    validated.tenantId !== state.snapshot.tenantId ||
    validated.agentId !== agent.id ||
    validated.environment !== expectedEnvironment
  ) {
    return unknownReliabilityDimension(
      'The runtime drift result does not match this agent, tenant, or environment, so it was rejected.',
    )
  }
  if (validated.status !== 'ready') {
    return unknownReliabilityDimension(
      validated.unavailableReason ??
        'Runtime drift analysis is not ready, so no reliability posture is inferred.',
    )
  }
  if (
    validated.baselineWindowId === undefined ||
    validated.baselineWindowId.trim() === '' ||
    validated.observedWindowId === undefined ||
    validated.observedWindowId.trim() === '' ||
    validated.baselineEvidenceId === undefined ||
    validated.baselineEvidenceId.trim() === '' ||
    validated.observedEvidenceId === undefined ||
    validated.observedEvidenceId.trim() === ''
  ) {
    return unknownReliabilityDimension(
      'Runtime error-rate analysis is ready, but baseline and observed evidence references are incomplete, so no reliability posture is inferred.',
    )
  }
  if (
    validated.coverage === undefined ||
    validated.coverage.baselineSamples < MIN_RELIABILITY_SAMPLES ||
    validated.coverage.observedSamples < MIN_RELIABILITY_SAMPLES ||
    !validated.coverage.metricsWithData.includes('error-rate')
  ) {
    return unknownReliabilityDimension(
      `Runtime error-rate coverage does not meet the required ${MIN_RELIABILITY_SAMPLES} baseline and observed samples, so no reliability posture is inferred.`,
    )
  }

  const synthetic = validated.source === 'mock-synthetic'
  const expectedEvidenceType = synthetic ? 'synthetic_validation' : 'observed_runtime'
  const expectedEvidence = [
    {
      id: synthetic ? `${validated.baselineEvidenceId}-synthetic` : validated.baselineEvidenceId,
      windowKind: 'baseline',
      sourceObjectId: validated.baselineWindowId,
    },
    {
      id: synthetic ? `${validated.observedEvidenceId}-synthetic` : validated.observedEvidenceId,
      windowKind: 'observed',
      sourceObjectId: validated.observedWindowId,
    },
  ] as const
  const evidenceMatches = expectedEvidence.every(({ id, sourceObjectId, windowKind }) => {
    const evidence = state.snapshot.evidence.find((item) => item.id === id)
    return (
      snapshotAgent.evidenceIds.includes(id) &&
      evidence?.sourceObjectId === sourceObjectId &&
      evidence?.evidenceTypes.includes(expectedEvidenceType) === true &&
      evidence.metadata?.sourceConnector === 'azure-monitor-otel' &&
      evidence.metadata.windowKind === windowKind
    )
  })
  if (!evidenceMatches) {
    return unknownReliabilityDimension(
      'The estate snapshot does not contain the exact baseline and observed runtime evidence linked to this agent, so no reliability posture is inferred.',
    )
  }

  const errorRate = validated.dimensions.find((dimension) => dimension.dimension === 'error-rate')
  if (
    errorRate === undefined ||
    errorRate.baselineRate === undefined ||
    errorRate.observedRate === undefined
  ) {
    return unknownReliabilityDimension(
      'Runtime drift analysis does not contain a measured baseline and observed error rate, so no reliability posture is inferred.',
    )
  }

  const posture: ScorecardPosture =
    errorRate.observedRate >= CRITICAL_OBSERVED_ERROR_RATE
      ? 'critical'
      : errorRate.observedRate > 0
        ? 'attention'
        : 'healthy'
  const provenance =
    validated.source === 'mock-synthetic'
      ? '[SYNTHETIC] Measured mock observations'
      : 'Measured runtime observations'
  const coverage =
    validated.coverage === undefined
      ? ''
      : ` Coverage: ${validated.coverage.baselineSamples} baseline and ${validated.coverage.observedSamples} observed samples.`
  const direction =
    errorRate.observedRate > errorRate.baselineRate
      ? 'increased'
      : errorRate.observedRate < errorRate.baselineRate
        ? 'decreased'
        : 'remained unchanged'
  const explanation = `${provenance} show the error rate ${direction} from ${(errorRate.baselineRate * 100).toFixed(1)}% to ${(errorRate.observedRate * 100).toFixed(1)}%.${coverage} ${
    posture === 'critical'
      ? `The observed error rate meets or exceeds the ${(CRITICAL_OBSERVED_ERROR_RATE * 100).toFixed(0)}% critical reliability threshold.`
      : posture === 'attention'
        ? 'Measured failures are present, so the reliability posture requires attention.'
        : 'No measured failures are present in the observed window.'
  }`

  return {
    id: 'reliability',
    label: 'Reliability',
    posture,
    coverage: validated.source === 'azure-monitor-otel' ? 'observed' : 'derived',
    explanation,
    findingIds: [],
  }
}

export function buildAgentScorecard(
  agent: GraphNode,
  state: AgentSentinelState,
  exposureEvidence: ExposureFinding[] | ExposureLoadState = 'loading',
  tokenEconomicsReport?: TokenEconomicsReport,
  driftAnalysis?: DriftAnalysisResult | null,
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
    reliabilityDimensionFromDrift(agent, state, driftAnalysis),
    costDimensionFromTokenEconomics(agent, state, tokenEconomicsReport),
  ]

  return { agentId: agent.id, dimensions }
}
