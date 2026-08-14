import {
  BotRegular,
  CloudRegular,
  DatabaseRegular,
  DocumentRegular,
  KeyRegular,
} from '@fluentui/react-icons'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'

import type { NodeKind } from '@agent-sentinel/domain'

export interface AgentGraphNodeData extends Record<string, unknown> {
  kind: NodeKind
  label: string
  detail: string
  status: 'safe' | 'warning' | 'critical' | 'mitigated'
  evidenceId: string
}

export type AgentGraphNodeType = Node<AgentGraphNodeData, 'agentGraphNode'>

const icons = {
  input: DocumentRegular,
  agent: BotRegular,
  identity: KeyRegular,
  data: DatabaseRegular,
  mcp: CloudRegular,
  tool: CloudRegular,
  control: KeyRegular,
}

export function AgentGraphNode({ data, selected }: NodeProps<AgentGraphNodeType>) {
  const Icon = icons[data.kind]

  return (
    <div
      className={`graph-node graph-node--${data.kind} graph-node--${data.status} ${
        selected ? 'graph-node--selected' : ''
      }`}
      data-testid={`graph-node-${data.kind}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="graph-node__icon" aria-hidden="true">
        <Icon />
      </div>
      <div className="graph-node__content">
        <span className="graph-node__kind">{data.kind}</span>
        <strong>{data.label}</strong>
        <span>{data.detail}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
