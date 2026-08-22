// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { authApi } from './auth-api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('authApi', () => {
  it('parses disabled and enabled public configurations', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ enabled: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            enabled: true,
            clientId: 'spa-client',
            authority: 'https://login.microsoftonline.com/tenant-id',
            scopes: ['api://agent-sentinel/AgentSentinel.Read'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(authApi.getConfig()).resolves.toEqual({ enabled: false })
    await expect(authApi.getConfig()).resolves.toMatchObject({
      enabled: true,
      clientId: 'spa-client',
    })
  })

  it('fails closed when configuration cannot be loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 503 })),
    )

    await expect(authApi.getConfig()).rejects.toThrow(/could not be loaded/)
  })

  it('rejects malformed enabled configuration', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ enabled: true, clientId: 'missing-fields' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    await expect(authApi.getConfig()).rejects.toThrow()
  })
})
