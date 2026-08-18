import { Badge } from '@fluentui/react-components'
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type NodeTypes,
} from '@xyflow/react'
import { useMemo } from 'react'

import type { EstateSnapshot, Evidence } from '@agent-sentinel/domain'

import { AgentGraphNode, type AgentGraphNodeType } from './AgentGraphNode'

const nodeTypes: NodeTypes = {
  agentGraphNode: AgentGraphNode,
}

interface ExposureGraphProps {
  snapshot: EstateSnapshot
  pathStatus: 'theoretical' | 'validated' | 'mitigated'
  onEvidenceSelect: (evidence: Evidence) => void
  title?: string
}

function layoutPositions(snapshot: EstateSnapshot): Map<string, { x: number; y: number }> {
  const nodeIds = new Set(snapshot.nodes.map((node) => node.id))
  const incoming = new Map(snapshot.nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, string[]>()
  for (const edge of snapshot.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to])
  }

  const levels = new Map<string, number>()
  const queue = snapshot.nodes
    .filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .map((node) => node.id)
  for (const root of queue) levels.set(root, 0)
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    if (current === undefined) continue
    const nextLevel = (levels.get(current) ?? 0) + 1
    for (const target of outgoing.get(current) ?? []) {
      if (!levels.has(target) || nextLevel > (levels.get(target) ?? 0)) {
        levels.set(target, nextLevel)
      }
      if (!queue.includes(target)) queue.push(target)
    }
  }

  for (const node of snapshot.nodes) {
    if (!levels.has(node.id)) levels.set(node.id, 0)
  }
  const groups = new Map<number, string[]>()
  for (const node of snapshot.nodes) {
    const level = levels.get(node.id) ?? 0
    groups.set(level, [...(groups.get(level) ?? []), node.id])
  }

  const positions = new Map<string, { x: number; y: number }>()
  for (const [level, ids] of groups) {
    ids.forEach((id, index) => {
      positions.set(id, { x: 30 + level * 220, y: 30 + index * 130 })
    })
  }
  return positions
}

export function ExposureGraph({
  snapshot,
  pathStatus,
  onEvidenceSelect,
  title = 'Evidence-backed exposure path',
}: ExposureGraphProps) {
  const evidenceById = useMemo(
    () => new Map(snapshot.evidence.map((item) => [item.id, item])),
    [snapshot.evidence],
  )
  const nodeById = useMemo(
    () => new Map(snapshot.nodes.map((node) => [node.id, node])),
    [snapshot.nodes],
  )
  const positions = useMemo(() => layoutPositions(snapshot), [snapshot])
  const mitigatedNodeIds = useMemo(
    () => new Set(snapshot.edges.filter((edge) => !edge.active).map((edge) => edge.to)),
    [snapshot.edges],
  )

  const nodes = useMemo<AgentGraphNodeType[]>(
    () =>
      snapshot.nodes
        .map((node) => ({
          id: node.id,
          type: 'agentGraphNode',
          position: positions.get(node.id) ?? { x: 0, y: 0 },
          data: {
            kind: node.kind,
            label: node.name,
            detail:
              node.metadata.permission ??
              node.metadata.label ??
              node.metadata.platform ??
              node.metadata.catalog ??
              node.metadata.channel ??
              node.environment,
            status:
              pathStatus === 'mitigated'
                ? mitigatedNodeIds.has(node.id)
                    ? 'mitigated'
                    : 'safe'
                : node.trust === 'untrusted'
                  ? 'critical'
                  : node.trust === 'conditional'
                    ? 'warning'
                    : 'safe',
            evidenceId: node.evidenceIds[0] ?? '',
          },
        })),
      [mitigatedNodeIds, pathStatus, positions, snapshot.nodes],
    )

  const edges = useMemo<Edge[]>(
    () =>
        snapshot.edges.map((edge) => {
            const disabled = !edge.active
            return {
            id: edge.id,
            source: edge.from,
            target: edge.to,
            animated: !disabled && pathStatus === 'validated',
            ariaLabel: `${edge.relationship.replaceAll('_', ' ')} relationship${
              disabled ? ', blocked by remediation' : ''
            }`,
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: disabled ? '#54b17a' : '#f76363',
            },
              style: {
              stroke: disabled ? '#54b17a' : '#f76363',
              strokeDasharray: disabled ? '7 5' : undefined,
                strokeWidth: pathStatus === 'validated' && !disabled ? 3 : 2,
              },
              data: { evidenceId: edge.evidenceIds[0] ?? '' },
            }
          }),
    [pathStatus, snapshot.edges],
  )

  return (
      <div className="graph-shell" aria-label={`Agent exposure graph: ${title}`}>
      <div className="graph-shell__toolbar">
        <div>
            <span className="eyebrow">ATTACK PATH</span>
            <strong>{title}</strong>
        </div>
        <div className="graph-shell__badges">
          <Badge
            appearance="tint"
            color={
              pathStatus === 'mitigated'
                ? 'success'
                : pathStatus === 'validated'
                  ? 'danger'
                  : 'warning'
            }
          >
            {pathStatus === 'mitigated'
              ? 'Exposure removed'
              : pathStatus === 'validated'
                ? 'Validated exploit'
                : 'Theoretical exposure'}
          </Badge>
            <Badge appearance="outline">{snapshot.nodes.length} assets</Badge>
            <Badge appearance="outline">{snapshot.evidence.length} evidence objects</Badge>
        </div>
      </div>
        <div className="graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.65}
          maxZoom={1.4}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
            onNodeClick={(_event, node) => {
              const evidence = evidenceById.get(node.data.evidenceId)
              if (evidence !== undefined) {
                onEvidenceSelect(evidence)
              }
            }}
            onEdgeClick={(_event, edge) => {
              const evidenceId =
                typeof edge.data?.evidenceId === 'string' ? edge.data.evidenceId : undefined
              const evidence = evidenceId === undefined ? undefined : evidenceById.get(evidenceId)
              if (evidence !== undefined) onEvidenceSelect(evidence)
            }}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#2f3a4d" gap={22} variant={BackgroundVariant.Dots} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) =>
              node.data.status === 'critical'
                ? '#d13438'
                : node.data.status === 'mitigated'
                  ? '#3a9b62'
                  : '#4f6bed'
            }
            maskColor="rgba(9, 14, 24, 0.74)"
          />
          <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <div className="graph-path-list">
          <div className="graph-path-list__header">
            <strong>Accessible path</strong>
            <span>Open any relationship to inspect its evidence.</span>
          </div>
          <ol>
            {snapshot.edges.map((edge) => {
              const source = nodeById.get(edge.from)
              const target = nodeById.get(edge.to)
              const evidence = evidenceById.get(edge.evidenceIds[0] ?? '')
              return (
                <li key={edge.id}>
                  <button
                    type="button"
                    disabled={evidence === undefined}
                    onClick={() => {
                      if (evidence !== undefined) onEvidenceSelect(evidence)
                    }}
                  >
                    <span>{source?.name ?? edge.from}</span>
                    <b>{edge.relationship.replaceAll('_', ' ')}</b>
                    <span>{target?.name ?? edge.to}</span>
                    <em>{edge.active ? 'Active' : 'Blocked'}</em>
                  </button>
                </li>
              )
            })}
          </ol>
        </div>
      </div>
  )
}
