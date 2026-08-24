import { describe, expect, it, vi, beforeEach } from 'vitest'
import { tokenEconomicsApi } from './token-economics-api'
import * as authFetch from './auth-fetch'

vi.mock('./auth-fetch')

const mockReport = {
  reportId: 'te-abc123',
  tenantId: 'tenant-demo',
  agentId: 'hr-policy-agent',
  environment: 'production',
  source: 'mock-synthetic',
  windowStart: '2026-08-01T00:00:00.000Z',
  windowEnd: '2026-08-23T23:59:59.000Z',
  computedAt: '2026-08-23T23:59:59.000Z',
  status: 'ready',
  coverage: {
    totalObservations: 20,
    deduplicatedObservations: 20,
    duplicatesRemoved: 0,
    successCount: 20,
    measuredSuccessCount: 20,
    inputTokenMeasuredCount: 20,
    outputTokenMeasuredCount: 20,
    totalTokenMeasuredCount: 20,
    costMeasuredCount: 20,
    costCoverage: 1,
  },
  totalInputTokens: 5200,
  totalOutputTokens: 3760,
  totalTokens: 8960,
  medianInputTokens: 260,
  medianOutputTokens: 188,
  medianTotalTokens: 448,
  measuredCostUsd: 0.44,
  medianCostUsd: 0.022,
  costPerSuccessUsd: 0.022,
  anomalies: [],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('tokenEconomicsApi.getReport', () => {
  it('parses and returns a valid TokenEconomicsReport', async () => {
    vi.spyOn(authFetch, 'apiFetch').mockResolvedValue(
      new Response(JSON.stringify(mockReport), { status: 200 }),
    )
    const result = await tokenEconomicsApi.getReport('hr-policy-agent')
    expect(result.agentId).toBe('hr-policy-agent')
    expect(result.status).toBe('ready')
    expect(result.measuredCostUsd).toBe(0.44)
    expect(authFetch.apiFetch).toHaveBeenCalledWith('/api/token-economics/agents/hr-policy-agent')
  })

  it('encodes agentId in the URL', async () => {
    vi.spyOn(authFetch, 'apiFetch').mockResolvedValue(
      new Response(JSON.stringify({ ...mockReport, agentId: 'agent with spaces' }), {
        status: 200,
      }),
    )
    await tokenEconomicsApi.getReport('agent with spaces')
    expect(authFetch.apiFetch).toHaveBeenCalledWith(
      '/api/token-economics/agents/agent%20with%20spaces',
    )
  })

  it('throws a typed error on HTTP failure', async () => {
    vi.spyOn(authFetch, 'apiFetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'not found' }), { status: 404 }),
    )
    await expect(tokenEconomicsApi.getReport('missing')).rejects.toThrow('not found')
  })

  it('throws on invalid schema response', async () => {
    vi.spyOn(authFetch, 'apiFetch').mockResolvedValue(
      new Response(JSON.stringify({ invalid: true }), { status: 200 }),
    )
    await expect(tokenEconomicsApi.getReport('agent')).rejects.toThrow()
  })
})
