import {
  agentInvocationTelemetrySchema,
  type AgentInvocationTelemetry,
  type MeasuredUsdCost,
} from './contract.js'

type ToolCallView = {
  readonly type?: unknown
  readonly name?: unknown
}

function toolNames(items: readonly ToolCallView[] | undefined): string[] | undefined {
  if (items === undefined) return undefined
  const names = items.flatMap((item) =>
    item.type === 'function_call' && typeof item.name === 'string' ? [item.name] : [],
  )
  return names.length === 0 ? undefined : names
}

export interface OpenAIResponsesTelemetryView {
  readonly usage?: {
    readonly input_tokens?: number
    readonly output_tokens?: number
  }
  readonly output?: readonly ToolCallView[]
}

export function telemetryFromOpenAIResponses(
  response: OpenAIResponsesTelemetryView,
  cost?: MeasuredUsdCost,
): AgentInvocationTelemetry {
  const usage =
    response.usage?.input_tokens === undefined && response.usage?.output_tokens === undefined
      ? undefined
      : {
          authority: 'provider' as const,
          ...(response.usage.input_tokens === undefined
            ? {}
            : { inputTokens: response.usage.input_tokens }),
          ...(response.usage.output_tokens === undefined
            ? {}
            : { outputTokens: response.usage.output_tokens }),
        }
  return agentInvocationTelemetrySchema.parse({
    ...(usage === undefined ? {} : { usage }),
    ...(cost === undefined ? {} : { cost }),
    ...(toolNames(response.output) === undefined
      ? {}
      : { toolCallNames: toolNames(response.output) }),
  })
}

export interface OpenAIAgentsTelemetrySeam {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly toolCallNames?: readonly string[]
}

export function telemetryFromOpenAIAgents(
  seam: OpenAIAgentsTelemetrySeam,
  cost?: MeasuredUsdCost,
): AgentInvocationTelemetry {
  return agentInvocationTelemetrySchema.parse({
    ...(seam.inputTokens === undefined && seam.outputTokens === undefined
      ? {}
      : {
          usage: {
            authority: 'provider',
            ...(seam.inputTokens === undefined ? {} : { inputTokens: seam.inputTokens }),
            ...(seam.outputTokens === undefined ? {} : { outputTokens: seam.outputTokens }),
          },
        }),
    ...(cost === undefined ? {} : { cost }),
    ...(seam.toolCallNames === undefined ? {} : { toolCallNames: seam.toolCallNames }),
  })
}

export interface AzureAIAgentsTelemetrySeam {
  readonly usage?: {
    readonly promptTokens?: number
    readonly completionTokens?: number
  }
  readonly toolCallNames?: readonly string[]
}

export function telemetryFromAzureAIAgents(
  seam: AzureAIAgentsTelemetrySeam,
  cost?: MeasuredUsdCost,
): AgentInvocationTelemetry {
  return agentInvocationTelemetrySchema.parse({
    ...(seam.usage?.promptTokens === undefined && seam.usage?.completionTokens === undefined
      ? {}
      : {
          usage: {
            authority: 'provider',
            ...(seam.usage.promptTokens === undefined
              ? {}
              : { inputTokens: seam.usage.promptTokens }),
            ...(seam.usage.completionTokens === undefined
              ? {}
              : { outputTokens: seam.usage.completionTokens }),
          },
        }),
    ...(cost === undefined ? {} : { cost }),
    ...(seam.toolCallNames === undefined ? {} : { toolCallNames: seam.toolCallNames }),
  })
}
