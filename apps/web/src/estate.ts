import type { Finding, GraphNode } from '@agent-sentinel/domain'

export type AgentStatus = 'Critical' | 'Review' | 'Healthy'

export function getAgentStatus(agent: GraphNode, findings: Finding[]): AgentStatus {
  if (
    findings.some(
      (finding) => finding.path.status !== 'mitigated' && finding.path.nodeIds.includes(agent.id),
    )
  )
    return 'Critical'
  if (agent.trust === 'conditional') return 'Review'
  return 'Healthy'
}
