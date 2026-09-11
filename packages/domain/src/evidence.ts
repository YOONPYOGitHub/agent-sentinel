import { z } from 'zod'

import { evidenceAuthoritySchema } from './evidence-authority.js'
import { otelEvidenceDetailsSchema } from './otel-evidence.js'

export const evidenceTypeSchema = z.enum([
  'declared_configuration',
  'observed_runtime',
  'synthetic_validation',
  'unknown',
])
export type EvidenceType = z.infer<typeof evidenceTypeSchema>

export const evidenceSourceStatusSchema = z
  .strictObject({
    status: z.enum(['live', 'stale', 'unknown']),
    sourceId: z.string().min(1).max(200),
    readiness: z.enum(['ready', 'degraded', 'unavailable', 'disabled', 'authorization-required']),
    dataState: z
      .enum(['complete', 'partial', 'stale', 'unsupported', 'empty', 'failed', 'cancelled'])
      .optional(),
    checkedAt: z.iso.datetime().optional(),
    reason: z.string().min(1).max(200).optional(),
  })
  .superRefine((status, context) => {
    if (
      status.status === 'live' &&
      (status.readiness !== 'ready' || status.dataState !== 'complete')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Live evidence source status requires ready and complete source health.',
      })
    }
    if (
      status.status !== 'live' &&
      status.readiness === 'ready' &&
      status.dataState === 'complete'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Ready and complete source health must be represented as live.',
      })
    }
  })
export type EvidenceSourceStatus = z.infer<typeof evidenceSourceStatusSchema>

export const evidenceSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    sourceObjectId: z.string().min(1),
    observedAt: z.iso.datetime(),
    freshness: z.enum(['live', 'recent', 'stale']),
    confidence: z.number().min(0).max(1),
    evidenceTypes: z
      .array(evidenceTypeSchema)
      .min(1)
      .max(evidenceTypeSchema.options.length)
      .default(['unknown'])
      .refine((types) => new Set(types).size === types.length, {
        message: 'Evidence types must be unique.',
      }),
    uri: z.url().optional(),
    summary: z.string().min(1),
    metadata: z.record(z.string(), z.string()).optional(),
    sourceStatus: evidenceSourceStatusSchema.optional(),
    authority: evidenceAuthoritySchema.optional(),
    otel: otelEvidenceDetailsSchema.optional(),
  })
  .superRefine((evidence, context) => {
    if (evidence.authority === undefined) return
    const sourceLocalId = evidence.authority.sourceId.slice(
      evidence.authority.sourceId.indexOf(':') + 1,
    )
    const expectedSourceObjectId = `${sourceLocalId}:${evidence.authority.providerObjectId}`
    const matchesAuthority =
      evidence.authority.provider === 'microsoft-entra'
        ? evidence.sourceObjectId.toLowerCase() === expectedSourceObjectId.toLowerCase()
        : evidence.sourceObjectId === expectedSourceObjectId
    if (!matchesAuthority) {
      context.addIssue({
        code: 'custom',
        path: ['sourceObjectId'],
        message: 'Authoritative evidence sourceObjectId must exactly match its scoped source.',
      })
    }
    if (evidence.observedAt !== evidence.authority.snapshotGeneratedAt) {
      context.addIssue({
        code: 'custom',
        path: ['observedAt'],
        message: 'Authoritative evidence observation must match its source snapshot generation.',
      })
    }
  })

export type Evidence = z.infer<typeof evidenceSchema>
