import { z } from 'zod'

export const AGENT_INVOCATION_CONTRACT_VERSION = 1 as const
export const AGENT_INVOCATION_RECORD_TYPE = 'agent_invocation' as const
export const AGENT_INVOCATION_SPAN_NAME = 'agent.invoke' as const
export const AGENT_INVOCATION_INSTRUMENTATION_NAME =
  '@agent-sentinel/runtime-instrumentation' as const
export const AGENT_INVOCATION_INSTRUMENTATION_VERSION = '0.1.0' as const

export const AGENT_INVOCATION_RESOURCE_ATTRIBUTE_KEYS = {
  serviceName: 'service.name',
} as const

export const AGENT_INVOCATION_ATTRIBUTE_KEYS = {
  tenantId: 'agent.sentinel.tenant_id',
  agentId: 'gen_ai.agent.id',
  environment: 'deployment.environment.name',
  sourceProjectId: 'agent.sentinel.source_project_id',
  contractVersion: 'agent.sentinel.contract_version',
  recordType: 'agent.sentinel.record_type',
  sourceConnectorId: 'agent.sentinel.source_connector_id',
  estateId: 'agent.sentinel.estate_id',
  estateTenantId: 'agent.sentinel.estate_tenant_id',
  estateEnvironment: 'agent.sentinel.estate_environment',
  sourceTenantId: 'agent.sentinel.source_tenant_id',
  sourceEnvironment: 'agent.sentinel.source_environment',
  providerAgentId: 'agent.sentinel.provider_agent_id',
  providerResourceId: 'agent.sentinel.provider_resource_id',
  providerInvocationId: 'agent.sentinel.provider_invocation_id',
  outcome: 'agent.sentinel.outcome',
  synthetic: 'agent.sentinel.synthetic',
  agentRunId: 'gen_ai.agent.run.id',
  runId: 'agent.sentinel.run_id',
  correlationId: 'agent.sentinel.correlation_id',
  agentVersion: 'gen_ai.agent.version',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  costUsd: 'agent.sentinel.cost.usd',
  toolCallNames: 'agent.sentinel.tool_call_names',
  errorType: 'error.type',
} as const

export const MAX_AGENT_INVOCATION_IDENTIFIER_LENGTH = 200
export const MAX_AGENT_INVOCATION_TOOL_NAMES = 50
export const MAX_AGENT_INVOCATION_TOKENS = 1_000_000
export const MAX_AGENT_INVOCATION_COST_USD = 10_000

const safeBindingPattern = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,199}$/
const safeToolNamePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/

export const agentInvocationIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_AGENT_INVOCATION_IDENTIFIER_LENGTH)
  .regex(safeBindingPattern)

export const agentInvocationToolNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_AGENT_INVOCATION_IDENTIFIER_LENGTH)
  .regex(safeToolNamePattern)

const applicationInsightsResourceIdInputSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => value === value.trim(), {
    message: 'Application Insights resource IDs cannot contain surrounding whitespace.',
  })
  .regex(
    /^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resourceGroups\/[A-Za-z0-9_.()-]{1,90}\/providers\/Microsoft\.Insights\/components\/[^%&\\?/#\p{Cc}]+$/iu,
    'Expected an exact Application Insights ARM resource ID.',
  )
  .refine((value) => {
    const segments = value.split('/')
    const resourceGroup = segments[4]
    const component = segments[8]
    return (
      resourceGroup !== undefined &&
      !resourceGroup.endsWith('.') &&
      component !== undefined &&
      component.length <= 260 &&
      !component.endsWith(' ') &&
      !component.endsWith('.')
    )
  }, 'Invalid Application Insights resource ID segment.')

export const applicationInsightsResourceIdSchema =
  applicationInsightsResourceIdInputSchema.transform((value) => value.toLowerCase())

const canonicalApplicationInsightsResourceIdSchema =
  applicationInsightsResourceIdInputSchema.refine((value) => value === value.toLowerCase(), {
    message: 'Emitted Application Insights resource IDs must be lower case.',
  })

export const agentInvocationConfigurationSchema = z.strictObject({
  applicationRoleName: z.string().trim().min(1).max(MAX_AGENT_INVOCATION_IDENTIFIER_LENGTH),
  providerResourceId: applicationInsightsResourceIdSchema,
  estateId: agentInvocationIdentifierSchema,
  estateTenantId: agentInvocationIdentifierSchema,
  estateEnvironment: agentInvocationIdentifierSchema,
  sourceConnectorId: agentInvocationIdentifierSchema,
  sourceTenantId: agentInvocationIdentifierSchema,
  sourceProjectId: agentInvocationIdentifierSchema,
  sourceEnvironment: agentInvocationIdentifierSchema,
  providerAgentId: agentInvocationIdentifierSchema,
  synthetic: z.literal(false).default(false),
})
export type AgentInvocationConfiguration = z.infer<typeof agentInvocationConfigurationSchema>
export type AgentInvocationConfigurationInput = z.input<typeof agentInvocationConfigurationSchema>

export const agentInvocationInputSchema = z.strictObject({
  providerInvocationId: agentInvocationIdentifierSchema.optional(),
  agentRunId: agentInvocationIdentifierSchema.optional(),
  runId: agentInvocationIdentifierSchema.optional(),
  correlationId: agentInvocationIdentifierSchema.optional(),
  agentVersion: agentInvocationIdentifierSchema.optional(),
  spanKind: z.enum(['server', 'consumer']).default('server'),
})
export type AgentInvocationInput = z.infer<typeof agentInvocationInputSchema>
export type AgentInvocationInputValue = z.input<typeof agentInvocationInputSchema>

export const measuredTokenUsageSchema = z
  .strictObject({
    authority: z.literal('provider'),
    inputTokens: z.number().int().min(0).max(MAX_AGENT_INVOCATION_TOKENS).optional(),
    outputTokens: z.number().int().min(0).max(MAX_AGENT_INVOCATION_TOKENS).optional(),
  })
  .refine((usage) => usage.inputTokens !== undefined || usage.outputTokens !== undefined, {
    message: 'Measured token usage must include at least one provider-reported value.',
  })
export type MeasuredTokenUsage = z.infer<typeof measuredTokenUsageSchema>

export const measuredUsdCostSchema = z.strictObject({
  authority: z.enum(['provider', 'billing']),
  currency: z.literal('USD'),
  amount: z.number().finite().min(0).max(MAX_AGENT_INVOCATION_COST_USD),
})
export type MeasuredUsdCost = z.infer<typeof measuredUsdCostSchema>

export const agentInvocationTelemetrySchema = z.strictObject({
  usage: measuredTokenUsageSchema.optional(),
  cost: measuredUsdCostSchema.optional(),
  toolCallNames: z
    .array(agentInvocationToolNameSchema)
    .max(MAX_AGENT_INVOCATION_TOOL_NAMES)
    .optional(),
})
export type AgentInvocationTelemetry = z.infer<typeof agentInvocationTelemetrySchema>

export const agentInvocationResultSchema = z.strictObject({
  providerInvocationId: agentInvocationIdentifierSchema,
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  spanId: z.string().regex(/^[0-9a-f]{16}$/),
  sampled: z.boolean(),
})
export type AgentInvocationResult = z.infer<typeof agentInvocationResultSchema>

const agentInvocationAttributeShape = {
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.tenantId]: agentInvocationIdentifierSchema,
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.agentId]: agentInvocationIdentifierSchema,
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.environment]: agentInvocationIdentifierSchema,
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.sourceProjectId]: agentInvocationIdentifierSchema,
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.contractVersion]: z.literal(AGENT_INVOCATION_CONTRACT_VERSION),
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.recordType]: z.literal(AGENT_INVOCATION_RECORD_TYPE),
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.sourceConnectorId]: agentInvocationIdentifierSchema,
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.estateId]: agentInvocationIdentifierSchema,
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.estateTenantId]: agentInvocationIdentifierSchema,
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.estateEnvironment]: agentInvocationIdentifierSchema,
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.sourceTenantId]: agentInvocationIdentifierSchema,
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.sourceEnvironment]: agentInvocationIdentifierSchema,
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.providerAgentId]: agentInvocationIdentifierSchema,
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.providerResourceId]:
    canonicalApplicationInsightsResourceIdSchema,
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.providerInvocationId]: agentInvocationIdentifierSchema,
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.outcome]: z.enum(['success', 'error']),
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.synthetic]: z.literal(false),
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.agentRunId]: agentInvocationIdentifierSchema.optional(),
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.runId]: agentInvocationIdentifierSchema.optional(),
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.correlationId]: agentInvocationIdentifierSchema.optional(),
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.agentVersion]: agentInvocationIdentifierSchema.optional(),
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.inputTokens]: z
    .number()
    .int()
    .min(0)
    .max(MAX_AGENT_INVOCATION_TOKENS)
    .optional(),
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.outputTokens]: z
    .number()
    .int()
    .min(0)
    .max(MAX_AGENT_INVOCATION_TOKENS)
    .optional(),
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.costUsd]: z
    .number()
    .min(0)
    .max(MAX_AGENT_INVOCATION_COST_USD)
    .optional(),
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.toolCallNames]: z.string().max(20_000).optional(),
  [AGENT_INVOCATION_ATTRIBUTE_KEYS.errorType]: z.string().min(1).max(100).optional(),
} as const

export const agentInvocationSpanAttributesSchema = z
  .strictObject(agentInvocationAttributeShape)
  .superRefine((attributes, context) => {
    const toolNames = attributes[AGENT_INVOCATION_ATTRIBUTE_KEYS.toolCallNames]
    if (toolNames === undefined) return
    try {
      z.array(agentInvocationToolNameSchema)
        .max(MAX_AGENT_INVOCATION_TOOL_NAMES)
        .parse(JSON.parse(toolNames))
    } catch {
      context.addIssue({
        code: 'custom',
        path: [AGENT_INVOCATION_ATTRIBUTE_KEYS.toolCallNames],
        message: 'Tool call names must be a bounded JSON string array.',
      })
    }
  })

export const agentInvocationContractFixtureSchema = z.strictObject({
  contractVersion: z.literal(AGENT_INVOCATION_CONTRACT_VERSION),
  recordType: z.literal(AGENT_INVOCATION_RECORD_TYPE),
  resourceAttributes: z.strictObject({
    [AGENT_INVOCATION_RESOURCE_ATTRIBUTE_KEYS.serviceName]: z
      .string()
      .trim()
      .min(1)
      .max(MAX_AGENT_INVOCATION_IDENTIFIER_LENGTH),
  }),
  span: z.strictObject({
    name: z.literal(AGENT_INVOCATION_SPAN_NAME),
    kind: z.enum(['SERVER', 'CONSUMER']),
    traceId: z.string().regex(/^[0-9a-f]{32}$/),
    spanId: z.string().regex(/^[0-9a-f]{16}$/),
    attributes: agentInvocationSpanAttributesSchema,
  }),
})
export type AgentInvocationContractFixture = z.infer<typeof agentInvocationContractFixtureSchema>

export const agentInvocationContractJsonSchema = {
  ...z.toJSONSchema(agentInvocationContractFixtureSchema, {
    target: 'draft-2020-12',
    reused: 'ref',
  }),
  $id: 'https://agent-sentinel.dev/contracts/agent-invocation-v1.schema.json',
  title: 'Agent Sentinel external runtime invocation span contract v1',
} as const
