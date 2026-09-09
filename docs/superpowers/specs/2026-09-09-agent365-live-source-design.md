# Agent 365 live source design

## Scope

Activate the existing read-only Microsoft Agent 365 package-catalog connector
from enabled connector-source records for the exact requested estate. Preserve
deployment JSON as an immutable compatibility source, use the same runtime
resolution in API and jobs, and retain the current no-write, no-scraping
boundary.

The existing dirty replacement-tenant parameter file is operational input. It
must remain unmodified and uncommitted.

## Prior art and selected approach

Three approaches were evaluated:

1. Import the existing `fix/connector-runtime-binding-r10` branch wholesale.
   This has useful shared runtime-source patterns, but it changes every
   connector, persistence generation semantics, connection-test APIs, and the
   dirty deployment parameter file. It is broader than this work package.
2. Resolve Agent 365 sources independently in API and jobs. This is small but
   duplicates deployment-source projection and risks divergent runtime
   behavior.
3. **Selected:** extract the existing deployment-source projection into the
   shared `@agent-sentinel/connector-runtime` package pattern, then add a
   focused Agent 365 runtime resolver used by both apps. Existing environment
   configuration remains the fallback path; persisted enabled sources become
   authoritative when a connector-source repository is supplied.

## Runtime source resolution

The shared resolver will:

- Read connector-source records through bounded, advancing pagination.
- Validate every returned record and reject estate, tenant, or environment
  mismatches.
- Select only `agent365` records for runtime composition.
- Keep disabled records and unsupported credential modes visible as inactive
  source health rather than executing them.
- Activate only explicit managed-identity or managed-identity-backed
  federated-app credentials.
- Preserve each record's source ID, tenant, environment, display name,
  Graph-origin restriction, limits, origin, version, and ETag in the runtime
  binding.
- Merge immutable deployment sources through the same
  `DeploymentConnectorSourceRepository` used by the API.

The API resolves the default estate at startup. The jobs worker resolves the
same combined repository before every ingestion run so later source changes do
not leave a stale worker connector active.

## Connector execution

The Agent 365 Graph client will accept a caller `AbortSignal` in addition to its
existing request timeout. Token acquisition, fetches, and retry waits will stop
on caller cancellation. Pagination remains constrained to the provider-issued
same-origin v1.0 package-list path and enforces per-source page, item, byte,
retry, and timeout bounds.

Multi-source collection will use the repository's bounded live aggregation
helper with at most two concurrent source executions and one aggregate
deadline. Each source reports typed `complete`, `empty`, `failed`, or
`cancelled` data state with measured page and record counts. Empty provider
responses remain valid provider responses but do not claim non-empty discovery
coverage. Any failed or cancelled enabled source keeps the aggregate snapshot
partial so jobs do not persist or reconcile incomplete authoritative data.

## Package classification and provenance

Every package remains a package-catalog observation. Classification is
deterministic and does not assert that every package is an agent:

- `agent365-agent`: a package with a documented agent element (`bot`,
  `declarativeAgent`, or `customEngineAgent`) or the documented `Copilot` host.
- `m365-declarative-agent`: a declarative-agent package hosted in `M365`.
- `sharepoint-declarative-agent`: a declarative-agent package hosted in
  `SharePoint`.
- `extension-package`: every other package.

M365 and SharePoint classifications are additional specificity, not separate
provider records or scraping paths. A package with multiple applicable hosts
retains all classifications while producing one node and one evidence record.

Every node, evidence record, and source health entry retains the exact estate,
tenant, environment, connector-source ID, provider package ID or fixed catalog
endpoint, observation time, and source name. Display names never participate in
identity or correlation. No detail endpoint, package content, SharePoint
content, principals, write endpoint, or inferred tool/runtime relationship is
used.

## API and jobs behavior

Both factories accept an optional resolved Agent 365 runtime. The ordinary
environment-only factory remains backward compatible for tests and deployments
without connector-source persistence.

The API exposes current source-linked health through the existing connector
status/catalog surfaces. Jobs use the same source IDs and persist the composed
health report. Inactive persisted Agent 365 records remain visible with stable
reasons such as `source-disabled` or
`dedicated-workload-identity-required`.

## Errors and safety

Provider, authorization, licensing, malformed-response, bounds, timeout, and
cancellation failures remain sanitized stable reason codes. Cancellation is
not rewritten as timeout or network failure. A source that has not executed is
not ready, and a synthetic or local fixture never creates a live pass.

The implementation performs no Azure, Microsoft 365, Entra, package, permission,
license, deployment, or other external mutation.

## Tests and validation

Focused tests will cover:

- persisted enabled/disabled source resolution and immutable deployment-source
  composition;
- API/jobs factory parity and exact source IDs;
- caller cancellation during token acquisition, fetch, and retry delay;
- page, item, byte, source-count, concurrency, and aggregate-duration bounds;
- complete, empty, failed, and cancelled health;
- Agent 365, M365 declarative, SharePoint declarative, and non-agent extension
  classification;
- exact tenant/source/package provenance and duplicate-ID rejection.

Validation uses Node.js 22.23.2 and pnpm 10.15.1 with concurrency limited to two.
Only affected package tests, lint, typecheck, formatting checks, and
`git diff --check` run; full repository gates, Playwright, Bicep, deployment,
and live provider calls remain out of scope.
