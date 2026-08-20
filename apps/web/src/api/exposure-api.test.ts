// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import { exposureApi } from './exposure-api'

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
})
