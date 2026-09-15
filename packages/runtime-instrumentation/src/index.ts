import { randomUUID } from 'node:crypto'

import {
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type SpanContext,
  type Tracer,
} from '@opentelemetry/api'

import {
  AGENT_INVOCATION_ATTRIBUTE_KEYS,
  AGENT_INVOCATION_CONTRACT_VERSION,
  AGENT_INVOCATION_RECORD_TYPE,
  AGENT_INVOCATION_RESOURCE_ATTRIBUTE_KEYS,
  AGENT_INVOCATION_SPAN_NAME,
  agentInvocationConfigurationSchema,
  agentInvocationInputSchema,
  agentInvocationResultSchema,
  agentInvocationTelemetrySchema,
  type AgentInvocationConfigurationInput,
  type AgentInvocationInputValue,
  type AgentInvocationResult,
  type AgentInvocationTelemetry,
} from './contract.js'

export * from './adapters.js'
export * from './contract.js'

export interface AgentInvocationCallbackResult<T> {
  readonly value: T
  readonly telemetry?: AgentInvocationTelemetry
}

export interface AgentInvocationContext {
  readonly providerInvocationId: string
  readonly spanContext: SpanContext
  readonly signal?: AbortSignal
  recordTelemetry(telemetry: AgentInvocationTelemetry): void
}

export interface InstrumentedAgentInvocation<T> extends AgentInvocationResult {
  readonly value: T
}

export interface InstrumentAgentInvocationOptions {
  readonly signal?: AbortSignal
}

export function agentInvocationResourceAttributes(
  configuration: AgentInvocationConfigurationInput,
): Attributes {
  const parsed = agentInvocationConfigurationSchema.parse(configuration)
  return {
    [AGENT_INVOCATION_RESOURCE_ATTRIBUTE_KEYS.serviceName]: parsed.applicationRoleName,
  }
}

function baseAttributes(
  configuration: ReturnType<typeof agentInvocationConfigurationSchema.parse>,
  input: ReturnType<typeof agentInvocationInputSchema.parse>,
  providerInvocationId: string,
): Attributes {
  return {
    [AGENT_INVOCATION_ATTRIBUTE_KEYS.tenantId]: configuration.sourceTenantId,
    [AGENT_INVOCATION_ATTRIBUTE_KEYS.agentId]: configuration.providerAgentId,
    [AGENT_INVOCATION_ATTRIBUTE_KEYS.environment]: configuration.sourceEnvironment,
    [AGENT_INVOCATION_ATTRIBUTE_KEYS.sourceProjectId]: configuration.sourceProjectId,
    [AGENT_INVOCATION_ATTRIBUTE_KEYS.contractVersion]: AGENT_INVOCATION_CONTRACT_VERSION,
    [AGENT_INVOCATION_ATTRIBUTE_KEYS.recordType]: AGENT_INVOCATION_RECORD_TYPE,
    [AGENT_INVOCATION_ATTRIBUTE_KEYS.sourceConnectorId]: configuration.sourceConnectorId,
    [AGENT_INVOCATION_ATTRIBUTE_KEYS.estateId]: configuration.estateId,
    [AGENT_INVOCATION_ATTRIBUTE_KEYS.estateTenantId]: configuration.estateTenantId,
    [AGENT_INVOCATION_ATTRIBUTE_KEYS.estateEnvironment]: configuration.estateEnvironment,
    [AGENT_INVOCATION_ATTRIBUTE_KEYS.sourceTenantId]: configuration.sourceTenantId,
    [AGENT_INVOCATION_ATTRIBUTE_KEYS.sourceEnvironment]: configuration.sourceEnvironment,
    [AGENT_INVOCATION_ATTRIBUTE_KEYS.providerAgentId]: configuration.providerAgentId,
    [AGENT_INVOCATION_ATTRIBUTE_KEYS.providerResourceId]: configuration.providerResourceId,
    [AGENT_INVOCATION_ATTRIBUTE_KEYS.providerInvocationId]: providerInvocationId,
    [AGENT_INVOCATION_ATTRIBUTE_KEYS.synthetic]: configuration.synthetic,
    ...(input.agentRunId === undefined
      ? {}
      : { [AGENT_INVOCATION_ATTRIBUTE_KEYS.agentRunId]: input.agentRunId }),
    ...(input.runId === undefined ? {} : { [AGENT_INVOCATION_ATTRIBUTE_KEYS.runId]: input.runId }),
    ...(input.correlationId === undefined
      ? {}
      : { [AGENT_INVOCATION_ATTRIBUTE_KEYS.correlationId]: input.correlationId }),
    ...(input.agentVersion === undefined
      ? {}
      : { [AGENT_INVOCATION_ATTRIBUTE_KEYS.agentVersion]: input.agentVersion }),
  }
}

function applyTelemetry(
  setAttribute: (name: string, value: string | number) => void,
  telemetry: AgentInvocationTelemetry | undefined,
): void {
  if (telemetry?.usage?.inputTokens !== undefined) {
    setAttribute(AGENT_INVOCATION_ATTRIBUTE_KEYS.inputTokens, telemetry.usage.inputTokens)
  }
  if (telemetry?.usage?.outputTokens !== undefined) {
    setAttribute(AGENT_INVOCATION_ATTRIBUTE_KEYS.outputTokens, telemetry.usage.outputTokens)
  }
  if (telemetry?.cost !== undefined) {
    setAttribute(AGENT_INVOCATION_ATTRIBUTE_KEYS.costUsd, telemetry.cost.amount)
  }
  if (telemetry?.toolCallNames !== undefined) {
    setAttribute(
      AGENT_INVOCATION_ATTRIBUTE_KEYS.toolCallNames,
      JSON.stringify(telemetry.toolCallNames),
    )
  }
}

function safeErrorType(error: unknown, cancelled: boolean): string {
  if (cancelled) return 'cancelled'
  const name = error instanceof Error ? error.name : ''
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(name) ? name : 'Error'
}

export async function instrumentAgentInvocation<T>(
  tracer: Tracer,
  configurationValue: AgentInvocationConfigurationInput,
  inputValue: AgentInvocationInputValue,
  callback: (context: AgentInvocationContext) => Promise<AgentInvocationCallbackResult<T>>,
  options: InstrumentAgentInvocationOptions = {},
): Promise<InstrumentedAgentInvocation<T>> {
  const configuration = agentInvocationConfigurationSchema.parse(configurationValue)
  const input = agentInvocationInputSchema.parse(inputValue)
  const providerInvocationId = input.providerInvocationId ?? randomUUID()
  const kind = input.spanKind === 'consumer' ? SpanKind.CONSUMER : SpanKind.SERVER

  return tracer.startActiveSpan(
    AGENT_INVOCATION_SPAN_NAME,
    { kind, attributes: baseAttributes(configuration, input, providerInvocationId) },
    async (span) => {
      const spanContext = span.spanContext()
      let recordedTelemetry: AgentInvocationTelemetry | undefined
      const context: AgentInvocationContext = {
        providerInvocationId,
        spanContext,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        recordTelemetry(telemetry): void {
          recordedTelemetry = agentInvocationTelemetrySchema.parse(telemetry)
        },
      }

      try {
        if (options.signal?.aborted === true) {
          const cancelled = new Error('Agent invocation was cancelled.')
          cancelled.name = 'AbortError'
          throw cancelled
        }
        const result = await callback(context)
        const telemetry =
          result.telemetry === undefined
            ? recordedTelemetry
            : agentInvocationTelemetrySchema.parse(result.telemetry)
        applyTelemetry((name, value) => span.setAttribute(name, value), telemetry)
        span.setAttribute(AGENT_INVOCATION_ATTRIBUTE_KEYS.outcome, 'success')
        span.setStatus({ code: SpanStatusCode.OK })
        return {
          value: result.value,
          ...agentInvocationResultSchema.parse({
            providerInvocationId,
            traceId: spanContext.traceId,
            spanId: spanContext.spanId,
            sampled: (spanContext.traceFlags & 1) === 1,
          }),
        }
      } catch (error: unknown) {
        applyTelemetry((name, value) => span.setAttribute(name, value), recordedTelemetry)
        span.setAttribute(AGENT_INVOCATION_ATTRIBUTE_KEYS.outcome, 'error')
        span.setAttribute(
          AGENT_INVOCATION_ATTRIBUTE_KEYS.errorType,
          safeErrorType(
            error,
            options.signal?.aborted === true || (error as Error)?.name === 'AbortError',
          ),
        )
        span.setStatus({ code: SpanStatusCode.ERROR })
        throw error
      } finally {
        span.end()
      }
    },
  )
}
