import { createHash } from 'node:crypto'

import {
  observationWindowSchema,
  otelAggregationSchema,
  otelEvidenceClaimSchema,
  otelEvidenceClassificationSchema,
  otelSamplingSchema,
  representativeOtelEvidenceSchema,
  type ObservationWindow,
  type OtelEvidenceCaveat,
  type OtelEvidenceClaim,
  type OtelWindowQuality,
  type RepresentativeOtelEvidence,
  type RuntimeObservation,
} from '@agent-sentinel/domain'
import { z } from 'zod'

export const MAX_REPRESENTATIVE_OTEL_PAGES = 20
export const MAX_REPRESENTATIVE_OTEL_RECORDS_PER_PAGE = 500
export const MAX_REPRESENTATIVE_OTEL_RECORDS =
  MAX_REPRESENTATIVE_OTEL_PAGES * MAX_REPRESENTATIVE_OTEL_RECORDS_PER_PAGE
export const MAX_REPRESENTATIVE_OTEL_OBSERVATIONS = 500

const boundedIdentifierSchema = z.string().trim().min(1).max(200)
const optionalIdentifierSchema = boundedIdentifierSchema.nullable().optional()
const signalSchema = z.enum(['trace', 'span', 'metric'])

export const representativeOtelWindowBindingSchema = z
  .strictObject({
    estateId: boundedIdentifierSchema,
    estateTenantId: boundedIdentifierSchema,
    estateEnvironment: boundedIdentifierSchema,
    sourceConnectorId: boundedIdentifierSchema,
    sourceTenantId: boundedIdentifierSchema,
    sourceEnvironment: boundedIdentifierSchema,
    providerResourceId: boundedIdentifierSchema,
    agentId: boundedIdentifierSchema,
    sourceAgentId: boundedIdentifierSchema,
    windowId: boundedIdentifierSchema,
    windowStart: z.iso.datetime(),
    windowEnd: z.iso.datetime(),
    queriedAt: z.iso.datetime(),
    maximumFreshnessHours: z.number().int().min(1).max(24 * 31).default(168),
  })
  .superRefine((binding, context) => {
    if (
      new Date(binding.windowEnd).getTime() <= new Date(binding.windowStart).getTime() ||
      new Date(binding.windowEnd).getTime() > new Date(binding.queriedAt).getTime()
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The evidence window must end after it starts and no later than the query time.',
      })
    }
  })
export type RepresentativeOtelWindowBinding = z.infer<
  typeof representativeOtelWindowBindingSchema
>

export const representativeOtelInputRecordSchema = z.strictObject({
  providerRecordId: boundedIdentifierSchema,
  estateId: optionalIdentifierSchema,
  estateTenantId: optionalIdentifierSchema,
  estateEnvironment: optionalIdentifierSchema,
  sourceConnectorId: optionalIdentifierSchema,
  sourceTenantId: optionalIdentifierSchema,
  sourceEnvironment: optionalIdentifierSchema,
  providerResourceId: optionalIdentifierSchema,
  sourceAgentId: optionalIdentifierSchema,
  traceId: z.string().max(64).nullable().optional(),
  spanId: z.string().max(32).nullable().optional(),
  signal: z.string().trim().min(1).max(50),
  observedAt: z.string().trim().min(1).max(100),
  classification: otelEvidenceClassificationSchema,
  sampling: otelSamplingSchema,
  aggregation: otelAggregationSchema,
  partial: z.boolean().default(false),
  claim: otelEvidenceClaimSchema,
})
export type RepresentativeOtelInputRecord = z.infer<
  typeof representativeOtelInputRecordSchema
>

export const representativeOtelPageSchema = z.strictObject({
  pageNumber: z.number().int().min(1).max(MAX_REPRESENTATIVE_OTEL_PAGES),
  cursor: boundedIdentifierSchema.optional(),
  nextCursor: boundedIdentifierSchema.optional(),
  records: z.array(z.unknown()).max(MAX_REPRESENTATIVE_OTEL_RECORDS_PER_PAGE),
})
export type RepresentativeOtelPage = z.infer<typeof representativeOtelPageSchema>

export interface RepresentativeOtelWindowNormalization {
  evidenceId: string
  status: OtelWindowQuality['status']
  caveats: OtelEvidenceCaveat[]
  evidence: RepresentativeOtelEvidence[]
  window: ObservationWindow
}

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

function addCaveat(caveats: Set<OtelEvidenceCaveat>, caveat: OtelEvidenceCaveat): void {
  caveats.add(caveat)
}

function normalizedId(prefix: string, value: string): string {
  return `otel-${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
}

function assertExactBoundary(
  record: RepresentativeOtelInputRecord,
  binding: RepresentativeOtelWindowBinding,
): void {
  for (const [field, expected] of [
    ['estateId', binding.estateId],
    ['estateTenantId', binding.estateTenantId],
    ['estateEnvironment', binding.estateEnvironment],
    ['sourceConnectorId', binding.sourceConnectorId],
    ['sourceTenantId', binding.sourceTenantId],
    ['sourceEnvironment', binding.sourceEnvironment],
    ['providerResourceId', binding.providerResourceId],
    ['sourceAgentId', binding.sourceAgentId],
  ] as const) {
    const actual = record[field]
    if (actual !== undefined && actual !== null && actual !== expected) {
      throw new Error(
        `OpenTelemetry record ${record.providerRecordId} does not match the exact ${field} binding.`,
      )
    }
  }
}

function expectedSignal(claim: OtelEvidenceClaim): 'trace' | 'span' | 'metric' | undefined {
  if (claim.kind === 'invocation') return 'trace'
  if (claim.kind === 'latency' || claim.kind === 'error') return 'span'
  if (
    claim.kind === 'input-tokens' ||
    claim.kind === 'output-tokens' ||
    claim.kind === 'cost'
  ) {
    return 'metric'
  }
  return undefined
}

function exactIdentifier(
  value: string | null | undefined,
  pattern: RegExp,
  caveat: 'missing-trace-id' | 'missing-span-id',
  caveats: Set<OtelEvidenceCaveat>,
): string | undefined {
  if (value === undefined || value === null || !pattern.test(value)) {
    addCaveat(caveats, caveat)
    return undefined
  }
  return value
}

function classificationFor(
  evidence: readonly RepresentativeOtelEvidence[],
): OtelWindowQuality['classification'] {
  const values = new Set(evidence.map((item) => item.provenance.classification))
  if (values.size === 0) return 'unknown'
  if (values.size > 1) return 'mixed'
  return values.has('synthetic') ? 'synthetic' : 'live'
}

function invocationKey(item: RepresentativeOtelEvidence): string | undefined {
  const { providerResourceId, traceId, spanId } = item.provenance
  return providerResourceId === undefined || traceId === undefined || spanId === undefined
    ? undefined
    : `${providerResourceId}\0${traceId}\0${spanId}`
}

function aggregateObservations(
  evidence: readonly RepresentativeOtelEvidence[],
  binding: RepresentativeOtelWindowBinding,
  caveats: Set<OtelEvidenceCaveat>,
): RuntimeObservation[] {
  const grouped = new Map<string, RepresentativeOtelEvidence[]>()
  for (const item of evidence) {
    const key = invocationKey(item)
    if (key === undefined) continue
    const group = grouped.get(key) ?? []
    group.push(item)
    grouped.set(key, group)
  }

  const observations: RuntimeObservation[] = []
  const requiredClaims = [
    'invocation',
    'latency',
    'error',
    'input-tokens',
    'output-tokens',
    'cost',
  ] as const

  for (const [key, group] of [...grouped.entries()].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    const claims = new Map<OtelEvidenceClaim['kind'], RepresentativeOtelEvidence>()
    for (const item of [...group].sort((left, right) => compareCodeUnits(left.id, right.id))) {
      if (item.claim.kind === 'unsupported') continue
      if (claims.has(item.claim.kind)) {
        addCaveat(caveats, 'duplicate-claim')
        continue
      }
      claims.set(item.claim.kind, item)
    }
    if (requiredClaims.some((claim) => !claims.has(claim))) {
      addCaveat(caveats, 'partial')
      continue
    }
    const classifications = new Set(group.map((item) => item.provenance.classification))
    if (classifications.size !== 1) {
      addCaveat(caveats, 'mixed-classification')
      continue
    }

    const invocation = claims.get('invocation')
    const latency = claims.get('latency')
    const error = claims.get('error')
    const inputTokens = claims.get('input-tokens')
    const outputTokens = claims.get('output-tokens')
    const cost = claims.get('cost')
    if (
      invocation === undefined ||
      latency === undefined ||
      error === undefined ||
      inputTokens === undefined ||
      outputTokens === undefined ||
      cost === undefined ||
      latency.claim.kind !== 'latency' ||
      error.claim.kind !== 'error' ||
      inputTokens.claim.kind !== 'input-tokens' ||
      outputTokens.claim.kind !== 'output-tokens' ||
      cost.claim.kind !== 'cost'
    ) {
      addCaveat(caveats, 'partial')
      continue
    }

    const provenance = invocation.provenance
    const { providerResourceId, traceId, spanId } = provenance
    if (providerResourceId === undefined || traceId === undefined || spanId === undefined) {
      addCaveat(caveats, 'partial')
      continue
    }
    const evidenceIds = [
      invocation.id,
      latency.id,
      error.id,
      inputTokens.id,
      outputTokens.id,
      cost.id,
    ]
    observations.push({
      id: normalizedId('invocation', key),
      tenantId: binding.estateTenantId,
      agentId: binding.agentId,
      environment: binding.sourceEnvironment,
      source: 'azure-monitor-otel',
      observedAt: provenance.observedAt,
      latencyMs: latency.claim.value,
      inputTokens: inputTokens.claim.value,
      outputTokens: outputTokens.claim.value,
      costUsd: cost.claim.value,
      success: !error.claim.value,
      ...(error.claim.value && error.claim.errorCode !== undefined
        ? { errorCode: error.claim.errorCode }
        : {}),
      correlations: [{ kind: 'correlation-id', value: traceId }],
      toolCallNames: [],
      synthetic: provenance.classification === 'synthetic',
      otelProvenance: {
        ...provenance,
        providerResourceId,
        traceId,
        spanId,
        evidenceIds,
      },
    })
  }
  return observations.sort((left, right) =>
    compareCodeUnits(`${left.observedAt}\0${left.id}`, `${right.observedAt}\0${right.id}`),
  )
}

function pageCaveats(
  pages: readonly RepresentativeOtelPage[],
  caveats: Set<OtelEvidenceCaveat>,
): void {
  const sorted = [...pages].sort((left, right) => left.pageNumber - right.pageNumber)
  for (const [index, page] of sorted.entries()) {
    const expectedPageNumber = index + 1
    if (page.pageNumber !== expectedPageNumber) addCaveat(caveats, 'incomplete-pagination')
    if (index === 0 && page.cursor !== undefined) addCaveat(caveats, 'incomplete-pagination')
    const next = sorted[index + 1]
    if (
      next !== undefined &&
      (page.nextCursor === undefined || page.nextCursor !== next.cursor)
    ) {
      addCaveat(caveats, 'incomplete-pagination')
    }
    if (next === undefined && page.nextCursor !== undefined) {
      addCaveat(caveats, 'incomplete-pagination')
    }
  }
  if (new Set(sorted.map((page) => page.pageNumber)).size !== sorted.length) {
    addCaveat(caveats, 'incomplete-pagination')
  }
}

export function normalizeRepresentativeOtelEvidence(
  pagesInput: readonly unknown[],
  bindingInput: z.input<typeof representativeOtelWindowBindingSchema>,
): RepresentativeOtelWindowNormalization {
  const binding = representativeOtelWindowBindingSchema.parse(bindingInput)
  const pages = z
    .array(representativeOtelPageSchema)
    .max(MAX_REPRESENTATIVE_OTEL_PAGES)
    .parse(pagesInput)
  const recordsReceived = pages.reduce((total, page) => total + page.records.length, 0)
  if (recordsReceived > MAX_REPRESENTATIVE_OTEL_RECORDS) {
    throw new Error(
      `Representative OpenTelemetry evidence exceeds ${MAX_REPRESENTATIVE_OTEL_RECORDS} records.`,
    )
  }

  const caveats = new Set<OtelEvidenceCaveat>()
  pageCaveats(pages, caveats)
  if (recordsReceived === 0) addCaveat(caveats, 'empty')

  const startMs = new Date(binding.windowStart).getTime()
  const endMs = new Date(binding.windowEnd).getTime()
  const queriedAtMs = new Date(binding.queriedAt).getTime()
  const freshnessMs = binding.maximumFreshnessHours * 60 * 60 * 1000
  const seenRecords = new Map<string, string>()
  let duplicatesRemoved = 0
  const evidence: RepresentativeOtelEvidence[] = []

  for (const page of [...pages].sort((left, right) => left.pageNumber - right.pageNumber)) {
    for (const input of page.records) {
      const parsed = representativeOtelInputRecordSchema.safeParse(input)
      if (!parsed.success) {
        addCaveat(caveats, 'invalid-record')
        continue
      }
      const record = parsed.data
      assertExactBoundary(record, binding)
      if (
        record.estateId === undefined ||
        record.estateId === null ||
        record.estateTenantId === undefined ||
        record.estateTenantId === null ||
        record.estateEnvironment === undefined ||
        record.estateEnvironment === null ||
        record.sourceConnectorId === undefined ||
        record.sourceConnectorId === null ||
        record.sourceTenantId === undefined ||
        record.sourceTenantId === null ||
        record.sourceEnvironment === undefined ||
        record.sourceEnvironment === null ||
        record.sourceAgentId === undefined ||
        record.sourceAgentId === null
      ) {
        addCaveat(caveats, 'invalid-record')
        continue
      }
      const canonicalRecord = JSON.stringify(record)
      const previous = seenRecords.get(record.providerRecordId)
      if (previous !== undefined) {
        duplicatesRemoved += 1
        addCaveat(
          caveats,
          previous === canonicalRecord ? 'duplicate-record' : 'conflicting-duplicate',
        )
        continue
      }
      seenRecords.set(record.providerRecordId, canonicalRecord)

      if (record.providerResourceId === undefined || record.providerResourceId === null) {
        addCaveat(caveats, 'missing-provider-resource-id')
      }
      const traceId = exactIdentifier(
        record.traceId,
        /^[0-9a-f]{32}$/,
        'missing-trace-id',
        caveats,
      )
      const spanId = exactIdentifier(
        record.spanId,
        /^[0-9a-f]{16}$/,
        'missing-span-id',
        caveats,
      )
      if (!signalSchema.safeParse(record.signal).success) {
        addCaveat(caveats, 'unsupported-signal')
        continue
      }
      const signal = signalSchema.parse(record.signal)
      const expected = expectedSignal(record.claim)
      if (expected === undefined) addCaveat(caveats, 'unsupported-claim')
      else if (expected !== signal) addCaveat(caveats, 'unsupported-signal')
      if (record.sampling.state === 'sampled') addCaveat(caveats, 'sampled')
      if (record.sampling.state === 'unknown') addCaveat(caveats, 'sampling-unknown')
      if (record.partial) addCaveat(caveats, 'partial')
      if (record.aggregation.kind !== 'raw') addCaveat(caveats, 'aggregated-metric')

      const observedAtMs = Date.parse(record.observedAt)
      if (!Number.isFinite(observedAtMs) || observedAtMs < startMs || observedAtMs > endMs) {
        addCaveat(caveats, observedAtMs > queriedAtMs ? 'future-timestamp' : 'invalid-record')
      } else if (queriedAtMs - observedAtMs > freshnessMs) {
        addCaveat(caveats, 'stale')
      }

      const normalized = representativeOtelEvidenceSchema.safeParse({
        id: normalizedId('record', canonicalRecord),
        providerRecordId: record.providerRecordId,
        signal,
        provenance: {
          estateId: binding.estateId,
          estateTenantId: binding.estateTenantId,
          estateEnvironment: binding.estateEnvironment,
          sourceConnectorId: binding.sourceConnectorId,
          sourceTenantId: binding.sourceTenantId,
          sourceEnvironment: binding.sourceEnvironment,
          provider: 'azure-monitor-otel',
          providerResourceId: record.providerResourceId ?? undefined,
          providerAgentId: binding.sourceAgentId,
          traceId,
          spanId,
          observedAt: record.observedAt,
          classification: record.classification,
          sampling: record.sampling,
          aggregation: record.aggregation,
        },
        claim: record.claim,
        partial: record.partial,
      })
      if (!normalized.success) {
        addCaveat(caveats, 'invalid-record')
        continue
      }
      evidence.push(normalized.data)
    }
  }

  evidence.sort((left, right) => compareCodeUnits(left.id, right.id))
  const aggregatedObservations = aggregateObservations(evidence, binding, caveats)
  if (aggregatedObservations.length > MAX_REPRESENTATIVE_OTEL_OBSERVATIONS) {
    addCaveat(caveats, 'partial')
  }
  const observations = aggregatedObservations.slice(0, MAX_REPRESENTATIVE_OTEL_OBSERVATIONS)
  const classification = classificationFor(evidence)
  if (classification === 'mixed') addCaveat(caveats, 'mixed-classification')
  const sortedCaveats = [...caveats].sort(compareCodeUnits)
  const status: OtelWindowQuality['status'] =
    recordsReceived === 0 ? 'unknown' : sortedCaveats.length > 0 ? 'degraded' : 'available'
  const quality: OtelWindowQuality = {
    status,
    classification,
    caveats: sortedCaveats,
    recordsReceived,
    recordsAccepted: evidence.length,
    duplicatesRemoved,
    pagesProcessed: pages.length,
  }
  const window = observationWindowSchema.parse({
    windowId: binding.windowId,
    tenantId: binding.estateTenantId,
    agentId: binding.agentId,
    environment: binding.sourceEnvironment,
    source: 'azure-monitor-otel',
    windowStart: binding.windowStart,
    windowEnd: binding.windowEnd,
    observations,
    otelQuality: quality,
  })
  const evidenceId = normalizedId(
    'evidence',
    JSON.stringify({
      binding,
      quality,
      evidence: evidence.map((item) => item.id),
      observations: observations.map((item) => item.id),
    }),
  )

  return {
    evidenceId,
    status,
    caveats: sortedCaveats,
    evidence,
    window,
  }
}
