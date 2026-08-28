import type { AccessToken, GetTokenOptions, TokenCredential } from '@azure/core-auth'
import { describe, expect, it, vi } from 'vitest'

import {
  PurviewGraphClient,
  PURVIEW_SENSITIVITY_LABELS_PATH,
  PURVIEW_TOKEN_SCOPE,
  purviewLimitsSchema,
  sanitizePurviewGraphBaseUrl,
} from '../src/index.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'
const LABEL_ID = '10000000-0000-0000-0000-000000000001'
const label = {
  id: LABEL_ID,
  displayName: 'Confidential',
  name: 'Confidential',
  color: '#ff0000',
  sensitivity: 10,
  priority: 20,
  applicableTo: 'email,site,unifiedGroup,teamwork,file,schematizedData',
  isEnabled: true,
}

function tokenForTenant(tenantId = TENANT_ID): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ tid: tenantId })}.signature`
}

class TestCredential implements TokenCredential {
  readonly scopes: (string | string[])[]
  constructor(
    private readonly accessToken: AccessToken | null = {
      token: tokenForTenant(),
      expiresOnTimestamp: Date.now() + 60_000,
    },
    scopes: (string | string[])[] = [],
  ) {
    this.scopes = scopes
  }
  getToken(scopes: string | string[], options?: GetTokenOptions): Promise<AccessToken | null> {
    void options
    this.scopes.push(scopes)
    return Promise.resolve(this.accessToken)
  }
}

const limits = purviewLimitsSchema.parse({
  maxPages: 3,
  maxItems: 10,
  requestTimeoutMs: 1_000,
  maxRetries: 2,
  maxRetryAfterMs: 2_000,
  maxResponseBytes: 20_000,
})

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.toString() : input.url
}

describe('PurviewGraphClient', () => {
  it('uses only the fixed v1.0 tenant label list, exact Graph scope, GET, and no caller OData', async () => {
    const credential = new TestCredential()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ value: [label] }))
    await expect(
      new PurviewGraphClient(limits, credential, TENANT_ID, { fetcher }).collect(),
    ).resolves.toEqual([label])
    expect(credential.scopes).toEqual([PURVIEW_TOKEN_SCOPE])
    const [input, init] = fetcher.mock.calls[0]!
    expect(requestUrl(input)).toBe(`https://graph.microsoft.com${PURVIEW_SENSITIVITY_LABELS_PATH}`)
    expect(requestUrl(input)).not.toContain('?')
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect(init?.headers).toEqual({
      Accept: 'application/json',
      Authorization: `Bearer ${tokenForTenant()}`,
    })
  })

  it('follows only same-origin exact-path nextLink and rejects hostile or repeated links', async () => {
    const nextLink = `https://graph.microsoft.com${PURVIEW_SENSITIVITY_LABELS_PATH}?$skiptoken=opaque`
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ value: [label], '@odata.nextLink': nextLink }))
      .mockResolvedValueOnce(
        json({
          value: [{ ...label, id: '10000000-0000-0000-0000-000000000002', name: 'General' }],
        }),
      )
    const result = await new PurviewGraphClient(limits, new TestCredential(), TENANT_ID, {
      fetcher,
    }).collect()
    expect(result).toHaveLength(2)
    expect(requestUrl(fetcher.mock.calls[1]![0])).toBe(nextLink)

    for (const link of [
      `https://evil.example${PURVIEW_SENSITIVITY_LABELS_PATH}?$skiptoken=x`,
      `http://graph.microsoft.com${PURVIEW_SENSITIVITY_LABELS_PATH}?$skiptoken=x`,
      `https://graph.microsoft.com:444${PURVIEW_SENSITIVITY_LABELS_PATH}?$skiptoken=x`,
      `https://graph.microsoft.com/beta/security/dataSecurityAndGovernance/sensitivityLabels?$skiptoken=x`,
      `https://graph.microsoft.com${PURVIEW_SENSITIVITY_LABELS_PATH}/${LABEL_ID}`,
      `https://graph.microsoft.com${PURVIEW_SENSITIVITY_LABELS_PATH}?$skiptoken=x#fragment`,
    ]) {
      await expect(
        new PurviewGraphClient(limits, new TestCredential(), TENANT_ID, {
          fetcher: vi
            .fn<typeof fetch>()
            .mockResolvedValue(json({ value: [label], '@odata.nextLink': link })),
        }).collect(),
      ).rejects.toMatchObject({ code: 'malformed-response' })
    }

    const repeated = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ value: [], '@odata.nextLink': nextLink }))
      .mockResolvedValueOnce(json({ value: [], '@odata.nextLink': nextLink }))
    await expect(
      new PurviewGraphClient(limits, new TestCredential(), TENANT_ID, {
        fetcher: repeated,
      }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })
  })

  it('never silently truncates page, item, response-byte, or aggregate caller bounds', async () => {
    const nextLink = `https://graph.microsoft.com${PURVIEW_SENSITIVITY_LABELS_PATH}?$skiptoken=more`
    await expect(
      new PurviewGraphClient(limits, new TestCredential(), TENANT_ID, {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(json({ value: [label], '@odata.nextLink': nextLink })),
      }).collect(1),
    ).rejects.toMatchObject({ code: 'bounds' })

    const itemLimits = purviewLimitsSchema.parse({ ...limits, maxItems: 1 })
    await expect(
      new PurviewGraphClient(itemLimits, new TestCredential(), TENANT_ID, {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(
          json({
            value: [label, { ...label, id: '10000000-0000-0000-0000-000000000002' }],
          }),
        ),
      }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })

    const pageLimits = purviewLimitsSchema.parse({ ...limits, maxPages: 1 })
    await expect(
      new PurviewGraphClient(pageLimits, new TestCredential(), TENANT_ID, {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(json({ value: [], '@odata.nextLink': nextLink })),
      }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })

    const byteLimits = purviewLimitsSchema.parse({ ...limits, maxResponseBytes: 1_024 })
    await expect(
      new PurviewGraphClient(byteLimits, new TestCredential(), TENANT_ID, {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response('x'.repeat(1_025), { headers: { 'content-length': '1025' } }),
          ),
      }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })
  })

  it.each([429, 500, 502, 503, 504])(
    'retries transient status %s only with bounded Retry-After',
    async (status) => {
      const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined)
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({}, { status, headers: { 'retry-after': '1' } }))
        .mockResolvedValueOnce(json({ value: [] }))
      await new PurviewGraphClient(limits, new TestCredential(), TENANT_ID, {
        fetcher,
        sleep,
      }).collect()
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(sleep).toHaveBeenCalledWith(1_000)
    },
  )

  it('does not retry other statuses or absent/excessive Retry-After', async () => {
    for (const response of [
      json({}, { status: 400, headers: { 'retry-after': '1' } }),
      json({}, { status: 503 }),
      json({}, { status: 503, headers: { 'retry-after': '99' } }),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
      await expect(
        new PurviewGraphClient(limits, new TestCredential(), TENANT_ID, {
          fetcher,
        }).collect(),
      ).rejects.toMatchObject({ code: 'request-failed' })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it.each([
    [401, 'authentication'],
    [403, 'authorization'],
    [404, 'not-available'],
    [418, 'request-failed'],
  ] as const)('maps %s to stable %s without retaining provider errors', async (status, code) => {
    const client = new PurviewGraphClient(limits, new TestCredential(), TENANT_ID, {
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ error: { message: 'private@contoso.com' } }, { status })),
    })
    await expect(client.collect()).rejects.toMatchObject({ code, status })
  })

  it('tolerates additive fields while validating and stripping known retained metadata', async () => {
    const result = await new PurviewGraphClient(limits, new TestCredential(), TENANT_ID, {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        json({
          '@odata.count': 1,
          additiveEnvelope: 'future',
          value: [
            {
              ...label,
              '@odata.type': '#microsoft.graph.security.sensitivityLabel',
              description: 'governance description not retained',
              future: 'additive',
            },
          ],
        }),
      ),
    }).collect()
    expect(result).toEqual([label])
    expect(JSON.stringify(result)).not.toContain('description')
    expect(JSON.stringify(result)).not.toContain('future')

    const nested = await new PurviewGraphClient(limits, new TestCredential(), TENANT_ID, {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        json({
          value: [
            {
              ...label,
              applicableTo: 'file,inventedTarget',
              sublabels: [
                {
                  ...label,
                  id: '00000000-0000-0000-0000-000000000002',
                  displayName: 'Nested label',
                },
              ],
            },
          ],
        }),
      ),
    }).collect()
    expect(nested).toMatchObject([
      { id: LABEL_ID, applicableTo: 'file' },
      { id: '00000000-0000-0000-0000-000000000002', displayName: 'Nested label' },
    ])
    expect(nested[0]).not.toHaveProperty('sublabels')

    for (const body of [
      { items: [label] },
      { value: [{ ...label, id: 'not-a-guid' }] },
      { value: [{ id: LABEL_ID }] },
      { value: [{ ...label, isEnabled: 'true' }] },
    ]) {
      await expect(
        new PurviewGraphClient(limits, new TestCredential(), TENANT_ID, {
          fetcher: vi.fn<typeof fetch>().mockResolvedValue(json(body)),
        }).collect(),
      ).rejects.toMatchObject({ code: 'malformed-response' })
    }
  })

  it('fails closed for cross-tenant, opaque, missing, and timed-out tokens', async () => {
    for (const accessToken of [
      {
        token: tokenForTenant('00000000-0000-0000-0000-000000000099'),
        expiresOnTimestamp: 1,
      },
      { token: 'opaque-token', expiresOnTimestamp: 1 },
      null,
    ]) {
      const fetcher = vi.fn<typeof fetch>()
      await expect(
        new PurviewGraphClient(limits, new TestCredential(accessToken), TENANT_ID, {
          fetcher,
        }).collect(),
      ).rejects.toMatchObject({ code: 'authentication' })
      expect(fetcher).not.toHaveBeenCalled()
    }

    const timeoutLimits = purviewLimitsSchema.parse({ ...limits, requestTimeoutMs: 100 })
    await expect(
      new PurviewGraphClient(
        timeoutLimits,
        { getToken: () => new Promise(() => undefined) },
        TENANT_ID,
        { fetcher: vi.fn<typeof fetch>() },
      ).collect(),
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('maps request aborts, network failures, and malformed JSON', async () => {
    await expect(
      new PurviewGraphClient(limits, new TestCredential(), TENANT_ID, {
        fetcher: vi.fn<typeof fetch>().mockRejectedValue(new Error('private network detail')),
      }).collect(),
    ).rejects.toMatchObject({ code: 'network' })
    await expect(
      new PurviewGraphClient(limits, new TestCredential(), TENANT_ID, {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response('{')),
      }).collect(),
    ).rejects.toMatchObject({ code: 'malformed-response' })

    const timeoutLimits = purviewLimitsSchema.parse({ ...limits, requestTimeoutMs: 100 })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    await expect(
      new PurviewGraphClient(timeoutLimits, new TestCredential(), TENANT_ID, {
        fetcher,
      }).collect(),
    ).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('Purview Global Graph boundary', () => {
  it('accepts only the exact credential-free Global Graph origin', () => {
    expect(sanitizePurviewGraphBaseUrl('https://graph.microsoft.com/')).toBe(
      'https://graph.microsoft.com',
    )
    for (const value of [
      'http://graph.microsoft.com',
      'https://user@example.com@graph.microsoft.com',
      'https://graph.microsoft.com:443',
      'https://graph.microsoft.com/v1.0',
      'https://graph.microsoft.com?x=1',
      'https://graph.microsoft.us',
      'https://evil.example',
    ]) {
      expect(() => sanitizePurviewGraphBaseUrl(value)).toThrow()
    }
  })
})
