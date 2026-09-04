import { describe, expect, it } from 'vitest'

import type { EstateContext, ExposureFinding } from '@agent-sentinel/domain'
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

function estate(
  tenantId = 'tenant-demo',
  id = tenantId,
  environment = 'validation',
): EstateContext {
  return { id, tenantId, environment }
}

describe('InMemoryExposureFindingRepository', () => {
  it('preserves firstSeen across upserts', async () => {
    const repo = new InMemoryExposureFindingRepository()
    const first = await repo.upsert(
      estate(),
      makeFinding({ firstSeen: '2026-08-14T12:00:00.000Z' }),
    )
    expect(first.firstSeen).toBe('2026-08-14T12:00:00.000Z')
    const second = await repo.upsert(
      estate(),
      makeFinding({ firstSeen: '2026-08-20T12:00:00.000Z' }),
    )
    expect(second.firstSeen).toBe('2026-08-14T12:00:00.000Z')
  })

  it('filters by tenant, severity, status, and policyId with paging', async () => {
    const repo = new InMemoryExposureFindingRepository()
    await repo.upsert(estate(), makeFinding({ id: 'a', riskScore: 91 }))
    await repo.upsert(
      estate(),
      makeFinding({ id: 'b', policyId: 'AS-POL-002', severity: 'high', riskScore: 76 }),
    )
    await repo.upsert(
      estate('other'),
      makeFinding({ id: 'c', tenantId: 'other', severity: 'high' }),
    )
    const result = await repo.listByTenant(estate(), { pageSize: 10 })
    expect(result.total).toBe(2)
    expect(result.items[0]?.riskScore).toBe(91)
    const filtered = await repo.listByTenant(estate(), { severity: 'high' })
    expect(filtered.total).toBe(1)
    expect(filtered.items[0]?.id).toBe('b')
    const byPolicy = await repo.listByTenant(estate(), { policyId: 'AS-POL-001' })
    expect(byPolicy.total).toBe(1)
  })

  it('resolves absent findings only for the tenant', async () => {
    const repo = new InMemoryExposureFindingRepository()
    await repo.upsert(estate(), makeFinding({ id: 'keep' }))
    await repo.upsert(estate(), makeFinding({ id: 'gone' }))
    const resolved = await repo.resolveAbsent(estate(), ['keep'])
    expect(resolved.map((r) => r.id)).toEqual(['gone'])
    const remaining = await repo.findById('gone', estate())
    expect(remaining?.status).toBe('resolved')
  })

  it('preserves findings from sources excluded from reconciliation', async () => {
    const repo = new InMemoryExposureFindingRepository()
    await repo.upsert(estate(), makeFinding({ id: 'foundry-gone' }))
    await repo.upsert(estate(), makeFinding({ id: 'manifest-active', sourceMode: 'manifest' }))
    const resolved = await repo.resolveAbsent(estate(), [], ['foundry'])
    expect(resolved.map((finding) => finding.id)).toEqual(['foundry-gone'])
    await expect(repo.findById('manifest-active', estate())).resolves.toMatchObject({
      status: 'open',
      sourceMode: 'manifest',
    })
  })

  it('isolates identical finding ids by tenant and aggregates all facets', async () => {
    const repo = new InMemoryExposureFindingRepository()
    await repo.upsert(estate('tenant-a'), makeFinding({ id: 'shared', tenantId: 'tenant-a' }))
    await repo.upsert(
      estate('tenant-b'),
      makeFinding({
        id: 'shared',
        tenantId: 'tenant-b',
        severity: 'high',
        policyId: 'AS-POL-002',
      }),
    )
    for (let index = 0; index < 60; index += 1) {
      await repo.upsert(
        estate('tenant-a'),
        makeFinding({ id: `tenant-a-${index}`, tenantId: 'tenant-a' }),
      )
    }

    await expect(repo.findById('shared', estate('tenant-a'))).resolves.toMatchObject({
      tenantId: 'tenant-a',
      severity: 'critical',
    })
    await expect(repo.findById('shared', estate('tenant-b'))).resolves.toMatchObject({
      tenantId: 'tenant-b',
      severity: 'high',
    })
    await expect(repo.getFacets(estate('tenant-a'))).resolves.toMatchObject({
      severity: { critical: 61 },
      policyId: { 'AS-POL-001': 61 },
    })
  })

  it('isolates identical finding IDs across environments in one tenant', async () => {
    const repo = new InMemoryExposureFindingRepository()
    const production = estate('tenant-a', 'production', 'production')
    const validation = estate('tenant-a', 'validation', 'validation')
    await repo.upsert(production, makeFinding({ id: 'shared', tenantId: 'tenant-a' }))
    await repo.upsert(
      validation,
      makeFinding({ id: 'shared', tenantId: 'tenant-a', severity: 'high' }),
    )

    await expect(repo.findById('shared', production)).resolves.toMatchObject({
      severity: 'critical',
    })
    await expect(repo.findById('shared', validation)).resolves.toMatchObject({
      severity: 'high',
    })
  })
})
