import { describe, expect, it, vi } from 'vitest'

import type { ExposureFinding, ExposureFindingRepository } from '@agent-sentinel/domain'

import { createApp } from '../src/app.js'

async function makeApp(
  mode: 'mock' | 'live',
  repository?: ExposureFindingRepository,
): ReturnType<typeof createApp> {
  process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
  const app = await createApp(
    undefined,
    { mode: 'disabled', allowedScopes: { read: [], write: [] } },
    {
      dataMode: mode,
      ...(repository ? { exposureRepository: repository } : {}),
    },
  )
  return app
}

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

describe('exposure API (mock mode)', () => {
  it('returns a deterministic list from the foundry manifest', async () => {
    const app = await makeApp('mock')
    try {
      const response = await app.inject({ method: 'GET', url: '/api/exposures' })
      expect(response.statusCode).toBe(200)
      const body: {
        findings: ExposureFinding[]
        total: number
        facets: { severity: Record<string, number> }
      } = response.json()
      expect(body.total).toBeGreaterThan(0)
      const critical = body.findings.filter((f) => f.severity === 'critical')
      expect(critical.length).toBeGreaterThanOrEqual(2)
      expect(body.findings.every((f) => f.sourceMode === 'mock')).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('returns 404 for unknown finding', async () => {
    const app = await makeApp('mock')
    try {
      const response = await app.inject({ method: 'GET', url: '/api/exposures/nope' })
      expect(response.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('filters by severity and returns matching only', async () => {
    const app = await makeApp('mock')
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/exposures?severity=high',
      })
      const body: { findings: ExposureFinding[] } = response.json()
      expect(body.findings.every((f) => f.severity === 'high')).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('registers status route before parameter route', async () => {
    const app = await makeApp('mock')
    try {
      const response = await app.inject({ method: 'GET', url: '/api/exposures/status' })
      expect(response.statusCode).toBe(200)
      const body: { mode: string } = response.json()
      expect(body.mode).toBe('mock')
    } finally {
      await app.close()
    }
  })

  it('returns findings for a detail route', async () => {
    const app = await makeApp('mock')
    try {
      const list = await app.inject({ method: 'GET', url: '/api/exposures' })
      const listBody: { findings: ExposureFinding[] } = list.json()
      const findingId = listBody.findings[0]!.id
      const detail = await app.inject({ method: 'GET', url: `/api/exposures/${findingId}` })
      expect(detail.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('uses the default tenant for mock detail routes regardless of query parameters', async () => {
    const app = await makeApp('mock')
    try {
      const list = await app.inject({ method: 'GET', url: '/api/exposures' })
      const listBody: { findings: ExposureFinding[] } = list.json()
      const findingId = listBody.findings[0]!.id
      const detail = await app.inject({
        method: 'GET',
        url: '/api/exposures/' + findingId + '?tenantId=tenant-other',
      })
      const body: ExposureFinding = detail.json()
      expect(detail.statusCode).toBe(200)
      expect(body.tenantId).toBe('tenant-demo')
    } finally {
      await app.close()
    }
  })

  it('isolates tenants in mock mode', async () => {
    const app = await makeApp('mock')
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/exposures?tenantId=tenant-other',
      })
      const body: { findings: ExposureFinding[] } = response.json()
      expect(body.findings.length).toBe(0)
    } finally {
      await app.close()
    }
  })
})

describe('exposure API (live mode)', () => {
  it('returns 404 when a detail finding belongs to another tenant', async () => {
    const findById = vi.fn<ExposureFindingRepository['findById']>()
    findById.mockResolvedValue(null)
    const repository: ExposureFindingRepository = {
      upsert: (finding) => Promise.resolve(finding),
      findById,
      listByTenant: () => Promise.resolve({ items: [], total: 0 }),
      getFacets: () => Promise.resolve({ severity: {}, status: {}, policyId: {} }),
      resolveAbsent: () => Promise.resolve([]),
    }
    const app = await makeApp('live', repository)
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/exposures/exposure-as-pol-001-agent-1',
      })
      expect(response.statusCode).toBe(404)
      expect(findById).toHaveBeenCalledWith('exposure-as-pol-001-agent-1', 'tenant-demo')
    } finally {
      await app.close()
    }
  })

  it('builds facets from the unpaginated list', async () => {
    const filteredFinding = makeFinding({ id: 'filtered' })
    const listByTenant = vi.fn<ExposureFindingRepository['listByTenant']>()
    listByTenant.mockResolvedValue({ items: [filteredFinding], total: 1 })
    const getFacets = vi.fn<ExposureFindingRepository['getFacets']>()
    getFacets.mockResolvedValue({
      severity: { critical: 1, high: 1 },
      status: { open: 2 },
      policyId: { 'AS-POL-001': 1, 'AS-POL-002': 1 },
    })
    const repository: ExposureFindingRepository = {
      upsert: (finding) => Promise.resolve(finding),
      findById: () => Promise.resolve(null),
      listByTenant,
      getFacets,
      resolveAbsent: () => Promise.resolve([]),
    }
    const app = await makeApp('live', repository)
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/exposures?severity=critical&page=1&pageSize=1',
      })
      const body: { total: number; facets: { severity: Record<string, number> } } = response.json()
      expect(response.statusCode).toBe(200)
      expect(body.total).toBe(1)
      expect(body.facets.severity).toEqual({ critical: 1, high: 1 })
      expect(listByTenant).toHaveBeenCalledWith('tenant-demo', {
        severity: 'critical',
        page: 1,
        pageSize: 1,
      })
      expect(getFacets).toHaveBeenCalledWith('tenant-demo')
    } finally {
      await app.close()
    }
  })

  it('forbids mutations against /api/demo in live mode', async () => {
    const repository: ExposureFindingRepository = {
      upsert: (f) => Promise.resolve(f),
      findById: () => Promise.resolve(null),
      listByTenant: () => Promise.resolve({ items: [], total: 0 }),
      getFacets: () => Promise.resolve({ severity: {}, status: {}, policyId: {} }),
      resolveAbsent: () => Promise.resolve([]),
    }
    const app = await makeApp('live', repository)
    try {
      const response = await app.inject({ method: 'POST', url: '/api/demo/reset' })
      expect(response.statusCode).toBe(403)
      const body: { error: string } = response.json()
      expect(body.error).toBe('read_only_mode')
    } finally {
      await app.close()
    }
  })
})
