import { readFile } from 'node:fs/promises'

import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AGENT_INVOCATION_ATTRIBUTE_KEYS,
  AGENT_INVOCATION_CONTRACT_VERSION,
  AGENT_INVOCATION_RECORD_TYPE,
  AGENT_INVOCATION_SPAN_NAME,
  agentInvocationConfigurationSchema,
  agentInvocationContractFixtureSchema,
  agentInvocationContractJsonSchema,
  agentInvocationInputSchema,
  agentInvocationResourceAttributes,
  agentInvocationResultSchema,
  agentInvocationTelemetrySchema,
  applicationInsightsResourceIdSchema,
  instrumentAgentInvocation,
  telemetryFromAzureAIAgents,
  telemetryFromOpenAIAgents,
  telemetryFromOpenAIResponses,
} from '../src/index.js'

const providerResourceId =
  '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg-test/providers/Microsoft.Insights/components/app-test'

const configuration = {
  applicationRoleName: 'agent-runtime',
  providerResourceId,
  estateId: 'estate-a',
  estateTenantId: 'tenant-a',
  estateEnvironment: 'portfolio',
  sourceConnectorId: 'direct',
  sourceTenantId: 'tenant-a',
  sourceProjectId: 'project-a',
  sourceEnvironment: 'production',
  providerAgentId: 'agent-a',
  synthetic: false,
} as const

const providers: BasicTracerProvider[] = []

function testTracing() {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    sampler: new AlwaysOnSampler(),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  providers.push(provider)
  return {
    exporter,
    provider,
    tracer: provider.getTracer('@agent-sentinel/runtime-instrumentation-test'),
  }
}

async function spans(exporter: InMemorySpanExporter, provider: BasicTracerProvider) {
  await provider.forceFlush()
  return exporter.getFinishedSpans()
}

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.shutdown()))
})

describe('instrumentAgentInvocation', () => {
  it('emits one exact connector-compatible SERVER span with native context IDs', async () => {
    const { exporter, provider, tracer } = testTracing()
    const result = await instrumentAgentInvocation(
      tracer,
      configuration,
      {
        providerInvocationId: 'fixture-baseline-1',
        agentRunId: 'run-baseline-1',
        correlationId: 'correlation-baseline-1',
        agentVersion: '17',
      },
      () =>
        Promise.resolve({
          value: 'ok',
          telemetry: {
            usage: { authority: 'provider', inputTokens: 320, outputTokens: 110 },
            cost: { authority: 'provider', currency: 'USD', amount: 0.012 },
            toolCallNames: ['knowledge_search', 'answer'],
          },
        }),
    )
    const finished = await spans(exporter, provider)

    expect(finished).toHaveLength(1)
    const span = finished[0]!
    expect(span.name).toBe(AGENT_INVOCATION_SPAN_NAME)
    expect(span.kind).toBe(SpanKind.SERVER)
    expect(span.status.code).toBe(SpanStatusCode.OK)
    expect(result.traceId).toBe(span.spanContext().traceId)
    expect(result.spanId).toBe(span.spanContext().spanId)
    expect(result.sampled).toBe(true)

    const fixture = agentInvocationContractFixtureSchema.parse(
      JSON.parse(
        await readFile(
          new URL('../contract/agent-invocation-v1.fixture.json', import.meta.url),
          'utf8',
        ),
      ),
    )
    expect(span.attributes).toEqual(fixture.span.attributes)
    expect(agentInvocationResourceAttributes(configuration)).toEqual(fixture.resourceAttributes)
  })

  it('keeps a streaming invocation open until terminal completion', async () => {
    const { exporter, provider, tracer } = testTracing()
    let finish!: () => void
    const terminal = new Promise<void>((resolve) => {
      finish = resolve
    })
    const pending = instrumentAgentInvocation(tracer, configuration, {}, async () => {
      await terminal
      return { value: 'done' }
    })

    expect(exporter.getFinishedSpans()).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 15))
    finish()
    await pending
    const [span] = await spans(exporter, provider)
    expect(span).toBeDefined()
    expect(durationMilliseconds(span!)).toBeGreaterThanOrEqual(10)
  })

  it('sets a sanitized error outcome without recording error content', async () => {
    const { exporter, provider, tracer } = testTracing()
    const sensitive = new Error('secret prompt and user@example.com')
    sensitive.name = 'ProviderFailure'

    await expect(
      instrumentAgentInvocation(tracer, configuration, {}, (context) => {
        context.recordTelemetry({
          usage: { authority: 'provider', inputTokens: 12 },
          toolCallNames: ['lookup'],
        })
        return Promise.reject(sensitive)
      }),
    ).rejects.toBe(sensitive)

    const [span] = await spans(exporter, provider)
    expect(span?.attributes[AGENT_INVOCATION_ATTRIBUTE_KEYS.outcome]).toBe('error')
    expect(span?.attributes[AGENT_INVOCATION_ATTRIBUTE_KEYS.errorType]).toBe('ProviderFailure')
    expect(span?.attributes[AGENT_INVOCATION_ATTRIBUTE_KEYS.inputTokens]).toBe(12)
    expect(JSON.stringify(span?.attributes)).not.toContain('secret prompt')
    expect(JSON.stringify(span?.attributes)).not.toContain('user@example.com')
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR })
  })

  it('exports a cancelled invocation as an error and does not invoke the callback', async () => {
    const { exporter, provider, tracer } = testTracing()
    const controller = new AbortController()
    controller.abort()
    let called = false

    await expect(
      instrumentAgentInvocation(
        tracer,
        configuration,
        {},
        () => {
          called = true
          return Promise.resolve({ value: undefined })
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })

    const [span] = await spans(exporter, provider)
    expect(called).toBe(false)
    expect(span?.attributes[AGENT_INVOCATION_ATTRIBUTE_KEYS.outcome]).toBe('error')
    expect(span?.attributes[AGENT_INVOCATION_ATTRIBUTE_KEYS.errorType]).toBe('cancelled')
  })

  it('leaves unreported usage and cost absent rather than zero or estimated', async () => {
    const { exporter, provider, tracer } = testTracing()
    await instrumentAgentInvocation(tracer, configuration, {}, () =>
      Promise.resolve({ value: undefined }),
    )
    const [span] = await spans(exporter, provider)

    expect(span?.attributes).not.toHaveProperty(AGENT_INVOCATION_ATTRIBUTE_KEYS.inputTokens)
    expect(span?.attributes).not.toHaveProperty(AGENT_INVOCATION_ATTRIBUTE_KEYS.outputTokens)
    expect(span?.attributes).not.toHaveProperty(AGENT_INVOCATION_ATTRIBUTE_KEYS.costUsd)
    expect(
      agentInvocationTelemetrySchema.safeParse({
        cost: { authority: 'estimated', currency: 'USD', amount: 1 },
      }).success,
    ).toBe(false)
    expect(
      agentInvocationTelemetrySchema.safeParse({
        cost: { currency: 'USD', amount: 1 },
      }).success,
    ).toBe(false)
  })

  it('generates bounded unique provider invocation IDs', async () => {
    const { provider, tracer } = testTracing()
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        instrumentAgentInvocation(tracer, configuration, {}, () =>
          Promise.resolve({ value: undefined }),
        ),
      ),
    )
    await provider.forceFlush()
    expect(new Set(results.map((result) => result.providerInvocationId)).size).toBe(20)
    for (const result of results) {
      expect(result.providerInvocationId.length).toBeLessThanOrEqual(200)
    }
  })

  it('exports every invocation under an always-on sampler', async () => {
    const { exporter, provider, tracer } = testTracing()
    await Promise.all(
      Array.from({ length: 25 }, () =>
        instrumentAgentInvocation(tracer, configuration, {}, () =>
          Promise.resolve({ value: undefined }),
        ),
      ),
    )
    expect(await spans(exporter, provider)).toHaveLength(25)
  })

  it('supports CONSUMER spans only when explicitly selected', async () => {
    const { exporter, provider, tracer } = testTracing()
    await instrumentAgentInvocation(tracer, configuration, { spanKind: 'consumer' }, () =>
      Promise.resolve({
        value: undefined,
      }),
    )
    const [span] = await spans(exporter, provider)
    expect(span?.kind).toBe(SpanKind.CONSUMER)
  })
})

describe('privacy and conformance', () => {
  it('rejects arbitrary or sensitive fields at every public schema boundary', () => {
    for (const key of [
      'prompt',
      'response',
      'toolArguments',
      'toolResults',
      'headers',
      'credentials',
      'email',
      'attributes',
    ]) {
      expect(
        agentInvocationConfigurationSchema.safeParse({ ...configuration, [key]: 'secret' }).success,
      ).toBe(false)
      expect(agentInvocationInputSchema.safeParse({ [key]: 'secret' }).success).toBe(false)
      expect(agentInvocationTelemetrySchema.safeParse({ [key]: 'secret' }).success).toBe(false)
    }
    expect(
      agentInvocationTelemetrySchema.safeParse({ toolCallNames: ['lookup user@example.com'] })
        .success,
    ).toBe(false)
    expect(
      agentInvocationInputSchema.safeParse({ providerInvocationId: 'x'.repeat(201) }).success,
    ).toBe(false)
    expect(
      agentInvocationResultSchema.safeParse({
        providerInvocationId: 'invocation-a',
        traceId: '1'.repeat(32),
        spanId: 'a'.repeat(16),
        sampled: true,
        prompt: 'secret',
      }).success,
    ).toBe(false)
  })

  it('keeps contract constants aligned with the canonical fixture and JSON schema', async () => {
    const fixture = agentInvocationContractFixtureSchema.parse(
      JSON.parse(
        await readFile(
          new URL('../contract/agent-invocation-v1.fixture.json', import.meta.url),
          'utf8',
        ),
      ),
    )
    expect(fixture.contractVersion).toBe(AGENT_INVOCATION_CONTRACT_VERSION)
    expect(fixture.recordType).toBe(AGENT_INVOCATION_RECORD_TYPE)
    expect(fixture.span.name).toBe(AGENT_INVOCATION_SPAN_NAME)
    expect(applicationInsightsResourceIdSchema.parse(providerResourceId)).toBe(
      fixture.span.attributes[AGENT_INVOCATION_ATTRIBUTE_KEYS.providerResourceId],
    )

    const schemaFile = JSON.parse(
      await readFile(
        new URL('../contract/agent-invocation-v1.schema.json', import.meta.url),
        'utf8',
      ),
    ) as unknown
    expect(schemaFile).toEqual(agentInvocationContractJsonSchema)
  })

  it('maps only narrow provider usage and tool seams', () => {
    expect(
      telemetryFromOpenAIResponses({
        usage: { input_tokens: 10, output_tokens: 4 },
        output: [
          { type: 'message', name: 'ignored' },
          { type: 'function_call', name: 'search' },
        ],
      }),
    ).toEqual({
      usage: { authority: 'provider', inputTokens: 10, outputTokens: 4 },
      toolCallNames: ['search'],
    })
    expect(telemetryFromOpenAIAgents({ inputTokens: 8, toolCallNames: ['handoff'] })).toEqual({
      usage: { authority: 'provider', inputTokens: 8 },
      toolCallNames: ['handoff'],
    })
    expect(
      telemetryFromAzureAIAgents({
        usage: { promptTokens: 7, completionTokens: 3 },
      }),
    ).toEqual({
      usage: { authority: 'provider', inputTokens: 7, outputTokens: 3 },
    })
  })
})

function durationMilliseconds(span: ReadableSpan): number {
  return span.duration[0] * 1_000 + span.duration[1] / 1_000_000
}
