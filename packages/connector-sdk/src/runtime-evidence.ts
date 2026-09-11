import {
  assessRuntimeOtelQuality,
  authoritativeRuntimeAgentBinding,
  estateSnapshotSchema,
  evidenceSchema,
  runtimeOtelProvenanceSchema,
  type EstateSnapshot,
  type EstateContext,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type ObservationWindow,
  type OtelEvidenceCaveat,
  type RuntimeOtelEvidenceItem,
  type RuntimeObservation,
} from '@agent-sentinel/domain'

import {
  runtimeObservationWindowsSchema,
  type LiveSourceDataState,
  type RuntimeObservationWindows,
  type RuntimeTelemetryRequest,
} from './index.js'

export interface RuntimeEvidenceProjection {
  snapshot: EstateSnapshot
  addedEvidenceCount: number
  evidenceIds: string[]
  unmatchedToolCallNames: string[]
  windows: RuntimeObservationWindows
  dataState: {
    state: Exclude<LiveSourceDataState, 'failed' | 'cancelled'>
    reason?: string
  }
}

export type RuntimeEvidenceProjectionAuthority = RuntimeTelemetryRequest | EstateContext

export function runtimeTelemetryRequestForAgent(
  snapshot: EstateSnapshot,
  agent: GraphNode,
  estate?: EstateContext,
): RuntimeTelemetryRequest | undefined {
  const binding = authoritativeRuntimeAgentBinding(snapshot, agent, estate)
  if (binding === undefined) return undefined
  return {
    snapshotGeneratedAt: snapshot.generatedAt,
    ...(estate === undefined
      ? {}
      : {
          estateId: estate.id,
          estateEnvironment: estate.environment,
        }),
    tenantId: snapshot.tenantId,
    agentId: agent.id,
    ...binding,
  }
}

export function validateRuntimeTelemetryProvenance(
  request: RuntimeTelemetryRequest,
  windowsInput: RuntimeObservationWindows,
): RuntimeObservationWindows {
  const windows = runtimeObservationWindowsSchema.parse(windowsInput)
  if (request.estateId === undefined || request.estateEnvironment === undefined) {
    throw new Error('Runtime telemetry requests require exact estate identity.')
  }
  if (request.snapshotGeneratedAt === undefined) {
    throw new Error('Runtime telemetry requests require exact snapshot generation.')
  }
  const sourceConnectorId = request.sourceConnectorId
  const sourceTenantId = request.sourceTenantId ?? request.tenantId
  const sourceProjectId = request.sourceProjectId
  const sourceEnvironment = request.sourceEnvironment ?? windows.observed.environment
  const sourceAgentId = request.sourceAgentId ?? request.agentId
  const provenance = windows.provenance
  if (
    windows.baseline.tenantId !== request.tenantId ||
    windows.observed.tenantId !== request.tenantId ||
    windows.baseline.agentId !== request.agentId ||
    windows.observed.agentId !== request.agentId ||
    windows.baseline.environment !== sourceEnvironment ||
    windows.observed.environment !== sourceEnvironment ||
    provenance === undefined ||
    provenance.snapshotGeneratedAt !== request.snapshotGeneratedAt ||
    provenance.estateId !== request.estateId ||
    provenance.estateTenantId !== request.tenantId ||
    provenance.estateEnvironment !== request.estateEnvironment ||
    (sourceConnectorId !== undefined && provenance.sourceConnectorId !== sourceConnectorId) ||
    provenance.sourceTenantId !== sourceTenantId ||
    sourceProjectId === undefined ||
    provenance.sourceProjectId !== sourceProjectId ||
    provenance.sourceEnvironment !== sourceEnvironment ||
    provenance.providerAgentId !== sourceAgentId
  ) {
    throw new Error('Runtime telemetry response provenance does not match the exact request.')
  }
  for (const window of [windows.baseline, windows.observed]) {
    for (const observation of window.observations) {
      const nested = runtimeOtelProvenanceSchema.safeParse(observation.otelProvenance)
      const expectedClassification = observation.synthetic ? 'synthetic' : 'live'
      if (
        !nested.success ||
        nested.data.snapshotGeneratedAt !== provenance.snapshotGeneratedAt ||
        observation.tenantId !== request.tenantId ||
        observation.agentId !== request.agentId ||
        observation.environment !== sourceEnvironment ||
        nested.data.estateId !== provenance.estateId ||
        nested.data.estateTenantId !== provenance.estateTenantId ||
        nested.data.estateEnvironment !== provenance.estateEnvironment ||
        nested.data.sourceConnectorId !== provenance.sourceConnectorId ||
        nested.data.sourceTenantId !== provenance.sourceTenantId ||
        nested.data.sourceProjectId !== provenance.sourceProjectId ||
        nested.data.sourceEnvironment !== provenance.sourceEnvironment ||
        nested.data.provider !== provenance.provider ||
        nested.data.providerResourceId !== provenance.providerResourceId ||
        nested.data.providerAgentId !== provenance.providerAgentId ||
        nested.data.observedAt !== observation.observedAt ||
        nested.data.classification !== expectedClassification
      ) {
        throw new Error('Runtime observation provenance does not match the exact request.')
      }
    }
  }
  return windows
}

function isRuntimeTelemetryRequest(
  authority: RuntimeEvidenceProjectionAuthority,
): authority is RuntimeTelemetryRequest {
  return 'agentId' in authority
}

function authoritativeProjectionAgentForRequest(
  snapshot: EstateSnapshot,
  request: RuntimeTelemetryRequest,
): GraphNode {
  if (
    request.snapshotGeneratedAt !== snapshot.generatedAt ||
    request.estateId === undefined ||
    request.estateEnvironment === undefined ||
    request.tenantId !== snapshot.tenantId
  ) {
    throw new Error(
      'Runtime evidence projection requires the exact authoritative telemetry request.',
    )
  }
  const agents = snapshot.nodes.filter(
    (node) => node.kind === 'agent' && node.id === request.agentId,
  )
  if (agents.length !== 1) {
    throw new Error('Runtime evidence projection requires the selected authoritative agent.')
  }
  const agent = agents[0]!
  const binding = authoritativeRuntimeAgentBinding(snapshot, agent, {
    id: request.estateId,
    tenantId: request.tenantId,
    environment: request.estateEnvironment,
  })
  if (
    binding === undefined ||
    request.sourceConnectorId !== binding.sourceConnectorId ||
    request.sourceTenantId !== binding.sourceTenantId ||
    request.sourceProjectId !== binding.sourceProjectId ||
    request.sourceAgentId !== binding.sourceAgentId ||
    request.sourceEnvironment !== binding.sourceEnvironment
  ) {
    throw new Error(
      'Runtime evidence projection requires the exact authoritative telemetry request.',
    )
  }
  return agent
}

function authoritativeProjectionAgentForEstate(
  snapshot: EstateSnapshot,
  windows: RuntimeObservationWindows,
  estate: EstateContext,
): GraphNode {
  const provenance = windows.provenance
  if (
    estate.tenantId !== snapshot.tenantId ||
    estate.environment !== snapshot.environment ||
    provenance === undefined ||
    provenance.estateId !== estate.id ||
    provenance.estateTenantId !== estate.tenantId ||
    provenance.estateEnvironment !== estate.environment
  ) {
    throw new Error('Runtime evidence projection requires the exact trusted EstateContext.')
  }
  const selectedAgents = snapshot.nodes.filter(
    (node) => node.kind === 'agent' && node.id === windows.observed.agentId,
  )
  if (
    selectedAgents.length === 1 &&
    authoritativeRuntimeAgentBinding(snapshot, selectedAgents[0]!, estate) === undefined
  ) {
    throw new Error('Runtime telemetry requires exact authoritative discovered agent evidence.')
  }
  const agents = snapshot.nodes.filter((node) => {
    const binding = authoritativeRuntimeAgentBinding(snapshot, node, estate)
    return (
      binding !== undefined &&
      binding.sourceConnectorId === provenance.sourceConnectorId &&
      binding.sourceTenantId === provenance.sourceTenantId &&
      binding.sourceProjectId === provenance.sourceProjectId &&
      binding.sourceAgentId === provenance.providerAgentId &&
      binding.sourceEnvironment === provenance.sourceEnvironment
    )
  })
  if (agents.length !== 1) {
    throw new Error('Runtime evidence projection requires the selected authoritative agent.')
  }
  return agents[0]!
}

function authoritativeProjectionAgent(
  snapshot: EstateSnapshot,
  windows: RuntimeObservationWindows,
  authority: RuntimeEvidenceProjectionAuthority,
): GraphNode {
  const agent = isRuntimeTelemetryRequest(authority)
    ? authoritativeProjectionAgentForRequest(snapshot, authority)
    : authoritativeProjectionAgentForEstate(snapshot, windows, authority)
  const aggregateAgentIds = [
    windows.baseline.agentId,
    windows.observed.agentId,
    ...windows.baseline.observations.map((observation) => observation.agentId),
    ...windows.observed.observations.map((observation) => observation.agentId),
  ]
  if (aggregateAgentIds.some((agentId) => agentId !== agent.id)) {
    throw new Error('Runtime evidence projection requires the selected authoritative agent.')
  }
  if (
    windows.provenance !== undefined &&
    (isRuntimeTelemetryRequest(authority)
      ? windows.provenance.estateId !== authority.estateId ||
        windows.provenance.estateTenantId !== authority.tenantId ||
        windows.provenance.estateEnvironment !== authority.estateEnvironment
      : windows.provenance.estateId !== authority.id ||
        windows.provenance.estateTenantId !== authority.tenantId ||
        windows.provenance.estateEnvironment !== authority.environment)
  ) {
    throw new Error(
      'Runtime evidence projection requires the exact authoritative telemetry request.',
    )
  }
  return agent
}

export function withoutSyntheticObservations(
  windows: RuntimeObservationWindows,
): RuntimeObservationWindows {
  const withoutSynthetic = (window: ObservationWindow): ObservationWindow => {
    const observations = window.observations.filter((item) => !item.synthetic)
    if (
      window.otelQuality === undefined ||
      observations.length > 0 ||
      window.observations.every((item) => !item.synthetic)
    ) {
      return { ...window, observations }
    }
    return {
      ...window,
      observations,
      otelQuality: {
        status: 'unknown',
        classification: 'unknown',
        caveats: ['empty'],
        recordsReceived: window.otelQuality.recordsReceived,
        recordsAccepted: 0,
        duplicatesRemoved: 0,
        pagesProcessed: window.otelQuality.pagesProcessed,
      },
    }
  }
  return runtimeObservationWindowsSchema.parse({
    ...windows,
    baseline: withoutSynthetic(windows.baseline),
    observed: withoutSynthetic(windows.observed),
  })
}

function evidenceId(baseId: string, synthetic: boolean): string {
  return synthetic ? `${baseId}-synthetic` : baseId
}

function appendEvidenceId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids : [...ids, id]
}

function correlationValue(
  observation: RuntimeObservation,
  kind: 'agent-run-id' | 'correlation-id' | 'agent-version',
): string | undefined {
  return observation.correlations?.find((correlation) => correlation.kind === kind)?.value
}

function runtimeOtelEvidenceItem(
  observation: RuntimeObservation,
  matchedToolCallNames: ReadonlySet<string>,
): RuntimeOtelEvidenceItem {
  if (
    observation.otelProvenance === undefined ||
    observation.latencyMs === undefined ||
    observation.inputTokens === undefined ||
    observation.outputTokens === undefined ||
    observation.costUsd === undefined
  ) {
    throw new Error(
      'Normalized OpenTelemetry evidence requires exact invocation, latency, error, token, and cost claims.',
    )
  }
  const agentRunId = correlationValue(observation, 'agent-run-id')
  const correlationId = correlationValue(observation, 'correlation-id')
  const agentVersion = correlationValue(observation, 'agent-version')
  return {
    id: observation.id,
    observedAt: observation.observedAt,
    ...(agentRunId === undefined ? {} : { agentRunId }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(agentVersion === undefined ? {} : { agentVersion }),
    latencyMs: observation.latencyMs,
    inputTokens: observation.inputTokens,
    outputTokens: observation.outputTokens,
    costUsd: observation.costUsd,
    success: observation.success,
    ...(observation.errorCode !== undefined ? { errorCode: observation.errorCode } : {}),
    toolCallNames: observation.toolCallNames.filter((name) => matchedToolCallNames.has(name)),
    provenance: observation.otelProvenance,
  }
}

function evidenceForWindow(
  window: ObservationWindow,
  observations: RuntimeObservation[],
  baseId: string,
  kind: 'baseline' | 'observed',
  synthetic: boolean,
  agentName: string,
  matchedToolCallNames: ReadonlySet<string>,
  unmatchedToolCallNames: string[],
  sourceProvenance: RuntimeObservationWindows['provenance'],
): Evidence {
  const qualityStatus = window.otelQuality?.status ?? 'available'
  const successCount = observations.filter((item) => item.success).length
  const latestObservedAt = observations
    .map((item) => item.observedAt)
    .sort((left, right) => right.localeCompare(left))[0]
  const evidenceTypes =
    qualityStatus === 'available'
      ? [synthetic ? ('synthetic_validation' as const) : ('observed_runtime' as const)]
      : synthetic
        ? (['synthetic_validation', 'unknown'] as const)
        : (['unknown'] as const)
  const summary =
    qualityStatus === 'available'
      ? `${observations.length} directly measured ${synthetic ? 'synthetic validation' : 'runtime'} invocation${observations.length === 1 ? '' : 's'} for ${agentName}; ${successCount} succeeded and ${observations.length - successCount} failed.`
      : `OpenTelemetry ${kind} evidence for ${agentName} is ${qualityStatus}; no runtime success claim was established.`
  return evidenceSchema.parse({
    id: evidenceId(baseId, synthetic),
    source: 'Azure Monitor OpenTelemetry',
    sourceObjectId: window.windowId,
    observedAt: latestObservedAt ?? window.windowEnd,
    freshness: window.otelQuality?.caveats.includes('stale')
      ? 'stale'
      : kind === 'observed'
        ? 'live'
        : 'recent',
    confidence: qualityStatus === 'available' ? 1 : 0,
    evidenceTypes,
    summary,
    metadata: {
      sourceConnector: 'azure-monitor-otel',
      windowKind: kind,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      observationCount: String(observations.length),
      successfulObservationCount: String(successCount),
      failedObservationCount: String(observations.length - successCount),
      synthetic: String(synthetic),
      evidenceStatus: qualityStatus,
      evidenceCaveats: JSON.stringify(window.otelQuality?.caveats ?? []),
      recordsReceived: String(window.otelQuality?.recordsReceived ?? observations.length),
      recordsAccepted: String(window.otelQuality?.recordsAccepted ?? observations.length),
      duplicatesRemoved: String(window.otelQuality?.duplicatesRemoved ?? 0),
      unmatchedToolCallNames: JSON.stringify(unmatchedToolCallNames),
      ...(sourceProvenance === undefined
        ? {}
        : {
            estateId: sourceProvenance.estateId,
            estateTenantId: sourceProvenance.estateTenantId,
            estateEnvironment: sourceProvenance.estateEnvironment,
            sourceConnectorId: sourceProvenance.sourceConnectorId,
            sourceTenantId: sourceProvenance.sourceTenantId,
            sourceProjectId: sourceProvenance.sourceProjectId,
            sourceEnvironment: sourceProvenance.sourceEnvironment,
            sourceAgentId: sourceProvenance.providerAgentId,
          }),
    },
    ...(window.otelQuality !== undefined
      ? {
          otel: {
            quality: window.otelQuality,
            invocations: observations.map((observation) =>
              runtimeOtelEvidenceItem(observation, matchedToolCallNames),
            ),
          },
        }
      : {}),
  })
}

function classificationForObservations(
  observations: readonly RuntimeObservation[],
): 'live' | 'synthetic' | 'mixed' | 'unknown' {
  if (observations.length === 0) return 'unknown'
  const classifications = new Set(
    observations.map((observation) => (observation.synthetic ? 'synthetic' : 'live')),
  )
  if (classifications.size > 1) return 'mixed'
  return classifications.has('synthetic') ? 'synthetic' : 'live'
}

function degradeOtelWindow(
  window: ObservationWindow,
  observations: RuntimeObservation[],
  addedCaveats: readonly OtelEvidenceCaveat[] = ['invalid-record'],
): ObservationWindow {
  const existing = window.otelQuality
  return {
    ...window,
    observations,
    otelQuality: {
      recordsReceived:
        existing?.recordsReceived ?? Math.min(window.observations.length * 6, 10_000),
      recordsAccepted: existing?.recordsAccepted ?? Math.min(observations.length * 6, 10_000),
      duplicatesRemoved: existing?.duplicatesRemoved ?? 0,
      pagesProcessed: existing?.pagesProcessed ?? 0,
      status: 'degraded',
      classification: classificationForObservations(observations),
      caveats: [...new Set([...(existing?.caveats ?? []), ...addedCaveats])].sort(),
    },
  }
}

function removeMalformedOtelObservations(
  windowsInput: RuntimeObservationWindows,
): RuntimeObservationWindows {
  const windows = structuredClone(windowsInput)
  for (const window of [windows.baseline, windows.observed]) {
    let removed = false
    window.observations = window.observations.filter((observation) => {
      const parsed = runtimeOtelProvenanceSchema.safeParse(observation.otelProvenance)
      if (!parsed.success) {
        removed = true
        return false
      }
      observation.otelProvenance = parsed.data
      return true
    })
    if (removed) {
      const degraded = degradeOtelWindow(window, window.observations)
      window.otelQuality = degraded.otelQuality
    }
  }
  return windows
}

function hasExactOtelProvenance(
  snapshot: EstateSnapshot,
  agent: GraphNode,
  window: ObservationWindow,
  observation: RuntimeObservation,
  expectedProvenance: RuntimeObservationWindows['provenance'],
): boolean {
  const sourceConnectorId = agent.metadata['sourceConnectorId']
  const sourceTenantId = agent.metadata['sourceTenantId']
  const sourceProjectId = agent.metadata['sourceProjectId']
  const sourceAgentId = agent.metadata['sourceObjectId']
  const sourceEnvironment = agent.metadata['sourceEnvironment'] ?? agent.environment
  const provenance = observation.otelProvenance
  if (
    provenance === undefined ||
    expectedProvenance === undefined ||
    sourceConnectorId === undefined ||
    sourceTenantId === undefined ||
    sourceProjectId === undefined ||
    sourceAgentId === undefined
  ) {
    return false
  }
  const expectedClassification = observation.synthetic ? 'synthetic' : 'live'
  return (
    observation.tenantId === window.tenantId &&
    observation.agentId === window.agentId &&
    observation.environment === window.environment &&
    observation.source === window.source &&
    provenance.estateId === expectedProvenance.estateId &&
    provenance.snapshotGeneratedAt === snapshot.generatedAt &&
    provenance.snapshotGeneratedAt === expectedProvenance.snapshotGeneratedAt &&
    provenance.estateTenantId === observation.tenantId &&
    provenance.estateTenantId === snapshot.tenantId &&
    provenance.estateEnvironment === snapshot.environment &&
    provenance.sourceConnectorId === sourceConnectorId &&
    provenance.sourceTenantId === sourceTenantId &&
    provenance.sourceProjectId === sourceProjectId &&
    provenance.sourceEnvironment === observation.environment &&
    provenance.sourceEnvironment === sourceEnvironment &&
    provenance.provider === observation.source &&
    provenance.providerResourceId === expectedProvenance.providerResourceId &&
    provenance.providerAgentId === sourceAgentId &&
    provenance.observedAt === observation.observedAt &&
    provenance.classification === expectedClassification &&
    provenance.estateTenantId === expectedProvenance.estateTenantId &&
    provenance.estateEnvironment === expectedProvenance.estateEnvironment &&
    provenance.sourceConnectorId === expectedProvenance.sourceConnectorId &&
    provenance.sourceTenantId === expectedProvenance.sourceTenantId &&
    provenance.sourceProjectId === expectedProvenance.sourceProjectId &&
    provenance.sourceEnvironment === expectedProvenance.sourceEnvironment &&
    provenance.provider === expectedProvenance.provider &&
    provenance.providerAgentId === expectedProvenance.providerAgentId
  )
}

function enforceExactOtelProvenance(
  snapshot: EstateSnapshot,
  agent: GraphNode,
  windows: RuntimeObservationWindows,
): RuntimeObservationWindows {
  const sourceConnectorId = agent.metadata['sourceConnectorId']
  const sourceTenantId = agent.metadata['sourceTenantId']
  const sourceProjectId = agent.metadata['sourceProjectId']
  const sourceAgentId = agent.metadata['sourceObjectId']
  const sourceEnvironment = agent.metadata['sourceEnvironment'] ?? agent.environment
  const provenance = windows.provenance
  const nestedProvenance = [windows.baseline, windows.observed].flatMap((window) =>
    window.observations.flatMap((observation) =>
      observation.otelProvenance === undefined ? [] : [observation.otelProvenance],
    ),
  )
  const nestedBoundaryMatches =
    provenance !== undefined &&
    nestedProvenance.every(
      (nested) =>
        nested.snapshotGeneratedAt === provenance.snapshotGeneratedAt &&
        nested.estateId === provenance.estateId &&
        nested.estateTenantId === provenance.estateTenantId &&
        nested.estateEnvironment === provenance.estateEnvironment &&
        nested.sourceConnectorId === provenance.sourceConnectorId &&
        nested.sourceTenantId === provenance.sourceTenantId &&
        nested.sourceProjectId === provenance.sourceProjectId &&
        nested.sourceEnvironment === provenance.sourceEnvironment &&
        nested.provider === provenance.provider &&
        nested.providerResourceId === provenance.providerResourceId &&
        nested.providerAgentId === provenance.providerAgentId,
    )
  const expectedProvenance =
    provenance !== undefined &&
    nestedBoundaryMatches &&
    sourceConnectorId !== undefined &&
    sourceTenantId !== undefined &&
    sourceProjectId !== undefined &&
    sourceAgentId !== undefined &&
    provenance.snapshotGeneratedAt === snapshot.generatedAt &&
    provenance.estateTenantId === snapshot.tenantId &&
    provenance.estateEnvironment === snapshot.environment &&
    provenance.sourceConnectorId === sourceConnectorId &&
    provenance.sourceTenantId === sourceTenantId &&
    provenance.sourceProjectId === sourceProjectId &&
    provenance.sourceEnvironment === sourceEnvironment &&
    provenance.provider === 'azure-monitor-otel' &&
    provenance.providerAgentId === sourceAgentId
      ? provenance
      : undefined

  const exactWindow = (window: ObservationWindow): ObservationWindow => {
    if (window.otelQuality === undefined) return window
    const observations = window.observations.filter((observation) =>
      hasExactOtelProvenance(snapshot, agent, window, observation, expectedProvenance),
    )
    return observations.length === window.observations.length &&
      (observations.length > 0 || window.otelQuality.status !== 'available')
      ? window
      : degradeOtelWindow(window, observations)
  }

  return runtimeObservationWindowsSchema.parse({
    ...windows,
    baseline: exactWindow(windows.baseline),
    observed: exactWindow(windows.observed),
  })
}

export function recomputeRuntimeOtelQuality(
  windows: RuntimeObservationWindows,
): RuntimeObservationWindows {
  const assessedWindow = (window: ObservationWindow): ObservationWindow => {
    const assessment = assessRuntimeOtelQuality(window, {
      queriedAt: windows.queriedAt,
      maximumFreshnessHours: windows.maximumFreshnessHours ?? Number.NaN,
    })
    const validObservationIds = new Set(assessment.validObservationIds)
    return {
      ...window,
      observations: window.observations.filter((observation) =>
        validObservationIds.has(observation.id),
      ),
      ...(assessment.quality !== undefined ? { otelQuality: assessment.quality } : {}),
    }
  }

  return runtimeObservationWindowsSchema.parse({
    ...windows,
    baseline: assessedWindow(windows.baseline),
    observed: assessedWindow(windows.observed),
  })
}

function projectedRuntimeDataState(windows: RuntimeObservationWindows): {
  state: Exclude<LiveSourceDataState, 'failed' | 'cancelled'>
  reason?: string
} {
  const observations = [...windows.baseline.observations, ...windows.observed.observations]
  const quality = [windows.baseline.otelQuality, windows.observed.otelQuality].filter(
    (item) => item !== undefined,
  )
  if (quality.some((item) => item.caveats.includes('stale'))) {
    return { state: 'stale', reason: 'stale' }
  }
  if (observations.length === 0) {
    return quality.some((item) => item.status !== 'available')
      ? { state: 'partial', reason: 'degraded-quality' }
      : { state: 'empty', reason: 'empty' }
  }
  const live = observations.filter((observation) => !observation.synthetic).length
  if (live === 0) return { state: 'unsupported', reason: 'synthetic-only' }
  if (quality.some((item) => item.status !== 'available')) {
    return { state: 'partial', reason: 'degraded-quality' }
  }
  if (live < observations.length) {
    return { state: 'partial', reason: 'mixed-live-synthetic' }
  }
  return { state: 'complete' }
}

function exactToolMatches(
  nodes: GraphNode[],
  edges: GraphEdge[],
  agentId: string,
  toolName: string,
): { node: GraphNode; edge: GraphEdge } | undefined {
  const matches = edges.flatMap((edge) => {
    if (edge.from !== agentId || edge.relationship !== 'CAN_CALL') return []
    const node = nodes.find(
      (candidate) =>
        candidate.id === edge.to && candidate.kind === 'tool' && candidate.name === toolName,
    )
    return node === undefined ? [] : [{ node, edge }]
  })
  return matches.length === 1 ? matches[0] : undefined
}

function exactRuntimeEvidenceBoundary(
  evidence: Evidence,
  request: RuntimeTelemetryRequest,
): boolean {
  if (
    evidence.metadata?.['sourceConnector'] !== 'azure-monitor-otel' ||
    request.estateId === undefined ||
    request.estateEnvironment === undefined ||
    request.sourceConnectorId === undefined ||
    request.sourceTenantId === undefined ||
    request.sourceProjectId === undefined ||
    request.sourceAgentId === undefined ||
    request.sourceEnvironment === undefined
  ) {
    return false
  }
  const metadata = evidence.metadata
  const metadataMatches =
    metadata['estateId'] === request.estateId &&
    metadata['estateTenantId'] === request.tenantId &&
    metadata['estateEnvironment'] === request.estateEnvironment &&
    metadata['sourceConnectorId'] === request.sourceConnectorId &&
    metadata['sourceTenantId'] === request.sourceTenantId &&
    metadata['sourceProjectId'] === request.sourceProjectId &&
    metadata['sourceEnvironment'] === request.sourceEnvironment &&
    metadata['sourceAgentId'] === request.sourceAgentId
  if (metadataMatches) return true

  const invocations = evidence.otel?.invocations ?? []
  return (
    invocations.length > 0 &&
    invocations.every(
      (invocation) =>
        invocation.provenance.estateId === request.estateId &&
        invocation.provenance.estateTenantId === request.tenantId &&
        invocation.provenance.estateEnvironment === request.estateEnvironment &&
        invocation.provenance.sourceConnectorId === request.sourceConnectorId &&
        invocation.provenance.sourceTenantId === request.sourceTenantId &&
        invocation.provenance.sourceProjectId === request.sourceProjectId &&
        invocation.provenance.sourceEnvironment === request.sourceEnvironment &&
        invocation.provenance.providerAgentId === request.sourceAgentId,
    )
  )
}

export function removeRuntimeEvidenceForRequest(
  snapshotInput: EstateSnapshot,
  request: RuntimeTelemetryRequest,
): EstateSnapshot {
  const snapshot = estateSnapshotSchema.parse(structuredClone(snapshotInput))
  const removedIds = new Set(
    snapshot.evidence
      .filter((evidence) => exactRuntimeEvidenceBoundary(evidence, request))
      .map((evidence) => evidence.id),
  )
  if (removedIds.size === 0) return snapshot
  snapshot.evidence = snapshot.evidence.filter((evidence) => !removedIds.has(evidence.id))
  for (const node of snapshot.nodes) {
    node.evidenceIds = node.evidenceIds.filter((evidenceId) => !removedIds.has(evidenceId))
  }
  for (const edge of snapshot.edges) {
    edge.evidenceIds = edge.evidenceIds.filter((evidenceId) => !removedIds.has(evidenceId))
  }
  return estateSnapshotSchema.parse(snapshot)
}

export function projectRuntimeEvidence(
  snapshotInput: EstateSnapshot,
  windowsInput: RuntimeObservationWindows,
  authority: RuntimeEvidenceProjectionAuthority,
): RuntimeEvidenceProjection {
  let snapshot = estateSnapshotSchema.parse(structuredClone(snapshotInput))
  let windows = runtimeObservationWindowsSchema.parse(removeMalformedOtelObservations(windowsInput))
  let agent = authoritativeProjectionAgent(snapshot, windows, authority)
  if ('agentId' in authority) {
    snapshot = removeRuntimeEvidenceForRequest(snapshot, authority)
    agent = authoritativeProjectionAgent(snapshot, windows, authority)
  }
  const expectedEnvironment = agent.metadata['sourceEnvironment'] ?? agent.environment
  if (
    windows.observed.tenantId !== snapshot.tenantId ||
    windows.observed.environment !== expectedEnvironment
  ) {
    throw new Error('Runtime telemetry does not match the estate tenant and agent environment.')
  }
  windows = enforceExactOtelProvenance(snapshot, agent, windows)
  windows = recomputeRuntimeOtelQuality(windows)
  const unmatched = new Set<string>()
  let addedEvidenceCount = 0
  const projectedEvidenceIds: string[] = []

  for (const [kind, window, baseId] of [
    ['baseline', windows.baseline, windows.baselineEvidenceId],
    ['observed', windows.observed, windows.observedEvidenceId],
  ] as const) {
    const classifications =
      window.observations.length === 0 && window.otelQuality !== undefined
        ? [window.otelQuality.classification === 'synthetic']
        : [false, true]
    for (const synthetic of classifications) {
      const observations = window.observations.filter((item) => item.synthetic === synthetic)
      if (observations.length === 0 && window.observations.length > 0) continue
      if (observations.length === 0 && window.otelQuality === undefined) continue
      const toolNames = new Set(observations.flatMap((item) => item.toolCallNames))
      const matches = new Map<string, { node: GraphNode; edge: GraphEdge }>()
      if ((window.otelQuality?.status ?? 'available') === 'available') {
        for (const toolName of toolNames) {
          const match = exactToolMatches(snapshot.nodes, snapshot.edges, agent.id, toolName)
          if (match === undefined) unmatched.add(toolName)
          else matches.set(toolName, match)
        }
      }
      const id = evidenceId(baseId, synthetic)
      if (!projectedEvidenceIds.includes(id)) projectedEvidenceIds.push(id)
      const evidence = evidenceForWindow(
        window,
        observations,
        baseId,
        kind,
        synthetic,
        agent.name,
        new Set(matches.keys()),
        [...toolNames].filter((name) => !matches.has(name)).sort(),
        windows.provenance,
      )
      const existing = snapshot.evidence.find((item) => item.id === id)
      if (existing === undefined) {
        snapshot.evidence.push(evidence)
        addedEvidenceCount += 1
      } else if (JSON.stringify(existing) !== JSON.stringify(evidence)) {
        throw new Error(`Runtime evidence ID collides with existing evidence: ${id}`)
      }
      agent.evidenceIds = appendEvidenceId(agent.evidenceIds, id)
      for (const { node, edge } of matches.values()) {
        node.evidenceIds = appendEvidenceId(node.evidenceIds, id)
        edge.evidenceIds = appendEvidenceId(edge.evidenceIds, id)
      }
    }
  }

  return {
    snapshot: estateSnapshotSchema.parse(snapshot),
    addedEvidenceCount,
    evidenceIds: projectedEvidenceIds,
    unmatchedToolCallNames: [...unmatched].sort(),
    windows,
    dataState: projectedRuntimeDataState(windows),
  }
}
