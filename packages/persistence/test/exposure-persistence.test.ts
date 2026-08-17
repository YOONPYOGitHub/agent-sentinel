import { describe, expect, it } from 'vitest'

import type { ExposureFinding } from '@agent-sentinel/domain'
import { InMemoryExposureFindingRepository } from '../src/in-memory-exposure-finding-repository.js'

function makeFinding(overrides: Partial<ExposureFinding> = {}): ExposureFinding {
  return {
    id: 'exposure-as-pol-001-agent-1',
    policyId: 'AS-POL-001',
    policyName: 'Unapproved external transfer or send',
    severity: 'critical',
    status: 'open',
    riskScore: 91,
    title: 'Agent can transfer data externally',
    summary: 'summary',
    recommendation: 'require approval',
    affectedAgentId: 'agent-1',
    affectedAgentName: 'Agent One',
    declaredTools: ['external_send'],
    affectedNodeIds: ['agent-1'],
    affectedEdgeIds: ['edge-1'],
    evidenceIds: ['ev-1'],
    evidenceTypes: ['declared_configuration'],
    blastRadiusCount: 2,
    blastRadiusNodeIds: ['n1', 'n2'],
    firstSeen: '2026-08-14T12:00:00.000Z',
    lastSeen: '2026-08-14T12:00:00.000Z',
    sourceMode: 'foundry',
    validationStatus: 'theoretical',
    tenantId: 'tenant-demo',
    snapshotId: 'snap-1',
    ...overrides,
  }
}

describe('InMemoryExposureFindingRepository', () => {
  it('preserves firstSeen across upserts', async () => {
    const repo = new InMemoryExposureFindingRepository()
    const first = await repo.upsert(makeFinding({ firstSeen: '2026-08-14T12:00:00.000Z' }))
    expect(first.firstSeen).toBe('2026-08-14T12:00:00.000Z')
    const second = await repo.upsert(makeFinding({ firstSeen: '2026-08-20T12:00:00.000Z' }))
    expect(second.firstSeen).toBe('2026-08-14T12:00:00.000Z')
  })

  it('filters by tenant, severity, status, and policyId with paging', async () => {
    const repo = new InMemoryExposureFindingRepository()
    await repo.upsert(makeFinding({ id: 'a', riskScore: 91 }))
    await repo.upsert(
      makeFinding({ id: 'b', policyId: 'AS-POL-002', severity: 'high', riskScore: 76 }),
    )
    await repo.upsert(makeFinding({ id: 'c', tenantId: 'other', severity: 'high' }))
    const result = await repo.listByTenant('tenant-demo', { pageSize: 10 })
    expect(result.total).toBe(2)
    expect(result.items[0]?.riskScore).toBe(91)
    const filtered = await repo.listByTenant('tenant-demo', { severity: 'high' })
    expect(filtered.total).toBe(1)
    expect(filtered.items[0]?.id).toBe('b')
    const byPolicy = await repo.listByTenant('tenant-demo', { policyId: 'AS-POL-001' })
    expect(byPolicy.total).toBe(1)
  })

  it('resolves absent findings only for the tenant', async () => {
    const repo = new InMemoryExposureFindingRepository()
    await repo.upsert(makeFinding({ id: 'keep' }))
    await repo.upsert(makeFinding({ id: 'gone' }))
    const resolved = await repo.resolveAbsent('tenant-demo', ['keep'])
    expect(resolved.map((r) => r.id)).toEqual(['gone'])
    const remaining = await repo.findById('gone')
    expect(remaining?.status).toBe('resolved')
  })
})
