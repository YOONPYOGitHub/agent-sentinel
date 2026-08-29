import type { AccessToken, GetTokenOptions, TokenCredential } from '@azure/core-auth'
import { describe, expect, it, vi } from 'vitest'

import {
  AzureResourceGraphClient,
  AZURE_RESOURCE_GRAPH_API_VERSION,
  AZURE_RESOURCE_GRAPH_ORIGIN,
  AZURE_RESOURCE_GRAPH_PATH,
  AZURE_RESOURCE_GRAPH_QUERY,
  AZURE_RESOURCE_GRAPH_TOKEN_SCOPE,
  azureResourceGraphLimitsSchema,
  azureResourceGraphSourceConfigSchema,
} from '../src/index.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'
const SUBSCRIPTION_ID = '10000000-0000-0000-0000-000000000001'
const source = azureResourceGraphSourceConfigSchema.parse({
  id: 'primary',
  name: 'Primary Azure subscription',
  tenantId: TENANT_ID,
  environment: 'validation',
  subscriptions: [SUBSCRIPTION_ID],
})
const limits = azureResourceGraphLimitsSchema.parse({
  pageSize: 2,
  maxPages: 3,
  maxItems: 10,
  requestTimeoutMs: 1_000,
  maxRetries: 2,
  maxRetryAfterMs: 2_000,
  maxResponseBytes: 20_000,
})
const resource = {
  id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/ai`,
  name: 'ai',
  type: 'microsoft.cognitiveservices/accounts',
  location: 'koreacentral',
  subscriptionId: SUBSCRIPTION_ID,
  resourceGroup: 'rg',
  resourceKind: 'AIServices',
  skuName: 'S0',
  identityType: 'SystemAssigned',
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

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function page(data: unknown[], skipToken?: string, totalRecords = data.length): object {
  return {
    totalRecords,
    count: data.length,
    resultTruncated: 'false',
    data,
    ...(skipToken !== undefined ? { $skipToken: skipToken } : {}),
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.toString() : input.url
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON string request body.')
  return JSON.parse(init.body) as unknown
}

describe('AzureResourceGraphClient', () => {
  it('uses the fixed endpoint, query, subscription scope, and projected fields', async () => {
    const credential = new TestCredential()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(page([resource])))
    await expect(
      new AzureResourceGraphClient(source, limits, credential, { fetcher }).collect(),
    ).resolves.toEqual([resource])
    expect(credential.scopes).toEqual([AZURE_RESOURCE_GRAPH_TOKEN_SCOPE])
    const [input, init] = fetcher.mock.calls[0]!
    expect(requestUrl(input)).toBe(
      `${AZURE_RESOURCE_GRAPH_ORIGIN}${AZURE_RESOURCE_GRAPH_PATH}?api-version=${AZURE_RESOURCE_GRAPH_API_VERSION}`,
    )
    expect(init?.method).toBe('POST')
    const body = requestBody(init)
    expect(body).toEqual({
      subscriptions: [SUBSCRIPTION_ID],
      query: AZURE_RESOURCE_GRAPH_QUERY,
      options: { resultFormat: 'objectArray', $top: 2 },
    })
    expect(AZURE_RESOURCE_GRAPH_QUERY).not.toContain('properties.')
    expect(AZURE_RESOURCE_GRAPH_QUERY).not.toContain('tags')
  })

  it('uses bounded skip-token paging and rejects repeats or overflow', async () => {
    const second = { ...resource, id: `${resource.id}-two`, name: 'ai-two' }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(page([resource], 'opaque', 2)))
      .mockResolvedValueOnce(json(page([second], undefined, 2)))
    await expect(
      new AzureResourceGraphClient(source, limits, new TestCredential(), {
        fetcher,
      }).collect(),
    ).resolves.toHaveLength(2)
    expect(requestBody(fetcher.mock.calls[1]![1])).toMatchObject({
      options: {
        resultFormat: 'objectArray',
        $top: 2,
        $skipToken: 'opaque',
      },
    })

    const repeated = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(page([], 'same')))
      .mockResolvedValueOnce(json(page([], 'same')))
    await expect(
      new AzureResourceGraphClient(source, limits, new TestCredential(), {
        fetcher: repeated,
      }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })

    await expect(
      new AzureResourceGraphClient(source, limits, new TestCredential(), {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(json(page([resource], 'more', 2))),
      }).collect(1),
    ).rejects.toMatchObject({ code: 'bounds' })

    await expect(
      new AzureResourceGraphClient(source, limits, new TestCredential(), {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            json({ ...page([resource]), resultTruncated: 'true', $skipToken: undefined }),
          ),
      }).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })
  })

  it('rejects out-of-scope, duplicate, malformed, oversized, and mismatched-count data', async () => {
    const otherSubscription = '20000000-0000-0000-0000-000000000002'
    for (const body of [
      page([{ ...resource, subscriptionId: otherSubscription }]),
      page([
        {
          ...resource,
          id: resource.id.replace(SUBSCRIPTION_ID, otherSubscription),
        },
      ]),
      page([
        {
          ...resource,
          id: resource.id.replace('/resourceGroups/rg/', '/resourceGroups/other/'),
        },
      ]),
      page([
        {
          ...resource,
          id: resource.id.replace(
            '/Microsoft.CognitiveServices/accounts/',
            '/Microsoft.Search/searchServices/',
          ),
        },
      ]),
      page([resource, resource]),
      page([{ ...resource, type: 'microsoft.compute/virtualmachines' }]),
      { ...page([resource]), count: 2 },
      { ...page([resource]), totalRecords: 2 },
    ]) {
      await expect(
        new AzureResourceGraphClient(source, limits, new TestCredential(), {
          fetcher: vi.fn<typeof fetch>().mockResolvedValue(json(body)),
        }).collect(),
      ).rejects.toMatchObject({ code: 'malformed-response' })
    }

    await expect(
      new AzureResourceGraphClient(
        source,
        azureResourceGraphLimitsSchema.parse({ ...limits, pageSize: 1 }),
        new TestCredential(),
        {
          fetcher: vi
            .fn<typeof fetch>()
            .mockResolvedValue(json(page([resource, { ...resource, id: `${resource.id}-two` }]))),
        },
      ).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })

    await expect(
      new AzureResourceGraphClient(
        source,
        azureResourceGraphLimitsSchema.parse({ ...limits, maxResponseBytes: 1_024 }),
        new TestCredential(),
        {
          fetcher: vi
            .fn<typeof fetch>()
            .mockResolvedValue(
              new Response('x'.repeat(1_025), { headers: { 'content-length': '1025' } }),
            ),
        },
      ).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })
  })

  it.each([
    [401, 'authentication'],
    [403, 'authorization'],
    [404, 'not-available'],
    [418, 'request-failed'],
  ] as const)('maps %s to stable %s without retaining provider errors', async (status, code) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: { message: 'private@contoso.com' } }, { status }))
    await expect(
      new AzureResourceGraphClient(source, limits, new TestCredential(), {
        fetcher,
      }).collect(),
    ).rejects.toMatchObject({ code, status })
  })

  it('retries only bounded transient responses and validates token tenant', async () => {
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined)
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, { status: 503, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(json(page([])))
    await new AzureResourceGraphClient(source, limits, new TestCredential(), {
      fetcher,
      sleep,
    }).collect()
    expect(sleep).toHaveBeenCalledWith(1_000)

    await expect(
      new AzureResourceGraphClient(
        source,
        limits,
        new TestCredential({
          token: tokenForTenant('00000000-0000-0000-0000-000000000002'),
          expiresOnTimestamp: Date.now() + 60_000,
        }),
      ).collect(),
    ).rejects.toMatchObject({ code: 'authentication' })
  })
})
