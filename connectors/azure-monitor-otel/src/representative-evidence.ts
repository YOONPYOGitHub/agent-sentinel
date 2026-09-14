import { createHash } from 'node:crypto'

import {
  agentCorrelationsSchema,
  azureApplicationInsightsResourceIdSchema,
  observationWindowSchema,
  otelAggregationSchema,
  otelEvidenceClaimSchema,
  otelEvidenceClassificationSchema,
  otelSamplingSchema,
  otelTelemetryContractIdentitySchema,
  otelTelemetryContractSchema,
  representativeOtelEvidenceSchema,
  sourceProjectIdSchema,
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
    snapshotGeneratedAt: z.iso.datetime(),
    estateId: boundedIdentifierSchema,
    estateTenantId: boundedIdentifierSchema,
    estateEnvironment: boundedIdentifierSchema,
    sourceConnectorId: boundedIdentifierSchema,
    sourceTenantId: boundedIdentifierSchema,
    sourceProjectId: sourceProjectIdSchema,
    sourceEnvironment: boundedIdentifierSchema,
    providerResourceId: azureApplicationInsightsResourceIdSchema,
    agentId: boundedIdentifierSchema,
    sourceAgentId: boundedIdentifierSchema,
    sourceSetFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    measuredAt: z.iso.datetime(),
    contract: otelTelemetryContractIdentitySchema,
    windowId: boundedIdentifierSchema,
    windowStart: z.iso.datetime(),
    windowEnd: z.iso.datetime(),
    queriedAt: z.iso.datetime(),
    maximumFreshnessHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 31)
      .default(168),
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
export type RepresentativeOtelWindowBinding = z.infer<typeof representativeOtelWindowBindingSchema>

export const representativeOtelInputRecordSchema = z
  .strictObject({
    providerRecordId: boundedIdentifierSchema,
    observationId: boundedIdentifierSchema.optional(),
    observationFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    snapshotGeneratedAt: z.iso.datetime().nullable().optional(),
    estateId: optionalIdentifierSchema,
    estateTenantId: optionalIdentifierSchema,
    estateEnvironment: optionalIdentifierSchema,
    sourceConnectorId: optionalIdentifierSchema,
    sourceTenantId: optionalIdentifierSchema,
    sourceProjectId: sourceProjectIdSchema.nullable().optional(),
    sourceEnvironment: optionalIdentifierSchema,
    providerResourceId: azureApplicationInsightsResourceIdSchema.nullable().optional(),
    sourceAgentId: optionalIdentifierSchema,
    providerInvocationId: optionalIdentifierSchema,
    sourceSetFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .optional(),
    measuredAt: z.iso.datetime().nullable().optional(),
    traceId: z.string().max(64).nullable().optional(),
    spanId: z.string().max(32).nullable().optional(),
    signal: z.string().trim().min(1).max(50),
    observedAt: z.string().trim().min(1).max(100),
    classification: otelEvidenceClassificationSchema,
    sampling: otelSamplingSchema,
    aggregation: otelAggregationSchema,
    contract: otelTelemetryContractSchema.nullable().optional(),
    correlations: agentCorrelationsSchema.optional(),
    toolCallNames: z.array(boundedIdentifierSchema).max(50).optional(),
    partial: z.boolean(),
    claim: otelEvidenceClaimSchema,
  })
  .superRefine((record, context) => {
    if ((record.observationId === undefined) !== (record.observationFingerprint === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Observation ID and fingerprint must be supplied together.',
      })
    }
  })
export type RepresentativeOtelInputRecord = z.infer<typeof representativeOtelInputRecordSchema>

export const representativeOtelPageSchema = z.strictObject({
  pageNumber: z.number().int().min(1).max(MAX_REPRESENTATIVE_OTEL_PAGES),
  cursor: boundedIdentifierSchema.optional(),
  nextCursor: boundedIdentifierSchema.optional(),
  records: z.array(z.unknown()).max(MAX_REPRESENTATIVE_OTEL_RECORDS_PER_PAGE),
})
export type RepresentativeOtelPage = z.infer<typeof representativeOtelPageSchema>

export const representativeOtelLiveReadinessSchema = z.enum([
  'live-ready',
  'synthetic-only',
  'insufficient-data',
])
export type RepresentativeOtelLiveReadiness = z.infer<typeof representativeOtelLiveReadinessSchema>

export interface RepresentativeOtelWindowNormalization {
  evidenceId: string
  status: OtelWindowQuality['status']
  liveReadiness: RepresentativeOtelLiveReadiness
  caveats: OtelEvidenceCaveat[]
  evidence: RepresentativeOtelEvidence[]
  window: ObservationWindow
}

export interface RepresentativeOtelInputDiagnostics {
  recordsReceivedOffset?: number
  duplicatesRemovedOffset?: number
  caveats?: readonly OtelEvidenceCaveat[]
}

const representativeOtelInputDiagnosticsSchema = z.strictObject({
  recordsReceivedOffset: z.number().int().min(0).max(MAX_REPRESENTATIVE_OTEL_RECORDS).default(0),
  duplicatesRemovedOffset: z.number().int().min(0).max(MAX_REPRESENTATIVE_OTEL_RECORDS).default(0),
  caveats: z
    .array(z.enum(['duplicate-record', 'conflicting-duplicate']))
    .max(2)
    .default([]),
})

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

function addCaveat(caveats: Set<OtelEvidenceCaveat>, caveat: OtelEvidenceCaveat): void {
  caveats.add(caveat)
}

function normalizedId(prefix: string, value: string): string {
  return `otel-${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
}

function hasExactBoundary(
  record: RepresentativeOtelInputRecord,
  binding: RepresentativeOtelWindowBinding,
): boolean {
  for (const [field, expected] of [
    ['snapshotGeneratedAt', binding.snapshotGeneratedAt],
    ['estateId', binding.estateId],
    ['estateTenantId', binding.estateTenantId],
    ['estateEnvironment', binding.estateEnvironment],
    ['sourceConnectorId', binding.sourceConnectorId],
    ['sourceTenantId', binding.sourceTenantId],
    ['sourceProjectId', binding.sourceProjectId],
    ['sourceEnvironment', binding.sourceEnvironment],
    ['providerResourceId', binding.providerResourceId],
    ['sourceAgentId', binding.sourceAgentId],
    ['sourceSetFingerprint', binding.sourceSetFingerprint],
    ['measuredAt', binding.measuredAt],
  ] as const) {
    if (record[field] !== expected) return false
  }
  return (
    record.providerInvocationId !== undefined &&
    record.providerInvocationId !== null &&
    record.contract?.version === binding.contract.version &&
    record.contract.recordType === binding.contract.recordType &&
    record.contract.applicationRoleName === binding.contract.applicationRoleName &&
    record.contract.requestName === binding.contract.requestName
  )
}

function expectedSignal(claim: OtelEvidenceClaim): 'trace' | 'span' | 'metric' | undefined {
  if (claim.kind === 'invocation') return 'trace'
  if (claim.kind === 'latency' || claim.kind === 'error') return 'span'
  if (claim.kind === 'input-tokens' || claim.kind === 'output-tokens' || claim.kind === 'cost') {
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
  const { providerInvocationId, providerResourceId, sourceSetFingerprint, traceId, spanId } =
    item.provenance
  return providerInvocationId === undefined ||
    providerResourceId === undefined ||
    sourceSetFingerprint === undefined ||
    traceId === undefined ||
    spanId === undefined
    ? undefined
    : `${providerResourceId}\0${sourceSetFingerprint}\0${providerInvocationId}\0${traceId}\0${spanId}`
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
    }
    const supportedClaims = group.filter((item) => item.claim.kind !== 'unsupported')
    const exactProvenance = new Set(
      supportedClaims.map((item) =>
        JSON.stringify({
          provenance: item.provenance,
          correlations: item.correlations,
          toolCallNames: item.toolCallNames,
          partial: item.partial,
        }),
      ),
    )
    if (exactProvenance.size !== 1) {
      addCaveat(caveats, 'invalid-record')
      continue
    }
    const observationIds = new Set(
      supportedClaims.flatMap((item) =>
        item.observationId === undefined ? [] : [item.observationId],
      ),
    )
    if (
      observationIds.size > 1 ||
      (observationIds.size === 1 &&
        supportedClaims.some((item) => item.observationId === undefined))
    ) {
      addCaveat(caveats, 'invalid-record')
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
    if (
      provenance.sampling.state !== 'complete' ||
      provenance.sampling.rate !== 1 ||
      provenance.aggregation.kind !== 'raw' ||
      invocation.partial
    ) {
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
      id: observationIds.size === 1 ? [...observationIds][0]! : normalizedId('invocation', key),
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
      correlations: agentCorrelationsSchema.parse([
        ...(invocation.correlations ?? []),
        ...(invocation.correlations?.some((correlation) => correlation.kind === 'correlation-id')
          ? []
          : [{ kind: 'correlation-id' as const, value: traceId }]),
      ]),
      toolCallNames: invocation.toolCallNames ?? [],
      synthetic: provenance.classification === 'synthetic',
      otelProvenance: {
        ...provenance,
        providerResourceId,
        traceId,
        spanId,
        partial: false,
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
  const cursors = new Set<string>()
  const nextCursors = new Set<string>()
  for (const [index, page] of sorted.entries()) {
    const expectedPageNumber = index + 1
    if (page.pageNumber !== expectedPageNumber) addCaveat(caveats, 'incomplete-pagination')
    if (index === 0 && page.cursor !== undefined) addCaveat(caveats, 'incomplete-pagination')
    if (page.cursor !== undefined) {
      if (cursors.has(page.cursor)) addCaveat(caveats, 'incomplete-pagination')
      cursors.add(page.cursor)
    }
    if (page.nextCursor !== undefined) {
      if (nextCursors.has(page.nextCursor) || page.nextCursor === page.cursor) {
        addCaveat(caveats, 'incomplete-pagination')
      }
      nextCursors.add(page.nextCursor)
    }
    const next = sorted[index + 1]
    if (next !== undefined && (page.nextCursor === undefined || page.nextCursor !== next.cursor)) {
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
  diagnosticsInput: RepresentativeOtelInputDiagnostics = {},
): RepresentativeOtelWindowNormalization {
  const binding = representativeOtelWindowBindingSchema.parse(bindingInput)
  const diagnostics = representativeOtelInputDiagnosticsSchema.parse(diagnosticsInput)
  const pages = z
    .array(representativeOtelPageSchema)
    .max(MAX_REPRESENTATIVE_OTEL_PAGES)
    .parse(pagesInput)
  const recordsReceived =
    pages.reduce((total, page) => total + page.records.length, 0) +
    diagnostics.recordsReceivedOffset
  if (recordsReceived > MAX_REPRESENTATIVE_OTEL_RECORDS) {
    throw new Error(
      `Representative OpenTelemetry evidence exceeds ${MAX_REPRESENTATIVE_OTEL_RECORDS} records.`,
    )
  }

  const caveats = new Set<OtelEvidenceCaveat>(diagnostics.caveats)
  pageCaveats(pages, caveats)
  if (recordsReceived === 0) addCaveat(caveats, 'empty')

  const startMs = new Date(binding.windowStart).getTime()
  const endMs = new Date(binding.windowEnd).getTime()
  const queriedAtMs = new Date(binding.queriedAt).getTime()
  const freshnessMs = binding.maximumFreshnessHours * 60 * 60 * 1000
  if (queriedAtMs - endMs > freshnessMs) addCaveat(caveats, 'stale')
  const recordsByProviderId = new Map<
    string,
    Array<{ canonical: string; record: RepresentativeOtelInputRecord }>
  >()
  const candidateRecords: Array<{
    canonical: string
    record: RepresentativeOtelInputRecord
  }> = []
  const observationFingerprints = new Map<string, Set<string>>()
  let duplicatesRemoved = diagnostics.duplicatesRemovedOffset
  const evidence: RepresentativeOtelEvidence[] = []

  for (const page of [...pages].sort((left, right) => left.pageNumber - right.pageNumber)) {
    for (const input of page.records) {
      const parsed = representativeOtelInputRecordSchema.safeParse(input)
      if (!parsed.success) {
        addCaveat(caveats, 'invalid-record')
        continue
      }
      const record = parsed.data
      if (!hasExactBoundary(record, binding)) {
        if (record.providerResourceId === undefined || record.providerResourceId === null) {
          addCaveat(caveats, 'missing-provider-resource-id')
        }
        addCaveat(caveats, 'invalid-record')
        continue
      }
      const canonicalRecord = JSON.stringify(record)
      candidateRecords.push({ canonical: canonicalRecord, record })
      if (record.observationId !== undefined && record.observationFingerprint !== undefined) {
        const fingerprints = observationFingerprints.get(record.observationId) ?? new Set<string>()
        fingerprints.add(record.observationFingerprint)
        observationFingerprints.set(record.observationId, fingerprints)
      }
    }
  }

  const conflictingObservationIds = new Set(
    [...observationFingerprints.entries()]
      .filter(([, fingerprints]) => fingerprints.size > 1)
      .map(([observationId]) => observationId),
  )
  for (const item of candidateRecords) {
    if (
      item.record.observationId !== undefined &&
      conflictingObservationIds.has(item.record.observationId)
    ) {
      duplicatesRemoved += 1
      addCaveat(caveats, 'conflicting-duplicate')
      continue
    }
    const group = recordsByProviderId.get(item.record.providerRecordId) ?? []
    group.push(item)
    recordsByProviderId.set(item.record.providerRecordId, group)
  }

  const records: Array<{ canonical: string; record: RepresentativeOtelInputRecord }> = []
  for (const [, group] of [...recordsByProviderId.entries()].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    const variants = new Set(group.map((item) => item.canonical))
    if (variants.size > 1) {
      duplicatesRemoved += group.length
      addCaveat(caveats, 'conflicting-duplicate')
      continue
    }
    if (group.length > 1) {
      duplicatesRemoved += group.length - 1
      addCaveat(caveats, 'duplicate-record')
    }
    records.push(group[0]!)
  }

  for (const { canonical: canonicalRecord, record } of records) {
    if (record.providerResourceId === undefined || record.providerResourceId === null) {
      addCaveat(caveats, 'missing-provider-resource-id')
    }
    const traceId = exactIdentifier(record.traceId, /^[0-9a-f]{32}$/, 'missing-trace-id', caveats)
    const spanId = exactIdentifier(record.spanId, /^[0-9a-f]{16}$/, 'missing-span-id', caveats)
    if (!signalSchema.safeParse(record.signal).success) {
      addCaveat(caveats, 'unsupported-signal')
      continue
    }
    const signal = signalSchema.parse(record.signal)
    const expected = expectedSignal(record.claim)
    if (expected === undefined) addCaveat(caveats, 'unsupported-claim')
    else if (expected !== signal) addCaveat(caveats, 'unsupported-signal')
    if (record.sampling.state === 'sampled') addCaveat(caveats, 'sampled')
    if (
      record.sampling.state === 'unknown' ||
      (record.sampling.state === 'complete' && record.sampling.rate !== 1)
    ) {
      addCaveat(caveats, 'sampling-unknown')
    }
    if (record.partial) addCaveat(caveats, 'partial')
    if (record.aggregation.kind !== 'raw') addCaveat(caveats, 'aggregated-metric')

    const observedAtMs = Date.parse(record.observedAt)
    if (!Number.isFinite(observedAtMs) || observedAtMs < startMs || observedAtMs > endMs) {
      addCaveat(caveats, observedAtMs > queriedAtMs ? 'future-timestamp' : 'invalid-record')
    } else if (endMs - observedAtMs > freshnessMs) {
      addCaveat(caveats, 'stale')
    }

    const normalized = representativeOtelEvidenceSchema.safeParse({
      id: normalizedId('record', canonicalRecord),
      providerRecordId: record.providerRecordId,
      ...(record.observationId === undefined ? {} : { observationId: record.observationId }),
      signal,
      provenance: {
        snapshotGeneratedAt: binding.snapshotGeneratedAt,
        estateId: binding.estateId,
        estateTenantId: binding.estateTenantId,
        estateEnvironment: binding.estateEnvironment,
        sourceConnectorId: binding.sourceConnectorId,
        sourceTenantId: binding.sourceTenantId,
        sourceProjectId: binding.sourceProjectId,
        sourceEnvironment: binding.sourceEnvironment,
        provider: 'azure-monitor-otel',
        providerResourceId: record.providerResourceId ?? undefined,
        providerAgentId: binding.sourceAgentId,
        providerInvocationId: record.providerInvocationId ?? undefined,
        sourceSetFingerprint: record.sourceSetFingerprint ?? undefined,
        measuredAt: record.measuredAt ?? undefined,
        traceId,
        spanId,
        observedAt: record.observedAt,
        classification: record.classification,
        sampling: record.sampling,
        aggregation: record.aggregation,
        contract: record.contract ?? undefined,
      },
      ...(record.correlations === undefined ? {} : { correlations: record.correlations }),
      ...(record.toolCallNames === undefined ? {} : { toolCallNames: record.toolCallNames }),
      claim: record.claim,
      partial: record.partial,
    })
    if (!normalized.success) {
      addCaveat(caveats, 'invalid-record')
      continue
    }
    evidence.push(normalized.data)
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
  const evidenceBinding: Omit<RepresentativeOtelWindowBinding, 'queriedAt'> = {
    snapshotGeneratedAt: binding.snapshotGeneratedAt,
    estateId: binding.estateId,
    estateTenantId: binding.estateTenantId,
    estateEnvironment: binding.estateEnvironment,
    sourceConnectorId: binding.sourceConnectorId,
    sourceTenantId: binding.sourceTenantId,
    sourceProjectId: binding.sourceProjectId,
    sourceEnvironment: binding.sourceEnvironment,
    providerResourceId: binding.providerResourceId,
    agentId: binding.agentId,
    sourceAgentId: binding.sourceAgentId,
    sourceSetFingerprint: binding.sourceSetFingerprint,
    measuredAt: binding.measuredAt,
    contract: binding.contract,
    windowId: binding.windowId,
    windowStart: binding.windowStart,
    windowEnd: binding.windowEnd,
    maximumFreshnessHours: binding.maximumFreshnessHours,
  }
  const evidenceId = normalizedId(
    'evidence',
    JSON.stringify({
      binding: evidenceBinding,
      quality,
      evidence: evidence.map((item) => item.id),
      observations: observations.map((item) => item.id),
    }),
  )
  const liveReadiness = representativeOtelLiveReadinessSchema.parse(
    status === 'available' && classification === 'live' && observations.length > 0
      ? 'live-ready'
      : status === 'available' && classification === 'synthetic' && observations.length > 0
        ? 'synthetic-only'
        : 'insufficient-data',
  )

  return {
    evidenceId,
    status,
    liveReadiness,
    caveats: sortedCaveats,
    evidence,
    window,
  }
}
