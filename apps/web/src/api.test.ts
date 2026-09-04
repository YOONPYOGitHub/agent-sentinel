import { afterEach, describe, expect, it, vi } from 'vitest'

import { connectorApi, demoApi } from './api'
import { apiFetch, setActiveEstateId } from './api/auth-fetch'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('demoApi', () => {
  it('does not send a JSON content type for an empty POST', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          snapshot: {
            tenantId: 'demo',
            environment: 'demo',
            generatedAt: '2026-08-14T12:00:00.000Z',
            nodes: [],
            edges: [],
            evidence: [],
          },
          findings: [],
          validations: [],
          remediations: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    await demoApi.reset()
    expect(fetchMock).toHaveBeenCalledWith('/api/demo/reset', {
      method: 'POST',
    })
  })

  it('surfaces the API operation message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Validation is required.' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    await expect(demoApi.proposeRemediation('finding-1')).rejects.toThrow('Validation is required.')
  })
})

describe('connectorApi', () => {
  it('parses a valid connector status response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ source: 'mock', connectorId: 'mock-agent-estate', mode: 'mock' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
    )
    const status = await connectorApi.getConnectorStatus()
    expect(status).toMatchObject({
      source: 'mock',
      connectorId: 'mock-agent-estate',
      mode: 'mock',
    })
  })
})

describe('apiFetch', () => {
  it('adds the active estate header on each request', async () => {
    setActiveEstateId('korea')
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await apiFetch('/api/demo/state')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]
    expect(call).toBeDefined()
    const [, requestInit] = call!
    expect(requestInit).toBeDefined()
    expect((requestInit as RequestInit).headers).toBeInstanceOf(Headers)
    expect(new Headers((requestInit as RequestInit).headers).get('x-agent-sentinel-estate-id')).toBe(
      'korea',
    )
    setActiveEstateId(undefined)
  })
})
