# Development

## Canonical environment

The canonical source is the WSL repository at `~/project/agent-sentinel`.
GitHub is the shared source of truth. Do not install dependencies or develop
from a OneDrive-synchronized clone.

Requirements:

- Node.js 22
- pnpm 10
- Azure CLI and Bicep for infrastructure validation

Install from the existing WSL store when offline:

```bash
pnpm install --offline --frozen-lockfile
```

## Common commands

```bash
pnpm lint
pnpm test
pnpm test:e2e
pnpm --filter @agent-sentinel/web build
```

Run live Foundry validation only when explicitly intended:

```bash
pnpm foundry:validate
```

It exercises synthetic Azure resources and is never part of CI.

## Custom manifest adapter

`connectors/manifest` (`@agent-sentinel/manifest-connector`) turns an
operator-supplied manifest into an `EstateSnapshot`. The envelope contract itself
lives in `packages/connector-sdk/src/manifest.ts` so the SDK stays the single
source of truth; the connector re-exports it rather than duplicating schemas.

```bash
pnpm --filter @agent-sentinel/manifest-connector test
pnpm manifest:validate -- /absolute/path/to/manifest.json \
  --tenant contoso-ai-lab \
  --environment production
pnpm manifest:scan /absolute/path/to/manifest.json \
  --tenant contoso-ai-lab \
  --environment production
```

The validator CLI (`tools/validate-manifest.ts`) is offline: it requires the
expected tenant binding, optionally verifies the environment binding, runs the
same strict validation as the connector, and prints the
normalized entity counts plus the deterministic SHA-256 manifest hash used for
ingestion idempotency. A worked example lives at
`connectors/manifest/examples/sample-manifest.json`.

The scanner CLI is also offline. It uses the same strict acceptance and
normalization path, then the same deterministic policy-engine entry point used
after runtime discovery. JSON is the default for CI; add `--format text` for an
author explanation or `--fail-on warn` for a stricter gate. Exit codes are `0`
accepted, `1` policy gate failed, `2` invalid input, and `3` unexpected failure.

Manifest evidence may include an optional `sourceBinding` with
`sourceConnectorId`, `sourceTenantId`, `sourceObjectId`, and
`sourceEnvironment`. The live read model uses only an exact four-field match to
an authoritative agent or tool, and the manifest `subjectId` must equal the
provider `sourceObjectId`. It never merges nodes or infers relationships.
For `runtime_observed` evidence, only non-synthetic Azure Monitor evidence
verifies the claim; missing,
ambiguous, unavailable, and successfully queried-but-unobserved states remain
explicit. Lack of an observation is never reported as a contradiction. Runtime
verification is bounded to the latest 500 manifest sources for an environment;
exceeding that cap reports `source-limit-exceeded` rather than masquerading as
a repository outage. Declared-configuration reconciliation reports only an
exact authoritative object match and its cited evidence. It does not compare or
endorse free-form manifest claims.

When changing the envelope:

- Update `manifest.ts`, `connectors/manifest/schemas/manifest.schema.json`, and
  the example together. Tests assert parity between the Zod schema and the
  hand-maintained JSON Schema on the critical constraints.
- Bump `MANIFEST_SCHEMA_VERSION` and extend `SUPPORTED_MANIFEST_VERSIONS` for a
  breaking change; unsupported versions must be rejected, never coerced.
- Keep the adapter read-only. `ManifestConnector` intentionally has no
  `execute()`, and an `execute` action depth is rejected at load time.

## Azure Monitor OpenTelemetry runtime connector

`@agent-sentinel/azure-monitor-otel-connector` is query-only. It sends one
bounded query to the fixed Azure Monitor Logs endpoint and fixed `AppRequests`
table, then strictly maps the projected rows into baseline and observed
`ObservationWindow` objects. It does not create resources, ingest telemetry, or
fall back to local data.

Live activation requires `AGENT_SENTINEL_DATA_MODE=live` and at least one
validated source. Configure sources with `AZURE_MONITOR_SOURCES_JSON`, or use
the legacy single-source variables:

- `AZURE_MONITOR_WORKSPACE_ID`
- `AZURE_MONITOR_TENANT_ID` (must match the API tenant binding)
- `AZURE_MONITOR_ENVIRONMENT`
- `FOUNDRY_PROJECT_ENDPOINT` (the final path segment supplies the exact source
  project ID)

Each `AZURE_MONITOR_SOURCES_JSON` item must include `sourceProjectId` matching
the authoritative Foundry agent metadata for that source.
Foundry configuration applies the same trimmed 200-character project-ID schema
to connector-source API/domain endpoint ingress, legacy environment ingress,
JSON portfolio parsing, and connector construction. An overlong final endpoint
segment is rejected before persistence, credentials, or any provider request
can start.

The runtime does not read a separate Azure Monitor connector-enabled
environment variable. The `azureMonitorConnectorEnabled` Bicep parameter gates
whether deployment configuration is injected; runtime activation is derived
from data mode and the validated source configuration.

Deployment-source projection uses the same activation resolution as the runtime:
live mode projects validated JSON sources or the complete legacy tuple, while
mock mode does not parse or project Azure Monitor configuration. Projected
records remain read-only and `not-tested`; projection is not readiness evidence.
In live mode, configuring any legacy tuple field requires all three fields;
an incomplete tuple is a configuration error rather than an inactive connector.
Leaving all three fields empty keeps the connector inactive. Non-empty source
JSON takes precedence over the legacy tuple.

Optional bounds are `AZURE_MONITOR_BASELINE_WINDOW_HOURS` (default 168),
`AZURE_MONITOR_OBSERVED_WINDOW_HOURS` (default 24), and
`AZURE_MONITOR_REQUEST_TIMEOUT_MS` (default 15000). Authentication uses
`DefaultAzureCredential`; grant only the Azure Monitor Logs query data action
(`Microsoft.OperationalInsights/workspaces/query/read`, commonly through Log
Analytics Reader) on the target workspace. No shared key is accepted.
Window and observation freshness are recomputed from the trusted provider
`queriedAt` timestamp and `maximumFreshnessHours`; connector-supplied
`available` status or stale caveats are not authoritative. A missing freshness
maximum degrades quality as unverified, and timestamps outside the configured
maximum remain stale. A default 168-hour baseline that ends within the
168-hour freshness limit is therefore valid.

Behavior and token-economics routes require a snapshot resolver to return the
exact authoritative telemetry request before calling the runtime connector.
Eligibility rejects unresolved or mixed-authority citations,
`isNonAuthoritative=true`, synthetic/test markers, `synthetic_validation`
evidence, missing exact declared configuration, and any estate, source,
environment, or provider-agent mismatch. Identity names, owners, primary IDs,
tenant inventory, and `RUNS_AS` edges never establish runtime eligibility.

Instrumented request spans must reach `AppRequests` with these OTel/custom
properties:

The resource `service.name` must equal the connector
`applicationRoleName`, the span name must be `agent.invoke`, and the span kind
must be `SERVER` (or `CONSUMER` only for a queue consumer). See
[external runtime instrumentation](external-runtime-instrumentation.md).

| Property                                | Mapping                                                            |
| --------------------------------------- | ------------------------------------------------------------------ |
| `agent.sentinel.tenant_id`              | Required source tenant binding                                     |
| `gen_ai.agent.id`                       | Required provider agent binding                                    |
| `deployment.environment.name`           | Required source environment binding                                |
| `agent.sentinel.source_project_id`      | Required exact source project binding                              |
| `agent.sentinel.contract_version`       | Required literal `1`                                               |
| `agent.sentinel.record_type`            | Required literal `agent_invocation`                                |
| `agent.sentinel.source_connector_id`    | Required exact connector source binding                            |
| `agent.sentinel.estate_id`              | Required estate binding                                            |
| `agent.sentinel.estate_tenant_id`       | Required estate tenant binding                                     |
| `agent.sentinel.estate_environment`     | Required estate environment binding                                |
| `agent.sentinel.source_tenant_id`       | Required exact source tenant binding                               |
| `agent.sentinel.source_environment`     | Required exact source environment binding                          |
| `agent.sentinel.provider_agent_id`      | Required exact provider agent binding                              |
| `agent.sentinel.provider_resource_id`   | Required exact lower-cased Application Insights ARM resource ID    |
| `agent.sentinel.provider_invocation_id` | Required unique invocation/observation ID                          |
| `agent.sentinel.outcome`                | Required terminal `success` or `error` matching native span status |
| `agent.sentinel.synthetic`              | Required explicit classification; live evidence must be `false`    |
| `gen_ai.agent.run.id`                   | Optional exact agent-run identifier                                |
| `agent.sentinel.run_id`                 | Optional fallback exact agent-run identifier                       |
| `agent.sentinel.correlation_id`         | Optional exact correlation identifier (falls back to operation)    |
| `gen_ai.agent.version`                  | Optional broad agent-version context; not counted as an exact run  |
| `gen_ai.usage.input_tokens`             | Optional measured provider input tokens; absent stays unknown      |
| `gen_ai.usage.output_tokens`            | Optional measured provider output tokens; absent stays unknown     |
| `agent.sentinel.cost.usd`               | Optional authoritative measured USD cost; never estimated          |
| `agent.sentinel.tool_call_names`        | Optional bounded JSON string array of validated tool names         |
| `error.type`                            | Optional sanitized error code/type                                 |

`pnpm --filter @agent-sentinel/scripts validate-live` emits bounded synthetic
validation spans. Their exact sanitized Foundry project ID supports source
binding, but `agent.sentinel.synthetic=true` remains authoritative and the span
must never be described as live runtime evidence.

The Azure Monitor row must also expose a 32-lowercase-hex trace ID, a
16-lowercase-hex span ID, and `ItemCount == 1`. Each row is converted into
invocation, latency, error, input-token, output-token, and cost claims and then
passed through the same representative normalizer used by offline contract
tests. Missing, sampled, stale, synthetic, conflicting, or mismatched claims
remain `unknown`, `insufficient-data`, or degraded; the connector does not
substitute `AppMetrics`, fixtures, or estimated values.

The complete bounded response is canonicalized by observation ID before
baseline/observed partitioning. If one observation ID is reused with conflicting
content across windows, every conflicting row is removed and each affected
window is degraded with `conflicting-duplicate`.

Jobs and the live read model map validated telemetry windows onto an already
discovered agent node. Both paths validate the returned estate, snapshot,
tenant, environment, source project, workspace, provider agent, and nested
observation provenance against the exact request before projection. Jobs
persists only validated projections and retains the authoritative discovery
snapshot when optional runtime evidence is rejected; the API performs the same
validation before its short-lived request projection. Tool and `CAN_CALL` edge
evidence is added only when a tool-call name has exactly one existing outgoing
tool match; unmatched or ambiguous names are reported as coverage gaps and
never create graph objects. Synthetic validation spans are typed separately and
excluded from behavior-baseline and token-economics analysis. Token Economics
reports runtime correlation-ID availability as the fraction of measured
observations carrying an agent-run or correlation identifier. This is
linkability, not evidence that an outcome was actually joined. Agent-version
context is preserved but is not counted as exact because one version can span
many unrelated runs and outcomes.

Before either path queries telemetry, the discovered agent and one cited
declared-configuration evidence record must both be authoritative and exactly
match the snapshot estate, connector source, source tenant, source project,
source environment, and provider agent ID. Names, owners, primary IDs, tenant
inventory membership, and non-authoritative manifest metadata never establish
runtime eligibility or a `RUNS_AS` relationship.

Persisted runtime invocation evidence retains bounded agent-run ID, correlation
ID, agent version, and the original order of tool-call names that matched
exactly one declared tool edge. Those fields participate in immutable evidence
collision checks and are returned unchanged through `/api/demo/state`.

The checked-in Azure Monitor response fixture is local-only and contract-tested:

```bash
pnpm --filter @agent-sentinel/azure-monitor-otel-connector test
```

## Shared UI and Storybook

`@agent-sentinel/ui` owns design tokens and reusable operational primitives.
Start Storybook for isolated component work:

```bash
pnpm storybook
```

Build the static catalog and run the component contract tests:

```bash
pnpm storybook:build
pnpm --filter @agent-sentinel/ui test
```

Storybook wraps stories in the production Fluent dark theme. The accessibility
addon runs in `error` mode so violations fail supported Storybook test flows.
Stories use synthetic operational states only and do not call APIs.

If configuration is absent, credentials fail, the provider rejects the query,
or any row violates its tenant/agent/environment/time binding, the API returns
typed unknown. It never reads the mock fixtures in live mode.

## Contribution practice

- Work on feature branches.
- Keep deterministic policy and graph behavior independent of model access.
- Add tests for behavior changes.
- Preserve explicit live, synthetic, mock, planned, and unknown boundaries.
- Never substitute mock success when a live connector fails.
- Use full-commit build tags and verified digest-qualified deployment references.

The private CI runner can be deallocated. Start it before expecting queued jobs
to run. Its managed identity is intentionally limited to image push; platform
deployment remains a separate privileged operation.
