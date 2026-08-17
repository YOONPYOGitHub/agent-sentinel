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
})
