import { useEffect, useMemo, useState } from 'react'

import type { DriftAnalysisResult } from '@agent-sentinel/domain'

import { behaviorApi } from '../api/behavior-api'

export type AgentDriftState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; result: DriftAnalysisResult }

const CACHE_TTL_MS = 60_000
const MAX_CONCURRENT_REQUESTS = 4
const REQUEST_TIMEOUT_MS = 30_000
let activeRequests = 0
const requestQueue: Array<() => void> = []
const cache = new Map<string, { expiresAt: number; promise: Promise<DriftAnalysisResult> }>()

function drainRequestQueue(): void {
  while (activeRequests < MAX_CONCURRENT_REQUESTS) {
    const start = requestQueue.shift()
    if (start === undefined) return
    activeRequests += 1
    start()
  }
}

function schedule<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    requestQueue.push(() => {
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(new Error('Runtime drift request timed out after 30 seconds.')),
        REQUEST_TIMEOUT_MS,
      )
      void operation(controller.signal)
        .then(resolve, (error: unknown) => {
          const failure =
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : error instanceof Error
                ? error
                : new Error('Runtime drift request failed.')
          reject(failure)
        })
        .finally(() => {
          clearTimeout(timeout)
          activeRequests -= 1
          drainRequestQueue()
        })
    })
    drainRequestQueue()
  })
}

export function clearAgentDriftCache(): void {
  cache.clear()
}

export function loadAgentDrift(agentId: string, scope = 'default'): Promise<DriftAnalysisResult> {
  if (agentId.trim() === '') return Promise.reject(new Error('Agent ID is required.'))
  const now = Date.now()
  const cacheKey = `${scope}\0${agentId}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined && cached.expiresAt > now) return cached.promise

  const promise = schedule((signal) => behaviorApi.getDrift(agentId, signal))
  cache.set(cacheKey, { expiresAt: Number.POSITIVE_INFINITY, promise })
  void promise.then(
    () => {
      if (cache.get(cacheKey)?.promise === promise) {
        cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, promise })
      }
    },
    () => {
      if (cache.get(cacheKey)?.promise === promise) cache.delete(cacheKey)
    },
  )
  return promise
}

function errorState(error: unknown): AgentDriftState {
  return {
    status: 'error',
    message: error instanceof Error ? error.message : 'Runtime drift data could not be loaded.',
  }
}

export function useAgentDrift(agentId: string, scope = 'default'): AgentDriftState {
  const [state, setState] = useState<AgentDriftState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setState({ status: 'loading' })

    const refresh = async () => {
      try {
        const result = await loadAgentDrift(agentId, scope)
        if (!cancelled) setState({ status: 'done', result })
      } catch (error) {
        if (!cancelled) setState(errorState(error))
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), CACHE_TTL_MS)
      }
    }
    void refresh()

    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [agentId, scope])

  return state
}

export function useAgentDriftPortfolio(
  agentIds: readonly string[],
  scope = 'default',
): Readonly<Record<string, AgentDriftState>> {
  const key = agentIds.join('\0')
  const ids = useMemo(() => (key === '' ? [] : key.split('\0')), [key])
  const [states, setStates] = useState<Record<string, AgentDriftState>>({})

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setStates(Object.fromEntries(ids.map((id) => [id, { status: 'loading' } as const])))

    const refresh = async () => {
      const entries = await Promise.all(
        ids.map(async (id) => {
          let next: AgentDriftState
          try {
            next = { status: 'done', result: await loadAgentDrift(id, scope) }
          } catch (error) {
            next = errorState(error)
          }
          return [id, next] as const
        }),
      )
      if (cancelled) return
      setStates(Object.fromEntries(entries))
      if (!cancelled) timer = setTimeout(() => void refresh(), CACHE_TTL_MS)
    }
    void refresh()

    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [ids, scope])

  return states
}
