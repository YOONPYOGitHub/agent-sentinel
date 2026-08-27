# Agent Sentinel domain context

## Product boundary

Agent Sentinel is a cross-platform AI Agent Operations and Security control
plane. It consumes authoritative data from Microsoft and third-party systems;
it does not recreate their native administration.

## Product pillars

- **Discover:** inventory and ownership across agent platforms.
- **Govern:** policy, exceptions, approvals, and compliance evidence.
- **Protect:** exposure, validation, incidents, and response.
- **Observe:** reliability, quality, activity, latency, and cost.
- **Optimize:** evidence-backed recommendations and outcome verification.
- **Lifecycle:** release, promotion, drift, rollback, and retirement.

## Shared language

- **Agent estate:** all agents and their versions, identities, capabilities,
  owners, environments, and dependencies within a tenant.
- **Evidence graph:** typed assets and relationships whose claims always cite a
  source, confidence, freshness, and observation timestamp.
- **Attack path:** an evidence-backed sequence from an untrusted origin to a
  sensitive data asset or high-impact action.
- **Blast radius:** assets, data, actions, users, and downstream agents reachable
  from a selected node or compromised path.
- **Validation:** a bounded, non-destructive test that changes a theoretical
  finding into validated or not reproduced.
- **Remediation:** an authorized, auditable, idempotent action that reduces
  exposure and has a defined rollback posture.
- **Trust Catalog:** governed Agents, MCP servers, tools, models, and connectors
  with provenance, permissions, validation, exposure, usage, and lifecycle
  evidence.

## Invariants

- Missing evidence lowers confidence; it never implies safety.
- No finding or relationship exists without evidence.
- No impactful action executes without authorization and approval context.
- Tenant and environment boundaries apply below the UI.
- LLM output may summarize evidence but does not establish security truth.

## Azure AI Foundry connector

The `@agent-sentinel/foundry-connector` workspace discovers declared agent and function-tool configuration from the Foundry v1 API. This evidence is labeled **Declared configuration** and is not presented as observed runtime behavior. The `@agent-sentinel/scenarios` workspace defines the six synthetic validation agents; `@agent-sentinel/scripts` owns provisioning and live validation.

Environment variables:

- `AGENT_SENTINEL_CONNECTOR=mock|foundry` (defaults to `mock`)
- `FOUNDRY_PROJECT_ENDPOINT`
- `FOUNDRY_TENANT_ID`
- `FOUNDRY_ENVIRONMENT`

```bash
cd /home/yoonpyohong/project/agent-sentinel
FOUNDRY_PROJECT_ENDPOINT=https://ais-agent-sentinel-260814.services.ai.azure.com/api/projects/agent-sentinel-pjt tsx scripts/provision-agents.ts
FOUNDRY_PROJECT_ENDPOINT=https://ais-agent-sentinel-260814.services.ai.azure.com/api/projects/agent-sentinel-pjt tsx scripts/validate-live.ts
# Destructive; review before running. Deletes only manifest agent names.
FOUNDRY_PROJECT_ENDPOINT=https://ais-agent-sentinel-260814.services.ai.azure.com/api/projects/agent-sentinel-pjt tsx scripts/cleanup-agents.ts
```

Live validation writes the sanitized, Git-ignored `scripts/live-validation-report.json`.

## Custom manifest adapter

The `@agent-sentinel/manifest-connector` workspace ingests an operator-supplied
manifest describing agents that no first-party connector covers. It is a
**non-authoritative** source and exists to make coverage gaps explicit rather
than invisible.

Vocabulary:

- **Manifest envelope:** the versioned, strictly validated document an operator
  supplies. Defined once in `@agent-sentinel/connector-sdk`.
- **Adapter claim:** an evidence record originating from a manifest. Always
  `sourceOfTruth: false` and `isNonAuthoritative: true`.
- **Declared configuration vs runtime observed:** manifest evidence is treated as
  declared configuration unless the manifest declares `runtime_observed` evidence
  _and_ the adapter declares `supportsRuntimeTelemetry` with `evidenceDepth: 'deep'`.
  Otherwise the claim is downgraded to declared configuration.

Invariants specific to the adapter, on top of the shared invariants above:

- A manifest never outranks a first-party connector. Confidence is capped at 0.7
  (default 0.4) for declared claims.
- The adapter performs no network I/O. Remote URLs and relative paths are
  rejected before any read; only absolute local paths are accepted.
- The adapter cannot act. There is no `execute()` and an `execute` action depth is
  rejected at load time.
- Tenant and environment must match the server-controlled estate boundary,
  enforced below the UI and again by persistence.
- API ingestion requires JWT Administrator `configure` plus the deployment write
  gate. There is no unauthenticated ingestion endpoint.
- Immutable content-hash versions are stored separately and jobs composes only
  the latest version per manifest as non-authoritative evidence.

```bash
pnpm manifest:validate -- /absolute/path/to/manifest.json
```

## Behavior baseline and drift-analysis engine

The `@agent-sentinel/behavior-engine` workspace implements a deterministic
statistical engine for per-agent runtime behavior baselines and drift findings.
It depends only on `@agent-sentinel/domain` and performs no network I/O.

### What is implemented

- **Robust statistics:** median and MAD (median absolute deviation) for
  latency, token, and measured cost distributions. Resistant to outliers; no
  mean/stddev.
- **Rate drift:** absolute-delta comparison of error rate with four severity
  levels. Success rate is not duplicated because it is the exact complement.
- **Tool-sequence drift:** set and order-pattern analysis of added, removed, and
  reordered tool calls with explainable severity.
- **Fail-closed data quality:** stale windows, sparse samples (< 10),
  invalid timestamps, high duplicate ratios, and clock-skew violations all
  produce `status: 'invalid'` or `status: 'insufficient-data'`, never a
  silent healthy fallback.
- **Cost absent = unknown:** `costUsd` is never estimated; the cost dimension is
  omitted when measurements are absent and analyzed with the same robust
  thresholds when measurements exist.
- **Typed evidence references:** `DriftAnalysisResult.baselineEvidenceId` and
  `observedEvidenceId` are immutable string references to evidence records.

### Mode separation

| Result field        | Mock mode                 | Live mode (OTel configured)                |
| ------------------- | ------------------------- | ------------------------------------------ |
| `source`            | `'mock-synthetic'`        | `'azure-monitor-otel'`                     |
| `status`            | `'ready'` (or data issue) | engine result, or typed unknown on failure |
| `unavailableReason` | Set only for a data issue | Set for absent/failed/invalid telemetry    |
| Drift shown?        | Yes (synthetic data)      | Only when measured windows validate        |

`source: 'mock-synthetic'` is **never** present in live mode API responses.
Synthetic results never replace an unavailable live result.

### Live runtime adapter

The `@agent-sentinel/azure-monitor-otel-connector` workspace performs a bounded,
read-only Azure Monitor Logs query and strictly maps projected OTel
`AppRequests` rows into `ObservationWindow` objects. It activates only when its
workspace, tenant, and environment configuration is injected. Absent
configuration and provider/contract failures remain typed unknown; only mock
mode reads the fixed fixtures in `@agent-sentinel/mock-connector`.

Invariants:

- No LLM involvement in drift analysis. Severity and confidence are
  deterministic functions of measured values and thresholds defined in
  `packages/behavior-engine/src/thresholds.ts`.
- Computational bounds are explicit: ≤ 10,000 observations per window,
  ≤ 10 dimensions per analysis result, ≤ 50 tool names per observation.
- The engine is read-only. There is no ingestion endpoint.
