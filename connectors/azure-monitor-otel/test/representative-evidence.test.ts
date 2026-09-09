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
  snapshotGeneratedAt: '2026-09-06T06:00:00.000Z',
  estateId: 'estate-a',
  estateTenantId: 'tenant-a',
  estateEnvironment: 'portfolio',
  sourceConnectorId: 'source-a',
  sourceTenantId: 'tenant-a',
  sourceProjectId: 'project-a',
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
  it('requires exact snapshot-generation provenance for every representative claim', async () => {
    const pages = await fixture()
    for (const page of pages) {
      for (const record of page.records) {
        record.snapshotGeneratedAt = '2026-09-06T06:00:00.000Z'
      }
    }

    const result = normalizeRepresentativeOtelEvidence(pages, {
      ...binding,
      snapshotGeneratedAt: '2026-09-06T06:00:00.000Z',
    })

    expect(result.status).toBe('available')
    expect(result.window.observations[0]?.otelProvenance?.snapshotGeneratedAt).toBe(
      '2026-09-06T06:00:00.000Z',
    )
  })

  it('normalizes complete trace, span, and metric claims with exact provenance', async () => {
    const result = normalizeRepresentativeOtelEvidence(await fixture(), binding)

    expect(result.status).toBe('available')
    expect(result.liveReadiness).toBe('live-ready')
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
        correlations: [{ kind: 'correlation-id', value: '11111111111111111111111111111111' }],
      }),
    ])
    expect(result.window.observations[0]?.otelProvenance).toMatchObject({
      estateId: 'estate-a',
      estateTenantId: 'tenant-a',
      estateEnvironment: 'portfolio',
      sourceConnectorId: 'source-a',
      sourceTenantId: 'tenant-a',
      sourceProjectId: 'project-a',
      sourceEnvironment: 'production',
      providerResourceId: binding.providerResourceId,
      providerAgentId: 'provider-agent-a',
      traceId: '11111111111111111111111111111111',
      spanId: 'aaaaaaaaaaaaaaaa',
      classification: 'live',
      sampling: { state: 'complete', rate: 1 },
      aggregation: { kind: 'raw' },
      partial: false,
    })
    expect(result.window.observations[0]?.otelProvenance?.evidenceIds).toHaveLength(6)
  })

  it('binds enriched invocation identity and ordered tools into normalized evidence IDs', async () => {
    const firstPages = await fixture()
    for (const page of firstPages) {
      for (const record of page.records) {
        record.correlations = [
          { kind: 'agent-run-id', value: 'run-a' },
          { kind: 'correlation-id', value: 'correlation-a' },
          { kind: 'agent-version', value: '17' },
        ]
        record.toolCallNames = ['knowledge_search', 'answer']
      }
    }
    const secondPages = structuredClone(firstPages)
    for (const page of secondPages) {
      for (const record of page.records) {
        record.correlations = [
          { kind: 'agent-run-id', value: 'run-b' },
          { kind: 'correlation-id', value: 'correlation-b' },
          { kind: 'agent-version', value: '18' },
        ]
        record.toolCallNames = ['answer', 'knowledge_search']
      }
    }

    const first = normalizeRepresentativeOtelEvidence(firstPages, binding)
    const second = normalizeRepresentativeOtelEvidence(secondPages, binding)

    expect(first.window.observations[0]).toMatchObject({
      correlations: [
        { kind: 'agent-run-id', value: 'run-a' },
        { kind: 'correlation-id', value: 'correlation-a' },
        { kind: 'agent-version', value: '17' },
      ],
      toolCallNames: ['knowledge_search', 'answer'],
    })
    expect(second.window.observations[0]).toMatchObject({
      correlations: [
        { kind: 'agent-run-id', value: 'run-b' },
        { kind: 'correlation-id', value: 'correlation-b' },
        { kind: 'agent-version', value: '18' },
      ],
      toolCallNames: ['answer', 'knowledge_search'],
    })
    expect(second.evidenceId).not.toBe(first.evidenceId)
  })

  it('canonicalizes reordered equivalent correlation sets across claims', async () => {
    const pages = await fixture()
    for (const [index, record] of pages.flatMap((page) => page.records).entries()) {
      const correlations = [
        { kind: 'agent-run-id', value: 'run-a' },
        { kind: 'correlation-id', value: 'correlation-a' },
        { kind: 'agent-version', value: '17' },
      ]
      record.correlations =
        index % 2 === 0 ? correlations : [correlations[2], correlations[0], correlations[1]]
    }

    const result = normalizeRepresentativeOtelEvidence(pages, binding)
    const reordered = normalizeRepresentativeOtelEvidence(
      [...pages].reverse().map((page) => ({
        ...page,
        records: [...page.records].reverse(),
      })),
      binding,
    )

    expect(result.status).toBe('available')
    expect(result.window.observations[0]?.correlations).toEqual([
      { kind: 'agent-run-id', value: 'run-a' },
      { kind: 'correlation-id', value: 'correlation-a' },
      { kind: 'agent-version', value: '17' },
    ])
    expect(reordered).toEqual(result)
  })

  it('adds the trace correlation when another correlation kind is already present', async () => {
    const pages = await fixture()
    for (const record of pages.flatMap((page) => page.records)) {
      record.correlations = [
        { kind: 'agent-version', value: '17' },
        { kind: 'agent-run-id', value: 'run-a' },
      ]
    }

    const result = normalizeRepresentativeOtelEvidence(pages, binding)

    expect(result.status).toBe('available')
    expect(result.window.observations[0]?.correlations).toEqual([
      { kind: 'agent-run-id', value: 'run-a' },
      { kind: 'correlation-id', value: '11111111111111111111111111111111' },
      { kind: 'agent-version', value: '17' },
    ])
  })

  it('fails closed when claims disagree on enriched invocation identity', async () => {
    const pages = await fixture()
    for (const page of pages) {
      for (const record of page.records) {
        record.correlations = [
          { kind: 'agent-run-id', value: 'run-a' },
          { kind: 'correlation-id', value: 'correlation-a' },
          { kind: 'agent-version', value: '17' },
        ]
        record.toolCallNames = ['knowledge_search', 'answer']
      }
    }
    pages[0]!.records[0]!.correlations = [
      { kind: 'agent-run-id', value: 'run-b' },
      { kind: 'correlation-id', value: 'correlation-a' },
      { kind: 'agent-version', value: '17' },
    ]

    const result = normalizeRepresentativeOtelEvidence(pages, binding)

    expect(result.status).toBe('degraded')
    expect(result.caveats).toContain('invalid-record')
    expect(result.evidence).toHaveLength(6)
    expect(result.window.observations).toEqual([])
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
    const reversedConflictResult = normalizeRepresentativeOtelEvidence(
      [...conflicting].reverse().map((page) => ({ ...page, records: [...page.records].reverse() })),
      binding,
    )

    expect(conflictResult.status).toBe('degraded')
    expect(conflictResult.caveats).toContain('conflicting-duplicate')
    expect(conflictResult.caveats).toContain('partial')
    expect(conflictResult.evidence).toHaveLength(5)
    expect(conflictResult.window.observations).toEqual([])
    expect(conflictResult.window.otelQuality).toMatchObject({
      recordsReceived: 7,
      recordsAccepted: 5,
      duplicatesRemoved: 2,
    })
    expect(reversedConflictResult).toEqual(conflictResult)
  })

  it('degrades contradictory exact provenance without projecting runtime evidence', async () => {
    for (const [field, value] of [
      ['estateId', 'estate-b'],
      ['estateTenantId', 'tenant-b'],
      ['estateEnvironment', 'other-estate'],
      ['sourceConnectorId', 'source-b'],
      ['sourceTenantId', 'tenant-b'],
      ['sourceProjectId', 'project-b'],
      ['sourceEnvironment', 'staging'],
      ['providerResourceId', '/subscriptions/other/resource'],
      ['sourceAgentId', 'provider-agent-b'],
    ] as const) {
      const pages = await fixture()
      pages[0]!.records[0]![field] = value
      const result = normalizeRepresentativeOtelEvidence(pages, binding)

      expect(result.status).toBe('degraded')
      expect(result.caveats).toContain('invalid-record')
      expect(result.window.observations).toEqual([])
      expect(result.window.otelQuality?.status).toBe('degraded')
    }
  })

  it('degrades missing exact provenance fields without projecting runtime evidence', async () => {
    for (const field of [
      'estateId',
      'estateTenantId',
      'estateEnvironment',
      'sourceConnectorId',
      'sourceTenantId',
      'sourceProjectId',
      'sourceEnvironment',
      'providerResourceId',
      'sourceAgentId',
    ] as const) {
      const pages = await fixture()
      delete pages[0]!.records[0]![field]
      const result = normalizeRepresentativeOtelEvidence(pages, binding)

      expect(result.status).toBe('degraded')
      expect(result.caveats).toContain('invalid-record')
      expect(result.window.observations).toEqual([])
      expect(result.window.otelQuality?.status).toBe('degraded')
    }
  })

  it('rejects claim-wide provenance differences deterministically regardless of claim order', async () => {
    const mutations: Array<(record: Record<string, unknown>) => void> = [
      (record) => {
        record.observedAt = '2026-09-06T05:00:00.001Z'
      },
      (record) => {
        record.classification = 'synthetic'
      },
      (record) => {
        record.sampling = { state: 'complete' }
      },
      (record) => {
        record.sampling = { state: 'sampled', rate: 0.5 }
      },
      (record) => {
        record.aggregation = { kind: 'delta' }
      },
      (record) => {
        record.partial = true
      },
    ]

    for (const mutate of mutations) {
      const pages = await fixture()
      mutate(pages[1]!.records[0]!)
      const result = normalizeRepresentativeOtelEvidence(pages, binding)
      const reordered = normalizeRepresentativeOtelEvidence(
        [...pages].reverse().map((page) => ({
          ...page,
          records: [...page.records].reverse(),
        })),
        binding,
      )

      expect(result.status).toBe('degraded')
      expect(result.caveats).toContain('invalid-record')
      expect(result.window.observations).toEqual([])
      expect(reordered).toEqual(result)
    }
  })

  it('requires every input claim to state partiality explicitly', async () => {
    const pages = await fixture()
    delete pages[1]!.records[0]!.partial

    const result = normalizeRepresentativeOtelEvidence(pages, binding)

    expect(result.status).toBe('degraded')
    expect(result.caveats).toEqual(expect.arrayContaining(['invalid-record', 'partial']))
    expect(result.window.observations).toEqual([])
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
    const empty = normalizeRepresentativeOtelEvidence([{ pageNumber: 1, records: [] }], binding)
    expect(empty.status).toBe('unknown')
    expect(empty.liveReadiness).toBe('insufficient-data')
    expect(empty.caveats).toEqual(['empty'])
    expect(empty.window.observations).toEqual([])

    const stale = normalizeRepresentativeOtelEvidence(await fixture(), {
      ...binding,
      queriedAt: '2026-09-06T07:01:00.000Z',
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

  it('accepts a default 168-hour baseline whose window ended within the freshness limit', async () => {
    const pages = await fixture()
    for (const page of pages) {
      for (const record of page.records) {
        record.observedAt = '2026-09-01T06:00:00.000Z'
      }
    }

    const result = normalizeRepresentativeOtelEvidence(pages, {
      ...binding,
      windowStart: '2026-09-01T06:00:00.000Z',
      windowEnd: '2026-09-08T06:00:00.000Z',
      queriedAt: '2026-09-09T06:00:00.000Z',
      maximumFreshnessHours: 168,
    })

    expect(result.status).toBe('available')
    expect(result.caveats).not.toContain('stale')
    expect(result.liveReadiness).toBe('live-ready')
  })

  it('rejects observations older than the freshness limit relative to their window end', async () => {
    const pages = await fixture()
    for (const page of pages) {
      for (const record of page.records) {
        record.observedAt = '2026-09-01T05:59:59.999Z'
      }
    }

    const result = normalizeRepresentativeOtelEvidence(pages, {
      ...binding,
      windowStart: '2026-09-01T05:00:00.000Z',
      windowEnd: '2026-09-08T06:00:00.000Z',
      queriedAt: '2026-09-09T06:00:00.000Z',
      maximumFreshnessHours: 168,
    })

    expect(result.status).toBe('degraded')
    expect(result.caveats).toContain('stale')
    expect(result.liveReadiness).toBe('insufficient-data')
  })

  it('detects self-looping and replayed continuation tokens across the full chain', async () => {
    const selfLoop = await fixture()
    selfLoop[1]!.nextCursor = 'page-2'
    selfLoop.push({ pageNumber: 3, cursor: 'page-2', records: [] })
    const selfLoopResult = normalizeRepresentativeOtelEvidence(selfLoop, binding)
    expect(selfLoopResult.status).toBe('degraded')
    expect(selfLoopResult.caveats).toContain('incomplete-pagination')

    const replayed = await fixture()
    replayed[1]!.nextCursor = 'page-3'
    replayed.push(
      { pageNumber: 3, cursor: 'page-3', nextCursor: 'page-2', records: [] },
      { pageNumber: 4, cursor: 'page-2', records: [] },
    )
    const replayedResult = normalizeRepresentativeOtelEvidence(replayed, binding)
    expect(replayedResult.status).toBe('degraded')
    expect(replayedResult.caveats).toContain('incomplete-pagination')
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
    expect(result.liveReadiness).toBe('synthetic-only')
    expect(result.window.otelQuality?.classification).toBe('synthetic')
    expect(result.window.observations[0]?.synthetic).toBe(true)
    expect(result.evidence.every((item) => item.provenance.classification === 'synthetic')).toBe(
      true,
    )
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
