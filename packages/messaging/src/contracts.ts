import { z } from 'zod'

export const findingDetectedEventSchema = z.object({
  type: z.literal('finding.detected'),
  correlationId: z.string().uuid(),
  estateId: z.string().min(1),
  tenantId: z.string().min(1),
  environment: z.string().min(1),
  findingId: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  timestamp: z.iso.datetime(),
})
export type FindingDetectedEvent = z.infer<typeof findingDetectedEventSchema>

export const validationRequestedEventSchema = z.object({
  type: z.literal('validation.requested'),
  correlationId: z.string().uuid(),
  estateId: z.string().min(1),
  tenantId: z.string().min(1),
  environment: z.string().min(1),
  findingId: z.string().min(1),
  runId: z.string().min(1),
  timestamp: z.iso.datetime(),
})
export type ValidationRequestedEvent = z.infer<typeof validationRequestedEventSchema>

export const snapshotIngestedEventSchema = z.object({
  type: z.literal('snapshot.ingested'),
  correlationId: z.string().uuid(),
  estateId: z.string().min(1),
  tenantId: z.string().min(1),
  environment: z.string().min(1),
  snapshotId: z.string().min(1),
  timestamp: z.iso.datetime(),
})
export type SnapshotIngestedEvent = z.infer<typeof snapshotIngestedEventSchema>

export type DomainEvent = FindingDetectedEvent | ValidationRequestedEvent | SnapshotIngestedEvent

export const domainEventSchema = z.discriminatedUnion('type', [
  findingDetectedEventSchema,
  validationRequestedEventSchema,
  snapshotIngestedEventSchema,
])
