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

Live activation requires all of:

- `AZURE_MONITOR_WORKSPACE_ID`
- `AZURE_MONITOR_TENANT_ID` (must match the API tenant binding)
- `AZURE_MONITOR_ENVIRONMENT`

Optional bounds are `AZURE_MONITOR_BASELINE_WINDOW_HOURS` (default 168),
`AZURE_MONITOR_OBSERVED_WINDOW_HOURS` (default 24), and
`AZURE_MONITOR_REQUEST_TIMEOUT_MS` (default 15000). Authentication uses
`DefaultAzureCredential`; grant only the Azure Monitor Logs query data action
(`Microsoft.OperationalInsights/workspaces/query/read`, commonly through Log
Analytics Reader) on the target workspace. No shared key is accepted.

Instrumented request spans must reach `AppRequests` with these OTel/custom
properties:

| Property                         | Mapping                                     |
| -------------------------------- | ------------------------------------------- |
| `agent.sentinel.tenant_id`       | Required tenant binding                     |
| `gen_ai.agent.id`                | Required agent binding                      |
| `deployment.environment.name`    | Required environment binding                |
| `agent.sentinel.observation_id`  | Observation id (falls back to request id)   |
| `gen_ai.usage.input_tokens`      | Optional measured input tokens              |
| `gen_ai.usage.output_tokens`     | Optional measured output tokens             |
| `agent.sentinel.cost.usd`        | Optional measured USD cost; never estimated |
| `agent.sentinel.tool_call_names` | Optional JSON string array of ordered tools |
| `error.type`                     | Optional error code                         |

The checked-in Azure Monitor response fixture is local-only and contract-tested:

```bash
pnpm --filter @agent-sentinel/azure-monitor-otel-connector test
```

If configuration is absent, credentials fail, the provider rejects the query,
or any row violates its tenant/agent/environment/time binding, the API returns
typed unknown. It never reads the mock fixtures in live mode.

## Contribution practice

- Work on feature branches.
- Keep deterministic policy and graph behavior independent of model access.
- Add tests for behavior changes.
- Preserve explicit live, synthetic, mock, planned, and unknown boundaries.
- Never substitute mock success when a live connector fails.
- Use immutable image tags derived from commits.

The private CI runner can be deallocated. Start it before expecting queued jobs
to run. Its managed identity is intentionally limited to image push; platform
deployment remains a separate privileged operation.
