# External runtime instrumentation

The reusable `@agent-sentinel/runtime-instrumentation` package is the supported
producer contract for live invocation evidence consumed by the Azure Monitor
OpenTelemetry connector. Integration belongs in each external agent runtime.
The current Agent Sentinel API and jobs read and project evidence; they must not
emit qualifying `agent.invoke` invocation spans on behalf of external agents.

## Runtime contract

Initialize OpenTelemetry in the external runtime, then pass its `Tracer` to
`instrumentAgentInvocation`. The helper owns exactly one `SERVER` span named
`agent.invoke` per callback (`CONSUMER` is opt-in for queue consumers). It does
not own exporter, sampler, processor, or tracer-provider initialization.

Configure the provider resource with:

```ts
resourceFromAttributes(agentInvocationResourceAttributes(configuration))
```

`service.name` must exactly equal the connector source
`applicationRoleName`. The runtime must export to the exact Application
Insights component named by `providerResourceId`. Use an always-on sampler when
the connector is expected to report complete raw evidence (`ItemCount == 1`).

The callback is the lifetime boundary. For a stream, await its terminal event
or final response inside the callback:

```ts
await instrumentAgentInvocation(tracer, configuration, input, async () => {
  const stream = await client.responses.stream(request)
  const response = await stream.finalResponse()
  return {
    value: response,
    telemetry: telemetryFromOpenAIResponses(response),
  }
})
```

Omit `providerInvocationId` to use the helper's UUID. A caller-supplied value is
strictly bounded and must be unique within the connector source.

The OpenAI Responses adapter reads only terminal token usage and function-call
names. OpenAI Agents and Azure AI Agents expose narrow normalized seams because
their SDK result shapes vary: map only provider-reported terminal token usage
and validated tool names. Do not derive usage from text length or estimate
cost. Cost is emitted only when a provider or billing authority explicitly
supplies a USD amount.

The schemas intentionally provide no way to capture prompts, responses, tool
arguments/results, headers, credentials, email addresses, exception messages,
or arbitrary attributes. Missing usage and cost remain absent.

## Deployment variables

Each external runtime should map its own secretless configuration into these
values. Names are recommended deployment bindings; the package accepts a typed
object and does not read process environment itself.

| Variable                                              | Required value                                       |
| ----------------------------------------------------- | ---------------------------------------------------- |
| `AGENT_SENTINEL_APPLICATION_ROLE_NAME`                | Exact connector `applicationRoleName`/`service.name` |
| `AGENT_SENTINEL_PROVIDER_RESOURCE_ID`                 | Exact Application Insights ARM resource ID           |
| `AGENT_SENTINEL_ESTATE_ID`                            | Estate binding                                       |
| `AGENT_SENTINEL_ESTATE_TENANT_ID`                     | Estate tenant binding                                |
| `AGENT_SENTINEL_ESTATE_ENVIRONMENT`                   | Estate environment binding                           |
| `AGENT_SENTINEL_SOURCE_CONNECTOR_ID`                  | Exact connector source ID                            |
| `AGENT_SENTINEL_SOURCE_TENANT_ID`                     | Source tenant and `agent.sentinel.tenant_id`         |
| `AGENT_SENTINEL_SOURCE_PROJECT_ID`                    | Exact source project ID                              |
| `AGENT_SENTINEL_SOURCE_ENVIRONMENT`                   | Source/deployment environment                        |
| `AGENT_SENTINEL_PROVIDER_AGENT_ID`                    | Exact provider agent ID                              |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` or equivalent | Export destination owned by the external runtime     |

The connector-side workspace, source, tenant, project, environment, provider
resource, role, and agent bindings must match these values exactly. Remaining
deployment work is runtime-specific: add the package, configure the resource
and exporter, wrap the terminal invocation boundary, deploy, generate approved
non-synthetic traffic, and verify raw unsampled `AppRequests`.

The canonical fixture and Draft 2020-12 JSON schema are exported at
`@agent-sentinel/runtime-instrumentation/contract/agent-invocation-v1.*`.
