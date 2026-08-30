import { describe, expect, it } from 'vitest'
import {
  computeDistributionStats,
  computeToolSequenceSummary,
  deduplicateObservations,
} from '../src/stats.js'
import type { RuntimeObservation } from '@agent-sentinel/domain'

function obs(id: string, overrides: Partial<RuntimeObservation> = {}): RuntimeObservation {
  return {
    id,
    tenantId: 'test',
    agentId: 'test-agent',
    environment: 'test',
    source: 'mock-synthetic',
    synthetic: true,
    observedAt: '2026-08-01T10:00:00.000Z',
    success: true,
    toolCallNames: [],
    ...overrides,
  }
}

describe('computeDistributionStats', () => {
  it('returns null for an empty array', () => {
    expect(computeDistributionStats([])).toBeNull()
  })

  it('computes median and MAD for odd-length array', () => {
    const result = computeDistributionStats([1, 3, 5, 7, 9])
    expect(result).not.toBeNull()
    expect(result!.median).toBe(5)
    expect(result!.mad).toBe(2) // deviations: [4,2,0,2,4] → sorted [0,2,2,4,4] → median=2
    expect(result!.min).toBe(1)
    expect(result!.max).toBe(9)
    expect(result!.sampleCount).toBe(5)
    expect(result!.zeroVariance).toBe(false)
  })

  it('computes median and MAD for even-length array', () => {
    // [800,1200,1225,1250,1900] is odd but let us test even:
    const result = computeDistributionStats([10, 20, 30, 40])
    expect(result).not.toBeNull()
    expect(result!.median).toBe(25) // (20+30)/2
    expect(result!.zeroVariance).toBe(false)
  })

  it('handles single value (zero variance)', () => {
    const result = computeDistributionStats([42])
    expect(result).not.toBeNull()
    expect(result!.median).toBe(42)
    expect(result!.mad).toBe(0)
    expect(result!.zeroVariance).toBe(true)
  })

  it('handles all-identical values (zero variance)', () => {
    const result = computeDistributionStats([100, 100, 100, 100, 100])
    expect(result).not.toBeNull()
    expect(result!.median).toBe(100)
    expect(result!.mad).toBe(0)
    expect(result!.zeroVariance).toBe(true)
  })

  it('handles negative values', () => {
    const result = computeDistributionStats([-10, -5, 0, 5, 10])
    expect(result).not.toBeNull()
    expect(result!.median).toBe(0)
    expect(result!.min).toBe(-10)
    expect(result!.max).toBe(10)
  })

  it('is deterministic — same inputs produce same outputs', () => {
    const values = [900, 1100, 800, 1200, 1000, 950, 1300, 850, 1150, 1050]
    const r1 = computeDistributionStats(values)
    const r2 = computeDistributionStats(values)
    expect(r1).toEqual(r2)
  })

  it('handles sparse array with one valid value', () => {
    const result = computeDistributionStats([7])
    expect(result).not.toBeNull()
    expect(result!.sampleCount).toBe(1)
    expect(result!.zeroVariance).toBe(true)
  })

  it('does not mutate the input array', () => {
    const values = [5, 3, 1, 4, 2]
    const copy = [...values]
    computeDistributionStats(values)
    expect(values).toEqual(copy)
  })
})

describe('computeToolSequenceSummary', () => {
  it('returns sorted unique tools and correct counts', () => {
    const sequences = [['tool_b', 'tool_a'], ['tool_a', 'tool_c'], ['tool_a']]
    const result = computeToolSequenceSummary(sequences)
    expect(result.uniqueTools).toEqual(['tool_a', 'tool_b', 'tool_c'])
    expect(result.sequencePatterns).toEqual(['tool_a', 'tool_a → tool_c', 'tool_b → tool_a'])
    expect(result.callCount).toBe(5)
    expect(result.sampleCount).toBe(3)
  })

  it('returns empty summary for empty input', () => {
    const result = computeToolSequenceSummary([])
    expect(result.uniqueTools).toEqual([])
    expect(result.sequencePatterns).toEqual([])
    expect(result.callCount).toBe(0)
    expect(result.sampleCount).toBe(0)
  })

  it('returns empty tools for sequences with no tool calls', () => {
    const result = computeToolSequenceSummary([[], [], []])
    expect(result.uniqueTools).toEqual([])
    expect(result.callCount).toBe(0)
    expect(result.sampleCount).toBe(3)
  })

  it('deduplicates tools across sequences', () => {
    const result = computeToolSequenceSummary([['x', 'x'], ['x']])
    expect(result.uniqueTools).toEqual(['x'])
    expect(result.callCount).toBe(3)
  })

  it('is deterministic regardless of input order', () => {
    const a = computeToolSequenceSummary([['z', 'a'], ['b']])
    const b = computeToolSequenceSummary([['b'], ['z', 'a']])
    expect(a.uniqueTools).toEqual(b.uniqueTools)
  })
})

describe('deduplicateObservations', () => {
  it('removes duplicate IDs, keeping first occurrence', () => {
    const observations = [
      obs('id-1', { latencyMs: 100 }),
      obs('id-2', { latencyMs: 200 }),
      obs('id-1', { latencyMs: 999 }), // duplicate
    ]
    const { deduplicated, duplicatesRemoved } = deduplicateObservations(observations)
    expect(deduplicated).toHaveLength(2)
    expect(deduplicated[0]!.latencyMs).toBe(100) // first wins
    expect(duplicatesRemoved).toBe(1)
  })

  it('returns original array unchanged when no duplicates', () => {
    const observations = [obs('id-1'), obs('id-2'), obs('id-3')]
    const { deduplicated, duplicatesRemoved } = deduplicateObservations(observations)
    expect(deduplicated).toHaveLength(3)
    expect(duplicatesRemoved).toBe(0)
  })

  it('handles empty input', () => {
    const { deduplicated, duplicatesRemoved } = deduplicateObservations([])
    expect(deduplicated).toHaveLength(0)
    expect(duplicatesRemoved).toBe(0)
  })

  it('removes all duplicates when all IDs are the same', () => {
    const observations = [obs('same'), obs('same'), obs('same')]
    const { deduplicated, duplicatesRemoved } = deduplicateObservations(observations)
    expect(deduplicated).toHaveLength(1)
    expect(duplicatesRemoved).toBe(2)
  })
})
