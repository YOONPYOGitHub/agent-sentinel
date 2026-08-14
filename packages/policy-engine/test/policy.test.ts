import { describe, expect, it } from 'vitest'

import type { EstateSnapshot } from '@agent-sentinel/domain'

import { evaluateUncontrolledEgress } from '../src/index.js'

const snapshot: EstateSnapshot = {
  tenantId: 'tenant-demo',
  environment: 'demo',
  generatedAt: '2026-08-14T12:00:00.000Z',
  evidence: [
    {
      id: 'evidence',
      source: 'mock',
      sourceObjectId: 'object',
      observedAt: '2026-08-14T12:00:00.000Z',
      freshness: 'live',
      confidence: 1,
      summary: 'Synthetic evidence',
    },
  ],
  nodes: [
    {
      id: 'input',
      kind: 'input',
      name: 'External document',
      description: 'Untrusted document',
      environment: 'demo',
      trust: 'untrusted',
      evidenceIds: ['evidence'],
      metadata: {},
    },
    {
      id: 'mcp',
      kind: 'mcp',
      name: 'External MCP',
      description: 'Unapproved MCP server',
      environment: 'demo',
      trust: 'untrusted',
      evidenceIds: ['evidence'],
      metadata: {},
    },
  ],
  edges: [
    {
      id: 'edge',
      from: 'input',
      to: 'mcp',
      relationship: 'CAN_EXFILTRATE_TO',
      evidenceIds: ['evidence'],
      active: true,
      removable: true,
    },
  ],
}

describe('uncontrolled egress policy', () => {
  it('creates an explainable critical finding', () => {
    const findings = evaluateUncontrolledEgress(snapshot)

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      severity: 'critical',
      policyId: 'AS-POL-004',
    })
    expect(findings[0]?.path.evidenceIds).toEqual(['evidence'])
  })

  it('passes after the risky relationship is disabled', () => {
    const findings = evaluateUncontrolledEgress({
      ...snapshot,
      edges: snapshot.edges.map((edge) => ({ ...edge, active: false })),
    })

    expect(findings).toHaveLength(0)
  })
})
