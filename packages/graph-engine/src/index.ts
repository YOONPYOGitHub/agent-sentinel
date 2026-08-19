import type {
  AttackPath,
  EstateSnapshot,
  GraphEdge,
  GraphNode,
  RiskFactors,
} from '@agent-sentinel/domain'

export interface AttackPathQuery {
  sourceNodeIds: string[]
  targetNodeIds: string[]
  factors: RiskFactors
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

export function findAttackPaths(snapshot: EstateSnapshot, query: AttackPathQuery): AttackPath[] {
  const targetIds = new Set(query.targetNodeIds)
  const activeEdges = snapshot.edges.filter((edge) => edge.active)
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
        snapshot.nodes
          .find((node) => node.id === id)
          ?.evidenceIds.forEach((evidenceId) => {
            evidenceIds.add(evidenceId)
          })
      }
      for (const id of edgeIds) {
        snapshot.edges
          .find((edge) => edge.id === id)
          ?.evidenceIds.forEach((evidenceId) => {
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

export function calculateBlastRadius(snapshot: EstateSnapshot, originNodeId: string): GraphNode[] {
  const reached = new Set<string>()
  const queue = [originNodeId]

  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || reached.has(current)) {
      continue
    }
    reached.add(current)

    for (const edge of snapshot.edges) {
      if (edge.active && edge.from === current && !reached.has(edge.to)) {
        queue.push(edge.to)
      }
    }
  }

  reached.delete(originNodeId)
  return snapshot.nodes.filter((node) => reached.has(node.id))
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
