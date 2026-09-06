import { describe, expect, it, vi } from 'vitest'

import type {
  EstateSnapshot,
  Evidence,
  ExposureFinding,
  ExposureFindingRepository,
  SnapshotRepository,
} from '@agent-sentinel/domain'

import { createApp } from '../src/app.js'
import { buildRemediationPreview } from '../src/exposure-routes.js'

async function makeApp(
  mode: 'mock' | 'live',
  repository?: ExposureFindingRepository,
  snapshotRepository?: SnapshotRepository,
): ReturnType<typeof createApp> {
  process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
  const app = await createApp(
    undefined,
    { mode: 'disabled', allowedScopes: { read: [], write: [] } },
    {
      dataMode: mode,
      ...(repository ? { exposureRepository: repository } : {}),
      ...(snapshotRepository ? { snapshotRepository } : {}),
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

function makePreviewSnapshot(
  options: {
    alternateRoute?: boolean
    staleOrUnknownEvidence?: boolean
  } = {},
): EstateSnapshot {
  const observedAt = '2026-08-14T12:00:00.000Z'
  const evidence: Evidence = {
    id: 'ev-1',
    source: 'Azure AI Foundry Agent Service',
    sourceObjectId: 'agent-1',
    observedAt,
    freshness: options.staleOrUnknownEvidence ? 'stale' : 'live',
    confidence: 1,
    evidenceTypes: options.staleOrUnknownEvidence ? ['unknown'] : ['declared_configuration'],
    summary: 'Declared configuration evidence.',
  }
  const toolNode = (id: string, name: string) => ({
    id,
    kind: 'tool' as const,
    name,
    description: `Declared function ${name}.`,
    environment: 'validation',
    trust: 'conditional' as const,
    evidenceIds: [evidence.id],
    metadata: {},
  })
  return {
    tenantId: 'tenant-demo',
    environment: 'validation',
    generatedAt: observedAt,
    evidence: [evidence],
    nodes: [
      {
        id: 'agent-1',
        kind: 'agent',
        name: 'Agent One',
        description: 'Agent under analysis.',
        environment: 'validation',
        trust: 'conditional',
        evidenceIds: [evidence.id],
        metadata: { approvalRequired: 'false' },
      },
      toolNode('external-tool-1', 'external_send'),
      ...(options.alternateRoute ? [toolNode('external-tool-2', 'external_transfer')] : []),
    ],
    edges: [
      {
        id: 'edge-1',
        from: 'agent-1',
        to: 'external-tool-1',
        relationship: 'CAN_CALL',
        evidenceIds: [evidence.id],
        active: true,
        removable: false,
      },
      ...(options.alternateRoute
        ? [
            {
              id: 'edge-2',
              from: 'agent-1',
              to: 'external-tool-2',
              relationship: 'CAN_CALL' as const,
              evidenceIds: [evidence.id],
              active: true,
              removable: false,
            },
          ]
        : []),
    ],
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

  it('rejects a tenant assertion outside the authorized estate', async () => {
    const app = await makeApp('mock')
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/exposures?tenantId=tenant-other',
      })
      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ error: 'forbidden' })
    } finally {
      await app.close()
    }
  })

  it('rejects an environment assertion outside the authorized estate', async () => {
    const app = await makeApp('mock')
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/exposures?environment=production',
      })
      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ error: 'forbidden' })
    } finally {
      await app.close()
    }
  })

  it('returns an evidence-backed graph scoped to the finding', async () => {
    const app = await makeApp('mock')
    try {
      const list = await app.inject({ method: 'GET', url: '/api/exposures' })
      const listBody: { findings: ExposureFinding[] } = list.json()
      const finding = listBody.findings[0]!
      const response = await app.inject({
        method: 'GET',
        url: `/api/exposures/${finding.id}/graph`,
      })
      expect(response.statusCode).toBe(200)
      const graph: EstateSnapshot = response.json()
      expect(graph.nodes.some((node) => node.id === finding.affectedAgentId)).toBe(true)
      expect(graph.edges.map((edge) => edge.id).sort()).toEqual([...finding.affectedEdgeIds].sort())
      expect(graph.edges.every((edge) => graph.nodes.some((node) => node.id === edge.from))).toBe(
        true,
      )
      expect(graph.edges.every((edge) => graph.nodes.some((node) => node.id === edge.to))).toBe(
        true,
      )
      expect(graph.evidence.length).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })

  it('calculates a simulation-only remediation impact preview', async () => {
    const app = await makeApp('mock')
    try {
      const list = await app.inject({ method: 'GET', url: '/api/exposures' })
      const listBody: { findings: ExposureFinding[] } = list.json()
      const finding = listBody.findings.find((candidate) => candidate.affectedEdgeIds.length > 0)!
      const response = await app.inject({
        method: 'GET',
        url: `/api/exposures/${finding.id}/remediation-preview`,
      })
      expect(response.statusCode).toBe(200)
      const preview: {
        findingId: string
        simulationOnly: boolean
        before: { riskScore: number; blastRadiusCount: number }
        after: { riskScore: number; blastRadiusCount: number }
        targetEdgeIds: string[]
        residualFindings: ExposureFinding[]
        residualRoutes: Array<{ edgeIds: string[]; riskScore: number }>
        uncertainty: Array<{ code: string; evidenceIds: string[] }>
        citedEvidence: Evidence[]
        beforeGraph: EstateSnapshot
        afterGraph: EstateSnapshot
      } = response.json()
      expect(preview).toMatchObject({
        findingId: finding.id,
        simulationOnly: true,
        before: { riskScore: finding.riskScore },
        targetEdgeIds: finding.affectedEdgeIds,
      })
      expect(preview.after.riskScore).toBe(
        preview.residualFindings.reduce(
          (maximum, residual) => Math.max(maximum, residual.riskScore),
          0,
        ),
      )
      expect(preview.after.blastRadiusCount).toBeLessThan(preview.before.blastRadiusCount)
      expect(
        preview.afterGraph.edges
          .filter((edge) => finding.affectedEdgeIds.includes(edge.id))
          .every((edge) => !edge.active),
      ).toBe(true)
      expect(preview.beforeGraph.nodes.map((node) => node.id).sort()).toEqual(
        preview.afterGraph.nodes.map((node) => node.id).sort(),
      )
      expect(preview.beforeGraph.edges.map((edge) => edge.id).sort()).toEqual(
        preview.afterGraph.edges.map((edge) => edge.id).sort(),
      )
      expect(preview.citedEvidence.map((item) => item.id)).toEqual(
        expect.arrayContaining(finding.evidenceIds),
      )
    } finally {
      await app.close()
    }
  })

  it('retains nonzero residual risk when an alternate active route remains', () => {
    const preview = buildRemediationPreview(
      makePreviewSnapshot({ alternateRoute: true }),
      makeFinding(),
    )

    expect(preview.targetEdgeIds).toEqual(['edge-1'])
    expect(preview.after.riskScore).toBe(91)
    expect(preview.impact.riskReduction).toBe(0)
    expect(preview.residualFindings).toHaveLength(1)
    expect(preview.residualRoutes).toEqual([
      expect.objectContaining({ edgeIds: ['edge-2'], riskScore: 91 }),
    ])
  })

  it('reports partial route removal from the simulated snapshot', () => {
    const preview = buildRemediationPreview(
      makePreviewSnapshot({ alternateRoute: true }),
      makeFinding(),
    )

    expect(preview.afterGraph.edges.find((edge) => edge.id === 'edge-1')?.active).toBe(false)
    expect(preview.afterGraph.edges.find((edge) => edge.id === 'edge-2')?.active).toBe(true)
    expect(preview.after.blastRadiusCount).toBe(1)
  })

  it('reports zero residual risk only when all active risky routes are removed', () => {
    const preview = buildRemediationPreview(
      makePreviewSnapshot({ alternateRoute: true }),
      makeFinding({ affectedEdgeIds: ['edge-1', 'edge-2'] }),
    )

    expect(preview.after.riskScore).toBe(0)
    expect(preview.impact.riskReduction).toBe(91)
    expect(preview.residualFindings).toEqual([])
    expect(preview.residualRoutes).toEqual([])
  })

  it('reports unchanged residual risk when the requested route removal is a no-op', () => {
    const snapshot = makePreviewSnapshot({ alternateRoute: true })
    snapshot.edges = snapshot.edges.map((edge) =>
      edge.id === 'edge-1' ? { ...edge, active: false } : edge,
    )

    const preview = buildRemediationPreview(snapshot, makeFinding())

    expect(preview.title).toBe('No active risky routes to block')
    expect(preview.targetEdgeIds).toEqual([])
    expect(preview.after.riskScore).toBe(preview.before.riskScore)
    expect(preview.impact.riskReduction).toBe(0)
    expect(preview.residualRoutes).toEqual([
      expect.objectContaining({ edgeIds: ['edge-2'], riskScore: 91 }),
    ])
    expect(preview.uncertainty).toContainEqual(
      expect.objectContaining({ code: 'no-active-target-routes' }),
    )
  })

  it('never claims risk reduction when a stale finding has no target routes', () => {
    const preview = buildRemediationPreview(
      makePreviewSnapshot({ alternateRoute: true }),
      makeFinding({ affectedEdgeIds: [], riskScore: 99 }),
    )

    expect(preview.targetEdgeIds).toEqual([])
    expect(preview.after.riskScore).toBe(preview.before.riskScore)
    expect(preview.impact.riskReduction).toBe(0)
    expect(preview.residualFindings).toHaveLength(1)
    expect(preview.residualRoutes).toEqual([
      expect.objectContaining({ edgeIds: ['edge-1', 'edge-2'], riskScore: 91 }),
    ])
    expect(preview.citedEvidence).toEqual([expect.objectContaining({ id: 'ev-1' })])
  })

  it('never claims risk reduction when every requested target is inactive', () => {
    const snapshot = makePreviewSnapshot({ alternateRoute: true })
    snapshot.edges = snapshot.edges.map((edge) => ({ ...edge, active: false }))

    const preview = buildRemediationPreview(snapshot, makeFinding({ riskScore: 99 }))

    expect(preview.targetEdgeIds).toEqual([])
    expect(preview.after.riskScore).toBe(preview.before.riskScore)
    expect(preview.impact.riskReduction).toBe(0)
    expect(preview.uncertainty).toContainEqual(
      expect.objectContaining({ code: 'no-active-target-routes' }),
    )
  })

  it('reports partial target coverage when only some requested routes are active', () => {
    const preview = buildRemediationPreview(
      makePreviewSnapshot({ alternateRoute: true }),
      makeFinding({ affectedEdgeIds: ['edge-1', 'already-inactive-edge'] }),
    )

    expect(preview.targetEdgeIds).toEqual(['edge-1'])
    expect(preview.after.riskScore).toBe(91)
    expect(preview.impact.riskReduction).toBe(0)
    expect(preview.uncertainty).toContainEqual(
      expect.objectContaining({ code: 'partial-target-coverage' }),
    )
  })

  it('reports missing cited evidence as residual-analysis uncertainty', () => {
    const preview = buildRemediationPreview(
      makePreviewSnapshot({ alternateRoute: true }),
      makeFinding({ evidenceIds: ['ev-1', 'missing-evidence'] }),
    )

    expect(preview.after.riskScore).toBe(91)
    expect(preview.uncertainty).toContainEqual({
      code: 'missing-evidence',
      message: 'The simulated analysis references evidence absent from the snapshot.',
      evidenceIds: ['missing-evidence'],
    })
  })

  it('reports stale and unknown evidence as residual-analysis uncertainty', () => {
    const preview = buildRemediationPreview(
      makePreviewSnapshot({ alternateRoute: true, staleOrUnknownEvidence: true }),
      makeFinding(),
    )

    expect(preview.after.riskScore).toBe(91)
    expect(preview.uncertainty).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'stale-evidence', evidenceIds: ['ev-1'] }),
        expect.objectContaining({ code: 'unknown-evidence', evidenceIds: ['ev-1'] }),
      ]),
    )
  })

  it('claims no reduction when deterministic analysis cannot reproduce the selected policy', () => {
    const preview = buildRemediationPreview(
      makePreviewSnapshot(),
      makeFinding({ policyId: 'AS-POL-999', riskScore: 64 }),
    )

    expect(preview.after.riskScore).toBe(preview.before.riskScore)
    expect(preview.impact.riskReduction).toBe(0)
    expect(preview.uncertainty).toContainEqual(
      expect.objectContaining({ code: 'analysis-coverage-unknown' }),
    )
  })

  it('generates an evidence-cited advisory narrative without changing the finding', async () => {
    const app = await makeApp('mock')
    try {
      const list = await app.inject({ method: 'GET', url: '/api/exposures' })
      const listBody: { findings: ExposureFinding[] } = list.json()
      const finding = listBody.findings[0]!
      const response = await app.inject({
        method: 'GET',
        url: `/api/exposures/${finding.id}/narrative`,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        findingId: finding.id,
        model: 'deterministic-advisory-mock',
        advisoryOnly: true,
      })
      const detail = await app.inject({ method: 'GET', url: `/api/exposures/${finding.id}` })
      expect(detail.json()).toMatchObject({
        id: finding.id,
        policyId: finding.policyId,
        status: finding.status,
        riskScore: finding.riskScore,
        recommendation: finding.recommendation,
        validationStatus: finding.validationStatus,
      })
    } finally {
      await app.close()
    }
  })
})

describe('exposure API (live mode)', () => {
  it('rejects a cross-estate tenant before querying persistence', async () => {
    const listByTenant = vi.fn<ExposureFindingRepository['listByTenant']>()
    const getFacets = vi.fn<ExposureFindingRepository['getFacets']>()
    const repository: ExposureFindingRepository = {
      upsert: (_estate, finding) => Promise.resolve(finding),
      findById: () => Promise.resolve(null),
      listByTenant,
      getFacets,
      resolveAbsent: () => Promise.resolve([]),
    }
    const app = await makeApp('live', repository)
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/exposures?tenantId=tenant-other',
      })
      expect(response.statusCode).toBe(403)
      expect(listByTenant).not.toHaveBeenCalled()
      expect(getFacets).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('returns 404 when a detail finding belongs to another tenant', async () => {
    const findById = vi.fn<ExposureFindingRepository['findById']>()
    findById.mockResolvedValue(null)
    const repository: ExposureFindingRepository = {
      upsert: (_estate, finding) => Promise.resolve(finding),
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
      expect(findById).toHaveBeenCalledWith('exposure-as-pol-001-agent-1', {
        id: 'default',
        tenantId: 'tenant-demo',
        environment: 'validation',
      })
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
      upsert: (_estate, finding) => Promise.resolve(finding),
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
      expect(listByTenant).toHaveBeenCalledWith(
        {
          id: 'default',
          tenantId: 'tenant-demo',
          environment: 'validation',
        },
        {
          severity: 'critical',
          page: 1,
          pageSize: 1,
        },
      )
      expect(getFacets).toHaveBeenCalledWith({
        id: 'default',
        tenantId: 'tenant-demo',
        environment: 'validation',
      })
    } finally {
      await app.close()
    }
  })

  it('forbids mutations against /api/demo in live mode', async () => {
    const repository: ExposureFindingRepository = {
      upsert: (_estate, finding) => Promise.resolve(finding),
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

  it('loads the finding snapshot with an explicit tenant boundary', async () => {
    const finding = makeFinding()
    const repository: ExposureFindingRepository = {
      upsert: (_estate, finding) => Promise.resolve(finding),
      findById: () => Promise.resolve(finding),
      listByTenant: () => Promise.resolve({ items: [], total: 0 }),
      getFacets: () => Promise.resolve({ severity: {}, status: {}, policyId: {} }),
      resolveAbsent: () => Promise.resolve([]),
    }
    const snapshot: EstateSnapshot = {
      tenantId: 'tenant-demo',
      environment: 'production',
      generatedAt: '2026-08-14T12:00:00.000Z',
      nodes: [
        {
          id: 'agent-1',
          kind: 'agent',
          name: 'Agent One',
          description: 'Synthetic agent',
          environment: 'production',
          evidenceIds: ['ev-1'],
          metadata: {},
        },
      ],
      edges: [],
      evidence: [
        {
          id: 'ev-1',
          source: 'Synthetic connector',
          sourceObjectId: 'agent-1',
          observedAt: '2026-08-14T12:00:00.000Z',
          freshness: 'live',
          confidence: 1,
          evidenceTypes: ['synthetic_validation'],
          summary: 'Synthetic evidence',
        },
      ],
    }
    const findById = vi.fn<SnapshotRepository['findById']>().mockResolvedValue(snapshot)
    const snapshotRepository: SnapshotRepository = {
      save: () => Promise.resolve(),
      findLatest: () => Promise.resolve(null),
      findById,
      list: () => Promise.resolve([]),
    }
    const app = await makeApp('live', repository, snapshotRepository)
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/exposures/${finding.id}/graph`,
      })
      expect(response.statusCode).toBe(200)
      expect(findById).toHaveBeenCalledWith('snap-1', {
        id: 'default',
        tenantId: 'tenant-demo',
        environment: 'validation',
      })
    } finally {
      await app.close()
    }
  })

  it('returns a deterministic residual preview when the target route is no longer active', async () => {
    const finding = makeFinding()
    const snapshot = makePreviewSnapshot({ alternateRoute: true })
    snapshot.edges = snapshot.edges.map((edge) =>
      edge.id === 'edge-1' ? { ...edge, active: false } : edge,
    )
    const repository: ExposureFindingRepository = {
      upsert: (_estate, value) => Promise.resolve(value),
      findById: () => Promise.resolve(finding),
      listByTenant: () => Promise.resolve({ items: [], total: 0 }),
      getFacets: () => Promise.resolve({ severity: {}, status: {}, policyId: {} }),
      resolveAbsent: () => Promise.resolve([]),
    }
    const snapshotRepository: SnapshotRepository = {
      save: () => Promise.resolve(),
      findLatest: () => Promise.resolve(null),
      findById: () => Promise.resolve(snapshot),
      list: () => Promise.resolve([]),
    }
    const app = await makeApp('live', repository, snapshotRepository)
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/exposures/${finding.id}/remediation-preview`,
      })

      expect(response.statusCode).toBe(200)
      const body: {
        title: string
        targetEdgeIds: string[]
        after: { riskScore: number }
        impact: { riskReduction: number }
        residualRoutes: Array<{ edgeIds: string[]; riskScore: number }>
        uncertainty: Array<{ code: string }>
      } = response.json()
      expect(body).toMatchObject({
        title: 'No active risky routes to block',
        targetEdgeIds: [],
        after: { riskScore: 91 },
        impact: { riskReduction: 0 },
        residualRoutes: [{ edgeIds: ['edge-2'], riskScore: 91 }],
      })
      expect(body.uncertainty).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'no-active-target-routes' })]),
      )
    } finally {
      await app.close()
    }
  })
})
