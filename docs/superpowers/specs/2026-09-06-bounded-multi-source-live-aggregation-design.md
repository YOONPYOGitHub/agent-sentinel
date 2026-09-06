# Bounded multi-source live connector aggregation

## Context

The live connector stack already supports multiple Foundry, Entra, and Azure
Monitor source definitions, exact source bindings, per-provider pagination or
row limits, and source health. The remaining aggregation gap is execution:
Foundry and Entra start every configured source concurrently, while API runtime
telemetry has a private batching loop with no shared duration or cancellation
contract. Empty or degraded source results are also not represented uniformly
in source health.

This change starts from `aac8c1f` and must not modify graph provenance, exposure
routes, jobs, messaging, worker infrastructure, cloud configuration, or the
unrelated tenant parameter file.

## Considered approaches

1. **Shared bounded runner with connector adapters (selected).** Add a small
   connector-SDK primitive that schedules source work with deterministic result
   ordering, bounded concurrency, a total duration deadline, external
   cancellation, and typed outcomes. Foundry, Entra, and API runtime telemetry
   retain their provider-specific page and record limits while using the shared
   runner for aggregation.
2. **Independent connector-specific loops.** This minimizes shared API changes
   but duplicates concurrency, deadline, cancellation, and outcome semantics.
   The connectors would drift and adversarial behavior would need repeated
   fixes.
3. **API-only aggregation.** This would improve runtime telemetry reads but
   leave direct Foundry and Entra live discovery unbounded, including callers
   outside the API.

## Design

### Shared execution contract

Add a connector-SDK bounded aggregation helper with:

- a strict maximum source count;
- configurable concurrency;
- a total operation duration;
- optional caller cancellation;
- deterministic input-order outcomes independent of completion order;
- typed `complete`, `partial`, `stale`, `unsupported`, `empty`, `failed`, and
  `cancelled` source states;
- sanitized failure reasons; and
- per-result page and record counts validated against caller-supplied
  per-source caps.

The helper creates one operation signal from the caller signal and deadline.
It starts no more than the configured concurrency, does not start queued work
after cancellation, and waits for started work to settle. A task that ignores
the signal is still classified as cancelled when it settles after the
deadline; connector adapters must pass the signal to token and HTTP calls so
normal live operations stop promptly.

### Foundry

`MultiFoundryConnector` will use the shared runner for connection tests and
discovery. Existing Foundry page, item, response-byte, retry, and continuation
limits remain authoritative. The single-source connector will expose the last
bounded discovery page and record counts to the aggregate adapter.

Successful non-empty source snapshots are `complete`. Successful zero-agent
snapshots are `empty`. Bound exhaustion is `partial`; authorization and other
failures are `failed`; cancellation remains distinct. Any non-complete source
prevents the portfolio from returning a complete authoritative snapshot.
`FoundryPortfolioIncompleteError` continues to carry exact estate, tenant,
environment, source, provider, and provider object provenance.

### Entra

`MultiEntraEnrichmentConnector` will run configured source discovery through
the same bounded runner after authoritative Foundry discovery succeeds. The
existing Graph client page, item, retry, response-byte, and request timeout
limits remain in force, and the operation signal is propagated to Graph token
and HTTP requests.

Each source is composed only into Foundry agents with the exact configured
source ID and tenant/environment boundary. Empty inventories, incomplete
optional capability coverage, unsupported capability states, stale results,
failures, and cancellation remain separate source data states. Display names
and aggregate/local node IDs never become correlation keys.

### Azure Monitor and API runtime aggregation

The runtime telemetry contract gains an optional operation signal. Azure
Monitor combines it with its request timeout and passes it to credential and
HTTP operations. The API replaces its private batch loop with the bounded
runner, retaining exact source connector, source tenant, source environment,
provider agent, aggregate agent, snapshot, window, observation, and evidence
IDs.

Azure Monitor query rows remain capped by the existing provider parser and
schema. Runtime aggregation adds a total duration and records/pages validation
at the orchestration boundary. Empty windows are typed `empty`, stale quality
is `stale`, degraded quality is `partial`, unsupported attribution is
`unsupported`, and provider or projection errors are `failed`. Synthetic
observations are never promoted to live runtime evidence.

### Health and compatibility

Extend source health with an optional typed data state and ensure the health
schema preserves exact source provenance. Existing readiness values and
callers remain compatible. Overall readiness can be `ready` only when every
enabled configured source completed without a failed, cancelled, partial, or
stale result. Valid-empty remains visible and does not create live evidence.

Single-source legacy environment variables and existing no-argument connector
calls remain supported. No writes, permission changes, network changes, or
external system mutations are introduced.

## Tests

Focused tests will cover:

- deterministic output under out-of-order completion;
- concurrency, source-count, page, record, and duration bounds;
- caller cancellation and queued-work suppression;
- one failed source preventing complete success;
- explicit empty, stale, unsupported, partial, failed, and cancelled states;
- duplicate provider IDs and display names remaining separate by exact source
  binding;
- preservation of estate, tenant, environment, source, provider object, agent,
  snapshot/window, observation, and evidence IDs;
- synthetic and empty telemetry never becoming live evidence; and
- single-source and existing constructor compatibility.

Final validation is the repository Node 22 lint, typecheck, test, build, and
`git diff --check` suite.
