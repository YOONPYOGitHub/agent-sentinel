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
})
