import { describe, expect, it } from 'vitest'

import type { Remediation } from '@agent-sentinel/domain'

import { createSeedSnapshot, MockAgentConnector } from '../src/index.js'

describe('MockAgentConnector', () => {
  it('seeds the exact three agents with valid evidence and trusted supporting MCPs', () => {
    const snapshot = createSeedSnapshot()
    const agents = snapshot.nodes.filter((node) => node.kind === 'agent')
    const nodeIds = new Set(snapshot.nodes.map((node) => node.id))
    const evidenceIds = new Set(snapshot.evidence.map((item) => item.id))

    expect(agents.map((agent) => agent.id)).toEqual([
      'sales-research-agent',
      'hr-policy-agent',
      'code-review-copilot',
    ])
    expect(agents.find((agent) => agent.id === 'hr-policy-agent')).toMatchObject({
      name: 'HR Policy Assistant',
      environment: 'production',
      owner: 'People & Culture',
      trust: 'trusted',
      metadata: { platform: 'Azure OpenAI Service' },
    })
    expect(agents.find((agent) => agent.id === 'code-review-copilot')).toMatchObject({
      name: 'Code Review Copilot',
      environment: 'development',
      owner: 'Engineering Platform',
      trust: 'trusted',
      metadata: { platform: 'GitHub Copilot Extensions' },
    })
    expect(
      ['hr-sharepoint-mcp', 'cr-github-actions-mcp'].map(
        (id) => snapshot.nodes.find((node) => node.id === id)?.trust,
      ),
    ).toEqual(['trusted', 'trusted'])
    expect([...evidenceIds].filter((id) => id.startsWith('evidence-hr-'))).toEqual([
      'evidence-hr-agent-manifest',
      'evidence-hr-identity-role',
      'evidence-hr-data-classification',
      'evidence-hr-mcp-approved',
    ])
    expect([...evidenceIds].filter((id) => id.startsWith('evidence-cr-'))).toEqual([
      'evidence-cr-agent-manifest',
      'evidence-cr-identity-role',
      'evidence-cr-data-classification',
      'evidence-cr-mcp-approved',
    ])

    for (const node of snapshot.nodes)
      expect(node.evidenceIds.every((id) => evidenceIds.has(id))).toBe(true)
    for (const edge of snapshot.edges) {
      expect(nodeIds.has(edge.from)).toBe(true)
      expect(nodeIds.has(edge.to)).toBe(true)
      expect(edge.evidenceIds.every((id) => evidenceIds.has(id))).toBe(true)
    }
  })

  it('executes an approved remediation and preserves an audit result', async () => {
    const connector = new MockAgentConnector()
    const remediation: Remediation = {
      id: 'remediation-1',
      findingId: 'finding-1',
      title: 'Block external MCP route',
      description: 'Disable the data-to-MCP relationship.',
      targetEdgeId: 'edge-data-mcp',
      status: 'approved',
      expectedRiskReduction: 91,
      businessDisruption: 'low',
      approvedBy: 'Avery Morgan',
      approvedAt: '2026-08-14T12:01:00.000Z',
      approvalReason: 'Validated critical exposure',
      rollbackAvailable: true,
    }
    const result = await connector.execute(remediation, {
      approvedBy: 'Avery Morgan',
      approvedAt: '2026-08-14T12:01:00.000Z',
      reason: 'Validated critical exposure',
    })
    expect(result.remediation.status).toBe('completed')
    expect(result.snapshot.edges.find((edge) => edge.id === 'edge-data-mcp')?.active).toBe(false)
  })
})
