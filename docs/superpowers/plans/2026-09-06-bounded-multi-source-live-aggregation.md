# Bounded Multi-Source Live Connector Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggregate configured Foundry, Entra, and Azure Monitor live reads with deterministic bounded execution, cancellation, exact provenance, and explicit per-source data states.

**Architecture:** Add one dependency-free bounded aggregation primitive to the connector SDK, then adapt each live connector at its existing source boundary. Provider clients retain their current page, item/row, retry, byte, and request timeout limits; the shared layer adds source-count, concurrency, total-duration, cancellation, deterministic result ordering, and uniform outcome typing. API runtime telemetry uses the same primitive without changing graph, jobs, messaging, worker, or exposure-route code.

**Tech Stack:** Node.js 22, TypeScript, Zod, Vitest, pnpm 10.15.1, Fastify, Azure Identity.

---

## File structure

- Create `packages/connector-sdk/src/live-aggregation.ts`: generic bounded scheduler and typed source outcomes.
- Create `packages/connector-sdk/test/live-aggregation.test.ts`: scheduler adversarial tests.
- Modify `packages/connector-sdk/src/index.ts`: export aggregation APIs, add source data state/provenance schema support, and add optional operation signals.
- Modify `connectors/foundry/src/index.ts`: bounded portfolio execution, discovery metrics, cancellation, and health data states.
- Modify `connectors/foundry/test/connector.test.ts`: concurrency, deadline, empty, failure, order, provenance, and compatibility coverage.
- Modify `connectors/entra-identity/src/client.ts`: propagate caller cancellation into token and Graph requests.
- Modify `connectors/entra-identity/src/index.ts`: bounded source aggregation and typed source data states.
- Modify `connectors/entra-identity/test/connector.test.ts`: exact-binding, partial/empty/failure, cancellation, and ordering coverage.
- Modify `connectors/azure-monitor-otel/src/index.ts`: propagate cancellation and expose typed query data state.
- Modify `connectors/azure-monitor-otel/test/connector.test.ts`: empty/stale/partial/failure/cancellation and exact-ID coverage.
- Modify `apps/api/src/demo-service.ts`: replace the private runtime batch loop with the bounded aggregation helper.
- Modify `apps/api/test/read-model.test.ts`: runtime aggregation duration, deterministic outcomes, source failures, and synthetic/empty evidence coverage.
- Modify `packages/domain/src/index.ts`: extend the runtime evidence response with bounded, sanitized per-source outcomes.
- Modify `docs/foundry-live-agents.md`, `docs/entra-identity-connector.md`, and `docs/connector-availability.md`: document live aggregation limits and evidence-state semantics.

### Task 1: Shared bounded aggregation primitive

**Files:**
- Create: `packages/connector-sdk/test/live-aggregation.test.ts`
- Create: `packages/connector-sdk/src/live-aggregation.ts`
- Modify: `packages/connector-sdk/src/index.ts`

- [ ] **Step 1: Write failing scheduler tests**

Add tests that construct deferred source operations and assert:

```ts
const result = await aggregateLiveSources({
  sources: [{ id: 'b' }, { id: 'a' }, { id: 'c' }],
  limits: {
    maxSources: 3,
    maxConcurrency: 2,
    maxDurationMs: 1_000,
    maxPagesPerSource: 2,
    maxRecordsPerSource: 5,
  },
  execute: async (source, context) => ({
    state: 'complete',
    value: source.id,
    pages: 1,
    records: 1,
    evidenceIds: [`evidence:${source.id}`],
  }),
})

expect(result.outcomes.map((item) => item.source.id)).toEqual(['b', 'a', 'c'])
expect(result.complete).toBe(true)
```

Cover no more than `maxConcurrency` active operations, source-count rejection,
per-source page and record overrun becoming `partial`, caller cancellation,
deadline cancellation, queued work not starting after abort, rejected work
becoming sanitized `failed`, and explicit `empty`, `stale`, and `unsupported`
states surviving unchanged.

- [ ] **Step 2: Run the connector SDK test and confirm failure**

Run:

```bash
pnpm --filter @agent-sentinel/connector-sdk test -- live-aggregation.test.ts
```

Expected: failure because `aggregateLiveSources` and its types do not exist.

- [ ] **Step 3: Implement the scheduler**

Create these public contracts in `live-aggregation.ts`:

```ts
export type LiveSourceDataState =
  | 'complete'
  | 'partial'
  | 'stale'
  | 'unsupported'
  | 'empty'
  | 'failed'
  | 'cancelled'

export interface LiveAggregationLimits {
  readonly maxSources: number
  readonly maxConcurrency: number
  readonly maxDurationMs: number
  readonly maxPagesPerSource: number
  readonly maxRecordsPerSource: number
}

export interface LiveSourceExecutionContext {
  readonly signal: AbortSignal
  readonly maxPages: number
  readonly maxRecords: number
}

export interface LiveSourceValue<T> {
  readonly state: Exclude<LiveSourceDataState, 'failed' | 'cancelled'>
  readonly value: T
  readonly pages: number
  readonly records: number
  readonly evidenceIds: readonly string[]
  readonly reason?: string
}
```

Implement `aggregateLiveSources()` with an index-based worker pool. Parse
positive integer limits with Zod, reject duplicate source IDs, preserve input
order in `outcomes`, combine the external signal with a deadline controller,
and sanitize failures to stable reason codes supplied through an optional
`failureReason(error)` callback. If reported pages or records exceed their
per-source caps, retain the value only for diagnostics but classify the outcome
as `partial` with reason `bounds`. `complete` is true only when every outcome is
`complete`; empty, stale, partial, unsupported, failed, or cancelled all prevent
complete success.

- [ ] **Step 4: Extend shared connector contracts**

In `packages/connector-sdk/src/index.ts`:

```ts
export interface ConnectorOperationRequest {
  readonly signal?: AbortSignal
}

export interface RuntimeTelemetryReadOptions extends ConnectorOperationRequest {}

export interface ConnectorSourceHealth {
  // existing fields
  readonly dataState?: LiveSourceDataState
}
```

Export the new aggregation types and function. Add `dataState` and the existing
`provenance` object to `connectorHealthReportSchema`. Change
`AgentConnector.discover` to accept an optional `ConnectorOperationRequest` and
`RuntimeTelemetryConnector.readObservationWindows` to accept optional
`RuntimeTelemetryReadOptions`. Existing implementations that ignore optional
arguments remain assignable.

- [ ] **Step 5: Run SDK tests, typecheck, and lint**

Run:

```bash
pnpm --filter @agent-sentinel/connector-sdk test &&
pnpm --filter @agent-sentinel/connector-sdk typecheck &&
pnpm --filter @agent-sentinel/connector-sdk lint
```

Expected: all pass.

- [ ] **Step 6: Commit the shared primitive**

```bash
git add packages/connector-sdk/src packages/connector-sdk/test
git commit -m "Add bounded live source aggregation" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Bound Foundry portfolio discovery

**Files:**
- Modify: `connectors/foundry/test/connector.test.ts`
- Modify: `connectors/foundry/src/index.ts`
- Modify: `docs/foundry-live-agents.md`

- [ ] **Step 1: Write failing Foundry portfolio tests**

Add tests that:

1. create three sources with deferred fetchers and assert at most two are active;
2. complete requests in reverse order and assert nodes, evidence, and health
   remain in configured source order;
3. return zero agents for one source and assert `dataState: 'empty'`;
4. fail one source and assert `FoundryPortfolioIncompleteError`, exact
   provenance, `overall: 'degraded'`, and no cached aggregate evidence;
5. abort before the queued source starts and assert `request-aborted` plus
   `dataState: 'cancelled'`; and
6. construct the connector with existing arguments and call `discover()` with
   no options to prove compatibility.

- [ ] **Step 2: Run the focused Foundry tests and confirm failure**

Run:

```bash
pnpm --filter @agent-sentinel/foundry-connector test -- connector.test.ts
```

Expected: new assertions fail because portfolio execution is still unbounded
and health has no data state.

- [ ] **Step 3: Add aggregate limits and discovery metrics**

Extend `FoundryConnectorOptions` with optional aggregate limits:

```ts
readonly aggregation?: Partial<LiveAggregationLimits>
```

Use safe defaults of 50 sources, concurrency 4, total duration 60 seconds, and
the existing Foundry page/item limits for per-source caps. Track the exact page
count and returned agent count from `listAgents()` in a private last-discovery
measurement reset at each call.

- [ ] **Step 4: Replace Foundry `Promise.all*` fan-out**

Use `aggregateLiveSources()` in `testConnection()` and `discover(request)`.
Pass `context.signal` to each single-source connector. Scope and merge only
`complete` non-empty snapshots. Map zero-agent success to `empty`; map bounded
continuation/item failures to `partial`; map caller/deadline aborts to
`cancelled`; map all other failures to `failed`.

Keep `FoundryPortfolioIncompleteError` fail-closed for every outcome other than
`complete`, including empty, because a complete authoritative portfolio cannot
be established from missing discovery records. Preserve
`FoundryPortfolioSourceFailure.provenance` unchanged.

- [ ] **Step 5: Update Foundry health and documentation**

Set `dataState` on every Foundry source. Overall health is ready only when every
source has readiness `ready` and data state `complete`. Document concurrency,
duration, source count, per-source page/item bounds, cancellation, empty-source
behavior, and the absence of mock fallback.

- [ ] **Step 6: Run Foundry checks**

Run:

```bash
pnpm --filter @agent-sentinel/foundry-connector test &&
pnpm --filter @agent-sentinel/foundry-connector typecheck &&
pnpm --filter @agent-sentinel/foundry-connector lint
```

Expected: all pass.

- [ ] **Step 7: Commit Foundry aggregation**

```bash
git add connectors/foundry docs/foundry-live-agents.md
git commit -m "Bound multi-source Foundry aggregation" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Bound Entra enrichment without weakening exact correlation

**Files:**
- Modify: `connectors/entra-identity/test/connector.test.ts`
- Modify: `connectors/entra-identity/src/client.ts`
- Modify: `connectors/entra-identity/src/index.ts`
- Modify: `docs/entra-identity-connector.md`

- [ ] **Step 1: Write failing Entra adversarial tests**

Add tests for bounded concurrency and cancellation across three matching source
IDs, deterministic composition when Graph calls settle out of order, an empty
service-principal inventory, one failed source alongside one successful source,
duplicate display names and provider IDs in different source boundaries, and
missing exact source bindings never borrowing another source.

Assert per-source `dataState` values and that one failed source leaves overall
health degraded/partial rather than ready.

- [ ] **Step 2: Run Entra tests and confirm failure**

Run:

```bash
pnpm --filter @agent-sentinel/entra-identity-connector test -- connector.test.ts
```

Expected: new bounded execution and data-state assertions fail.

- [ ] **Step 3: Propagate operation signals through the Graph client**

Add optional `signal?: AbortSignal` parameters to the Entra client probe and
collection methods. Combine the caller signal with each existing request
timeout:

```ts
const signal =
  externalSignal === undefined
    ? AbortSignal.timeout(requestTimeoutMs)
    : AbortSignal.any([externalSignal, AbortSignal.timeout(requestTimeoutMs)])
```

Pass the signal to `credential.getToken(..., { abortSignal: signal })` and
`fetch`. Preserve existing bounded pages, items, retries, retry-after, and
response bytes.

- [ ] **Step 4: Use bounded aggregation in multi-source Entra composition**

Add optional aggregation limits to `MultiEntraEnrichmentOptions`, defaulting to
50 sources, concurrency 4, total duration 60 seconds, and the configured Graph
page/item limits. Call `base.discover(request)` first, then run only exact
configured source matches through `aggregateLiveSources()`.

Compose results in configured source order. Classify no returned identities as
`empty`; incomplete capability coverage as `partial`; disabled or unavailable
provider capability as `unsupported`; old provider observations, if present,
as `stale`; rejected calls as `failed`; and aborts as `cancelled`. Never use
display name or aggregate node ID as a match key.

- [ ] **Step 5: Run Entra checks**

Run:

```bash
pnpm --filter @agent-sentinel/entra-identity-connector test &&
pnpm --filter @agent-sentinel/entra-identity-connector typecheck &&
pnpm --filter @agent-sentinel/entra-identity-connector lint
```

Expected: all pass.

- [ ] **Step 6: Commit Entra aggregation**

```bash
git add connectors/entra-identity docs/entra-identity-connector.md
git commit -m "Bound multi-source Entra enrichment" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Bound Azure Monitor and API runtime evidence aggregation

**Files:**
- Modify: `connectors/azure-monitor-otel/test/connector.test.ts`
- Modify: `connectors/azure-monitor-otel/src/index.ts`
- Modify: `apps/api/test/read-model.test.ts`
- Modify: `apps/api/src/demo-service.ts`
- Modify: `packages/domain/src/index.ts`

- [ ] **Step 1: Write failing Azure Monitor connector tests**

Add tests that pass an external abort signal, assert it reaches credential and
fetch calls, and verify source `dataState` mapping:

```ts
expect(health.sources).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ id: 'otel:project-a', dataState: 'empty' }),
    expect.objectContaining({ id: 'otel:project-b', dataState: 'failed' }),
  ]),
)
```

Also assert source rebinding preserves the aggregate agent ID while
`otelProvenance` retains exact estate ID, source connector ID, source tenant,
source environment, provider workspace resource ID, provider agent ID,
observation ID, window ID, and evidence IDs.

- [ ] **Step 2: Write failing API runtime aggregation tests**

Build a persisted snapshot with agents from at least three exact source
bindings. Use deferred telemetry reads to assert concurrency 4 or lower,
deterministic per-source outcome order, a total duration abort, failed source
isolation, empty windows producing no live evidence, and synthetic windows
remaining synthetic/unknown.

Extend expected runtime evidence with:

```ts
sources: [
  {
    sourceConnectorId: 'project-a',
    sourceTenantId: 'tenant-a',
    sourceEnvironment: 'production',
    agentIds: ['aggregate-agent-a'],
    state: 'complete',
    evidenceIds: ['otel-baseline-evidence', 'otel-observed-evidence'],
  },
]
```

- [ ] **Step 3: Run focused tests and confirm failure**

Run:

```bash
pnpm --filter @agent-sentinel/azure-monitor-otel-connector test -- connector.test.ts &&
pnpm --filter @agent-sentinel/api test -- read-model.test.ts
```

Expected: new cancellation, source state, and response-schema assertions fail.

- [ ] **Step 4: Propagate Azure Monitor operation signals**

Accept `RuntimeTelemetryReadOptions` in single- and multi-source
`readObservationWindows`. Combine caller cancellation with
`requestTimeoutMs`, pass the signal into Azure credential acquisition and the
Logs query, and retain the existing 10,000-row parser limit.

Set data state from returned windows: no accepted observations is `empty`,
quality caveat `stale` is `stale`, degraded or unknown quality is `partial`,
successful measured non-synthetic observations is `complete`, query failure is
`failed`, and abort is `cancelled`.

- [ ] **Step 5: Replace API batching with shared aggregation**

In `DemoService.queryRuntimeEvidence`, call `aggregateLiveSources()` over exact
agent telemetry requests using:

```ts
{
  maxSources: 1_000,
  maxConcurrency: 4,
  maxDurationMs: 60_000,
  maxPagesPerSource: 1,
  maxRecordsPerSource: 10_000,
}
```

Pass the operation signal to the runtime connector. Project completed,
partial, and stale measured windows only after schema and exact-provenance
validation; empty produces no evidence; unsupported, failed, and cancelled
remain explicit failures. Preserve deterministic snapshot mutation by applying
outcomes in original agent order.

- [ ] **Step 6: Extend the runtime evidence response schema**

In `packages/domain/src/index.ts`, add a strict `sources` array with exact
source connector, tenant, environment, aggregate agent IDs, typed data state,
evidence IDs, and optional sanitized reason. Keep all existing summary fields
for backward compatibility.

- [ ] **Step 7: Run Azure Monitor, domain, and API checks**

Run:

```bash
pnpm --filter @agent-sentinel/domain test &&
pnpm --filter @agent-sentinel/domain typecheck &&
pnpm --filter @agent-sentinel/azure-monitor-otel-connector test &&
pnpm --filter @agent-sentinel/azure-monitor-otel-connector typecheck &&
pnpm --filter @agent-sentinel/api test &&
pnpm --filter @agent-sentinel/api typecheck &&
pnpm --filter @agent-sentinel/api lint
```

Expected: all pass.

- [ ] **Step 8: Commit runtime aggregation**

```bash
git add packages/domain/src/index.ts connectors/azure-monitor-otel apps/api
git commit -m "Bound live runtime evidence aggregation" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Compatibility documentation and full verification

**Files:**
- Modify: `docs/connector-availability.md`
- Review only: all changed files

- [ ] **Step 1: Document aggregate truth states**

Update connector availability documentation to state that configured live
sources are aggregated with bounded concurrency and duration while existing
provider page/item/row limits remain enforced. Define complete, partial, stale,
unsupported, empty, failed, and cancelled. State explicitly that mock,
synthetic, missing, and empty evidence never establish live readiness.

- [ ] **Step 2: Run focused compatibility tests together**

Run:

```bash
pnpm --filter @agent-sentinel/connector-sdk test &&
pnpm --filter @agent-sentinel/foundry-connector test &&
pnpm --filter @agent-sentinel/entra-identity-connector test &&
pnpm --filter @agent-sentinel/azure-monitor-otel-connector test &&
pnpm --filter @agent-sentinel/api test
```

Expected: all pass.

- [ ] **Step 3: Run the full required Node 22 validation**

Confirm `node --version` is Node 22, then run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 4: Review scope and untouched files**

Run:

```bash
git status --short
git diff --name-only aac8c1f
git diff --exit-code -- infra/environments/mngenvmcap098047-foundry.parameters.bicepparam
```

The final command may show the pre-existing user change relative to `HEAD`; do
not stage, edit, restore, or include that file. Confirm the changed-name list
does not include `packages/graph-engine`, `apps/api/src/exposure-routes.ts`,
`apps/jobs`, `packages/messaging`, or worker infrastructure.

- [ ] **Step 5: Request independent code review**

Invoke `superpowers:requesting-code-review` and address only findings within
the task scope. Re-run affected focused tests after fixes.

- [ ] **Step 6: Commit the final documentation or review fixes**

```bash
git add docs/connector-availability.md
git commit -m "Document bounded live aggregation states" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If the documentation was already committed with a related implementation
change and no review fixes remain, skip this empty commit.

- [ ] **Step 7: Verify final commit and worktree state**

Run:

```bash
git --no-pager log --oneline --decorate -8
git status --short --branch
```

Expected: local commits are present; only the unrelated tenant parameter file
remains modified and unstaged.
