import type { AccessToken, GetTokenOptions, TokenCredential } from '@azure/core-auth'
import { describe, expect, it, vi } from 'vitest'

import {
  Agent365ConnectorError,
  Agent365GraphClient,
  AGENT365_PACKAGES_PATH,
  AGENT365_TOKEN_SCOPE,
  agent365LimitsSchema,
  sanitizeAgent365GraphBaseUrl,
} from '../src/index.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'

function tokenForTenant(tenantId = TENANT_ID): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ tid: tenantId })}.signature`
}

class TestCredential implements TokenCredential {
  readonly scopes: (string | string[])[] = []
  constructor(
    private readonly token: AccessToken | null = {
      token: tokenForTenant(),
      expiresOnTimestamp: 1,
    },
  ) {}
  getToken(scopes: string | string[], options?: GetTokenOptions): Promise<AccessToken | null> {
    void options
    this.scopes.push(scopes)
    return Promise.resolve(this.token)
  }
}

const limits = agent365LimitsSchema.parse({
  maxPages: 3,
  maxItems: 10,
  requestTimeoutMs: 1_000,
  maxRetries: 2,
  maxRetryAfterMs: 2_000,
  maxResponseBytes: 20_000,
})
const item = { id: 'P_1', displayName: 'Package one' }

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function reason(error: unknown): string | undefined {
  return error instanceof Agent365ConnectorError ? error.code : undefined
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.toString() : input.url
}
describe('Agent365GraphClient', () => {
  it('uses only the exact GA list endpoint, GET method, Graph scope, and no unsupported select', async () => {
    const credential = new TestCredential()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ value: [item] }))
    const result = await new Agent365GraphClient(limits, credential, TENANT_ID, {
      fetcher,
    }).collect()
    expect(result).toEqual([item])
    expect(credential.scopes).toEqual([AGENT365_TOKEN_SCOPE])
    const [url, init] = fetcher.mock.calls[0]!
    expect(requestUrl(url)).toBe(`https://graph.microsoft.com${AGENT365_PACKAGES_PATH}`)
    expect(requestUrl(url)).not.toContain('$select')
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect(init?.headers).toEqual({
      Accept: 'application/json',
      Authorization: `Bearer ${tokenForTenant()}`,
    })
  })

  it('follows standard same-origin package-list nextLink values', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          '@odata.context':
            'https://graph.microsoft.com/v1.0/$metadata#copilot/admin/catalog/packages',
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?$skiptoken=opaque',
          value: [item],
        }),
      )
      .mockResolvedValueOnce(json({ value: [{ id: 'P_2', displayName: 'Package two' }] }))
    const result = await new Agent365GraphClient(limits, new TestCredential(), TENANT_ID, {
      fetcher,
    }).collect()
    expect(result.map((entry) => entry.id)).toEqual(['P_1', 'P_2'])
    expect(requestUrl(fetcher.mock.calls[1]![0])).toContain('$skiptoken=opaque')
  })

  it.each([
    'https://evil.example/v1.0/copilot/admin/catalog/packages?$skiptoken=x',
    'https://user:pass@graph.microsoft.com/v1.0/copilot/admin/catalog/packages?$skiptoken=x',
    'https://graph.microsoft.com:444/v1.0/copilot/admin/catalog/packages?$skiptoken=x',
    'https://graph.microsoft.com/beta/copilot/admin/catalog/packages?$skiptoken=x',
    'https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages/P_1',
    'https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?$skiptoken=x#fragment',
  ])('rejects hostile nextLink %s', async (nextLink) => {
    const client = new Agent365GraphClient(limits, new TestCredential(), TENANT_ID, {
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ '@odata.nextLink': nextLink, value: [item] })),
    })
    await expect(client.collect()).rejects.toMatchObject({ code: 'malformed-response' })
  })

  it('rejects repeated nextLink values', async () => {
    const link = 'https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?$skiptoken=same'
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ '@odata.nextLink': link, value: [item] }))
      .mockResolvedValueOnce(json({ '@odata.nextLink': link, value: [] }))
    await expect(
      new Agent365GraphClient(limits, new TestCredential(), TENANT_ID, { fetcher }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })
  })

  it('enforces page, item, response byte, and caller maximum bounds', async () => {
    await expect(
      new Agent365GraphClient(limits, new TestCredential(), TENANT_ID, {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(json({ value: [item] })),
      }).collect(11),
    ).rejects.toMatchObject({ code: 'bounds' })

    const itemLimits = agent365LimitsSchema.parse({ ...limits, maxItems: 1 })
    await expect(
      new Agent365GraphClient(itemLimits, new TestCredential(), TENANT_ID, {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(json({ value: [item, { id: 'P_2', displayName: 'Two' }] })),
      }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })

    const pageLimits = agent365LimitsSchema.parse({ ...limits, maxPages: 1 })
    await expect(
      new Agent365GraphClient(pageLimits, new TestCredential(), TENANT_ID, {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(
          json({
            '@odata.nextLink':
              'https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?$skiptoken=more',
            value: [item],
          }),
        ),
      }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })

    const byteLimits = agent365LimitsSchema.parse({ ...limits, maxResponseBytes: 1_024 })
    await expect(
      new Agent365GraphClient(byteLimits, new TestCredential(), TENANT_ID, {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response('x'.repeat(1_025), { headers: { 'content-length': '1025' } }),
          ),
      }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })
  })

  it('retries only documented transient statuses with bounded Retry-After', async () => {
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined)
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json(
          { error: { code: 'TooManyRequests' } },
          { status: 429, headers: { 'retry-after': '1' } },
        ),
      )
      .mockResolvedValueOnce(json({ value: [item] }))
    await new Agent365GraphClient(limits, new TestCredential(), TENANT_ID, {
      fetcher,
      sleep,
    }).collect()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(1_000)

    const noRetry = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ error: { code: 'BadRequest' } }, { status: 400, headers: { 'retry-after': '1' } }),
      )
    await expect(
      new Agent365GraphClient(limits, new TestCredential(), TENANT_ID, {
        fetcher: noRetry,
      }).collect(),
    ).rejects.toMatchObject({ code: 'request-failed', status: 400 })
    expect(noRetry).toHaveBeenCalledTimes(1)
  })

  it('does not retry absent or excessive Retry-After', async () => {
    for (const headers of [{}, { 'retry-after': '99' }]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          json({ error: { code: 'ServiceUnavailable' } }, { status: 503, headers }),
        )
      await expect(
        new Agent365GraphClient(limits, new TestCredential(), TENANT_ID, { fetcher }).collect(),
      ).rejects.toMatchObject({ code: 'request-failed', status: 503 })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it('sanitizes authentication, authorization, license, tenant availability, and status failures', async () => {
    const cases: [number, unknown, string][] = [
      [401, { error: { code: 'InvalidAuthenticationToken' } }, 'authentication'],
      [
        403,
        { error: { code: 'Authorization_RequestDenied', message: 'private' } },
        'authorization',
      ],
      [403, { error: { code: 'LicenseRequired', message: 'private' } }, 'license-required'],
      [404, { error: { code: 'NotFound', message: 'private' } }, 'not-available'],
      [418, { error: { code: 'private', message: 'private' } }, 'request-failed'],
    ]
    for (const [status, body, expected] of cases) {
      const client = new Agent365GraphClient(limits, new TestCredential(), TENANT_ID, {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(json(body, { status })),
      })
      await expect(client.collect()).rejects.toSatisfy(
        (error: unknown) => reason(error) === expected,
      )
    }
  })

  it('rejects a valid-looking Graph token from another tenant', async () => {
    const credential = new TestCredential({
      token: tokenForTenant('00000000-0000-0000-0000-000000000099'),
      expiresOnTimestamp: Date.now() + 60_000,
    })
    await expect(
      new Agent365GraphClient(limits, credential, TENANT_ID, {
        fetcher: vi.fn<typeof fetch>(),
      }).collect(),
    ).rejects.toMatchObject({ code: 'authentication' })
  })

  it('bounds token acquisition even when a credential ignores abort', async () => {
    const timeoutLimits = agent365LimitsSchema.parse({ ...limits, requestTimeoutMs: 100 })
    const credential: TokenCredential = {
      getToken: () => new Promise(() => undefined),
    }
    await expect(
      new Agent365GraphClient(timeoutLimits, credential, TENANT_ID, {
        fetcher: vi.fn<typeof fetch>(),
      }).collect(),
    ).rejects.toMatchObject({ code: 'timeout' })
  })
  it('maps missing tokens, network failures, and aborts to stable reasons', async () => {
    await expect(
      new Agent365GraphClient(limits, new TestCredential(null), TENANT_ID, {
        fetcher: vi.fn<typeof fetch>(),
      }).collect(),
    ).rejects.toMatchObject({ code: 'authentication' })

    await expect(
      new Agent365GraphClient(limits, new TestCredential(), TENANT_ID, {
        fetcher: vi.fn<typeof fetch>().mockRejectedValue(new Error('sensitive network detail')),
      }).collect(),
    ).rejects.toMatchObject({ code: 'network' })

    const timeoutLimits = agent365LimitsSchema.parse({ ...limits, requestTimeoutMs: 100 })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    await expect(
      new Agent365GraphClient(timeoutLimits, new TestCredential(), TENANT_ID, {
        fetcher,
      }).collect(),
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('rejects malformed envelopes and undocumented enum values', async () => {
    for (const body of [
      { items: [item] },
      { value: [{ ...item, type: 'invented' }] },
      { value: [{ ...item, appId: 'not-a-guid' }] },
    ]) {
      await expect(
        new Agent365GraphClient(limits, new TestCredential(), TENANT_ID, {
          fetcher: vi.fn<typeof fetch>().mockResolvedValue(json(body)),
        }).collect(),
      ).rejects.toMatchObject({ code: 'malformed-response' })
    }
  })

  it('tolerates additive bounded Graph fields without persisting them', async () => {
    const result = await new Agent365GraphClient(limits, new TestCredential(), TENANT_ID, {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        json({
          value: [{ ...item, additivePackageField: 'future' }],
          additiveEnvelopeField: 'future',
        }),
      ),
    }).collect()

    expect(result).toEqual([item])
    expect(result[0]).not.toHaveProperty('additivePackageField')
  })

  it('accepts documented bounded @odata metadata and non-RFC-versioned Azure GUIDs', async () => {
    const appId = '00000000-0000-0000-0000-000000000000'
    const result = await new Agent365GraphClient(limits, new TestCredential(), TENANT_ID, {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        json({
          '@odata.count': 1,
          value: [{ ...item, '@odata.type': '#microsoft.graph.copilotPackage', appId }],
        }),
      ),
    }).collect()
    expect(result[0]?.appId).toBe(appId)
  })
})

describe('Graph base URL boundary', () => {
  it('accepts only the fixed credential-free Graph origin', () => {
    expect(sanitizeAgent365GraphBaseUrl('https://graph.microsoft.com')).toBe(
      'https://graph.microsoft.com',
    )
    for (const value of [
      'http://graph.microsoft.com',
      'https://user:pass@graph.microsoft.com',
      'https://graph.microsoft.com:443',
      'https://graph.microsoft.com/v1.0',
      'https://graph.microsoft.com?x=1',
      'https://graph.microsoft.com/#x',
      'https://evil.example',
    ]) {
      expect(() => sanitizeAgent365GraphBaseUrl(value)).toThrow()
    }
  })
})
