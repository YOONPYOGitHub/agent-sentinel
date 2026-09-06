import {
  assessRuntimeOtelQuality,
  estateSnapshotSchema,
  evidenceSchema,
  runtimeOtelProvenanceSchema,
  type EstateSnapshot,
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
  type RuntimeObservationWindows,
  type RuntimeTelemetryRequest,
} from './index.js'

export interface RuntimeEvidenceProjection {
  snapshot: EstateSnapshot
  addedEvidenceCount: number
  unmatchedToolCallNames: string[]
}

export function runtimeTelemetryRequestForAgent(
  snapshot: EstateSnapshot,
  agent: GraphNode,
): RuntimeTelemetryRequest | undefined {
  if (agent.kind !== 'agent') return undefined
  const sourceConnectorId = agent.metadata['sourceConnectorId']
  const sourceTenantId = agent.metadata['sourceTenantId']
  const sourceAgentId = agent.metadata['sourceObjectId']
  const sourceEnvironment = agent.metadata['sourceEnvironment']
  if (
    sourceConnectorId === undefined ||
    sourceTenantId === undefined ||
    sourceAgentId === undefined ||
    sourceEnvironment === undefined
  ) {
    return undefined
  }
  return {
    tenantId: snapshot.tenantId,
    agentId: agent.id,
    sourceConnectorId,
    sourceTenantId,
    sourceAgentId,
    sourceEnvironment,
  }
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

function runtimeOtelEvidenceItem(observation: RuntimeObservation): RuntimeOtelEvidenceItem {
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
  return {
    id: observation.id,
    observedAt: observation.observedAt,
    latencyMs: observation.latencyMs,
    inputTokens: observation.inputTokens,
    outputTokens: observation.outputTokens,
    costUsd: observation.costUsd,
    success: observation.success,
    ...(observation.errorCode !== undefined ? { errorCode: observation.errorCode } : {}),
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
  unmatchedToolCallNames: string[],
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
    },
    ...(window.otelQuality !== undefined
      ? {
          otel: {
            quality: window.otelQuality,
            invocations: observations.map(runtimeOtelEvidenceItem),
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
  sharedEstateId: string | undefined,
  sharedProviderResourceId: string | undefined,
): boolean {
  const sourceConnectorId = agent.metadata['sourceConnectorId']
  const sourceTenantId = agent.metadata['sourceTenantId']
  const sourceAgentId = agent.metadata['sourceObjectId']
  const sourceEnvironment = agent.metadata['sourceEnvironment'] ?? agent.environment
  const provenance = observation.otelProvenance
  if (
    provenance === undefined ||
    sourceConnectorId === undefined ||
    sourceTenantId === undefined ||
    sourceAgentId === undefined ||
    sharedEstateId === undefined ||
    sharedProviderResourceId === undefined
  ) {
    return false
  }
  const expectedClassification = observation.synthetic ? 'synthetic' : 'live'
  return (
    observation.tenantId === window.tenantId &&
    observation.agentId === window.agentId &&
    observation.environment === window.environment &&
    observation.source === window.source &&
    provenance.estateId === sharedEstateId &&
    provenance.estateTenantId === observation.tenantId &&
    provenance.estateTenantId === snapshot.tenantId &&
    provenance.estateEnvironment === snapshot.environment &&
    provenance.sourceConnectorId === sourceConnectorId &&
    provenance.sourceTenantId === sourceTenantId &&
    provenance.sourceEnvironment === observation.environment &&
    provenance.sourceEnvironment === sourceEnvironment &&
    provenance.provider === observation.source &&
    provenance.providerResourceId === sharedProviderResourceId &&
    provenance.providerAgentId === sourceAgentId &&
    provenance.observedAt === observation.observedAt &&
    provenance.classification === expectedClassification
  )
}

function enforceExactOtelProvenance(
  snapshot: EstateSnapshot,
  agent: GraphNode,
  windows: RuntimeObservationWindows,
): RuntimeObservationWindows {
  const provenance = [windows.baseline, windows.observed].flatMap((window) =>
    window.otelQuality === undefined
      ? []
      : window.observations.flatMap((observation) =>
          observation.otelProvenance === undefined ? [] : [observation.otelProvenance],
        ),
  )
  const estateIds = new Set(provenance.map((item) => item.estateId))
  const providerResourceIds = new Set(provenance.map((item) => item.providerResourceId))
  const sharedEstateId = estateIds.size === 1 ? [...estateIds][0] : undefined
  const sharedProviderResourceId =
    providerResourceIds.size === 1 ? [...providerResourceIds][0] : undefined

  const exactWindow = (window: ObservationWindow): ObservationWindow => {
    if (window.otelQuality === undefined) return window
    const observations = window.observations.filter((observation) =>
      hasExactOtelProvenance(
        snapshot,
        agent,
        window,
        observation,
        sharedEstateId,
        sharedProviderResourceId,
      ),
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

function enforceAssessedOtelQuality(windows: RuntimeObservationWindows): RuntimeObservationWindows {
  const assessedWindow = (window: ObservationWindow): ObservationWindow => {
    const assessment = assessRuntimeOtelQuality(window)
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

export function projectRuntimeEvidence(
  snapshotInput: EstateSnapshot,
  windowsInput: RuntimeObservationWindows,
): RuntimeEvidenceProjection {
  const snapshot = estateSnapshotSchema.parse(structuredClone(snapshotInput))
  let windows = runtimeObservationWindowsSchema.parse(removeMalformedOtelObservations(windowsInput))
  const agents = snapshot.nodes.filter(
    (node) => node.kind === 'agent' && node.id === windows.observed.agentId,
  )
  if (agents.length !== 1) {
    throw new Error('Runtime telemetry must match exactly one existing agent node.')
  }
  const agent = agents[0]!
  const expectedEnvironment = agent.metadata['sourceEnvironment'] ?? agent.environment
  if (
    windows.observed.tenantId !== snapshot.tenantId ||
    windows.observed.environment !== expectedEnvironment
  ) {
    throw new Error('Runtime telemetry does not match the estate tenant and agent environment.')
  }
  windows = enforceExactOtelProvenance(snapshot, agent, windows)
  windows = enforceAssessedOtelQuality(windows)
  const unmatched = new Set<string>()
  let addedEvidenceCount = 0

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
      const evidence = evidenceForWindow(
        window,
        observations,
        baseId,
        kind,
        synthetic,
        agent.name,
        [...toolNames].filter((name) => !matches.has(name)).sort(),
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
    unmatchedToolCallNames: [...unmatched].sort(),
  }
}
