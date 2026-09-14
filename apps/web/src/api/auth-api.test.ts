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
            tenantId: '11111111-1111-4111-8111-111111111111',
            clientId: '22222222-2222-4222-8222-222222222222',
            authority: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111',
            scopes: ['api://agent-sentinel/AgentSentinel.Read'],
            redirectUri: 'https://sentinel.example/auth/callback',
            postLogoutRedirectUri: 'https://sentinel.example/',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(authApi.getConfig()).resolves.toEqual({ enabled: false })
    await expect(authApi.getConfig()).resolves.toMatchObject({
      enabled: true,
      clientId: '22222222-2222-4222-8222-222222222222',
    })
  })

  it('fails closed when configuration cannot be loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 503 })),
    )

    await expect(authApi.getConfig()).rejects.toThrow(/could not be loaded/)
  })

  it('rejects an authority that does not match the configured tenant', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            enabled: true,
            tenantId: '11111111-1111-4111-8111-111111111111',
            clientId: '22222222-2222-4222-8222-222222222222',
            authority: 'https://login.microsoftonline.com/organizations',
            scopes: ['api://agent-sentinel/AgentSentinel.Read'],
            redirectUri: 'https://sentinel.example/auth-redirect.html',
            postLogoutRedirectUri: 'https://sentinel.example/',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    await expect(authApi.getConfig()).rejects.toThrow(/configured tenant/)
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
