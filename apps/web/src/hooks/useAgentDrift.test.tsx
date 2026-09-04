// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DriftAnalysisResult } from '@agent-sentinel/domain'

import { setActiveEstateId } from '../api/auth-fetch'
import {
  clearAgentDriftCache,
  loadAgentDrift,
  useAgentDrift,
  useAgentDriftPortfolio,
} from './useAgentDrift'

const { getDriftMock } = vi.hoisted(() => ({
  getDriftMock: vi.fn<(agentId: string, signal?: AbortSignal) => Promise<DriftAnalysisResult>>(),
}))
vi.mock('../api/behavior-api', () => ({ behaviorApi: { getDrift: getDriftMock } }))

function result(agentId: string): DriftAnalysisResult {
  return {
    analysisId: `drift-${agentId}`,
    tenantId: 'tenant',
    agentId,
    environment: 'validation',
    source: 'azure-monitor-otel',
    status: 'insufficient-data',
    computedAt: '2026-09-02T00:00:00.000Z',
    dimensions: [],
    anyDrift: false,
    unavailableReason: 'Minimum sample count not met.',
  }
}

beforeEach(() => {
  clearAgentDriftCache()
  setActiveEstateId(undefined)
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('useAgentDrift', () => {
  it('exposes loading and done states', async () => {
    let resolve!: (value: DriftAnalysisResult) => void
    getDriftMock.mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    const hook = renderHook(() => useAgentDrift('agent-a'))

    expect(hook.result.current).toEqual({ status: 'loading' })
    act(() => resolve(result('agent-a')))
    await waitFor(() => expect(hook.result.current.status).toBe('done'))
  })

  it('exposes provider errors instead of collapsing them into unavailable', async () => {
    getDriftMock.mockRejectedValue(new Error('Logs query failed.'))
    const hook = renderHook(() => useAgentDrift('agent-a'))

    await waitFor(() =>
      expect(hook.result.current).toEqual({
        status: 'error',
        message: 'Logs query failed.',
      }),
    )
  })

  it('deduplicates concurrent requests for the same agent', async () => {
    getDriftMock.mockResolvedValue(result('agent-a'))
    const hook = renderHook(() => ({
      first: useAgentDrift('agent-a'),
      second: useAgentDrift('agent-a'),
    }))

    await waitFor(() => expect(hook.result.current.second.status).toBe('done'))
    expect(getDriftMock).toHaveBeenCalledTimes(1)
  })

  it('isolates cached results by snapshot scope', async () => {
    getDriftMock.mockResolvedValue(result('agent-a'))
    const hook = renderHook(({ scope }) => useAgentDrift('agent-a', scope), {
      initialProps: { scope: 'foundry:tenant:snapshot-1' },
    })
    await waitFor(() => expect(hook.result.current.status).toBe('done'))

    hook.rerender({ scope: 'foundry:tenant:snapshot-2' })
    await waitFor(() => expect(getDriftMock).toHaveBeenCalledTimes(2))
  })

  it('isolates cached results by active estate', async () => {
    getDriftMock.mockResolvedValue(result('agent-a'))
    setActiveEstateId('estate-primary')
    await loadAgentDrift('agent-a', 'shared-snapshot')
    setActiveEstateId('estate-research')
    await loadAgentDrift('agent-a', 'shared-snapshot')
    expect(getDriftMock).toHaveBeenCalledTimes(2)
  })

  it('does not start queued drift work under a different estate', async () => {
    const blockers: Array<(value: DriftAnalysisResult) => void> = []
    getDriftMock.mockImplementation(
      (agentId) =>
        new Promise((resolve) => {
          if (agentId === 'queued-agent') {
            resolve(result(agentId))
            return
          }
          blockers.push(resolve)
        }),
    )
    setActiveEstateId('estate-primary')
    const active = Array.from({ length: 4 }, (_, index) =>
      loadAgentDrift(`blocking-agent-${index}`),
    )
    await vi.waitFor(() => expect(getDriftMock).toHaveBeenCalledTimes(4))
    const queued = loadAgentDrift('queued-agent')
    const queuedFailure = expect(queued).rejects.toThrow(
      'Active estate changed before runtime drift request started.',
    )

    setActiveEstateId('estate-research')
    blockers.forEach((resolve, index) => resolve(result(`blocking-agent-${index}`)))
    await Promise.all(active)
    await queuedFailure
    expect(getDriftMock).not.toHaveBeenCalledWith('queued-agent', expect.any(AbortSignal))
  })
})

describe('useAgentDriftPortfolio', () => {
  it('queries all agents with at most four concurrent requests', async () => {
    let active = 0
    let maximumActive = 0
    getDriftMock.mockImplementation(
      (agentId) =>
        new Promise((resolve) => {
          active += 1
          maximumActive = Math.max(maximumActive, active)
          setTimeout(() => {
            active -= 1
            resolve(result(agentId))
          }, 5)
        }),
    )
    const ids = Array.from({ length: 9 }, (_, index) => `agent-${index}`)
    const hook = renderHook(() => useAgentDriftPortfolio(ids))

    await waitFor(() =>
      expect(Object.values(hook.result.current).every((state) => state.status === 'done')).toBe(
        true,
      ),
    )
    expect(getDriftMock).toHaveBeenCalledTimes(ids.length)
    expect(maximumActive).toBe(4)
  })

  it('does not apply results from a replaced portfolio', async () => {
    let resolveOld!: (value: DriftAnalysisResult) => void
    getDriftMock.mockImplementation((agentId) => {
      if (agentId === 'old-agent') {
        return new Promise((resolve) => {
          resolveOld = resolve
        })
      }
      return Promise.resolve(result(agentId))
    })
    const hook = renderHook(
      ({ ids, scope }: { ids: string[]; scope: string }) => useAgentDriftPortfolio(ids, scope),
      { initialProps: { ids: ['old-agent'], scope: 'snapshot-1' } },
    )

    hook.rerender({ ids: ['new-agent'], scope: 'snapshot-2' })
    await waitFor(() => expect(hook.result.current['new-agent']?.status).toBe('done'))
    act(() => resolveOld(result('old-agent')))
    await waitFor(() => expect(hook.result.current['old-agent']).toBeUndefined())
  })

  it('times out stalled requests and releases the global queue slot', async () => {
    vi.useFakeTimers()
    getDriftMock.mockImplementation(
      (agentId, signal) =>
        new Promise((resolve, reject) => {
          if (agentId !== 'stalled-agent') {
            resolve(result(agentId))
            return
          }
          signal?.addEventListener(
            'abort',
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error('Runtime drift request aborted.'),
              ),
            { once: true },
          )
        }),
    )

    const stalled = loadAgentDrift('stalled-agent')
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(stalled).rejects.toThrow('Runtime drift request timed out after 30 seconds.')
    await expect(loadAgentDrift('next-agent')).resolves.toEqual(result('next-agent'))
  })
})
