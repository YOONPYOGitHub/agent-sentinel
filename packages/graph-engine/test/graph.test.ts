import { describe, expect, it } from 'vitest'

import type { EstateSnapshot, RiskFactors } from '@agent-sentinel/domain'

import {
  calculateBlastRadius,
  disableEdge,
  findAttackPaths,
  simulateEdgeRemoval,
} from '../src/index.js'

const evidence = {
  id: 'evidence-1',
  source: 'mock',
  sourceObjectId: 'object-1',
  observedAt: '2026-08-14T12:00:00.000Z',
  freshness: 'live' as const,
  confidence: 1,
  evidenceTypes: ['synthetic_validation' as const],
  summary: 'Synthetic evidence',
}

const snapshot: EstateSnapshot = {
  tenantId: 'tenant-demo',
  environment: 'demo',
  generatedAt: '2026-08-14T12:00:00.000Z',
  evidence: [evidence],
  nodes: ['input', 'agent', 'identity', 'data', 'mcp'].map((id) => ({
    id,
    kind:
      id === 'input'
        ? 'input'
        : id === 'agent'
          ? 'agent'
          : id === 'identity'
            ? 'identity'
            : id === 'data'
              ? 'data'
              : 'mcp',
    name: id,
    description: id,
    environment: 'demo',
    evidenceIds: [evidence.id],
    metadata: {},
  })),
  edges: [
    ['input-agent', 'input', 'agent', 'TRIGGERS', false],
    ['agent-identity', 'agent', 'identity', 'RUNS_AS', false],
    ['identity-data', 'identity', 'data', 'CAN_READ', false],
    ['data-mcp', 'data', 'mcp', 'CAN_EXFILTRATE_TO', true],
  ].map(([id, from, to, relationship, removable]) => ({
    id: String(id),
    from: String(from),
    to: String(to),
    relationship: relationship as 'TRIGGERS',
    evidenceIds: [evidence.id],
    active: true,
    removable: Boolean(removable),
  })),
}

const factors: RiskFactors = {
  reachability: 1,
  exploitability: 1,
  businessImpact: 1,
  privilege: 1,
  dataSensitivity: 1,
  activity: 1,
  confidence: 1,
  compensatingControlDiscount: 0.05,
}

describe('graph engine', () => {
  it('finds an evidence-backed path from untrusted input to external MCP', () => {
    const paths = findAttackPaths(snapshot, {
      sourceNodeIds: ['input'],
      targetNodeIds: ['mcp'],
      factors,
    })

    expect(paths).toHaveLength(1)
    expect(paths[0]?.nodeIds).toEqual(['input', 'agent', 'identity', 'data', 'mcp'])
    expect(paths[0]?.riskScore).toBe(95)
    expect(paths[0]?.evidenceIds).toEqual(['evidence-1'])
  })

  it('removes the attack path and reduces blast radius after remediation', () => {
    const before = calculateBlastRadius(snapshot, 'input')
    const remediated = disableEdge(snapshot, 'data-mcp')
    const after = calculateBlastRadius(remediated, 'input')
    const paths = findAttackPaths(remediated, {
      sourceNodeIds: ['input'],
      targetNodeIds: ['mcp'],
      factors,
    })

    expect(before.map((node) => node.id)).toContain('mcp')
    expect(after.map((node) => node.id)).not.toContain('mcp')
    expect(paths).toHaveLength(0)
  })

  it('previews a non-removable edge without mutating the source snapshot', () => {
    const immutableEdge = snapshot.edges.find((edge) => edge.id === 'data-mcp')
    expect(immutableEdge).toBeDefined()
    const previewSource = {
      ...snapshot,
      edges: snapshot.edges.map((edge) =>
        edge.id === 'data-mcp' ? { ...edge, removable: false } : edge,
      ),
    }

    const preview = simulateEdgeRemoval(previewSource, 'data-mcp')

    expect(preview.edges.find((edge) => edge.id === 'data-mcp')?.active).toBe(false)
    expect(previewSource.edges.find((edge) => edge.id === 'data-mcp')?.active).toBe(true)
  })
})
