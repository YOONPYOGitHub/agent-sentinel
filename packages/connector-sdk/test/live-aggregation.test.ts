import { describe, expect, it } from 'vitest'

import { aggregateLiveSources, type LiveSourceValue } from '../src/index.js'

interface Source {
  id: string
}

function complete(value: string, pages = 1, records = 1): LiveSourceValue<string> {
  return {
    state: 'complete',
    value,
    pages,
    records,
    evidenceIds: [`evidence:${value}`],
  }
}

const limits = {
  maxSources: 10,
  maxConcurrency: 2,
  maxDurationMs: 1_000,
  maxPagesPerSource: 2,
  maxRecordsPerSource: 5,
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for test condition.')
}

describe('bounded live source aggregation', () => {
  it('rejects an empty source set instead of reporting vacuous completeness', async () => {
    await expect(
      aggregateLiveSources({
        sources: [],
        limits,
        execute: async (source: Source) => complete(source.id),
      }),
    ).rejects.toThrow('at least one')
  })

  it('preserves configured order while bounding concurrent source execution', async () => {
    let active = 0
    let maximumActive = 0
    const releases = new Map<string, () => void>()
    const sources = [{ id: 'source-b' }, { id: 'source-a' }, { id: 'source-c' }]

    const aggregation = aggregateLiveSources({
      sources,
      limits,
      execute: async (source) => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise<void>((resolve) => releases.set(source.id, resolve))
        active -= 1
        return complete(source.id)
      },
    })

    await waitUntil(() => releases.size === 2)
    expect([...releases.keys()]).toEqual(['source-b', 'source-a'])
    releases.get('source-a')?.()
    await waitUntil(() => releases.size === 3)
    expect([...releases.keys()]).toEqual(['source-b', 'source-a', 'source-c'])
    releases.get('source-c')?.()
    releases.get('source-b')?.()

    const result = await aggregation
    expect(maximumActive).toBe(2)
    expect(result.complete).toBe(true)
    expect(result.outcomes.map((outcome) => outcome.source.id)).toEqual([
      'source-b',
      'source-a',
      'source-c',
    ])
    expect(result.outcomes.map((outcome) => outcome.value)).toEqual([
      'source-b',
      'source-a',
      'source-c',
    ])
  })

  it('rejects duplicate sources and source counts above the configured bound', async () => {
    await expect(
      aggregateLiveSources({
        sources: [{ id: 'duplicate' }, { id: 'duplicate' }],
        limits,
        execute: async (source) => complete(source.id),
      }),
    ).rejects.toThrow('unique')
    await expect(
      aggregateLiveSources({
        sources: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        limits: { ...limits, maxSources: 2 },
        execute: async (source) => complete(source.id),
      }),
    ).rejects.toThrow('maxSources')
  })

  it('classifies reported page and record overruns as partial', async () => {
    const result = await aggregateLiveSources({
      sources: [{ id: 'pages' }, { id: 'records' }],
      limits,
      execute: async (source) =>
        source.id === 'pages' ? complete(source.id, 3, 1) : complete(source.id, 1, 6),
    })

    expect(result.complete).toBe(false)
    expect(result.outcomes).toEqual([
      expect.objectContaining({ state: 'partial', reason: 'bounds', pages: 3, records: 1 }),
      expect.objectContaining({ state: 'partial', reason: 'bounds', pages: 1, records: 6 }),
    ])
  })

  it('retains explicit non-complete states and sanitizes rejected work', async () => {
    const states = ['empty', 'stale', 'unsupported', 'partial'] as const
    const result = await aggregateLiveSources({
      sources: [...states.map((state) => ({ id: state })), { id: 'failed' }],
      limits,
      execute: async (source) => {
        if (source.id === 'failed') throw new Error('private provider response')
        const state = states.find((candidate) => candidate === source.id)
        if (state === undefined) throw new Error('unexpected source')
        return {
          ...complete(source.id),
          state,
          reason: state === 'complete' ? undefined : state,
        }
      },
      failureReason: () => 'provider-failed',
    })

    expect(result.complete).toBe(false)
    expect(result.outcomes.map((outcome) => outcome.state)).toEqual([
      'empty',
      'stale',
      'unsupported',
      'partial',
      'failed',
    ])
    expect(result.outcomes.at(-1)).toMatchObject({
      state: 'failed',
      reason: 'provider-failed',
    })
    expect(JSON.stringify(result)).not.toContain('private provider response')
  })

  it('cancels queued work and classifies started work when the caller aborts', async () => {
    const controller = new AbortController()
    const started: string[] = []
    const resultPromise = aggregateLiveSources({
      sources: [{ id: 'started' }, { id: 'queued' }],
      limits: { ...limits, maxConcurrency: 1 },
      signal: controller.signal,
      execute: async (source, context) => {
        started.push(source.id)
        await new Promise<void>((resolve) =>
          context.signal.addEventListener('abort', () => resolve(), { once: true }),
        )
        return complete(source.id)
      },
    })

    await Promise.resolve()
    controller.abort()
    const result = await resultPromise

    expect(started).toEqual(['started'])
    expect(result.outcomes.map((outcome) => outcome.state)).toEqual(['cancelled', 'cancelled'])
    expect(result.outcomes.map((outcome) => outcome.reason)).toEqual(['cancelled', 'cancelled'])
  })

  it('applies one total duration deadline to all source work', async () => {
    const started: string[] = []
    const result = await aggregateLiveSources({
      sources: [{ id: 'slow' }, { id: 'never-started' }],
      limits: { ...limits, maxConcurrency: 1, maxDurationMs: 10 },
      execute: async (source, context) => {
        started.push(source.id)
        await new Promise<void>((resolve) =>
          context.signal.addEventListener('abort', () => resolve(), { once: true }),
        )
        return complete(source.id)
      },
    })

    expect(started).toEqual(['slow'])
    expect(result.complete).toBe(false)
    expect(result.outcomes.map((outcome) => outcome.state)).toEqual(['cancelled', 'cancelled'])
    expect(result.outcomes.map((outcome) => outcome.reason)).toEqual([
      'duration-exceeded',
      'duration-exceeded',
    ])
  })
})
