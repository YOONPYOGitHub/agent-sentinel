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

const positions: Record<string, { x: number; y: number }> = {
  'external-document': { x: 10, y: 150 },
  'sales-research-agent': { x: 185, y: 150 },
  'sales-agent-identity': { x: 360, y: 150 },
  'customer-360-data': { x: 535, y: 150 },
  'external-enrichment-mcp': { x: 710, y: 150 },
}

interface ExposureGraphProps {
  snapshot: EstateSnapshot
  pathStatus: 'theoretical' | 'validated' | 'mitigated'
  onEvidenceSelect: (evidence: Evidence) => void
}

export function ExposureGraph({ snapshot, pathStatus, onEvidenceSelect }: ExposureGraphProps) {
  const evidenceById = useMemo(
    () => new Map(snapshot.evidence.map((item) => [item.id, item])),
    [snapshot.evidence],
  )

  const nodes = useMemo<AgentGraphNodeType[]>(
    () =>
      snapshot.nodes
        .filter((node) => node.id in positions)
        .map((node) => ({
          id: node.id,
          type: 'agentGraphNode',
          position: positions[node.id] ?? { x: 0, y: 0 },
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
                ? node.id === 'external-enrichment-mcp'
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
    [pathStatus, snapshot.nodes],
  )

  const edges = useMemo<Edge[]>(
    () =>
      snapshot.edges
        .filter((edge) => edge.from in positions && edge.to in positions)
        .map((edge) => {
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
          }
        }),
    [pathStatus, snapshot.edges],
  )

  return (
    <div className="graph-shell" aria-label="Agent exposure graph">
      <div className="graph-shell__toolbar">
        <div>
          <span className="eyebrow">ATTACK PATH</span>
          <strong>Indirect prompt injection to external egress</strong>
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
          <Badge appearance="outline">5 assets</Badge>
          <Badge appearance="outline">6 evidence objects</Badge>
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
    </div>
  )
}
