// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import type { ExposureFinding, ExposurePage } from '@agent-sentinel/domain'

import { exposureApi } from './exposure-api'

function makePageResponse(overrides: Partial<ExposureFinding> = {}): ExposurePage {
  const finding: ExposureFinding = {
    id: 'finding-1',
    policyId: 'AS-POL-004',
    policyName: 'Data egress without approval',
    severity: 'critical',
    status: 'open',
    riskScore: 82,
    title: 'Sales exposure',
    summary: 'Sales agent is exposed.',
    recommendation: 'Contain.',
    affectedAgentId: 'sales-research-agent',
    affectedAgentName: 'Sales Research Agent',
    declaredTools: [],
    affectedNodeIds: ['sales-research-agent'],
    affectedEdgeIds: ['edge-sales'],
    evidenceIds: ['evidence-sales'],
    evidenceTypes: ['declared_configuration'],
    blastRadiusCount: 2,
    blastRadiusNodeIds: ['sales-research-agent', 'sales-identity'],
    firstSeen: '2026-08-14T12:00:00.000Z',
    lastSeen: '2026-08-14T12:00:00.000Z',
    sourceMode: 'mock',
    validationStatus: 'theoretical',
    tenantId: 'test',
    snapshotId: 'snap-test',
    ...overrides,
  }

  return {
    findings: [finding],
    total: 1,
    facets: { severity: { critical: 1 }, status: { open: 1 }, policyId: { 'AS-POL-004': 1 } },
  }
}

function jsonResponse(page: ExposurePage): Response {
  return new Response(JSON.stringify(page), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('exposureApi', () => {
  it('parses a valid list response and forwards filters', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          findings: [],
          total: 0,
          facets: { severity: {}, status: {}, policyId: {} },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const page = await exposureApi.list({ severity: 'high' })
    expect(page.total).toBe(0)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/exposures?severity=high')
    vi.unstubAllGlobals()
  })

  it('rejects with the API error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ message: 'nope' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    await expect(exposureApi.list()).rejects.toThrow('nope')
    vi.unstubAllGlobals()
  })

  it('parses a remediation preview response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          findingId: 'finding-1',
          actionId: 'preview-finding-1',
          actionType: 'block-route',
          title: 'Block route to External send',
          description: 'Simulation only.',
          targetEdgeIds: ['edge-1'],
          simulationOnly: true,
          before: { riskScore: 91, blastRadiusCount: 2 },
          after: { riskScore: 0, blastRadiusCount: 1 },
          impact: {
            riskReduction: 91,
            blastRadiusReduction: 1,
            businessDisruption: 'unknown',
            workflowImpact: 'unknown',
            rollbackAvailable: true,
          },
          beforeGraph: {
            tenantId: 'tenant-demo',
            environment: 'validation',
            generatedAt: '2026-08-18T09:00:00.000Z',
            nodes: [],
            edges: [],
            evidence: [],
          },
          afterGraph: {
            tenantId: 'tenant-demo',
            environment: 'validation',
            generatedAt: '2026-08-18T09:00:00.000Z',
            nodes: [],
            edges: [],
            evidence: [],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const preview = await exposureApi.getRemediationPreview('finding-1')

    expect(preview.after.riskScore).toBe(0)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/exposures/finding-1/remediation-preview')
    vi.unstubAllGlobals()
  })

  it('requests and parses an advisory incident narrative', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          findingId: 'finding-1',
          model: 'gpt-5.6-terra',
          generatedAt: '2026-08-20T00:00:00.000Z',
          summary: 'Grounded summary.',
          attackPathExplanation: 'Grounded path.',
          impactExplanation: 'Grounded impact.',
          recommendationExplanation: 'Grounded recommendation.',
          sectionCitations: {
            summary: ['evidence-1'],
            attackPathExplanation: ['evidence-1'],
            impactExplanation: ['evidence-1'],
            recommendationExplanation: ['evidence-1'],
            uncertainty: ['evidence-1'],
          },
          uncertainty: ['Runtime behavior is not observed.'],
          citations: [{ evidenceId: 'evidence-1', claim: 'Grounded claim.' }],
          advisoryOnly: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const narrative = await exposureApi.generateNarrative('finding-1')

    expect(narrative.model).toBe('gpt-5.6-terra')
    expect(fetchMock.mock.calls[0]).toEqual(['/api/exposures/finding-1/narrative'])
    vi.unstubAllGlobals()
  })

  it('uses authenticated POST only when the advisory API requires it', async () => {
    const narrative = {
      findingId: 'finding-1',
      model: 'gpt-5.6-terra',
      generatedAt: '2026-08-20T00:00:00.000Z',
      summary: 'Grounded summary.',
      attackPathExplanation: 'Grounded path.',
      impactExplanation: 'Grounded impact.',
      recommendationExplanation: 'Grounded recommendation.',
      sectionCitations: {
        summary: ['evidence-1'],
        attackPathExplanation: ['evidence-1'],
        impactExplanation: ['evidence-1'],
        recommendationExplanation: ['evidence-1'],
        uncertainty: ['evidence-1'],
      },
      uncertainty: ['Runtime behavior is not observed.'],
      citations: [{ evidenceId: 'evidence-1', claim: 'Grounded claim.' }],
      advisoryOnly: true,
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'authenticated_post_required' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(narrative), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(exposureApi.generateNarrative('finding-1')).resolves.toMatchObject({
      model: 'gpt-5.6-terra',
    })
    expect(fetchMock.mock.calls).toEqual([
      ['/api/exposures/finding-1/narrative'],
      ['/api/exposures/finding-1/narrative', { method: 'POST' }],
    ])
    vi.unstubAllGlobals()
  })

  describe('listAll', () => {
    it('returns a complete-schema finding from a single page', async () => {
      const page = makePageResponse()
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(page))
      vi.stubGlobal('fetch', fetchMock)

      await expect(exposureApi.listAll()).resolves.toEqual(page.findings)
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/exposures?page=1&pageSize=200')
      vi.unstubAllGlobals()
    })

    it('requests pages until the reported total is collected', async () => {
      const firstPage = { ...makePageResponse(), total: 2 }
      const secondPage = { ...makePageResponse({ id: 'finding-2' }), total: 2 }
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(firstPage))
        .mockResolvedValueOnce(jsonResponse(secondPage))
      vi.stubGlobal('fetch', fetchMock)

      await expect(exposureApi.listAll({ severity: 'critical', pageSize: 1 })).resolves.toEqual([
        ...firstPage.findings,
        ...secondPage.findings,
      ])
      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        '/api/exposures?severity=critical&page=1&pageSize=1',
        '/api/exposures?severity=critical&page=2&pageSize=1',
      ])
      vi.unstubAllGlobals()
    })

    it('fails closed on an empty page before the reported total is collected', async () => {
      const page = { ...makePageResponse(), findings: [], total: 3 }
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(page))
      vi.stubGlobal('fetch', fetchMock)

      await expect(exposureApi.listAll()).rejects.toThrow(
        /Exposure pagination ended before completion/,
      )
      expect(fetchMock).toHaveBeenCalledOnce()
      vi.unstubAllGlobals()
    })

    it('throws when MAX_PAGES is exhausted before all findings are collected', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => {
        const page = {
          ...makePageResponse({ id: `finding-${fetchMock.mock.calls.length}` }),
          total: 200,
        }
        return Promise.resolve(jsonResponse(page))
      })
      vi.stubGlobal('fetch', fetchMock)

      await expect(exposureApi.listAll({ pageSize: 1 })).rejects.toThrow(
        /Pagination limit.*exhausted/,
      )
      expect(fetchMock).toHaveBeenCalledTimes(100)
      vi.unstubAllGlobals()
    })

    it('fails closed when repeated pages do not advance unique results', async () => {
      const page = { ...makePageResponse(), total: 2 }
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(() => Promise.resolve(jsonResponse(page)))
      vi.stubGlobal('fetch', fetchMock)

      await expect(exposureApi.listAll({ pageSize: 1 })).rejects.toThrow(
        /Pagination limit.*exhausted/,
      )
      expect(fetchMock).toHaveBeenCalledTimes(100)
      vi.unstubAllGlobals()
    })

    it('fails closed when the reported total changes during pagination', async () => {
      const firstPage = { ...makePageResponse(), total: 2 }
      const secondPage = { ...makePageResponse({ id: 'finding-2' }), total: 1 }
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(firstPage))
        .mockResolvedValueOnce(jsonResponse(secondPage))
      vi.stubGlobal('fetch', fetchMock)

      await expect(exposureApi.listAll({ pageSize: 1 })).rejects.toThrow(
        /Exposure pagination changed during collection/,
      )
      vi.unstubAllGlobals()
    })

    it('fails closed when the snapshot changes during pagination', async () => {
      const firstPage = { ...makePageResponse(), total: 2 }
      const secondPage = {
        ...makePageResponse({ id: 'finding-2', snapshotId: 'snap-other' }),
        total: 2,
      }
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(firstPage))
        .mockResolvedValueOnce(jsonResponse(secondPage))
      vi.stubGlobal('fetch', fetchMock)

      await expect(exposureApi.listAll({ pageSize: 1 })).rejects.toThrow(
        /Exposure snapshot changed during pagination/,
      )
      vi.unstubAllGlobals()
    })

    it('fails closed when a page mixes snapshots', async () => {
      const page = { ...makePageResponse(), total: 0 }
      page.findings.push({
        ...page.findings[0]!,
        id: 'finding-2',
        snapshotId: 'snap-other',
      })
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(page))
      vi.stubGlobal('fetch', fetchMock)

      await expect(exposureApi.listAll()).rejects.toThrow(/multiple snapshots/)
      vi.unstubAllGlobals()
    })
  })
})
