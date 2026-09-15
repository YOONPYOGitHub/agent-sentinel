# Agent Sentinel runtime instrumentation

This package emits the single versioned OpenTelemetry request span consumed by
the Azure Monitor connector. It does not initialize a tracer provider,
sampler, resource, processor, or exporter.

```ts
const result = await instrumentAgentInvocation(
  tracer,
  configuration,
  { agentRunId, correlationId },
  async () => {
    const response = await client.responses.create(request)
    return {
      value: response,
      telemetry: telemetryFromOpenAIResponses(response),
    }
  },
)
```

For streaming APIs, await the provider's terminal response inside the callback.
The `agent.invoke` span stays open until that callback resolves or rejects.
`recordTelemetry` can preserve provider-reported terminal usage before an error.

Initialize the runtime's OTel resource with
`agentInvocationResourceAttributes(configuration)`. Its `service.name` must
equal the connector source's `applicationRoleName`; the exact lower-cased
Application Insights ARM resource ID must also match the connector source.
Use an always-on sampler when complete invocation evidence is required.

Only measured provider token usage is accepted. Cost requires an explicit
provider or billing authority and `USD`; absent values are omitted. The API has
no prompt, response, tool argument/result, header, credential, email, exception
recording, or arbitrary span-attribute surface.

`telemetryFromOpenAIResponses` reads only `usage.input_tokens`,
`usage.output_tokens`, and function-call names. The OpenAI Agents and Azure AI
Agents adapters intentionally accept narrow normalized seams because SDK result
shapes vary by version. Map only terminal provider usage and already-sanitized
tool names into those seams.
