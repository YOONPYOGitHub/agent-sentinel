// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { DriftAnalysisResult } from '@agent-sentinel/domain'
import { behaviorApi } from './behavior-api'

function makeDriftResult(
  status: 'ready' | 'insufficient-data' | 'stale' | 'invalid' = 'ready',
  source: 'mock-synthetic' | 'azure-monitor-otel' = 'mock-synthetic',
  overrides: Partial<DriftAnalysisResult> = {},
): DriftAnalysisResult {
  const base: DriftAnalysisResult = {
    analysisId: 'drift-sales-research-agent-mock',
    agentId: 'sales-research-agent',
    tenantId: 'tenant-demo',
    environment: 'validation',
    source,
    status,
    dimensions: [],
    anyDrift: false,
    computedAt: '2026-07-22T12:00:00.000Z',
    ...overrides,
  }
  return base
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('behaviorApi.getDrift', () => {
  it('returns a parsed DriftAnalysisResult for a valid response', async () => {
    const result = makeDriftResult('ready')
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonOk(result)))
    const parsed = await behaviorApi.getDrift('sales-research-agent')
    expect(parsed.agentId).toBe('sales-research-agent')
    expect(parsed.status).toBe('ready')
    vi.unstubAllGlobals()
  })

  it('calls the correct URL', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonOk(makeDriftResult()))
    vi.stubGlobal('fetch', fetchMock)
    await behaviorApi.getDrift('hr-policy-agent')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/behavior/agents/hr-policy-agent/drift')
    vi.unstubAllGlobals()
  })

  it('encodes special characters in agentId', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonOk(makeDriftResult()))
    vi.stubGlobal('fetch', fetchMock)
    await behaviorApi.getDrift('agent with spaces')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/behavior/agents/agent%20with%20spaces/drift')
    vi.unstubAllGlobals()
  })

  it('forwards an abort signal to the request', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonOk(makeDriftResult()))
    const controller = new AbortController()
    vi.stubGlobal('fetch', fetchMock)

    await behaviorApi.getDrift('sales-research-agent', controller.signal)

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
    vi.unstubAllGlobals()
  })

  it('throws when the response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ message: 'agent not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    await expect(behaviorApi.getDrift('bad-agent')).rejects.toThrow('agent not found')
    vi.unstubAllGlobals()
  })

  it('throws a generic message when response body has no message field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('Internal error', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        }),
      ),
    )
    await expect(behaviorApi.getDrift('bad-agent')).rejects.toThrow(
      'Request failed with status 500',
    )
    vi.unstubAllGlobals()
  })

  it('accepts invalid status as a valid unavailable response (live mode contract)', async () => {
    const unavailableResult = makeDriftResult('invalid', 'azure-monitor-otel', {
      unavailableReason: 'OTel connector not connected.',
    })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonOk(unavailableResult)))
    const parsed = await behaviorApi.getDrift('any-agent')
    expect(parsed.status).toBe('invalid')
    expect(parsed.source).toBe('azure-monitor-otel')
    expect(parsed.unavailableReason).toBe('OTel connector not connected.')
    vi.unstubAllGlobals()
  })

  it('throws if response does not match DriftAnalysisResult schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(jsonOk({ not: 'a drift result' })),
    )
    await expect(behaviorApi.getDrift('any-agent')).rejects.toThrow()
    vi.unstubAllGlobals()
  })
})
