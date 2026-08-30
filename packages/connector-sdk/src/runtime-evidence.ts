import {
  estateSnapshotSchema,
  evidenceSchema,
  type EstateSnapshot,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type ObservationWindow,
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
  return runtimeObservationWindowsSchema.parse({
    ...windows,
    baseline: {
      ...windows.baseline,
      observations: windows.baseline.observations.filter((item) => !item.synthetic),
    },
    observed: {
      ...windows.observed,
      observations: windows.observed.observations.filter((item) => !item.synthetic),
    },
  })
}

function evidenceId(baseId: string, synthetic: boolean): string {
  return synthetic ? `${baseId}-synthetic` : baseId
}

function appendEvidenceId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids : [...ids, id]
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
  const successCount = observations.filter((item) => item.success).length
  const latestObservedAt = observations
    .map((item) => item.observedAt)
    .sort((left, right) => right.localeCompare(left))[0]!
  return evidenceSchema.parse({
    id: evidenceId(baseId, synthetic),
    source: 'Azure Monitor OpenTelemetry',
    sourceObjectId: window.windowId,
    observedAt: latestObservedAt,
    freshness: kind === 'observed' ? 'live' : 'recent',
    confidence: 1,
    evidenceTypes: [synthetic ? 'synthetic_validation' : 'observed_runtime'],
    summary: `${observations.length} directly measured ${synthetic ? 'synthetic validation' : 'runtime'} invocation${observations.length === 1 ? '' : 's'} for ${agentName}; ${successCount} succeeded and ${observations.length - successCount} failed.`,
    metadata: {
      sourceConnector: 'azure-monitor-otel',
      windowKind: kind,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      observationCount: String(observations.length),
      successfulObservationCount: String(successCount),
      failedObservationCount: String(observations.length - successCount),
      synthetic: String(synthetic),
      unmatchedToolCallNames: JSON.stringify(unmatchedToolCallNames),
    },
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
  const windows = runtimeObservationWindowsSchema.parse(windowsInput)
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
  const unmatched = new Set<string>()
  let addedEvidenceCount = 0

  for (const [kind, window, baseId] of [
    ['baseline', windows.baseline, windows.baselineEvidenceId],
    ['observed', windows.observed, windows.observedEvidenceId],
  ] as const) {
    for (const synthetic of [false, true]) {
      const observations = window.observations.filter((item) => item.synthetic === synthetic)
      if (observations.length === 0) continue
      const toolNames = new Set(observations.flatMap((item) => item.toolCallNames))
      const matches = new Map<string, { node: GraphNode; edge: GraphEdge }>()
      for (const toolName of toolNames) {
        const match = exactToolMatches(snapshot.nodes, snapshot.edges, agent.id, toolName)
        if (match === undefined) unmatched.add(toolName)
        else matches.set(toolName, match)
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
