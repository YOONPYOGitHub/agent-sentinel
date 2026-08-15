import type { AccessToken, TokenCredential } from '@azure/core-auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FoundryHttpClient, sanitizeFoundryEndpoint } from './foundry-http.js'

class TestCredential implements TokenCredential {
  getToken(): Promise<AccessToken> {
    return Promise.resolve({ token: 'test-token', expiresOnTimestamp: Date.now() + 60_000 })
  }
}

function client(): FoundryHttpClient {
  return new FoundryHttpClient(
    'https://contoso.services.ai.azure.com/api/projects/sentinel',
    new TestCredential(),
  )
}

function requestedUrl(index: number): URL {
  const target: unknown = vi.mocked(fetch).mock.calls[index]?.[0]
  if (!(target instanceof URL)) throw new Error(`Expected request ${index} to use a URL.`)
  return target
}

describe('FoundryHttpClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('surfaces the endpoint, status, and Foundry error message', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ error: { message: 'Unauthorized by RBAC.' } }, { status: 403 }),
    )
    await expect(client().createAgent('test-agent', {})).rejects.toThrow(
      /agents\/test-agent\/versions.*status 403: Unauthorized by RBAC/,
    )
  })

  it('gets an existing agent by encoded immutable ID', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ id: 'agent-id', name: 'sales-research', version: '1' }),
    )
    await expect(client().getAgent('agent/id')).resolves.toMatchObject({ id: 'agent-id' })
    expect(requestedUrl(0).toString()).toContain('/agents/agent%2Fid')
  })

  it('treats only GET 404 as absence', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ error: { message: 'Missing.' } }, { status: 404 }),
    )
    await expect(client().getAgent('missing')).resolves.toBeUndefined()
  })

  it('paginates safely through body and header continuation tokens', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ value: [{ id: 'one' }], continuationToken: 'body' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [{ id: 'two' }] }), {
          headers: { 'x-ms-continuation-token': 'header' },
        }),
      )
      .mockResolvedValueOnce(Response.json({ value: [{ id: 'three' }] }))
    await expect(client().listAgents()).resolves.toHaveLength(3)
    expect(requestedUrl(1).searchParams.get('continuationToken')).toBe('body')
    expect(requestedUrl(2).searchParams.get('continuationToken')).toBe('header')
  })

  it('rejects nextLink values outside the agents collection', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ value: [], nextLink: 'https://evil.example/agents?api-version=v1' }),
    )
    await expect(client().listAgents()).rejects.toThrow('untrusted agents nextLink')
  })

  it('retries transient statuses with bounded exponential backoff', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const retryingClient = new FoundryHttpClient(
      'https://contoso.services.ai.azure.com/api/projects/sentinel',
      new TestCredential(),
      sleep,
    )
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ value: [] }))

    await expect(retryingClient.listAgents()).resolves.toEqual([])
    expect(sleep).toHaveBeenCalledWith(1_000)
    expect(retryingClient.retryCount).toBe(1)
  })
})

describe('sanitizeFoundryEndpoint', () => {
  it('normalizes a valid endpoint', () => {
    expect(
      sanitizeFoundryEndpoint(
        ' https://contoso.services.ai.azure.com/api/projects/sentinel/ ',
      ),
    ).toBe('https://contoso.services.ai.azure.com/api/projects/sentinel')
  })

  it.each([
    'http://contoso.services.ai.azure.com/api/projects/sentinel',
    'https://evil.example/api/projects/sentinel',
    'https://contoso.services.ai.azure.com/api/projects/sentinel?secret=value',
    'https://user:pass@contoso.services.ai.azure.com/api/projects/sentinel',
    'https://contoso.services.ai.azure.com/openai',
  ])('rejects unsafe endpoint %s', (endpoint) => {
    expect(() => sanitizeFoundryEndpoint(endpoint)).toThrow()
  })
})
