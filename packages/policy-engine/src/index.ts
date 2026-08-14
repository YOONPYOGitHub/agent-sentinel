import type { EstateSnapshot, Finding, RiskFactors } from '@agent-sentinel/domain'
import { findAttackPaths } from '@agent-sentinel/graph-engine'

export const uncontrolledEgressPolicy = {
  id: 'AS-POL-004',
  name: 'Sensitive data requires controlled egress',
  description:
    'Untrusted input must not reach confidential data and an unapproved external endpoint.',
  severity: 'critical' as const,
}

const defaultFactors: RiskFactors = {
  reachability: 1,
  exploitability: 0.98,
  businessImpact: 0.97,
  privilege: 0.96,
  dataSensitivity: 1,
  activity: 0.92,
  confidence: 0.97,
  compensatingControlDiscount: 0.05,
}

export function evaluateUncontrolledEgress(snapshot: EstateSnapshot): Finding[] {
  const sourceNodeIds = snapshot.nodes
    .filter((node) => node.kind === 'input' && node.trust === 'untrusted')
    .map((node) => node.id)
  const targetNodeIds = snapshot.nodes
    .filter((node) => node.kind === 'mcp' && node.trust === 'untrusted')
    .map((node) => node.id)

  const paths = findAttackPaths(snapshot, {
    sourceNodeIds,
    targetNodeIds,
    factors: defaultFactors,
  })

  return paths.map((path, index) => ({
    id: `finding-uncontrolled-egress-${index + 1}`,
    title: 'Confidential data can reach an unapproved MCP server',
    summary:
      'An indirect prompt injection can traverse an overprivileged agent identity and expose confidential CRM data to an external endpoint.',
    severity: uncontrolledEgressPolicy.severity,
    path,
    owner: 'Sales AI Platform',
    policyId: uncontrolledEgressPolicy.id,
    detectedAt: snapshot.generatedAt,
    recommendation:
      'Block the unapproved MCP route, require approval for sensitive reads, and replace broad CRM permissions with a scoped role.',
  }))
}
