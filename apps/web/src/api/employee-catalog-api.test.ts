// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setActiveEstateId, setTokenProvider } from './auth-fetch'
import { employeeCatalogApi } from './employee-catalog-api'

const availableResponse = {
  status: 'available',
  authority: 'microsoft-agent-365',
  observedAt: '2026-09-14T06:00:00.000Z',
  agents: [
    {
      id: 'agent-1',
      name: 'Payroll assistant',
      description: 'Answers payroll questions.',
      platform: 'Microsoft Agent 365',
    },
  ],
}

afterEach(() => {
  setTokenProvider(undefined)
  setActiveEstateId(undefined)
  vi.unstubAllGlobals()
})

describe('employee catalog API', () => {
  it('loads the estate-scoped authenticated catalog contract', async () => {
    setTokenProvider(() => Promise.resolve('employee-token'))
    setActiveEstateId('primary')
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(availableResponse, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(employeeCatalogApi.get()).resolves.toEqual(availableResponse)
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/employee/agent-catalog')
    expect(headers.get('Authorization')).toBe('Bearer employee-token')
    expect(headers.get('x-agent-sentinel-estate-id')).toBe('primary')
  })

  it('rejects responses that leak agents while entitlement is unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            status: 'unknown',
            reason: 'stale-evidence',
            agents: [{ id: 'hidden', name: 'Hidden', description: 'Must not leak.' }],
          },
          { status: 200 },
        ),
      ),
    )

    await expect(employeeCatalogApi.get()).rejects.toMatchObject({
      name: 'EmployeeCatalogApiError',
      status: 200,
    })
  })

  it('does not substitute inventory when the endpoint is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ message: 'Entitlement service unavailable.' }, { status: 503 }),
        ),
    )

    await expect(employeeCatalogApi.get()).rejects.toMatchObject({
      name: 'EmployeeCatalogApiError',
      status: 503,
      message: 'Employee catalog request failed with status 503.',
    })
  })
})
