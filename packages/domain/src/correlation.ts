import { z } from 'zod'

export const agentCorrelationKindSchema = z.enum([
  'agent-run-id',
  'correlation-id',
  'agent-version',
])
export type AgentCorrelationKind = z.infer<typeof agentCorrelationKindSchema>

export const agentCorrelationSchema = z.strictObject({
  kind: agentCorrelationKindSchema,
  value: z.string().trim().min(1).max(200),
})
export type AgentCorrelation = z.infer<typeof agentCorrelationSchema>

const correlationKindOrder = new Map(
  agentCorrelationKindSchema.options.map((kind, index) => [kind, index] as const),
)

export const agentCorrelationsSchema = z
  .array(agentCorrelationSchema)
  .max(agentCorrelationKindSchema.options.length)
  .refine(
    (correlations) =>
      new Set(correlations.map((correlation) => correlation.kind)).size === correlations.length,
    'Agent correlation kinds must be unique.',
  )
  .transform((correlations) =>
    [...correlations].sort(
      (left, right) =>
        (correlationKindOrder.get(left.kind) ?? 0) - (correlationKindOrder.get(right.kind) ?? 0),
    ),
  )
