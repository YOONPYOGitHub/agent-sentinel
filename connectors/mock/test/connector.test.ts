import { describe, expect, it } from 'vitest'

import type { Remediation } from '@agent-sentinel/domain'

import { MockAgentConnector } from '../src/index.js'

describe('MockAgentConnector', () => {
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
