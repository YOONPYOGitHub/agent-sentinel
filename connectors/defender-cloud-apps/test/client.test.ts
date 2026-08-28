import type { AccessToken, GetTokenOptions, TokenCredential } from '@azure/core-auth'
import { describe, expect, it, vi } from 'vitest'

import {
  DefenderCloudAppsClient,
  DefenderCloudAppsConnectorError,
  DEFENDER_CLOUD_APPS_ACTIVITIES_PATH,
  DEFENDER_CLOUD_APPS_ALERTS_PATH,
  DEFENDER_CLOUD_APPS_TOKEN_SCOPE,
  defenderCloudAppsLimitsSchema,
  defenderCloudAppsSourceConfigSchema,
  sanitizeDefenderCloudAppsApiBaseUrl,
} from '../src/index.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'
const NOW = Date.parse('2026-08-28T08:00:00Z')
const source = defenderCloudAppsSourceConfigSchema.parse({
  id: 'tenant-a',
  name: 'Tenant A',
  tenantId: TENANT_ID,
  environment: 'production',
  portalHostname: 'contoso.us2.portal.cloudappsecurity.com',
})
const limits = defenderCloudAppsLimitsSchema.parse({
  lookbackHours: 24,
  pageSize: 2,
  maxPages: 6,
  maxItems: 10,
  requestTimeoutMs: 1_000,
  maxRetries: 2,
  maxRetryAfterMs: 2_000,
  maxResponseBytes: 20_000,
})

function tokenForTenant(tenantId = TENANT_ID): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ tid: tenantId })}.signature`
}

class TestCredential implements TokenCredential {
  readonly scopes: (string | string[])[]
  constructor(
    private readonly accessToken: AccessToken | null = {
      token: tokenForTenant(),
      expiresOnTimestamp: NOW + 60_000,
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

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input
  return new URL(typeof input === 'string' ? input : input.url)
}

function emptyCollection(): Response {
  return json({ data: [], hasNext: false, total: 0 })
}

describe('DefenderCloudAppsClient', () => {
  it('probes both authoritative list capabilities', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(emptyCollection()))
    await new DefenderCloudAppsClient(source, limits, new TestCredential(), {
      fetcher,
      now: () => NOW,
    }).probe()
    expect(fetcher.mock.calls.map(([input]) => requestUrl(input).pathname)).toEqual([
      DEFENDER_CLOUD_APPS_ALERTS_PATH,
      DEFENDER_CLOUD_APPS_ACTIVITIES_PATH,
    ])
    expect(
      fetcher.mock.calls.every(([input]) => requestUrl(input).searchParams.get('limit') === '1'),
    ).toBe(true)
  })

  it('uses exact GET list endpoints, documented OAuth audience, and fixed lookback query fields', async () => {
    const credential = new TestCredential()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(emptyCollection()))
    await new DefenderCloudAppsClient(source, limits, credential, {
      fetcher,
      now: () => NOW,
    }).collect()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(credential.scopes).toEqual([
      DEFENDER_CLOUD_APPS_TOKEN_SCOPE,
      DEFENDER_CLOUD_APPS_TOKEN_SCOPE,
    ])
    expect(fetcher.mock.calls.map(([input]) => requestUrl(input).pathname)).toEqual([
      DEFENDER_CLOUD_APPS_ALERTS_PATH,
      DEFENDER_CLOUD_APPS_ACTIVITIES_PATH,
    ])
    for (const [input, init] of fetcher.mock.calls) {
      const url = requestUrl(input)
      expect(url.origin).toBe(source.apiBaseUrl)
      expect(JSON.parse(url.searchParams.get('filters')!)).toEqual({
        date: { gte: NOW - 24 * 60 * 60 * 1_000 },
      })
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        sortDirection: 'desc',
        sortField: 'date',
        skip: '0',
        limit: '2',
      })
      expect(init?.method).toBe('GET')
      expect(init?.body).toBeUndefined()
      expect(init?.headers).toEqual({
        Accept: 'application/json',
        Authorization: `Bearer ${tokenForTenant()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      })
    }
  })

  it('advances skip by returned items only while hasNext is true', async () => {
    const alert1 = { _id: 'alert-1', timestamp: NOW, severityValue: 2 }
    const alert2 = { _id: 'alert-2', timestamp: NOW - 1 }
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input)
      if (url.pathname === DEFENDER_CLOUD_APPS_ACTIVITIES_PATH) {
        return Promise.resolve(emptyCollection())
      }
      return Promise.resolve(
        url.searchParams.get('skip') === '0'
          ? json({ data: [alert1], hasNext: true, total: 2 })
          : json({ data: [alert2], hasNext: false, total: 2 }),
      )
    })
    const result = await new DefenderCloudAppsClient(source, limits, new TestCredential(), {
      fetcher,
      now: () => NOW,
    }).collect()
    expect(result.alerts.map((alert) => alert.id)).toEqual(['alert-1', 'alert-2'])
    expect(requestUrl(fetcher.mock.calls[1]![0]).searchParams.get('skip')).toBe('1')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('applies the page budget independently to alerts and activities', async () => {
    const onePagePerResource = defenderCloudAppsLimitsSchema.parse({
      ...limits,
      maxPages: 1,
    })
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(
          requestUrl(input).pathname === DEFENDER_CLOUD_APPS_ALERTS_PATH
            ? json({ data: [{ _id: 'alert-1', timestamp: NOW }], hasNext: false })
            : json({ data: [{ _id: 'activity-1', timestamp: NOW }], hasNext: false }),
        ),
      )

    await expect(
      new DefenderCloudAppsClient(source, onePagePerResource, new TestCredential(), {
        fetcher,
        now: () => NOW,
      }).collect(),
    ).resolves.toMatchObject({
      alerts: [{ id: 'alert-1' }],
      activities: [{ id: 'activity-1' }],
    })
  })

  it('rejects repeated pages, nonadvancing hasNext, duplicate ids, and page exhaustion', async () => {
    const alert = { _id: 'alert-1', timestamp: NOW }
    const cases = [
      vi
        .fn<typeof fetch>()
        .mockImplementation(() => Promise.resolve(json({ data: [alert], hasNext: true }))),
      vi
        .fn<typeof fetch>()
        .mockImplementation(() => Promise.resolve(json({ data: [], hasNext: true }))),
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ data: [alert], hasNext: true }))
        .mockResolvedValueOnce(json({ data: [alert], hasNext: false })),
    ]
    for (const fetcher of cases) {
      await expect(
        new DefenderCloudAppsClient(source, limits, new TestCredential(), {
          fetcher,
          now: () => NOW,
        }).collect(),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof DefenderCloudAppsConnectorError &&
          (error.code === 'bounds' || error.code === 'malformed-response'),
      )
    }

    const pageLimits = defenderCloudAppsLimitsSchema.parse({ ...limits, maxPages: 2 })
    let pageIdentifier = 0
    await expect(
      new DefenderCloudAppsClient(source, pageLimits, new TestCredential(), {
        fetcher: vi.fn<typeof fetch>().mockImplementation(() =>
          Promise.resolve(
            json({
              data: [{ _id: `page-${pageIdentifier++}`, timestamp: NOW }],
              hasNext: true,
            }),
          ),
        ),
        now: () => NOW,
      }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })
  })

  it('enforces aggregate alert plus activity item and response-byte bounds without truncation', async () => {
    const bounded = defenderCloudAppsLimitsSchema.parse({ ...limits, maxItems: 1 })
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(
          requestUrl(input).pathname === DEFENDER_CLOUD_APPS_ALERTS_PATH
            ? json({ data: [{ _id: 'alert-1', timestamp: NOW }], hasNext: false })
            : json({ data: [{ _id: 'activity-1', timestamp: NOW }], hasNext: false }),
        ),
      )
    await expect(
      new DefenderCloudAppsClient(source, bounded, new TestCredential(), {
        fetcher,
        now: () => NOW,
      }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })

    const bytes = defenderCloudAppsLimitsSchema.parse({ ...limits, maxResponseBytes: 1_024 })
    await expect(
      new DefenderCloudAppsClient(source, bytes, new TestCredential(), {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response('x'.repeat(1_025), { headers: { 'content-length': '1025' } }),
          ),
        now: () => NOW,
      }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })
  })

  it('retries only 429 with a bounded Retry-After value', async () => {
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined)
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, { status: 429, headers: { 'retry-after': '1' } }))
      .mockImplementation(() => Promise.resolve(emptyCollection()))
    await new DefenderCloudAppsClient(source, limits, new TestCredential(), {
      fetcher,
      sleep,
      now: () => NOW,
    }).collect()
    expect(sleep).toHaveBeenCalledWith(1_000)
    expect(fetcher).toHaveBeenCalledTimes(3)

    for (const response of [
      json({}, { status: 500, headers: { 'retry-after': '1' } }),
      json({}, { status: 429 }),
      json({}, { status: 429, headers: { 'retry-after': '99' } }),
    ]) {
      const noRetry = vi.fn<typeof fetch>().mockResolvedValue(response)
      await expect(
        new DefenderCloudAppsClient(source, limits, new TestCredential(), {
          fetcher: noRetry,
          now: () => NOW,
        }).collect(),
      ).rejects.toMatchObject({ code: 'request-failed' })
      expect(noRetry).toHaveBeenCalledTimes(1)
    }
  })

  it.each([
    [401, 'authentication'],
    [403, 'authorization'],
    [404, 'not-available'],
    [418, 'request-failed'],
  ] as const)(
    'maps status %s to stable reason %s without reading provider bodies',
    async (status, code) => {
      const client = new DefenderCloudAppsClient(source, limits, new TestCredential(), {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(
          json(
            {
              error: {
                message: 'private username user@contoso.com and 192.0.2.1 must never be surfaced',
              },
            },
            { status },
          ),
        ),
        now: () => NOW,
      })
      await expect(client.collect()).rejects.toMatchObject({ code, status })
    },
  )

  it('rejects malformed responses but strips bounded additive and private fields', async () => {
    const privateAlert = {
      _id: 'alert-1',
      timestamp: NOW,
      severityValue: 1,
      title: 'private narrative',
      description: 'user@contoso.com from 192.0.2.1',
      entities: [
        { type: 'account', id: 'private-account', label: 'Person', pa: 'user@contoso.com' },
        { type: 'service', id: 20940, label: 'Safe service label is still omitted' },
        {
          type: 'policyRule',
          id: 'policy-1',
          policyType: 'ANOMALY_DETECTION',
          label: 'private policy name',
        },
      ],
      future: 'additive',
    }
    const privateActivity = {
      _id: 'activity-1',
      timestamp: NOW,
      actionType: 'Login',
      service: 20893,
      policy: 'policy-2',
      user: { username: 'user@contoso.com' },
      ip: { address: '192.0.2.1' },
      description: 'private narrative',
      future: 'additive',
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(
          requestUrl(input).pathname === DEFENDER_CLOUD_APPS_ALERTS_PATH
            ? json({ data: [privateAlert], hasNext: false, futureEnvelope: true })
            : json({ data: [privateActivity], hasNext: false, futureEnvelope: true }),
        ),
      )
    const result = await new DefenderCloudAppsClient(source, limits, new TestCredential(), {
      fetcher,
      now: () => NOW,
    }).collect()
    expect(result.alerts).toEqual([
      {
        id: 'alert-1',
        timestamp: NOW,
        severityValue: 1,
        serviceId: '20940',
        policyId: 'policy-1',
        policyType: 'ANOMALY_DETECTION',
      },
    ])
    expect(result.activities).toEqual([
      {
        id: 'activity-1',
        timestamp: NOW,
        actionType: 'Login',
        serviceId: '20893',
        policyId: 'policy-2',
      },
    ])
    const serialized = JSON.stringify(result)
    for (const forbidden of [
      'user@contoso.com',
      '192.0.2.1',
      'private narrative',
      'private-account',
      'future',
      'label',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }

    for (const body of [
      { value: [], hasNext: false },
      { data: [], hasNext: 'false' },
      { data: [{ _id: 'missing-timestamp' }], hasNext: false },
    ]) {
      await expect(
        new DefenderCloudAppsClient(source, limits, new TestCredential(), {
          fetcher: vi.fn<typeof fetch>().mockResolvedValue(json(body)),
          now: () => NOW,
        }).collect(),
      ).rejects.toMatchObject({ code: 'malformed-response' })
    }
  })

  it('rejects cross-tenant and opaque tokens that cannot be tenant-bound', async () => {
    await expect(
      new DefenderCloudAppsClient(
        source,
        limits,
        new TestCredential({
          token: tokenForTenant('00000000-0000-0000-0000-000000000099'),
          expiresOnTimestamp: NOW + 60_000,
        }),
        { fetcher: vi.fn<typeof fetch>(), now: () => NOW },
      ).collect(),
    ).rejects.toMatchObject({ code: 'authentication' })

    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(emptyCollection()))
    await expect(
      new DefenderCloudAppsClient(
        source,
        limits,
        new TestCredential({ token: 'opaque-oauth-token', expiresOnTimestamp: NOW + 60_000 }),
        { fetcher, now: () => NOW },
      ).collect(),
    ).rejects.toMatchObject({ code: 'authentication' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('maps token, network, malformed JSON, and request timeouts to stable reasons', async () => {
    await expect(
      new DefenderCloudAppsClient(source, limits, new TestCredential(null), {
        fetcher: vi.fn<typeof fetch>(),
        now: () => NOW,
      }).collect(),
    ).rejects.toMatchObject({ code: 'authentication' })

    await expect(
      new DefenderCloudAppsClient(source, limits, new TestCredential(), {
        fetcher: vi.fn<typeof fetch>().mockRejectedValue(new Error('private network detail')),
        now: () => NOW,
      }).collect(),
    ).rejects.toMatchObject({ code: 'network' })

    await expect(
      new DefenderCloudAppsClient(source, limits, new TestCredential(), {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response('{')),
        now: () => NOW,
      }).collect(),
    ).rejects.toMatchObject({ code: 'malformed-response' })

    const timeoutLimits = defenderCloudAppsLimitsSchema.parse({
      ...limits,
      requestTimeoutMs: 100,
    })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    await expect(
      new DefenderCloudAppsClient(source, timeoutLimits, new TestCredential(), {
        fetcher,
        now: () => NOW,
      }).collect(),
    ).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('Defender for Cloud Apps tenant portal boundary', () => {
  it('accepts only the official tenant-and-region portal host format', () => {
    expect(sanitizeDefenderCloudAppsApiBaseUrl(source.apiBaseUrl)).toBe(source.apiBaseUrl)
    expect(sanitizeDefenderCloudAppsApiBaseUrl('CONTOSO.US2.portal.cloudappsecurity.com')).toBe(
      source.apiBaseUrl,
    )
    for (const value of [
      'http://contoso.us2.portal.cloudappsecurity.com',
      'https://user:pass@contoso.us2.portal.cloudappsecurity.com',
      'https://contoso.us2.portal.cloudappsecurity.com:443',
      'https://contoso.us2.portal.cloudappsecurity.com/api',
      'https://contoso.us2.portal.cloudappsecurity.com?x=1',
      'https://contoso.us2.portal.cloudappsecurity.com/#x',
      'https://portal.cloudappsecurity.com',
      'https://contoso.portal.cloudappsecurity.com',
      'https://contoso.us2.portal.cloudappsecurity.com.evil.example',
      'https://evil.example',
    ]) {
      expect(() => sanitizeDefenderCloudAppsApiBaseUrl(value)).toThrow()
    }
  })
})
