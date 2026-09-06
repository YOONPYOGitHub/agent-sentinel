import { z } from 'zod'

import { otelEvidenceDetailsSchema } from './otel-evidence.js'

export const evidenceTypeSchema = z.enum([
  'declared_configuration',
  'observed_runtime',
  'synthetic_validation',
  'unknown',
])
export type EvidenceType = z.infer<typeof evidenceTypeSchema>

export const evidenceSchema = z.object({
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
  otel: otelEvidenceDetailsSchema.optional(),
})

export type Evidence = z.infer<typeof evidenceSchema>
