import { z } from 'zod'

const boundedIdentifierSchema = z.string().trim().min(1).max(200)
const otelTraceIdSchema = z.string().regex(/^[0-9a-f]{32}$/)
const otelSpanIdSchema = z.string().regex(/^[0-9a-f]{16}$/)

export const otelEvidenceStatusSchema = z.enum(['available', 'unknown', 'degraded'])
export type OtelEvidenceStatus = z.infer<typeof otelEvidenceStatusSchema>

export const otelEvidenceClassificationSchema = z.enum(['live', 'synthetic'])
export type OtelEvidenceClassification = z.infer<typeof otelEvidenceClassificationSchema>

export const otelSignalTypeSchema = z.enum(['trace', 'span', 'metric'])
export type OtelSignalType = z.infer<typeof otelSignalTypeSchema>

export const otelEvidenceCaveatSchema = z.enum([
  'empty',
  'invalid-record',
  'missing-provider-resource-id',
  'missing-trace-id',
  'missing-span-id',
  'sampled',
  'sampling-unknown',
  'partial',
  'stale',
  'future-timestamp',
  'unsupported-signal',
  'unsupported-claim',
  'aggregated-metric',
  'duplicate-record',
  'conflicting-duplicate',
  'duplicate-claim',
  'incomplete-pagination',
  'mixed-classification',
])
export type OtelEvidenceCaveat = z.infer<typeof otelEvidenceCaveatSchema>

export const otelSamplingSchema = z
  .strictObject({
    state: z.enum(['complete', 'sampled', 'unknown']),
    rate: z.number().positive().max(1).optional(),
  })
  .superRefine((sampling, context) => {
    if (sampling.state === 'complete' && sampling.rate !== undefined && sampling.rate !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['rate'],
        message: 'Complete telemetry can only declare a sampling rate of 1.',
      })
    }
    if (sampling.state === 'sampled' && sampling.rate !== undefined && sampling.rate >= 1) {
      context.addIssue({
        code: 'custom',
        path: ['rate'],
        message: 'Sampled telemetry must declare a sampling rate below 1.',
      })
    }
  })
export type OtelSampling = z.infer<typeof otelSamplingSchema>

export const otelAggregationSchema = z
  .strictObject({
    kind: z.enum(['raw', 'delta', 'cumulative', 'pre-aggregated']),
    periodStart: z.iso.datetime().optional(),
    periodEnd: z.iso.datetime().optional(),
  })
  .superRefine((aggregation, context) => {
    if (
      aggregation.kind === 'raw' &&
      (aggregation.periodStart !== undefined || aggregation.periodEnd !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Raw evidence cannot declare an aggregation period.',
      })
    }
    if (
      (aggregation.periodStart === undefined) !== (aggregation.periodEnd === undefined) ||
      (aggregation.periodStart !== undefined &&
        aggregation.periodEnd !== undefined &&
        new Date(aggregation.periodEnd).getTime() <= new Date(aggregation.periodStart).getTime())
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Aggregation periods must have an ordered start and end when supplied.',
      })
    }
  })
export type OtelAggregation = z.infer<typeof otelAggregationSchema>

export const otelEvidenceProvenanceSchema = z.strictObject({
  estateId: boundedIdentifierSchema,
  estateTenantId: boundedIdentifierSchema,
  estateEnvironment: boundedIdentifierSchema,
  sourceConnectorId: boundedIdentifierSchema,
  sourceTenantId: boundedIdentifierSchema,
  sourceEnvironment: boundedIdentifierSchema,
  provider: z.literal('azure-monitor-otel'),
  providerResourceId: boundedIdentifierSchema.optional(),
  providerAgentId: boundedIdentifierSchema,
  traceId: otelTraceIdSchema.optional(),
  spanId: otelSpanIdSchema.optional(),
  observedAt: z.iso.datetime(),
  classification: otelEvidenceClassificationSchema,
  sampling: otelSamplingSchema,
  aggregation: otelAggregationSchema,
})
export type OtelEvidenceProvenance = z.infer<typeof otelEvidenceProvenanceSchema>

export const otelEvidenceClaimSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('invocation'),
    value: z.literal(1),
    unit: z.literal('count'),
  }),
  z.strictObject({
    kind: z.literal('latency'),
    value: z.number().int().min(0).max(300_000),
    unit: z.literal('ms'),
  }),
  z.strictObject({
    kind: z.literal('error'),
    value: z.boolean(),
    errorCode: z.string().trim().min(1).max(100).optional(),
  }),
  z.strictObject({
    kind: z.enum(['input-tokens', 'output-tokens']),
    value: z.number().int().min(0).max(1_000_000),
    unit: z.literal('tokens'),
  }),
  z.strictObject({
    kind: z.literal('cost'),
    value: z.number().min(0).max(10_000),
    unit: z.literal('USD'),
  }),
  z.strictObject({
    kind: z.literal('unsupported'),
    name: z.string().trim().min(1).max(200),
  }),
])
export type OtelEvidenceClaim = z.infer<typeof otelEvidenceClaimSchema>

export const representativeOtelEvidenceSchema = z.strictObject({
  id: boundedIdentifierSchema,
  providerRecordId: boundedIdentifierSchema,
  signal: otelSignalTypeSchema,
  provenance: otelEvidenceProvenanceSchema,
  claim: otelEvidenceClaimSchema,
  partial: z.boolean(),
})
export type RepresentativeOtelEvidence = z.infer<typeof representativeOtelEvidenceSchema>

export const otelWindowQualitySchema = z
  .strictObject({
    status: otelEvidenceStatusSchema,
    classification: z.enum(['live', 'synthetic', 'mixed', 'unknown']).default('unknown'),
    caveats: z
      .array(otelEvidenceCaveatSchema)
      .max(otelEvidenceCaveatSchema.options.length)
      .refine((items) => new Set(items).size === items.length, {
        message: 'OpenTelemetry evidence caveats must be unique.',
      }),
    recordsReceived: z.number().int().min(0).max(10_000),
    recordsAccepted: z.number().int().min(0).max(10_000),
    duplicatesRemoved: z.number().int().min(0).max(10_000),
    pagesProcessed: z.number().int().min(0).max(20),
  })
  .superRefine((quality, context) => {
    if (
      quality.recordsAccepted > quality.recordsReceived ||
      quality.duplicatesRemoved > quality.recordsReceived
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Accepted and duplicate counts cannot exceed records received.',
      })
    }
    if (quality.status === 'available' && quality.caveats.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Available OpenTelemetry evidence cannot carry degradation caveats.',
      })
    }
    if (quality.status === 'available' && !['live', 'synthetic'].includes(quality.classification)) {
      context.addIssue({
        code: 'custom',
        path: ['classification'],
        message: 'Available OpenTelemetry evidence must have one explicit classification.',
      })
    }
    if (quality.status !== 'available' && quality.caveats.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['caveats'],
        message: 'Unknown or degraded OpenTelemetry evidence must explain its caveats.',
      })
    }
    if (quality.status === 'unknown' && quality.recordsAccepted > 0) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Unknown OpenTelemetry evidence cannot contain accepted records.',
      })
    }
  })
export type OtelWindowQuality = z.infer<typeof otelWindowQualitySchema>

export const runtimeOtelProvenanceSchema = otelEvidenceProvenanceSchema
  .required({
    providerResourceId: true,
    traceId: true,
    spanId: true,
  })
  .extend({
    partial: z.boolean(),
    evidenceIds: z.array(boundedIdentifierSchema).min(1).max(6),
  })
export type RuntimeOtelProvenance = z.infer<typeof runtimeOtelProvenanceSchema>

export const runtimeOtelEvidenceItemSchema = z.strictObject({
  id: boundedIdentifierSchema,
  observedAt: z.iso.datetime(),
  latencyMs: z.number().int().min(0).max(300_000),
  inputTokens: z.number().int().min(0).max(1_000_000),
  outputTokens: z.number().int().min(0).max(1_000_000),
  costUsd: z.number().min(0).max(10_000),
  success: z.boolean(),
  errorCode: z.string().trim().min(1).max(100).optional(),
  provenance: runtimeOtelProvenanceSchema,
})
export type RuntimeOtelEvidenceItem = z.infer<typeof runtimeOtelEvidenceItemSchema>

export const otelEvidenceDetailsSchema = z.strictObject({
  quality: otelWindowQualitySchema,
  invocations: z.array(runtimeOtelEvidenceItemSchema).max(500),
})
export type OtelEvidenceDetails = z.infer<typeof otelEvidenceDetailsSchema>
