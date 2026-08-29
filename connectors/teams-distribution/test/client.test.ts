import type { AccessToken, GetTokenOptions, TokenCredential } from '@azure/core-auth'
import { describe, expect, it, vi } from 'vitest'

import {
  TeamsDistributionGraphClient,
  TEAMS_DISTRIBUTION_APPS_PATH,
  TEAMS_DISTRIBUTION_ORGANIZATION_FILTER,
  TEAMS_DISTRIBUTION_SELECT,
  TEAMS_DISTRIBUTION_TOKEN_SCOPE,
  sanitizeTeamsDistributionGraphBaseUrl,
  teamsDistributionLimitsSchema,
} from '../src/index.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'
const APP_ID = '10000000-0000-0000-0000-000000000001'
const app = {
  id: APP_ID,
  externalId: '20000000-0000-0000-0000-000000000001',
  displayName: 'Contoso tenant app',
  distributionMethod: 'organization',
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

const limits = teamsDistributionLimitsSchema.parse({
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

describe('TeamsDistributionGraphClient', () => {
  it('uses only the fixed v1.0 organization catalog query, exact scope, GET, and select', async () => {
    const credential = new TestCredential()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ value: [app] }))
    await expect(
      new TeamsDistributionGraphClient(limits, credential, TENANT_ID, { fetcher }).collect(),
    ).resolves.toEqual([app])
    expect(credential.scopes).toEqual([TEAMS_DISTRIBUTION_TOKEN_SCOPE])
    const [input, init] = fetcher.mock.calls[0]!
    const url = new URL(requestUrl(input))
    expect(url.origin).toBe('https://graph.microsoft.com')
    expect(url.pathname).toBe(TEAMS_DISTRIBUTION_APPS_PATH)
    expect(url.searchParams.get('$filter')).toBe(TEAMS_DISTRIBUTION_ORGANIZATION_FILTER)
    expect(url.searchParams.get('$select')).toBe(TEAMS_DISTRIBUTION_SELECT)
    expect([...url.searchParams.keys()].sort()).toEqual(['$filter', '$select'])
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect(init?.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer ' + tokenForTenant(),
    })
  })

  it('follows only same-origin exact-path nextLink and rejects hostile or repeated links', async () => {
    const nextLink = `https://graph.microsoft.com${TEAMS_DISTRIBUTION_APPS_PATH}?$skiptoken=opaque`
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ value: [app], '@odata.nextLink': nextLink }))
      .mockResolvedValueOnce(
        json({ value: [{ ...app, id: '10000000-0000-0000-0000-000000000002' }] }),
      )
    await expect(
      new TeamsDistributionGraphClient(limits, new TestCredential(), TENANT_ID, {
        fetcher,
      }).collect(),
    ).resolves.toHaveLength(2)
    expect(requestUrl(fetcher.mock.calls[1]![0])).toBe(nextLink)

    for (const link of [
      `https://evil.example${TEAMS_DISTRIBUTION_APPS_PATH}?$skiptoken=x`,
      `http://graph.microsoft.com${TEAMS_DISTRIBUTION_APPS_PATH}?$skiptoken=x`,
      `https://graph.microsoft.com:444${TEAMS_DISTRIBUTION_APPS_PATH}?$skiptoken=x`,
      'https://graph.microsoft.com/beta/appCatalogs/teamsApps?$skiptoken=x',
      `https://graph.microsoft.com${TEAMS_DISTRIBUTION_APPS_PATH}/${APP_ID}`,
      `https://graph.microsoft.com${TEAMS_DISTRIBUTION_APPS_PATH}?$skiptoken=x#fragment`,
    ]) {
      await expect(
        new TeamsDistributionGraphClient(limits, new TestCredential(), TENANT_ID, {
          fetcher: vi
            .fn<typeof fetch>()
            .mockResolvedValue(json({ value: [app], '@odata.nextLink': link })),
        }).collect(),
      ).rejects.toMatchObject({ code: 'malformed-response' })
    }

    const repeated = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ value: [], '@odata.nextLink': nextLink }))
      .mockResolvedValueOnce(json({ value: [], '@odata.nextLink': nextLink }))
    await expect(
      new TeamsDistributionGraphClient(limits, new TestCredential(), TENANT_ID, {
        fetcher: repeated,
      }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })
  })

  it('never silently truncates page, item, response-byte, caller, or duplicate bounds', async () => {
    const nextLink = `https://graph.microsoft.com${TEAMS_DISTRIBUTION_APPS_PATH}?$skiptoken=more`
    await expect(
      new TeamsDistributionGraphClient(limits, new TestCredential(), TENANT_ID, {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(json({ value: [app], '@odata.nextLink': nextLink })),
      }).collect(1),
    ).rejects.toMatchObject({ code: 'bounds' })

    const itemLimits = teamsDistributionLimitsSchema.parse({ ...limits, maxItems: 1 })
    await expect(
      new TeamsDistributionGraphClient(itemLimits, new TestCredential(), TENANT_ID, {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(
          json({
            value: [app, { ...app, id: '10000000-0000-0000-0000-000000000002' }],
          }),
        ),
      }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })

    const pageLimits = teamsDistributionLimitsSchema.parse({ ...limits, maxPages: 1 })
    await expect(
      new TeamsDistributionGraphClient(pageLimits, new TestCredential(), TENANT_ID, {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(json({ value: [], '@odata.nextLink': nextLink })),
      }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })

    const byteLimits = teamsDistributionLimitsSchema.parse({
      ...limits,
      maxResponseBytes: 1_024,
    })
    await expect(
      new TeamsDistributionGraphClient(byteLimits, new TestCredential(), TENANT_ID, {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response('x'.repeat(1_025), { headers: { 'content-length': '1025' } }),
          ),
      }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })

    await expect(
      new TeamsDistributionGraphClient(limits, new TestCredential(), TENANT_ID, {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(json({ value: [app, app] })),
      }).collect(),
    ).rejects.toMatchObject({ code: 'malformed-response' })
  })

  it.each([429, 500, 502, 503, 504])(
    'retries transient status %s only with bounded Retry-After',
    async (status) => {
      const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined)
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({}, { status, headers: { 'retry-after': '1' } }))
        .mockResolvedValueOnce(json({ value: [] }))
      await new TeamsDistributionGraphClient(limits, new TestCredential(), TENANT_ID, {
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
        new TeamsDistributionGraphClient(limits, new TestCredential(), TENANT_ID, {
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
    const client = new TeamsDistributionGraphClient(limits, new TestCredential(), TENANT_ID, {
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ error: { message: 'private@contoso.com' } }, { status })),
    })
    await expect(client.collect()).rejects.toMatchObject({ code, status })
  })

  it('tolerates additive fields while stripping manifests, icons, files, and unknown data', async () => {
    const result = await new TeamsDistributionGraphClient(limits, new TestCredential(), TENANT_ID, {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        json({
          '@odata.count': 1,
          additiveEnvelope: 'future',
          value: [
            {
              ...app,
              '@odata.type': '#microsoft.graph.teamsApp',
              appDefinitions: [{ version: '1.0.0', publishingState: 'published' }],
              manifest: { bots: ['not retained'] },
              icon: 'not retained',
              file: 'not retained',
              future: 'additive',
            },
          ],
        }),
      ),
    }).collect()
    expect(result).toEqual([app])
    expect(JSON.stringify(result)).not.toMatch(/manifest|icon|file|future|version/i)

    await expect(
      new TeamsDistributionGraphClient(limits, new TestCredential(), TENANT_ID, {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(
          json({
            value: [
              {
                id: '30000000-0000-0000-0000-000000000003',
                externalId: '',
                displayName: null,
                distributionMethod: 'organization',
              },
            ],
          }),
        ),
      }).collect(),
    ).resolves.toEqual([
      {
        id: '30000000-0000-0000-0000-000000000003',
        distributionMethod: 'organization',
      },
    ])

    for (const body of [
      { items: [app] },
      { value: [{ ...app, id: 'not-a-guid' }] },
      { value: [{ ...app, distributionMethod: 'store' }] },
      { value: [{ ...app, distributionMethod: 'sideloaded' }] },
    ]) {
      await expect(
        new TeamsDistributionGraphClient(limits, new TestCredential(), TENANT_ID, {
          fetcher: vi.fn<typeof fetch>().mockResolvedValue(json(body)),
        }).collect(),
      ).rejects.toMatchObject({ code: 'malformed-response' })
    }
  })

  it('accepts a bounded opaque external catalog id', async () => {
    const result = await new TeamsDistributionGraphClient(limits, new TestCredential(), TENANT_ID, {
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ value: [{ ...app, externalId: 'lob-app-id' }] })),
    }).collect()
    expect(result[0]?.externalId).toBe('lob-app-id')
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
        new TeamsDistributionGraphClient(limits, new TestCredential(accessToken), TENANT_ID, {
          fetcher,
        }).collect(),
      ).rejects.toMatchObject({ code: 'authentication' })
      expect(fetcher).not.toHaveBeenCalled()
    }

    const timeoutLimits = teamsDistributionLimitsSchema.parse({
      ...limits,
      requestTimeoutMs: 100,
    })
    await expect(
      new TeamsDistributionGraphClient(
        timeoutLimits,
        { getToken: () => new Promise(() => undefined) },
        TENANT_ID,
        { fetcher: vi.fn<typeof fetch>() },
      ).collect(),
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('maps request aborts, network failures, and malformed JSON', async () => {
    await expect(
      new TeamsDistributionGraphClient(limits, new TestCredential(), TENANT_ID, {
        fetcher: vi.fn<typeof fetch>().mockRejectedValue(new Error('private network detail')),
      }).collect(),
    ).rejects.toMatchObject({ code: 'network' })
    await expect(
      new TeamsDistributionGraphClient(limits, new TestCredential(), TENANT_ID, {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response('{')),
      }).collect(),
    ).rejects.toMatchObject({ code: 'malformed-response' })

    const timeoutLimits = teamsDistributionLimitsSchema.parse({
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
      new TeamsDistributionGraphClient(timeoutLimits, new TestCredential(), TENANT_ID, {
        fetcher,
      }).collect(),
    ).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('Teams distribution Global Graph boundary', () => {
  it('accepts only the exact credential-free Global Graph origin', () => {
    expect(sanitizeTeamsDistributionGraphBaseUrl('https://graph.microsoft.com/')).toBe(
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
      expect(() => sanitizeTeamsDistributionGraphBaseUrl(value)).toThrow()
    }
  })
})
