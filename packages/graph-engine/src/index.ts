import type {
  AttackPath,
  EstateContext,
  EstateSnapshot,
  Evidence,
  EvidenceAuthority,
  GraphEdge,
  GraphNode,
  RiskFactors,
  RunsAsBinding,
} from '@agent-sentinel/domain'
import { assertEstateSnapshot } from '@agent-sentinel/domain'

export interface AttackPathQuery {
  sourceNodeIds: string[]
  targetNodeIds: string[]
  factors: RiskFactors
}

export const DEFAULT_LIVE_GRAPH_EVIDENCE_MAX_AGE_MS = 15 * 60 * 1_000

interface LiveGraphAuthorityRegistry {
  readonly sourceSnapshot: EstateSnapshot
  readonly sourceNodes: EstateSnapshot['nodes']
  readonly sourceEvidence: EstateSnapshot['evidence']
  readonly validatedSnapshot: EstateSnapshot
  readonly nodesById: ReadonlyMap<string, GraphNode>
  readonly evidenceById: ReadonlyMap<string, Evidence>
  readonly edgesById: ReadonlyMap<string, GraphEdge>
  readonly endpointAuthorityEvidenceByNodeId: ReadonlyMap<
    string,
    readonly { evidenceId: string; authority: EvidenceAuthority }[]
  >
  readonly evaluatedAt: number
  readonly maxEvidenceAgeMs: number
}

export interface LiveGraphTraversalContext {
  readonly mode: 'live'
}

export interface TrustedMockGraphTraversalContext {
  readonly mode: 'mock'
}

export type GraphTraversalContext = LiveGraphTraversalContext | TrustedMockGraphTraversalContext

const trustedLiveContexts = new WeakSet<object>()
const trustedMockContexts = new WeakSet<object>()
const liveAuthorityByContext = new WeakMap<object, LiveGraphAuthorityRegistry>()

export const trustedMockGraphTraversalContext = Object.freeze({
  mode: 'mock' as const,
})
trustedMockContexts.add(trustedMockGraphTraversalContext)

export interface LiveGraphSnapshotContextOptions {
  readonly estate: EstateContext
  readonly clock?: () => Date
  readonly maxEvidenceAgeMs?: number
}

interface TraversalSnapshotIndex {
  readonly snapshot: EstateSnapshot
  readonly nodesById: ReadonlyMap<string, GraphNode>
  readonly edgesById: ReadonlyMap<string, GraphEdge>
}

function sameAuthority(left: EvidenceAuthority, right: EvidenceAuthority): boolean {
  return (
    left.estateId === right.estateId &&
    left.sourceId === right.sourceId &&
    left.tenantId.toLowerCase() === right.tenantId.toLowerCase() &&
    left.environment === right.environment &&
    left.provider === right.provider &&
    left.sourceObjectId === right.sourceObjectId &&
    left.providerObjectId === right.providerObjectId &&
    left.snapshotGeneratedAt === right.snapshotGeneratedAt &&
    left.sourceRelease === right.sourceRelease
  )
}

function validLiveEvidence(
  evidence: Evidence,
  estate: EstateContext,
  evaluatedAt: number,
  maxEvidenceAgeMs: number,
): evidence is Evidence & { authority: EvidenceAuthority } {
  const authority = evidence.authority
  if (
    authority === undefined ||
    authority.estateId !== estate.id ||
    evidence.freshness === 'stale' ||
    evidence.confidence < 0.8 ||
    evidence.evidenceTypes.includes('synthetic_validation') ||
    evidence.evidenceTypes.includes('unknown') ||
    !evidence.evidenceTypes.includes('declared_configuration')
  ) {
    return false
  }
  const observedAt = Date.parse(evidence.observedAt)
  const generatedAt = Date.parse(authority.snapshotGeneratedAt)
  return (
    Number.isFinite(observedAt) &&
    Number.isFinite(generatedAt) &&
    observedAt <= evaluatedAt &&
    generatedAt <= evaluatedAt &&
    evaluatedAt - observedAt <= maxEvidenceAgeMs &&
    evaluatedAt - generatedAt <= maxEvidenceAgeMs
  )
}

export function createLiveGraphTraversalContextForSnapshot(
  snapshot: EstateSnapshot,
  options: LiveGraphSnapshotContextOptions,
): LiveGraphTraversalContext {
  const validated = assertEstateSnapshot(snapshot)
  if (
    validated.tenantId.toLowerCase() !== options.estate.tenantId.toLowerCase() ||
    validated.environment !== options.estate.environment
  ) {
    throw new Error('Live graph snapshot does not match the requested estate boundary.')
  }
  const clock = options.clock ?? (() => new Date())
  const evaluatedAt = clock().getTime()
  const maxEvidenceAgeMs = options.maxEvidenceAgeMs ?? DEFAULT_LIVE_GRAPH_EVIDENCE_MAX_AGE_MS
  if (
    !Number.isFinite(evaluatedAt) ||
    !Number.isFinite(maxEvidenceAgeMs) ||
    maxEvidenceAgeMs <= 0
  ) {
    throw new Error('Live graph authority requires a valid clock and positive evidence age.')
  }
  const nodesById = uniqueIdMap(validated.nodes, 'graph node')
  const evidenceById = uniqueIdMap(validated.evidence, 'evidence')
  const edgesById = uniqueIdMap(validated.edges, 'graph edge')
  assertUnambiguousIdentityCorrelationGuids(validated.nodes)
  const sourceGenerations = new Map<string, string>()
  const registeredAuthorityEvidenceIds = new Set<string>()
  const snapshotGeneratedAt = Date.parse(validated.generatedAt)
  for (const evidence of validated.evidence) {
    if (!validLiveEvidence(evidence, options.estate, evaluatedAt, maxEvidenceAgeMs)) continue
    if (
      !Number.isFinite(snapshotGeneratedAt) ||
      Date.parse(evidence.authority.snapshotGeneratedAt) > snapshotGeneratedAt ||
      Date.parse(evidence.observedAt) > snapshotGeneratedAt
    ) {
      continue
    }
    const sourceKey = [
      evidence.authority.estateId,
      evidence.authority.sourceId,
      evidence.authority.tenantId.toLowerCase(),
      evidence.authority.environment,
      evidence.authority.provider,
      evidence.authority.sourceObjectId,
    ].join('\0')
    const generationKey = `${evidence.authority.snapshotGeneratedAt}\0${evidence.authority.sourceRelease}`
    const existingGeneration = sourceGenerations.get(sourceKey)
    if (existingGeneration !== undefined && existingGeneration !== generationKey) {
      throw new Error('A live authority source cannot register multiple snapshot generations.')
    }
    sourceGenerations.set(sourceKey, generationKey)
    registeredAuthorityEvidenceIds.add(evidence.id)
  }
  const endpointAuthorityEvidenceByNodeId = new Map<
    string,
    readonly { evidenceId: string; authority: EvidenceAuthority }[]
  >()
  for (const node of validated.nodes) {
    const matches = node.evidenceIds.flatMap((evidenceId) => {
      if (!registeredAuthorityEvidenceIds.has(evidenceId)) return []
      const evidence = evidenceById.get(evidenceId)
      if (evidence?.authority === undefined || !nodeMatchesAuthority(node, evidence.authority)) {
        return []
      }
      return [{ evidenceId, authority: evidence.authority }]
    })
    endpointAuthorityEvidenceByNodeId.set(node.id, matches)
  }
  const context = Object.freeze({
    mode: 'live' as const,
  })
  trustedLiveContexts.add(context)
  liveAuthorityByContext.set(context, {
    sourceSnapshot: snapshot,
    sourceNodes: snapshot.nodes,
    sourceEvidence: snapshot.evidence,
    validatedSnapshot: validated,
    nodesById,
    evidenceById,
    edgesById,
    endpointAuthorityEvidenceByNodeId,
    evaluatedAt,
    maxEvidenceAgeMs,
  })
  return context
}

function uniqueIdMap<T extends { id: string }>(
  items: readonly T[],
  label: 'graph node' | 'graph edge' | 'evidence',
): ReadonlyMap<string, T> {
  const result = new Map<string, T>()
  for (const item of items) {
    if (result.has(item.id)) {
      throw new Error(`Live graph authority rejects duplicate ${label} ID: ${item.id}`)
    }
    result.set(item.id, item)
  }
  return result
}

function assertUnambiguousIdentityCorrelationGuids(nodes: readonly GraphNode[]): void {
  const identityByGuid = new Map<string, string>()
  const register = (
    node: GraphNode,
    kind: 'object-id' | 'application-id' | 'agent-identity-id',
    value: string | undefined,
  ): void => {
    if (value === undefined || !GUID_PATTERN.test(value)) return
    const key = [
      kind,
      node.metadata['estateId'] ?? '',
      node.metadata['sourceId'] ?? '',
      node.metadata['sourceTenantId']?.toLowerCase() ?? '',
      node.metadata['sourceEnvironment'] ?? '',
      value.toLowerCase(),
    ].join('\0')
    const existing = identityByGuid.get(key)
    if (existing !== undefined && existing !== node.id) {
      throw new Error(`Live graph correlation GUID resolves to multiple identities: ${value}`)
    }
    identityByGuid.set(key, node.id)
  }
  for (const node of nodes) {
    if (node.kind !== 'identity') continue
    const directoryObjectId = node.metadata['directoryObjectId']
    register(node, 'object-id', directoryObjectId)
    register(node, 'application-id', node.metadata['applicationId'])
    if (node.metadata['agentIdentityPreview'] === 'true') {
      register(node, 'agent-identity-id', directoryObjectId)
    }
  }
}

function assertTraversalContext(context: GraphTraversalContext): void {
  const trusted =
    context.mode === 'mock' ? trustedMockContexts.has(context) : trustedLiveContexts.has(context)
  if (!trusted) throw new Error('Graph traversal requires a trusted traversal context.')
}

function nodeMatchesAuthority(node: GraphNode, authority: EvidenceAuthority): boolean {
  return (
    node.metadata['sourceOfTruth'] === 'true' &&
    node.metadata['estateId'] === authority.estateId &&
    node.metadata['sourceId'] === authority.sourceId &&
    node.metadata['sourceTenantId']?.toLowerCase() === authority.tenantId.toLowerCase() &&
    node.metadata['sourceEnvironment'] === authority.environment &&
    node.metadata['provider'] === authority.provider &&
    node.metadata['providerObjectId'] === authority.providerObjectId &&
    node.metadata['snapshotGeneratedAt'] === authority.snapshotGeneratedAt &&
    node.metadata['sourceRelease'] === authority.sourceRelease &&
    (authority.provider === 'azure-ai-foundry-agent-service'
      ? node.metadata['sourceProjectId']
      : node.metadata['sourceInventoryObjectId']) === authority.sourceObjectId
  )
}

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OBJECT_ID_KEYS = ['entraServicePrincipalId', 'servicePrincipalId', 'objectId'] as const
const APPLICATION_ID_KEYS = ['entraAppId', 'appId', 'entraClientId', 'clientId'] as const
const AGENT_IDENTITY_ID_KEYS = ['entraAgentIdentityId', 'agentIdentityId'] as const

function identifiersMatchBinding(
  agent: GraphNode,
  identity: GraphNode,
  binding: RunsAsBinding,
): boolean {
  if (binding.identifier.kind === 'application-id') return false
  const directoryObjectId = identity.metadata['directoryObjectId']
  const applicationId = identity.metadata['applicationId']
  const identityIdentifier =
    binding.identifier.kind === 'agent-identity-id' &&
    identity.metadata['agentIdentityPreview'] !== 'true'
      ? undefined
      : directoryObjectId
  const checkKeys = (keys: readonly string[], expected: string | undefined): boolean =>
    keys.every((key) => {
      const value = agent.metadata[key]
      return (
        value === undefined ||
        (GUID_PATTERN.test(value) && value.toLowerCase() === expected?.toLowerCase())
      )
    })
  const hasExactIdentifier = (keys: readonly string[], expected: string): boolean =>
    keys.some((key) => agent.metadata[key]?.toLowerCase() === expected.toLowerCase())
  if (
    directoryObjectId === undefined ||
    identityIdentifier === undefined ||
    !GUID_PATTERN.test(identityIdentifier) ||
    !GUID_PATTERN.test(binding.identifier.value) ||
    identityIdentifier.toLowerCase() !== binding.identifier.value.toLowerCase() ||
    identityIdentifier.toLowerCase() !== binding.identity.providerObjectId.toLowerCase() ||
    !checkKeys(OBJECT_ID_KEYS, directoryObjectId) ||
    !checkKeys(APPLICATION_ID_KEYS, applicationId) ||
    !checkKeys(
      AGENT_IDENTITY_ID_KEYS,
      identity.metadata['agentIdentityPreview'] === 'true' ? directoryObjectId : undefined,
    )
  ) {
    return false
  }
  if (binding.identifier.kind === 'agent-identity-id') {
    return (
      identity.metadata['agentIdentityPreview'] === 'true' &&
      directoryObjectId.toLowerCase() === binding.identifier.value.toLowerCase() &&
      hasExactIdentifier(AGENT_IDENTITY_ID_KEYS, binding.identifier.value)
    )
  }
  return (
    directoryObjectId.toLowerCase() === binding.identifier.value.toLowerCase() &&
    hasExactIdentifier(OBJECT_ID_KEYS, binding.identifier.value)
  )
}

function liveRunsAsTraversable(
  edge: GraphEdge,
  nodesById: ReadonlyMap<string, GraphNode>,
  authority: LiveGraphAuthorityRegistry,
): boolean {
  const binding = edge.runsAsBinding
  const from = nodesById.get(edge.from)
  const to = nodesById.get(edge.to)
  if (
    binding === undefined ||
    from === undefined ||
    to === undefined ||
    from.kind !== 'agent' ||
    to.kind !== 'identity' ||
    !nodeMatchesAuthority(from, binding.agent) ||
    !nodeMatchesAuthority(to, binding.identity) ||
    !identifiersMatchBinding(from, to, binding) ||
    edge.evidenceIds.length !== 2 ||
    new Set(edge.evidenceIds).size !== 2
  ) {
    return false
  }
  const agentEvidence = (authority.endpointAuthorityEvidenceByNodeId.get(from.id) ?? []).filter(
    (record) => sameAuthority(record.authority, binding.agent),
  )
  const identityEvidence = (authority.endpointAuthorityEvidenceByNodeId.get(to.id) ?? []).filter(
    (record) => sameAuthority(record.authority, binding.identity),
  )
  if (agentEvidence.length !== 1 || identityEvidence.length !== 1) return false
  const expectedEvidenceIds = new Set([
    agentEvidence[0]!.evidenceId,
    identityEvidence[0]!.evidenceId,
  ])
  return edge.evidenceIds.every((evidenceId) => expectedEvidenceIds.has(evidenceId))
}

function isTraversableEdge(
  edge: GraphEdge,
  nodesById: ReadonlyMap<string, GraphNode>,
  context: GraphTraversalContext,
): boolean {
  if (!edge.active) return false
  if (edge.relationship !== 'RUNS_AS' || context.mode === 'mock') return true
  const authority = liveAuthorityByContext.get(context)
  return authority !== undefined && liveRunsAsTraversable(edge, nodesById, authority)
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameRunsAsBinding(
  left: RunsAsBinding | undefined,
  right: RunsAsBinding | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return (
    sameAuthority(left.agent, right.agent) &&
    sameAuthority(left.identity, right.identity) &&
    left.identifier.kind === right.identifier.kind &&
    left.identifier.value === right.identifier.value
  )
}

function isRegisteredEdgeStateVariant(
  snapshot: EstateSnapshot,
  authority: LiveGraphAuthorityRegistry,
): boolean {
  if (
    snapshot.tenantId.toLowerCase() !== authority.validatedSnapshot.tenantId.toLowerCase() ||
    snapshot.environment !== authority.validatedSnapshot.environment ||
    snapshot.generatedAt !== authority.validatedSnapshot.generatedAt ||
    snapshot.nodes !== authority.sourceNodes ||
    snapshot.evidence !== authority.sourceEvidence ||
    snapshot.edges.length !== authority.validatedSnapshot.edges.length
  ) {
    return false
  }
  for (const edge of snapshot.edges) {
    const registered = authority.edgesById.get(edge.id)
    if (
      registered === undefined ||
      edge.from !== registered.from ||
      edge.to !== registered.to ||
      edge.relationship !== registered.relationship ||
      edge.removable !== registered.removable ||
      typeof edge.active !== 'boolean' ||
      (edge.active && !registered.active) ||
      !sameStringArray(edge.evidenceIds, registered.evidenceIds) ||
      !sameRunsAsBinding(edge.runsAsBinding, registered.runsAsBinding)
    ) {
      return false
    }
  }
  return true
}

function traversalSnapshotIndex(
  snapshot: EstateSnapshot,
  context: GraphTraversalContext,
): TraversalSnapshotIndex | undefined {
  if (context.mode === 'mock') {
    const validated = assertEstateSnapshot(snapshot)
    return {
      snapshot: validated,
      nodesById: new Map(validated.nodes.map((node) => [node.id, node])),
      edgesById: new Map(validated.edges.map((edge) => [edge.id, edge])),
    }
  }
  const authority = liveAuthorityByContext.get(context)
  if (authority === undefined) return undefined
  if (snapshot === authority.sourceSnapshot) {
    return {
      snapshot: authority.validatedSnapshot,
      nodesById: authority.nodesById,
      edgesById: authority.edgesById,
    }
  }
  if (!isRegisteredEdgeStateVariant(snapshot, authority)) return undefined
  return {
    snapshot: {
      ...authority.validatedSnapshot,
      edges: snapshot.edges,
    },
    nodesById: authority.nodesById,
    edgesById: new Map(snapshot.edges.map((edge) => [edge.id, edge])),
  }
}

export function calculateRiskScore(factors: RiskFactors): number {
  const raw =
    factors.reachability *
    factors.exploitability *
    factors.businessImpact *
    factors.privilege *
    factors.dataSensitivity *
    factors.activity *
    factors.confidence *
    (1 - factors.compensatingControlDiscount)

  return Math.round(Math.min(1, raw) * 100)
}

export function findAttackPaths(
  snapshot: EstateSnapshot,
  query: AttackPathQuery,
  context: GraphTraversalContext,
): AttackPath[] {
  assertTraversalContext(context)
  const index = traversalSnapshotIndex(snapshot, context)
  if (index === undefined) return []
  const traversalIndex = index
  const validatedSnapshot = traversalIndex.snapshot
  const targetIds = new Set(query.targetNodeIds)
  const activeEdges = validatedSnapshot.edges.filter((edge) =>
    isTraversableEdge(edge, traversalIndex.nodesById, context),
  )
  const adjacency = new Map<string, GraphEdge[]>()

  for (const edge of activeEdges) {
    const current = adjacency.get(edge.from) ?? []
    current.push(edge)
    adjacency.set(edge.from, current)
  }

  const paths: AttackPath[] = []

  for (const sourceId of query.sourceNodeIds) {
    walk(sourceId, [sourceId], [], new Set([sourceId]))
  }

  return paths.sort((left, right) => right.riskScore - left.riskScore)

  function walk(nodeId: string, nodeIds: string[], edgeIds: string[], visited: Set<string>): void {
    if (targetIds.has(nodeId) && edgeIds.length > 0) {
      const evidenceIds = new Set<string>()
      for (const id of nodeIds) {
        traversalIndex.nodesById.get(id)?.evidenceIds.forEach((evidenceId) => {
          evidenceIds.add(evidenceId)
        })
      }
      for (const id of edgeIds) {
        traversalIndex.edgesById.get(id)?.evidenceIds.forEach((evidenceId) => {
          evidenceIds.add(evidenceId)
        })
      }

      paths.push({
        id: `path-${nodeIds[0]}-${nodeId}-${paths.length + 1}`,
        nodeIds,
        edgeIds,
        evidenceIds: [...evidenceIds],
        riskScore: calculateRiskScore(query.factors),
        factors: query.factors,
        status: 'theoretical',
      })
      return
    }

    for (const edge of adjacency.get(nodeId) ?? []) {
      if (visited.has(edge.to)) {
        continue
      }
      walk(edge.to, [...nodeIds, edge.to], [...edgeIds, edge.id], new Set([...visited, edge.to]))
    }
  }
}

export function calculateBlastRadius(
  snapshot: EstateSnapshot,
  originNodeId: string,
  context: GraphTraversalContext,
): GraphNode[] {
  assertTraversalContext(context)
  const index = traversalSnapshotIndex(snapshot, context)
  if (index === undefined) return []
  const traversalIndex = index
  const validatedSnapshot = traversalIndex.snapshot
  const reached = new Set<string>()
  const queue = [originNodeId]

  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || reached.has(current)) {
      continue
    }
    reached.add(current)

    for (const edge of validatedSnapshot.edges) {
      if (
        edge.from === current &&
        isTraversableEdge(edge, traversalIndex.nodesById, context) &&
        !reached.has(edge.to)
      ) {
        queue.push(edge.to)
      }
    }
  }

  reached.delete(originNodeId)
  return validatedSnapshot.nodes.filter((node) => reached.has(node.id))
}

export function disableEdge(snapshot: EstateSnapshot, edgeId: string): EstateSnapshot {
  const target = snapshot.edges.find((edge) => edge.id === edgeId)
  if (target === undefined) {
    throw new Error(`Cannot disable unknown edge: ${edgeId}`)
  }
  if (!target.removable) {
    throw new Error(`Edge is not remediable: ${edgeId}`)
  }

  return {
    ...snapshot,
    generatedAt: new Date().toISOString(),
    edges: snapshot.edges.map((edge) => (edge.id === edgeId ? { ...edge, active: false } : edge)),
  }
}

export function simulateEdgeRemoval(snapshot: EstateSnapshot, edgeId: string): EstateSnapshot {
  const target = snapshot.edges.find((edge) => edge.id === edgeId)
  if (target === undefined) {
    throw new Error(`Cannot simulate unknown edge removal: ${edgeId}`)
  }

  return {
    ...snapshot,
    edges: snapshot.edges.map((edge) => (edge.id === edgeId ? { ...edge, active: false } : edge)),
  }
}
