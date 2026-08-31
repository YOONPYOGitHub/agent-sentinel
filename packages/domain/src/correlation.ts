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
