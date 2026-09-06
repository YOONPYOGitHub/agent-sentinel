# GitHub Copilot coding agent handoff

## Purpose

This document gives GitHub Copilot coding agents enough context to implement
Agent Sentinel work safely in parallel. It is an execution handoff, not a claim
that every listed capability is deployed.

The integration owner retains responsibility for architecture decisions,
Azure/Microsoft 365 operations, permissions, real-data validation, deployment,
OneRAI, and final integration. Coding agents own bounded repository changes and
local validation only.

## Product mission and non-negotiable loop

Agent Sentinel is not another agent inventory dashboard and does not replace
Agent 365, Entra, Defender, Purview, Copilot Studio, or Foundry. It connects
their evidence to answer questions that cross control-plane boundaries.

The minimum complete product loop is:

1. **Connect** one or more authorized tenant/source instances.
2. **Discover** authoritative agents from each source.
3. **Normalize** agents, identities, tools, data, telemetry, distribution, and
   cloud resources into an evidence graph with exact provenance.
4. **Correlate** those entities using immutable provider identifiers only.
5. **Analyze** deterministic exposure, attack paths, assurance, and missing
   evidence.
6. **Govern** findings through cited, auditable, reversible, human-approved
   workflows.

A feature is not complete because a page renders. It is complete when its
evidence is real or explicitly synthetic, its boundary is enforced, and tests
prove failure states without requiring model access.

## Repository and branch state

- Repository: `YOONPYOGitHub/agent-sentinel`
- Integration branch: `feature/multi-source-otel`
- Integration head before the isolated release-evidence work: `ae531c2`
- Last evidenced deployed image: `7458b3e`; commits after that tag are code
  state only until a new sanitized deployment observation is supplied.
- Default branch `main` is 79 commits behind the integration branch at the time
  this document was prepared.
- Do not start implementation from `main` until the integration owner confirms
  synchronization. A task should explicitly use `feature/multi-source-otel` as
  its base.
- Runtime: Node.js 22, `pnpm@10.15.1`, TypeScript, Turborepo.

Important references:

- Product intent: `agent-sentinel-product-spec.md`
- Architecture: `docs/architecture.md`
- Data model: `docs/data-model.md`
- Connector status: `docs/connector-availability.md`
- Roadmap: `docs/roadmap.md`
- Current operational ledger: `docs/current-status.md`
- Known issues: `docs/known-issues.md`
- Release evidence: `docs/release-evidence.md`

Versioned sanitized release evidence takes precedence for release-specific
claims. Repository-only evidence proves commit and dirty state but deliberately
leaves checks, deployment, connectors, and live validation non-pass. Do not
promote a code, test, or historical live claim to deployment success.

## Current verified implementation

### Working foundation

- React SPA, Fastify API, and jobs worker run as a pnpm monorepo.
- Foundry discovers six repository-managed synthetic validation agents from the
  replacement environment.
- Entra, Purview, Defender for Cloud Apps, Teams catalog, Azure Resource Graph,
  and Azure Monitor OTel read paths are implemented and have replacement-tenant
  live evidence. Some sources are valid-empty or unattributed.
- Cosmos persists snapshots, exposure findings, governance cases, transition
  history, and manifest ingestions.
- Deterministic policy and graph engines generate cited exposure findings.
- Overview, inventory, exposure detail, evidence graph, governance posture,
  connectors, observability, and related pages exist.
- OneRAI evaluation tooling executes synthetic live Foundry probes and records
  agent version and manifest hash. Generated JSON/CSV evidence is intentionally
  ignored by git.
- Versioned release-evidence tooling generates and validates strict sanitized
  manifests without calling Azure or Microsoft 365. Live summaries must be
  supplied explicitly by the integration owner.
- Full repository lint, typecheck, unit tests, and build passed for the estate
  isolation commits described below.

### Multi-estate work already merged on the integration branch

- `7cab709`: canonical `EstateContext`, deployment estate registry,
  authentication-tenant allow-list, `/api/estates`, opaque estate selection
  header, and exposure tenant/environment assertion enforcement.
- `8c2daab`: active snapshot and exposure persistence require `EstateContext`;
  same-tenant environments are isolated; Cosmos uses estate-prefixed wrapper
  documents and default-estate-only bounded legacy reads.
- `4c5f201`: worker events require estate ID, tenant ID, and environment and
  fail closed on mismatch.

Non-default estates remain blocked on API surfaces that are not yet estate-aware.
Do not remove that block before every underlying service and cache is scoped.

### Important incomplete or disabled areas

- The deployed Azure image `7458b3e` lags the `ae531c2` code baseline used for
  this handoff. Coding agents must not claim later code is deployed.
- User sign-in is disabled in the replacement deployment even though JWT/RBAC
  and MSAL code exists.
- Entra service-principal inventory works, but migration parity is incomplete
  until corporate API/SPA authentication and exact agent-to-identity `RUNS_AS`
  correlation are demonstrated.
- Entra owner and app-role enrichment are separately gated. Agent Identity beta
  enrichment requires separately approved least privilege.
- The estate-scoped connector source configuration plane exposes deployment
  sources as read-only and supports gated user-source CRUD with strict
  non-secret schemas, ETags, idempotency, and immutable audit records. Its test
  surface reads stored evidence status only; it does not call providers or
  manufacture readiness. Deployment-time JSON/Bicep source arrays remain the
  active runtime configuration until a separately approved activation task.
- Agent 365 connector code exists but entitlement activation is pending.
- Power Platform unattended inventory remains blocked by unsupported app-only
  authorization.
- OTel is connected, but representative baseline/observed samples and persisted
  observation evidence remain incomplete.
- Quality, measured cost, and business outcome dimensions stay unknown without
  authoritative sources.
- Live remediation execution is unsupported and writes remain disabled.
- The strongest current response is a simulation-only graph preview, not a
  prediction of real operational impact.

## Evidence and security invariants

1. Never present mock, fixture, synthetic, empty, or missing evidence as live
   success.
2. Every live claim must retain estate, tenant, environment, connector source,
   source object ID, timestamp, freshness, confidence, and evidence reference.
3. Preserve valid-empty independently from unavailable, unauthorized, degraded,
   stale, and unknown.
4. Reject tenant, environment, source, or identity mismatches. Do not fall back
   to another source.
5. Exact identity correlation only. Display names and aliases are not identity
   keys.
6. Partial authoritative discovery must not overwrite the latest complete
   snapshot or resolve prior findings.
7. Writes require JWT, exact capability checks, deployment write enablement,
   idempotency, audit evidence, and reversible execution. Do not enable writes
   in a coding-agent task.
8. Secrets must not enter source definitions or API responses. Prefer managed
   identity or secretless federation; persist only secret references if a later
   approved design requires them.
9. Do not broaden Graph permissions or use preview APIs merely to make a demo
   pass.
10. Do not alter cloud resources, permissions, networking, or external systems.

## Dependency-ordered implementation plan

### P0-A: Finish web and API estate context

**Goal:** A selected estate scopes every request, cache, and response without
cross-estate leakage.

Primary files:

- `apps/web/src/api/auth-fetch.ts`
- `apps/web/src/hooks/DemoStateProvider.tsx`
- new estate context/provider and API schema files under `apps/web/src`
- `apps/web/src/components/AppLayout.tsx`
- `apps/api/src/estate-auth.ts`
- tenant-bound route modules in `apps/api/src`

Acceptance criteria:

- Load authenticated `/api/estates`.
- Persist only the opaque estate ID, never credentials or access tokens.
- Inject `x-agent-sentinel-estate-id` on API requests.
- Clear old state before loading a different estate.
- Ignore or abort stale responses after a switch.
- Scope drift, economics, business-value, governance, exposure, and demo-state
  caches by estate.
- Render no selector when only one estate is authorized.
- Keep non-default estates blocked on any server route not yet scoped.
- Add tests for header injection, switching, stale response cancellation, and
  default single-estate compatibility.

### P0-B: Persist connector source definitions

**Goal:** Establish a safe configuration-plane domain without yet activating
dynamic credentials or cloud writes.

Primary files:

- new connector-source domain schema in `packages/domain/src`
- repository interface in `packages/domain/src/repositories.ts`
- in-memory and Cosmos adapters in `packages/persistence/src`
- Cosmos Bicep container definition in `infra/modules/cosmos.bicep`

Record requirements:

- Estate ID and data tenant/environment.
- Stable source ID, connector type, display name, enabled state.
- Immutable origin: `deployment` or `user`.
- Connector-specific, strict, non-secret configuration.
- Credential mode and safe identity/reference metadata only.
- Version/ETag, created/updated timestamp, and actor.
- Append-only audit transition and idempotency key.

Acceptance criteria:

- Partition and authorize by estate.
- Same source ID may exist in different estates but not twice in one estate.
- Deployment sources are read-only and cannot be overridden by a user source.
- Optimistic concurrency maps stale ETags to an explicit conflict.
- API-facing objects never contain secret values.
- Existing deployment JSON remains the runtime source until activation is
  implemented.

### P0-C: Connector source CRUD and test API

**Depends on:** P0-A and P0-B.

**Goal:** Allow an Administrator to create, update, disable, delete, list, and
test non-secret connector source definitions.

Primary files:

- new routes under `apps/api/src`
- `apps/api/src/app.ts`
- `apps/api/src/auth.ts`
- connector-specific source schemas

Acceptance criteria:

- `configure` capability is mandatory in JWT mode.
- Every route uses `request.estateContext`.
- Strict Zod validation, bounded body sizes, pagination, idempotency, ETag
  concurrency, and immutable audit records.
- Test connection is read-only, bounded, timed out, and cannot mutate provider
  state.
- A failed test remains a failed/degraded state; it is never saved as ready.
- Deployment-origin records are visible but immutable.
- Disabled authentication or disabled live writes cannot create a
  production-looking user source.

### P0-D: Restore Entra migration parity

**Goal:** Keep replacement-tenant inventory while restoring the missing
identity and authentication parts of the original loop.

Coding-agent scope:

- Tests and configuration plumbing for corporate API/SPA authentication.
- Exact `RUNS_AS` correlation diagnostics and coverage summaries.
- Owner/app-role enrichment behavior using existing approved stable APIs.
- Clear separation between user authentication (`AUTH_*`) and Entra inventory
  (`ENTRA_*`).

Out of scope for coding agents:

- App registration changes, Conditional Access interaction, admin consent,
  Graph permission grants, and beta activation.

Acceptance criteria:

- No claim of Entra completion based only on inventory count.
- Report total authoritative agents, exact identity matches, ambiguous/missing
  matches, and evidence IDs.
- `RUNS_AS` is emitted only for one exact matching service-principal object ID,
  app/client ID, or Agent Identity ID.
- Authentication tenant and data estate tenant remain separate concepts.
- Optional enrichment failure degrades that source without erasing stable
  inventory.

### P0-E: Complete agent evidence correlation

**Depends on:** P0-C and P0-D.

**Goal:** For each authoritative agent, produce a coverage record over identity,
runtime, tools, data, distribution, and cloud resources.

Acceptance criteria:

- Typed source provenance rather than unstructured metadata-only joins.
- Exact per-source routing and no cross-tenant substitution.
- Duplicate provider agents are correlated deliberately, not silently merged by
  display name.
- Missing planes remain explicit unknowns.
- Persist content-addressed OTel observation-window evidence and reference it
  from analysis.
- Analysis runs across all authoritative discovered agents, not a fixed subset.

### P1: Connector onboarding UI

**Depends on:** P0-A through P0-C and corporate auth activation.

Implement accessible add/edit/disable/delete/test flows on Connectors. Reuse
existing permission hooks, controlled form patterns, error states, and connector
health cards. Deployment sources are read-only. Never display secret material.

### P1: Demo and release hardening

This work must use the same production code and evidence loop:

- One deterministic desktop path:
  Overview -> critical exposure -> cited graph -> simulation-only containment ->
  agent assurance -> observability.
- Disable or explain unavailable write actions in read-only mode.
- Correct stale connector messages.
- Fix core laptop overflow and mobile navigation before claiming responsive
  support.
- Make the clean-checkout E2E path green.
- Generate one sanitized, versioned release evidence manifest containing commit
  SHA, image digest, configuration hash, test results, live validation result,
  and timestamp.

## Parallel work allocation

Use these packages to avoid merge conflicts:

| Package                          | Owns                                                            | Must not touch                                    |
| -------------------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| A: Estate web context            | web API fetch, estate provider, selector, estate cache tests    | connector-source domain/persistence               |
| B: Connector source domain       | domain schemas, repository contracts, persistence, Cosmos Bicep | React pages and estate provider                   |
| C: Entra correlation diagnostics | Entra normalization/composition and focused tests               | authentication registrations or cloud permissions |
| D: Release evidence tooling      | scripts, evidence schema, documentation reconciliation          | connector runtime logic                           |
| E: Demo UX/E2E                   | read-only action state, responsive core pages, E2E              | domain and persistence contracts                  |

Do not run packages A and E concurrently unless file ownership is narrowed
further. P0-C starts only after A and B are merged.

## Validation matrix

During development, build workspace dependencies before dependent package
checks when exported types changed.

Required final checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Additional checks:

- Web/routing changes: `pnpm test:e2e`
- Bicep changes: `az bicep build -f infra/platform.bicep`
- Connector changes: connector package tests plus API/jobs composition tests
- Persistence changes: in-memory and fake-Cosmos concurrency/isolation tests
- Auth changes: API RBAC tests and browser token tests without real credentials

Do not report live validation from a cloud-agent environment. State that the
integration owner must run replacement-tenant validation after merging.

## Required completion report

Every coding-agent pull request must state:

1. Task and acceptance criteria completed.
2. Files and contracts changed.
3. Tests and commands run.
4. Security and evidence-boundary impact.
5. Migration/backward-compatibility impact.
6. Remaining unknowns and exact live validation required.
7. Confirmation that no cloud resource, permission, external system, secret, or
   generated live evidence was modified.
