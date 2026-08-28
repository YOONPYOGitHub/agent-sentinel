import type { TokenCredential } from '@azure/core-auth'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  POWER_PLATFORM_TOKEN_SCOPE,
  PowerPlatformConnectorError,
  PowerPlatformResourceQueryClient,
  powerPlatformLimitsSchema,
  powerPlatformSourceConfigSchema,
} from '../src/index.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const source = powerPlatformSourceConfigSchema.parse({
  id: 'environment-a',
  name: 'Environment A',
  tenantId,
  environment: 'env-a',
})
const getToken = vi.fn(() =>
  Promise.resolve({
    token: 'test-token',
    expiresOnTimestamp: Date.now() + 60_000,
  }),
)
const credential: TokenCredential = {
  getToken,
}

function resource(name: string, environmentId = 'env-a'): Record<string, unknown> {
  return {
    name,
    type: 'microsoft.copilotstudio/agents',
    tenantId,
    location: 'unitedstates',
    environmentId,
    properties: {
      displayName: `Agent ${name.slice(0, 4)}`,
      environmentId,
    },
  }
}

function page(
  data: Record<string, unknown>[],
  options: { truncated?: 0 | 1; skipToken?: string; totalRecords?: number } = {},
) {
  return {
    count: data.length,
    data,
    resultTruncated: options.truncated ?? 1,
    ...(options.skipToken ? { skipToken: options.skipToken } : {}),
    totalRecords: options.totalRecords ?? data.length,
  }
}

function client(
  fetcher: typeof fetch,
  overrides: Partial<ReturnType<typeof powerPlatformLimitsSchema.parse>> = {},
) {
  return new PowerPlatformResourceQueryClient(
    source,
    powerPlatformLimitsSchema.parse(overrides),
    credential,
    { fetcher },
  )
}

const requestBodySchema = z
  .object({
    Options: z.object({
      Top: z.number(),
      Skip: z.number().optional(),
      SkipToken: z.string().optional(),
    }),
  })
  .passthrough()

function parsedRequestBody(init: RequestInit | undefined) {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.')
  return requestBodySchema.parse(JSON.parse(init.body))
}

describe('PowerPlatformResourceQueryClient', () => {
  it('uses the exact host, scope, endpoint, POST method, and fixed structured query', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(page([resource('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')]))),
    )
    const values = await client(fetcher).collect()

    expect(values).toHaveLength(1)
    expect(getToken).toHaveBeenLastCalledWith(POWER_PLATFORM_TOKEN_SCOPE)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBeInstanceOf(URL)
    expect((url as URL).href).toBe(
      'https://api.powerplatform.com/resourcequery/resources/query?api-version=2024-10-01',
    )
    expect(init?.method).toBe('POST')
    expect(parsedRequestBody(init)).toEqual({
      TableName: 'PowerPlatformResources',
      Clauses: [
        {
          $type: 'where',
          FieldName: 'type',
          Operator: '==',
          Values: ["'microsoft.copilotstudio/agents'"],
        },
        {
          $type: 'where',
          FieldName: 'properties.environmentId',
          Operator: '==',
          Values: ["'env-a'"],
        },
      ],
      Options: { Top: 100, Skip: 0 },
    })
  })

  it('pages with only the returned skip token and scopes the query to the environment', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          page([resource('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')], {
            truncated: 0,
            skipToken: 'next-page',
            totalRecords: 2,
          }),
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          page([resource('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')], {
            totalRecords: 2,
          }),
        ),
      )

    await expect(client(fetcher).collect()).resolves.toMatchObject([
      { name: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { name: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    ])
    const secondBody = parsedRequestBody(fetcher.mock.calls[1]![1])
    expect(secondBody.Options).toEqual({ Top: 100, SkipToken: 'next-page' })
    expect(secondBody.Options).not.toHaveProperty('Skip')
  })

  it('escapes the configured environment in the fixed server-side query', async () => {
    const scopedSource = { ...source, environment: "env'a" }
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(
          page([resource('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', scopedSource.environment)]),
        ),
      ),
    )
    const queryClient = new PowerPlatformResourceQueryClient(
      scopedSource,
      powerPlatformLimitsSchema.parse({}),
      credential,
      { fetcher },
    )

    await queryClient.collect()

    expect(parsedRequestBody(fetcher.mock.calls[0]![1])).toMatchObject({
      Clauses: [
        {},
        {
          FieldName: 'properties.environmentId',
          Values: ["'env''a'"],
        },
      ],
    })
  })

  it('retries only an allowed status with a bounded Retry-After', async () => {
    const sleep = vi.fn(() => Promise.resolve())
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(Response.json(page([])))
    const queryClient = new PowerPlatformResourceQueryClient(
      source,
      powerPlatformLimitsSchema.parse({ maxRetries: 1, maxRetryAfterMs: 1_000 }),
      credential,
      { fetcher, sleep },
    )

    await expect(queryClient.collect()).resolves.toEqual([])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(1_000)
  })

  it('does not retry an unapproved status or an excessive Retry-After', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('', { status: 400, headers: { 'Retry-After': '1' } })),
    )
    await expect(client(fetcher).collect()).rejects.toMatchObject({
      code: 'request-failed',
      status: 400,
    })
    expect(fetcher).toHaveBeenCalledTimes(1)

    const throttled = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('', { status: 429, headers: { 'Retry-After': '10' } })),
    )
    await expect(client(throttled, { maxRetryAfterMs: 100 }).collect()).rejects.toMatchObject({
      code: 'request-failed',
      status: 429,
    })
    expect(throttled).toHaveBeenCalledTimes(1)
  })

  it('classifies timeout, authentication failure, and authorization', async () => {
    const timeoutFetcher = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    await expect(client(timeoutFetcher, { requestTimeoutMs: 100 }).collect()).rejects.toMatchObject(
      { code: 'timeout' },
    )

    const noToken: TokenCredential = { getToken: () => Promise.resolve(null) }
    await expect(
      new PowerPlatformResourceQueryClient(source, powerPlatformLimitsSchema.parse({}), noToken, {
        fetcher: vi.fn(),
      }).collect(),
    ).rejects.toMatchObject({ code: 'authentication' })

    await expect(
      client(vi.fn(() => Promise.resolve(new Response('', { status: 403 })))).collect(),
    ).rejects.toMatchObject({ code: 'authorization', status: 403 })

    await expect(
      client(vi.fn(() => Promise.reject(new Error('provider details')))).collect(),
    ).rejects.toMatchObject({ code: 'network' })
  })

  it('accepts extra envelope metadata and rejects cross-boundary resources', async () => {
    await expect(
      client(
        vi.fn(() => Promise.resolve(Response.json({ ...page([]), unexpected: true }))),
      ).collect(),
    ).resolves.toEqual([])

    await expect(
      client(
        vi.fn(() =>
          Promise.resolve(
            Response.json(
              page([
                {
                  ...resource('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
                  tenantId: '22222222-2222-4222-8222-222222222222',
                },
              ]),
            ),
          ),
        ),
      ).collect(),
    ).rejects.toMatchObject({ code: 'malformed-response' })

    await expect(
      client(
        vi.fn(() =>
          Promise.resolve(
            Response.json(
              page([resource('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'other-environment')]),
            ),
          ),
        ),
      ).collect(),
    ).rejects.toMatchObject({ code: 'malformed-response' })

    await expect(
      client(
        vi.fn(() =>
          Promise.resolve(
            Response.json(
              page([
                {
                  ...resource('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
                  properties: {
                    environmentId: 'env-a',
                    extra: Array.from({ length: 101 }, (_, index) => index),
                  },
                },
              ]),
            ),
          ),
        ),
      ).collect(),
    ).rejects.toMatchObject({ code: 'malformed-response' })
  })

  it('enforces item, response-byte, page, and continuation-token bounds', async () => {
    await expect(
      client(
        vi.fn(() => Promise.resolve(Response.json(page([], { truncated: 0, totalRecords: 1 })))),
      ).collect(),
    ).rejects.toMatchObject({ code: 'malformed-response' })

    await expect(
      client(
        vi.fn(() =>
          Promise.resolve(
            Response.json(
              page([
                resource('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
                resource('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
              ]),
            ),
          ),
        ),
        { pageSize: 2, maxItems: 1 },
      ).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })

    await expect(
      client(
        vi.fn(() =>
          Promise.resolve(
            new Response('x'.repeat(2_000), {
              headers: { 'Content-Length': '2000' },
            }),
          ),
        ),
        { maxResponseBytes: 1_024 },
      ).collect(),
    ).rejects.toMatchObject({ code: 'bounds' })

    const repeated = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json(page([], { truncated: 0, skipToken: 'same', totalRecords: 2 })),
      ),
    )
    await expect(client(repeated).collect()).rejects.toMatchObject({ code: 'bounds' })

    const endless = vi.fn<typeof fetch>((_url, init) => {
      const request = parsedRequestBody(init)
      return Promise.resolve(
        Response.json(
          page([], {
            truncated: 0,
            skipToken: request.Options.SkipToken === 'one' ? 'two' : 'one',
            totalRecords: 10,
          }),
        ),
      )
    })
    await expect(client(endless, { maxPages: 2 }).collect()).rejects.toMatchObject({
      code: 'bounds',
    })
  })

  it('exports a typed sanitized connector error', () => {
    expect(new PowerPlatformConnectorError('network', 'safe')).toMatchObject({
      name: 'PowerPlatformConnectorError',
      code: 'network',
    })
  })
})
