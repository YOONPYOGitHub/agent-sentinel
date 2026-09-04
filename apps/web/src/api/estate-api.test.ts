// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setTokenProvider } from './auth-fetch'
import { estateApi, estatesResponseSchema } from './estate-api'

const responseBody = {
  defaultEstateId: 'estate-primary',
  estates: [
    {
      id: 'estate-primary',
      name: 'Primary estate',
      tenantId: '11111111-1111-4111-8111-111111111111',
      environment: 'production',
      isDefault: true,
    },
  ],
}

afterEach(() => {
  setTokenProvider(undefined)
  vi.unstubAllGlobals()
})

describe('estate API contract', () => {
  it('parses a strict authorized-estate response', () => {
    expect(estatesResponseSchema.parse(responseBody)).toEqual(responseBody)
  })

  it('rejects unknown fields, invalid IDs, and duplicate IDs', () => {
    expect(() => estatesResponseSchema.parse({ ...responseBody, token: 'secret' })).toThrow()
    expect(() =>
      estatesResponseSchema.parse({
        ...responseBody,
        estates: [{ ...responseBody.estates[0], id: 'invalid/estate' }],
      }),
    ).toThrow()
    expect(() =>
      estatesResponseSchema.parse({
        ...responseBody,
        estates: [responseBody.estates[0], { ...responseBody.estates[0] }],
      }),
    ).toThrow(/Duplicate estate ID/)
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [503, 'unavailable'],
  ] as const)('classifies HTTP %s as %s', async (status, kind) => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ message: `${kind} estates` }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    await expect(estateApi.list()).rejects.toMatchObject({
      name: 'EstateApiError',
      kind,
      status,
    })
  })

  it('classifies response-validation failures as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ ...responseBody, estates: [{ id: 'invalid/estate' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    await expect(estateApi.list()).rejects.toMatchObject({
      name: 'EstateApiError',
      kind: 'unavailable',
      status: 200,
    })
  })

  it('loads and parses the authenticated endpoint', async () => {
    setTokenProvider(() => Promise.resolve('estate-access-token'))
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(estateApi.list()).resolves.toEqual(responseBody)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/estates')
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer estate-access-token')
    expect(headers.get('x-agent-sentinel-estate-id')).toBeNull()
  })
})
