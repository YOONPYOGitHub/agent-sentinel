import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  MAX_REPRESENTATIVE_OTEL_PAGES,
  MAX_REPRESENTATIVE_OTEL_RECORDS_PER_PAGE,
  normalizeRepresentativeOtelEvidence,
} from '../src/index.js'

interface EditablePage {
  pageNumber: number
  cursor?: string
  nextCursor?: string
  records: Array<Record<string, unknown>>
}

const binding = {
  estateId: 'estate-a',
  estateTenantId: 'tenant-a',
  estateEnvironment: 'portfolio',
  sourceConnectorId: 'source-a',
  sourceTenantId: 'tenant-a',
  sourceEnvironment: 'production',
  providerResourceId:
    '/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/rg-demo/providers/Microsoft.Insights/components/app-demo',
  agentId: 'agent-a',
  sourceAgentId: 'provider-agent-a',
  windowId: 'representative-window',
  windowStart: '2026-09-06T00:00:00.000Z',
  windowEnd: '2026-09-06T06:00:00.000Z',
  queriedAt: '2026-09-06T06:05:00.000Z',
  maximumFreshnessHours: 24,
} as const

async function fixture(): Promise<EditablePage[]> {
  return JSON.parse(
    await readFile(new URL('./fixtures/representative-otel-pages.json', import.meta.url), 'utf8'),
  ) as EditablePage[]
}

function nestedRecord(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${field} to be an object.`)
  }
  return value as Record<string, unknown>
}

describe('representative OpenTelemetry evidence normalization', () => {
  it('normalizes complete trace, span, and metric claims with exact provenance', async () => {
    const result = normalizeRepresentativeOtelEvidence(await fixture(), binding)

    expect(result.status).toBe('available')
    expect(result.caveats).toEqual([])
    expect(result.evidence).toHaveLength(6)
    expect(result.window.otelQuality).toEqual({
      status: 'available',
      classification: 'live',
      caveats: [],
      recordsReceived: 6,
      recordsAccepted: 6,
      duplicatesRemoved: 0,
      pagesProcessed: 2,
    })
    expect(result.window.observations).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-a',
        agentId: 'agent-a',
        environment: 'production',
        observedAt: '2026-09-06T05:00:00.000Z',
        latencyMs: 820,
        inputTokens: 320,
        outputTokens: 110,
        costUsd: 0.012,
        success: true,
        synthetic: false,
        correlations: [
          { kind: 'correlation-id', value: '11111111111111111111111111111111' },
        ],
        otelProvenance: expect.objectContaining({
          estateId: 'estate-a',
          estateTenantId: 'tenant-a',
          estateEnvironment: 'portfolio',
          sourceConnectorId: 'source-a',
          sourceTenantId: 'tenant-a',
          sourceEnvironment: 'production',
          providerResourceId: binding.providerResourceId,
          providerAgentId: 'provider-agent-a',
          traceId: '11111111111111111111111111111111',
          spanId: 'aaaaaaaaaaaaaaaa',
          classification: 'live',
          sampling: { state: 'complete', rate: 1 },
          aggregation: { kind: 'raw' },
        }),
      }),
    ])
    expect(result.window.observations[0]?.otelProvenance?.evidenceIds).toHaveLength(6)
  })

  it('derives failure only from an exact error span claim', async () => {
    const pages = await fixture()
    pages[0]!.records[2]!.claim = {
      kind: 'error',
      value: true,
      errorCode: 'timeout',
    }
    const result = normalizeRepresentativeOtelEvidence(pages, binding)

    expect(result.status).toBe('available')
    expect(result.window.observations[0]).toMatchObject({
      success: false,
      errorCode: 'timeout',
    })
  })

  it('deduplicates deterministically and degrades conflicting or replayed records', async () => {
    const replayed = await fixture()
    replayed[1]!.records.push(structuredClone(replayed[0]!.records[0]!))
    const replayResult = normalizeRepresentativeOtelEvidence(replayed, binding)
    expect(replayResult.status).toBe('degraded')
    expect(replayResult.caveats).toContain('duplicate-record')
    expect(replayResult.window.observations).toHaveLength(1)
    expect(replayResult.window.otelQuality?.duplicatesRemoved).toBe(1)

    const conflicting = await fixture()
    const duplicate = structuredClone(conflicting[0]!.records[1]!)
    nestedRecord(duplicate, 'claim').value = 999
    conflicting[1]!.records.push(duplicate)
    const conflictResult = normalizeRepresentativeOtelEvidence(conflicting, binding)
    expect(conflictResult.status).toBe('degraded')
    expect(conflictResult.caveats).toContain('conflicting-duplicate')
    expect(conflictResult.evidenceId).not.toBe(replayResult.evidenceId)
  })

  it('rejects cross-tenant, cross-source, and cross-resource correlation attempts', async () => {
    for (const [field, value] of [
      ['estateTenantId', 'tenant-b'],
      ['sourceConnectorId', 'source-b'],
      ['sourceTenantId', 'tenant-b'],
      ['providerResourceId', '/subscriptions/other/resource'],
      ['sourceAgentId', 'provider-agent-b'],
    ] as const) {
      const pages = await fixture()
      pages[0]!.records[0]![field] = value
      expect(() => normalizeRepresentativeOtelEvidence(pages, binding)).toThrow(
        `exact ${field} binding`,
      )
    }
  })

  it('keeps missing IDs, sampling, aggregation, partiality, and unsupported data degraded', async () => {
    const cases: Array<{
      mutate: (pages: EditablePage[]) => void
      caveat: string
    }> = [
      {
        mutate: (pages) => {
          pages[0]!.records[0]!.providerResourceId = null
        },
        caveat: 'missing-provider-resource-id',
      },
      {
        mutate: (pages) => {
          pages[0]!.records[0]!.traceId = null
        },
        caveat: 'missing-trace-id',
      },
      {
        mutate: (pages) => {
          pages[0]!.records[0]!.spanId = null
        },
        caveat: 'missing-span-id',
      },
      {
        mutate: (pages) => {
          pages[0]!.records[0]!.sampling = { state: 'sampled', rate: 0.5 }
        },
        caveat: 'sampled',
      },
      {
        mutate: (pages) => {
          pages[1]!.records[0]!.aggregation = {
            kind: 'pre-aggregated',
            periodStart: '2026-09-06T04:00:00.000Z',
            periodEnd: '2026-09-06T05:00:00.000Z',
          }
        },
        caveat: 'aggregated-metric',
      },
      {
        mutate: (pages) => {
          pages[0]!.records[1]!.partial = true
        },
        caveat: 'partial',
      },
      {
        mutate: (pages) => {
          pages[1]!.records[2]!.claim = { kind: 'unsupported', name: 'estimated-savings' }
        },
        caveat: 'unsupported-claim',
      },
      {
        mutate: (pages) => {
          pages[1]!.records[2]!.signal = 'log'
        },
        caveat: 'unsupported-signal',
      },
    ]

    for (const { mutate, caveat } of cases) {
      const pages = await fixture()
      mutate(pages)
      const result = normalizeRepresentativeOtelEvidence(pages, binding)
      expect(result.status).toBe('degraded')
      expect(result.caveats).toContain(caveat)
      expect(result.window.otelQuality?.status).not.toBe('available')
    }
  })

  it('marks empty, stale, and incomplete pages unknown or degraded instead of available', async () => {
    const empty = normalizeRepresentativeOtelEvidence(
      [{ pageNumber: 1, records: [] }],
      binding,
    )
    expect(empty.status).toBe('unknown')
    expect(empty.caveats).toEqual(['empty'])
    expect(empty.window.observations).toEqual([])

    const stale = normalizeRepresentativeOtelEvidence(await fixture(), {
      ...binding,
      maximumFreshnessHours: 1,
    })
    expect(stale.status).toBe('degraded')
    expect(stale.caveats).toContain('stale')

    const futurePages = await fixture()
    futurePages[0]!.records[0]!.observedAt = '2026-09-06T07:00:00.000Z'
    const future = normalizeRepresentativeOtelEvidence(futurePages, binding)
    expect(future.status).toBe('degraded')
    expect(future.caveats).toContain('future-timestamp')

    const incompletePages = await fixture()
    incompletePages[1]!.nextCursor = 'page-3'
    const incomplete = normalizeRepresentativeOtelEvidence(incompletePages, binding)
    expect(incomplete.status).toBe('degraded')
    expect(incomplete.caveats).toContain('incomplete-pagination')
  })

  it('enforces page and record bounds before normalization', () => {
    expect(() =>
      normalizeRepresentativeOtelEvidence(
        Array.from({ length: MAX_REPRESENTATIVE_OTEL_PAGES + 1 }, (_, index) => ({
          pageNumber: index + 1,
          records: [],
        })),
        binding,
      ),
    ).toThrow()
    expect(() =>
      normalizeRepresentativeOtelEvidence(
        [
          {
            pageNumber: 1,
            records: Array.from(
              { length: MAX_REPRESENTATIVE_OTEL_RECORDS_PER_PAGE + 1 },
              () => ({}),
            ),
          },
        ],
        binding,
      ),
    ).toThrow()
  })

  it('produces stable evidence and aggregation regardless of page or record order', async () => {
    const pages = await fixture()
    const first = normalizeRepresentativeOtelEvidence(pages, binding)
    const reordered = [...pages]
      .reverse()
      .map((page) => ({ ...page, records: [...page.records].reverse() }))
    const second = normalizeRepresentativeOtelEvidence(reordered, binding)

    expect(second.evidenceId).toBe(first.evidenceId)
    expect(second.evidence).toEqual(first.evidence)
    expect(second.window.observations).toEqual(first.window.observations)
  })

  it('preserves synthetic classification without promoting it to live evidence', async () => {
    const pages = await fixture()
    for (const page of pages) {
      for (const record of page.records) record.classification = 'synthetic'
    }
    const result = normalizeRepresentativeOtelEvidence(pages, binding)

    expect(result.status).toBe('available')
    expect(result.window.otelQuality?.classification).toBe('synthetic')
    expect(result.window.observations[0]?.synthetic).toBe(true)
    expect(
      result.evidence.every((item) => item.provenance.classification === 'synthetic'),
    ).toBe(true)
  })

  it('degrades mixed live and synthetic claims instead of merging classifications', async () => {
    const pages = await fixture()
    pages[1]!.records[0]!.classification = 'synthetic'
    const result = normalizeRepresentativeOtelEvidence(pages, binding)

    expect(result.status).toBe('degraded')
    expect(result.caveats).toContain('mixed-classification')
    expect(result.window.observations).toEqual([])
  })
})
