# Current status

**Status date: 2026-09-01** · Branch: `feature/multi-source-otel`

This is the authoritative dated ledger for the Agent Sentinel control plane. Every row states what is true today, not what is intended. Where a capability is absent, the ledger says so rather than describing it as pending success.

This document contains no secrets, tokens, subscription or tenant identifiers, personal contact details, or local absolute user paths.

Connector implementation, blocker type, and activation conditions are tracked
in [connector-availability.md](connector-availability.md).

---

## Replacement connector revalidation

Live state was revalidated at **2026-09-01 14:23 KST**:

- All seven configured sources report `ready`: Foundry, Entra, Defender for
  Cloud Apps, Purview, Azure Resource Graph, Teams organization catalog, and
  Azure Monitor OTel. Aggregate health is `ready` with `partial=false`.
- The latest complete jobs snapshot contains 349 nodes: 6 agents, 11 tools,
  315 identities, and 17 controls, with 338 evidence records.
- Defender alert/activity and Teams organization-catalog reads are valid empty
  results. They are connected, but zero records do not prove broader coverage.
- The three runtime identities retain only the approved reads:
  `Application.Read.All`, `SensitivityLabel.Read`, `Investigation.Read`, and
  `AppCatalog.Read.All`. Global Reader is the only active directory role.
- Agent 365 remains intentionally excluded. Power Platform remains disabled
  because Microsoft does not support unattended ResourceQuery inventory
  authorization. The manifest adapter remains write/auth-gated, and the
  business-outcome connector has no authoritative source to configure.
- API and jobs keep authentication disabled and writes false. No additional
  connector can be safely activated from the current implemented catalog.

---

## Recent delivery on `feature/governance-phase1-completion`

| Commit    | Change                                             | Effect                                                                                                                                                              |
| --------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `31495ef` | Shared UI container build integration              | Includes and builds the new workspace UI package inside the isolated web image context.                                                                             |
| `2fe089b` | Shared page header and operational states          | Routes every page through one accessible header contract and migrates Optimization loading, error, and empty states.                                                |
| `5d72f54` | Agent Sentinel UI and Storybook foundation         | Adds semantic design tokens, reusable KPI/status/freshness/data-state primitives, accessibility-enabled stories, and operational-page adoption.                     |
| `9e7735e` | Exact runtime correlation preservation             | Preserves bounded direct run, operation-correlation, and version context from OTel while reporting linkability separately from outcome joins.                       |
| `97d959c` | Measured-cost attribution                          | Attaches source-cited owner and business-unit context only from the exact authoritative agent while keeping missing boundaries typed `partial` or `unknown`.        |
| `f8cf4e9` | Typed manifest configuration verification          | Compares supported typed adapter declarations with exact authoritative values while keeping free-form claims explicitly unverified.                                 |
| `c938766` | Logout redirect transaction completion             | Processes the MSAL redirect response before login is available; production logout followed by login completes without stale interaction state.                      |
| `3cb3851` | Governance lifecycle browser coverage              | Covers approve, reject, expire, re-evaluate, and immutable transition evidence across the full Playwright suite.                                                    |
| `6b3f103` | Durable governance ordering index                  | Persists the Cosmos composite index required by governance case ordering.                                                                                           |
| `aab8c80` | Cosmos governance query compatibility              | Quotes reserved fields and serves authenticated governance reads from the durable repository.                                                                       |
| `ccebda2` | Entra v2 access-token audience validation          | Normalizes the configured API URI to the GUID audience emitted by Microsoft identity platform v2 tokens.                                                            |
| `8f9b3f7` | MSAL popup redirect bridge                         | Completes employee popup sign-in through the registered same-origin static bridge.                                                                                  |
| `acbb483` | Redirect-origin status correction                  | Records the approved Front Door HTTPS redirect/logout origin and registered SPA URLs.                                                                               |
| `39a8917` | Staged Entra authorization preparation             | Fail-closed JWT/MSAL configuration, capability probes, and token-driven live validation.                                                                            |
| `9fa550a` | Phase 10 shift-left scanner                        | Offline local/CI publish gate reusing manifest acceptance, normalization, runtime policies, domain findings, and cited evidence.                                    |
| `5fc9415` | Governance Phase 1 workflow increment              | Assignment, state guards, anonymous disabled-auth context, source-cited immutable history, bounded policy exceptions, and lifecycle evidence transitions.           |
| `a654ab6` | Azure Monitor OTel runtime connector               | Restricted read-only Logs query, strict row mapping, live behavior/token-economics integration, and local contract fixtures. Deployment activation remains pending. |
| `8179785` | Microsoft Entra authentication and RBAC foundation | JWT validation, four roles, per-route capability guards, SPA MSAL wiring. Not activated.                                                                            |
| `849b40b` | Entra Graph live-contract correction               | Accepts bounded `@odata.type` metadata and Azure application GUIDs, allowing the full primary-tenant service-principal inventory to validate.                       |
| `495a5f0` | Sanitized connector failure diagnostics            | Preserves stable provider reason codes in source health and jobs logs without exposing provider payloads.                                                           |
| `9acff50` | Benign telemetry-only validation mode              | Separates six-agent AppRequests validation from safety probes that may be stopped by provider policy.                                                               |

---

## Complete

| Item                                       | Evidence boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full application shell and navigation      | Thirteen routes plus global search are implemented with API, component, and end-to-end coverage for the work queue and established surfaces.                                                                                                                                                                                                                                                                                                                                       |
| Mock acceptance path across every surface  | Deterministic in-repository fixtures; no Azure access required to run or test the product.                                                                                                                                                                                                                                                                                                                                                                                         |
| Live Microsoft Foundry discovery           | **Live declared configuration only.** Agent and function-tool definitions. No runtime traces, tool authorization, or cost.                                                                                                                                                                                                                                                                                                                                                         |
| Multi-Foundry aggregation foundation       | **Implemented; one live source configured.** Up to 50 tenant/project sources have independent credentials, stable source namespaces, aggregate estate isolation, per-source health, and fail-closed partial snapshot handling. Cross-tenant access supports secretless managed-identity federation.                                                                                                                                                                                |
| Multi-source OTel routing foundation       | **Live for the primary source.** Aggregate agent ids resolve through the persisted snapshot to exact source workspace/tenant/environment/provider-agent bindings. Workspace-scoped UAMI reads return measured windows and typed `insufficient-data` when samples are sparse. Direct agent-run, operation-correlation, and agent-version identifiers are preserved under the same bounded correlation vocabulary.                                                                   |
| Cosmos-backed exposure findings            | **Live.** Container `findings`, partition key `/tenantId`, upsert preserves `firstSeen`.                                                                                                                                                                                                                                                                                                                                                                                           |
| Cosmos-backed governance posture           | **Live.** Derived from the same findings; posture tiles deep-link to the filtered findings that produced them.                                                                                                                                                                                                                                                                                                                                                                     |
| Jobs ingestion loop                        | **Live.** Interval discovery plus optional `snapshot-ingestion` Service Bus trigger with idempotency.                                                                                                                                                                                                                                                                                                                                                                              |
| Terra live validation, 6 of 6              | **Synthetic, operator-invoked.** `pnpm foundry:validate` exercises all six agents; never run by CI.                                                                                                                                                                                                                                                                                                                                                                                |
| Agent inventory and assurance catalog      | **Current.** Populated from live Foundry discovery; other platforms are absent, not empty-but-clean.                                                                                                                                                                                                                                                                                                                                                                               |
| Evidence-backed scorecard foundation       | **Partial live integration.** Agent detail and lifecycle use persisted exposures. Governance mixes declared owner/trust with exposures; release-history evidence is not connected. Reliability now consumes exact Azure Monitor error-rate evidence and remains `unknown` until both windows have at least ten samples. Cost and quality remain `unknown` live.                                                                                                                    |
| Connector management catalog               | **Current status surface.** Replacement-tenant Foundry, Entra, Purview, Defender for Cloud Apps, Teams organization catalog, Azure Resource Graph, and Azure Monitor OTel sources are connected. The manifest adapter remains activation-gated; Agent 365, Power Platform, and other platform entries retain their explicit prerequisite states.                                                                                                                                   |
| Unified live estate snapshot read model    | **Current.** Live `/api/demo/state` reads the latest jobs-persisted Cosmos snapshot for the exact configured tenant and environment. Inventory, catalog, lifecycle, trust, optimization, and observability no longer trigger an independent Foundry discovery. Missing persisted state returns explicit `503` without a mock fallback.                                                                                                                                             |
| Unified live exposure projections          | **Current and deployed as `7458b3e`.** Live Overview renders persisted `ExposureFinding` posture instead of the mock workflow and derives counts from the current snapshot. Unsupported estate dimensions remain `unknown`; stale, refreshing, unavailable, public, unclassified, and modeled states are explicit. Trust, lifecycle, agent detail, exposure, and governance consume the same active exposure contract; the legacy attack-path `Finding` remains mock-only.         |
| Entra authentication and RBAC              | **Replacement activation pending.** The corporate API and SPA registrations remain reusable, but the replacement Front Door redirect/logout URIs and runtime parameters have not been activated. The replacement deployment remains `AUTH_MODE=disabled` and writes remain false; the previous tenant's read-only JWT validation is historical evidence, not the current deployment state.                                                                                         |
| Entra identity enrichment                  | **Live for the replacement primary source.** `Application.Read.All` currently reads 323 validated service principals into the complete Cosmos snapshot. Optional owners, app roles, and preview APIs remain disabled. Current Foundry agents expose no matching identity metadata, so `RUNS_AS` correlation is correctly empty rather than inferred.                                                                                                                               |
| Azure Resource Graph inventory             | **Live for the current authorized view.** A fixed GA REST query maps only bounded Azure AI/supporting-resource fields to unattributed control/evidence records. User validation returned 64 resources; the narrower application UAMI persisted 5 visible resources and zero inferred edges without a new Reader assignment.                                                                                                                                                        |
| Cloud resource inventory surface           | **Current.** A dedicated route exposes only Azure Resource Graph control nodes with text/type/group/location/subscription filters and cited evidence. It labels RBAC-limited coverage explicitly and makes no agent, health, trust, or compliance inference.                                                                                                                                                                                                                       |
| Power Platform agent inventory             | **Implemented; unattended activation unsupported.** The official ResourceQuery connector is bounded and disabled. Microsoft currently supports inventory through delegated `ResourceQuery.Resources.Read` plus a supported Entra role, while explicitly excluding preview Power Platform RBAC roles from inventory access. An environment filter is not an authorization boundary, so no live inventory is persisted.                                                              |
| Defender for Cloud Apps evidence           | **Live, read-only.** Defender XDR is provisioned and the exact About-page API URL, connector UAMI `Investigation.Read`, and API/jobs source configuration are active. Both bounded list probes are ready. The 24-hour source currently returns zero alerts and activities, so the complete snapshot correctly adds no Defender controls or evidence and makes no agent attribution claim.                                                                                          |
| Purview sensitivity-label catalog          | **Live, read-only.** The replacement connector identity and `SensitivityLabel.Read` source are active on API/jobs. Twelve bounded label controls are persisted as unattributed evidence without content, usage, user, agent, trust, or compliance claims.                                                                                                                                                                                                                          |
| Teams tenant app catalog                   | **Live, read-only.** Replacement Teams licensing, the dedicated identity, and `AppCatalog.Read.All` are active. The bounded organization-catalog query is ready and currently returns zero organization entries; this is retained as an empty catalog result, not interpreted as installation or distribution coverage.                                                                                                                                                            |
| Azure deployment                           | **Live in the replacement tenant.** Container Apps `web`, `api`, and `jobs` run on a private ACA environment behind Front Door. Foundry, Entra, Purview, Defender, Teams catalog, Azure Resource Graph, and Azure Monitor reads are active; authentication and every write path remain disabled.                                                                                                                                                                                   |
| Corporate Service Tree registration        | **Complete.** Registered under the confirmed `MCAPS > GES Asia > Korea` hierarchy with two administrators.                                                                                                                                                                                                                                                                                                                                                                         |
| Universal custom manifest adapter          | **Implementation complete, activation pending.** Strict offline input, immutable ingestion, jobs composition, exact source-bound runtime verification, authoritative-object reconciliation, and exact typed configuration-value comparison are implemented. Missing, invalid, and mismatched authoritative values remain distinct; no graph relationship or free-form claim equivalence is inferred. Live ingestion stays blocked by writes-false and the public mutation posture. |
| Deterministic behavior-baseline engine     | **Current and deployed as `24f5353`.** `@agent-sentinel/behavior-engine` implements median/MAD statistics, drift analysis, evidence coverage, and typed `DriftAnalysisResult`. Reliability requires content-bound baseline/observed evidence, exact window provenance, source binding, and 10+10 samples. Five-minute aligned query windows keep IDs stable while late-arriving content produces a new evidence ID.                                                                |
| Token Economics foundation                 | **Current.** `analyzeTokenEconomics()` uses measured-only populations, reconciled coverage, evidence-linked MAD anomalies, and same-population cost per success. Reports expose exact run/correlation coverage separately from broad version context and attach source-cited owner/business-unit values only from the exact authoritative agent. Live mode remains `insufficient-data` below the ten-sample floor.                                                                 |
| Business-value evidence foundation         | **Current.** Outcome contracts carry run/correlation/version identifiers; the current resolver accepts only the exact discovered agent version. Source-authored values and evidence are preserved without aggregation, monetary estimates, or invocation proxies. Mock outcomes are explicitly synthetic; live mode remains `unknown` until an authoritative source is configured.                                                                                                 |
| Governance workflow and durable repository | **Current.** Valid transitions, explicit assignment, separation of duties, source/actor/timestamp audit evidence, bounded policy exceptions, and promote/drift-acknowledge/rollback/retire evidence transitions are enforced. Remediation approvals require and preserve a bounded rationale through connector execution; unsupported connector execution returns a controlled rejection.                                                                                          |
| Phase 10 shift-left scanner                | **Current, offline.** `@agent-sentinel/shift-left-scanner` and `pnpm manifest:scan` evaluate validated manifests with the unchanged runtime policy catalog and finding/evidence shapes. Deterministic pass/warn/block output and CI exit codes are available without Entra, ingestion, deployment, or network access.                                                                                                                                                              |
| Shared UI and Storybook foundation         | **Current.** `@agent-sentinel/ui` owns semantic design tokens plus reusable page-header, KPI, status, freshness, and data-state components. Storybook covers realistic loading, empty, degraded, denied, error, synthetic, and healthy states with accessibility checks; every page uses the shared header, while Observability/Optimization consume shared KPIs and Optimization uses shared operational states.                                                                  |

---

## In progress

| Item                                         | Where it stands                                                                                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unified inventory for future connectors      | Inventory renders any connector's records. Purview supplies live governance controls; Defender and Teams are ready with valid empty results, while Power Platform lacks supported unattended authorization.                                                                    |
| Azure Resource Graph coverage                | The connector is live with 5 UAMI-visible resources. Complete subscription coverage remains optional and requires separate approval for broader Reader RBAC.                                                                                                                   |
| Azure Monitor measured windows               | Query health is ready and 6 benign spans were ingested across 6 agents. Exact-match runtime graph projection and explicit evidence typing are implemented; drift and economics remain `insufficient-data` because the baseline has 0 samples and the minimum population is 10. |
| Employee catalog entitlement personalization | The assurance overlay renders. Per-employee entitlement filtering needs an authenticated principal.                                                                                                                                                                            |
| Additional Foundry sources                   | Runtime aggregation is implemented. Each target project still requires an approved credential/federation setup and `Azure AI User`; the current deployment remains the `primary` source only.                                                                                  |
| Live role coverage                           | Employee login and Viewer boundaries are validated. Analyst, Approver, Administrator, and write-scope live-token validation remain pending before any public write-path change.                                                                                                |
| Manifest ingestion activation                | The dedicated container and API/jobs images are deployed. The endpoint remains blocked by writes-false; activation requires Administrator, write-scope, and exact public-edge mutation validation.                                                                             |
| Repository documentation                     | This rebuild. Superseded and contradictory statements are being corrected in place.                                                                                                                                                                                            |

---

## Blocked

| Item                                 | Blocking condition                                                                                                                           | Unblocks when                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Terra authenticated `POST`           | The `BlockApiMutationPreAuth` WAF rule blocks every non-`GET`/`HEAD`/`OPTIONS` request under `/api/` pre-auth.                               | Authenticated write scopes are validated, then the rule is narrowed.                                  |
| WAF rule narrowing                   | Must not be relaxed until the authenticated write path is proven and anonymous mutation remains denied.                                      | JWT write-scope tests and an authorized remediation smoke test pass.                                  |
| Employee entitlement personalization | Requires tenant-authorized Entra entitlement evidence beyond the now-active authenticated principal.                                         | Activate and validate the `entra-agent-id` connector.                                                 |
| Power Platform inventory activation  | Microsoft does not document supported app-only inventory authorization; preview Power Platform RBAC is explicitly unsupported for inventory. | Microsoft publishes a production-supported unattended permission with an enforceable intended scope.  |
| Agent 365 package activation         | Replacement M365 E5 is active, but the Agent 365 product license and read permission are intentionally deferred.                             | Resolve the supported acquisition route, provision Agent 365, and approve `CopilotPackages.Read.All`. |

Corporate onboarding is tracked separately in [internal-onboarding.md](internal-onboarding.md). OneRAI remains blocked on authoritative Product CVP and Frontline CELA; that process does not block engineering.

---

## Pending

| Item                                   | Status / remaining prerequisite                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Behavior baseline and drift activation | The read-only connector, exact-match graph projection, and engine integration are implemented. Live analysis remains insufficient until each evaluated baseline and observed population contains at least 10 non-synthetic measured spans. |
| Real token economics activation        | Measured token/cost mapping and exact authoritative owner/business-unit attribution are implemented. Deployment remains `insufficient-data` until each baseline and observed window reaches ten measured samples; no cost is estimated.    |
| Business-value evidence                | The contract, API, mock demonstration, and Agent Detail UI are implemented. Live sourced claims require an authoritative outcome system with exact correlation identifiers.                                                                |

## Environment continuity

- The current Managed Environment remains the temporary live development and
  hackathon environment. Its Microsoft 365 licensing is deprovisioned, so Agent
  365, Teams, and Defender live validation cannot be completed there.
- A separate replacement Managed Environment User Tenant request is awaiting
  Reporting Manager approval. No replacement tenant or subscription exists yet.
- License-independent application, Azure, Foundry, Entra, Purview, policy,
  governance, telemetry, and test work continues in the current environment.
- After the replacement tenant is provisioned, verify its included M365 E5
  licensing, request separately gated products, and recreate Agent Sentinel from
  IaC. Do not depend on an in-place tenant migration.
- Replacement deployment naming is portable: new environments derive application,
  connector, Teams, Foundry, CI runner, and web-to-API routing names from a
  per-environment suffix. The current development parameter file explicitly
  preserves historical live identity and Foundry names to prevent replacement.
- Exact tenant, subscription, request, support-case, and smart-card identifiers
  are maintained only in the git-ignored local onboarding handoff.

## Deployment routing verification

- CI run `33351314784` produced immutable web, API, and jobs images for
  `31495ef`; all three healthy revisions were deployed on 2026-08-31.
- The registered `agent-sentinel` Front Door endpoint returns HTTP 200 for the
  web root and public connector-status/auth-configuration routes. Anonymous
  protected requests return the expected `401`.
- A separate unused `default` endpoint produced `404 Unavailable` during an
  initial probe. It is not the registered application or authentication origin.
- Desired state now declares only the active endpoint's architecture: one web
  private-link origin and one catch-all route. Web nginx is the sole proxy to
  the environment-only API.

---

## Exact evidence boundaries

These boundaries are what keep the product honest. They are enforced in code, not only in documentation.

| Boundary                                                                                              | Enforcement                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundry evidence is **declared configuration**, never observed runtime behavior.                      | Connector label plus explicit blind-spot reporting on `GET /api/connectors`.                                                                                                                              |
| The connector never infers tools, relationships, owners, or health that Foundry did not return.       | Schema validation; a malformed response fails rather than degrading to a guess.                                                                                                                           |
| A degraded connector reports degraded health; it is never replaced with mock success.                 | Connector health path in `apps/api`.                                                                                                                                                                      |
| Live product surfaces read one jobs-persisted estate snapshot for the configured tenant/environment.  | Live `/api/demo/state` uses `SnapshotRepository.findLatest`; absent state returns `503`.                                                                                                                  |
| Unconfigured or failed live runtime telemetry reports typed `unknown`; it never falls back to mock.   | Runtime route integration plus scorecard validation; mock cost posture is explicitly synthetic.                                                                                                           |
| Missing evidence lowers confidence and never implies safety.                                          | Product invariant, see [CONTEXT.md](CONTEXT.md).                                                                                                                                                          |
| The advisory model explains evidence; it never establishes security truth or authorizes an action.    | Grounding check plus schema validation; ungrounded output is rejected.                                                                                                                                    |
| Live mode is read-only for demo routes.                                                               | Non-`GET` requests to `/api/demo/*` return `403 read_only_mode` in live mode.                                                                                                                             |
| Remediation execution requires the `executeRemediation` capability, which only `Administrator` holds. | Per-route capability guards in `apps/api/src/auth.ts`.                                                                                                                                                    |
| The estate is synthetic. No production customer agents exist in the environment.                      | Six-agent manifest owned by `@agent-sentinel/scenarios`; deployment tagged `synthetic`.                                                                                                                   |
| Manifest adapter claims are non-authoritative and never outrank a first-party connector.              | `sourceOfTruth: false` is a constant; declared confidence is capped at 0.7, default 0.4.                                                                                                                  |
| Manifest typed values are compared only after one exact authoritative-object match.                   | A fixed field registry performs type-preserving exact comparison; mismatch, missing, and invalid authoritative values remain explicit. Free-form claim values are never read for equivalence.             |
| Token cost attribution never comes from telemetry labels or non-authoritative adapters.               | The API resolves owner and business unit only from the exact authoritative agent node and its cited declared-configuration evidence; every missing boundary returns typed `partial` or `unknown`.         |
| Runtime correlation availability is not presented as an outcome join.                                 | Runtime observations preserve direct run/correlation IDs and version context, but coverage reports linkability only. No outcome economics is calculated without a matching authoritative source contract. |
| The manifest adapter performs no network I/O; API input is inline JSON only.                          | Local paths reject URL forms before reads; API acceptance never dereferences manifest values.                                                                                                             |
| The manifest adapter cannot act on the estate.                                                        | `ManifestConnector` has no `execute()`; an `execute` action depth is rejected at load time.                                                                                                               |
| Manifest ingestion cannot cross the server-configured estate tenant or environment.                   | Acceptance binds the envelope and entity environments to server configuration; repository partitioning repeats the tenant check.                                                                          |
| A non-authoritative manifest outage cannot stop authoritative discovery.                              | Jobs degrades manifest composition and persists the complete Foundry snapshot without adapter data.                                                                                                       |

---

## Current Azure state

| Component                 | State on 2026-08-30                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container Apps            | `web` (external within the internal ACA environment), `api` (environment-internal only), `jobs` (no ingress). Reviewed surgical revisions are active.                                                      |
| ACA environment           | Internal, VNet-integrated, private.                                                                                                                                                                        |
| Data services             | Cosmos DB, PostgreSQL Flexible Server, Azure AI Search, Service Bus — all behind private endpoints or a delegated subnet.                                                                                  |
| Manifest persistence      | Cosmos `manifest-ingestions` exists with `/tenantId` partitioning and unique `(manifestId, envelope.producedAt)` versions. No live manifest has been admitted.                                             |
| Platform services         | Key Vault, Azure Container Registry (public network access disabled), Application Insights.                                                                                                                |
| Public edge — App Gateway | **Diagnostic and currently stopped.** WAF v2 remains available for bounded regional HTTP diagnostics when explicitly started.                                                                              |
| Public edge — Front Door  | **Active.** Routes web and API over HTTPS and is the registered SPA redirect and logout origin.                                                                                                            |
| Data mode                 | `live` — the API and jobs use the Foundry connector against Cosmos.                                                                                                                                        |
| Auth mode                 | `jwt`; employee login and Viewer read-only boundaries validated.                                                                                                                                           |
| Write posture             | `writeEnabled=false`; anonymous mutations are denied by authentication before route execution, and Front Door WAF remains in Prevention mode.                                                              |
| Advisory model            | `gpt-5.6-terra`, `GlobalStandard`, `NoAutoUpgrade`. Advisory output on the public edge remains **mock** until the grounded provider path is activated.                                                     |
| Build path                | Private self-hosted GitHub Actions runner inside the VNet. May be deallocated and must be started before a build.                                                                                          |
| Deploy path               | CI run `33316045414` built immutable `8eb1bd6` images; reviewed surgical ACA revisions for web, API, and jobs are healthy on that tag. Full Bicep remains gated by production approval and what-if review. |

Endpoint host names, resource names, and operational commands are in [deployment.md](deployment.md) and [runbooks.md](runbooks.md). No subscription, tenant, or credential values are recorded in documentation.

---

## Validation baseline

Measured on 2026-08-31 on `feature/multi-source-otel` with Node 22.

| Suite                         | Command                                                           | Result                                              |
| ----------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| Azure Monitor connector tests | `pnpm --filter @agent-sentinel/azure-monitor-otel-connector test` | **9 passing**, 1 file                               |
| Behavior engine tests         | `pnpm --filter @agent-sentinel/behavior-engine test`              | **73 passing**, 3 files                             |
| API unit tests                | `pnpm --filter @agent-sentinel/api test`                          | **222 passing**, 15 files                           |
| Manifest connector tests      | `pnpm --filter @agent-sentinel/manifest-connector test`           | **57 passing**, 1 file                              |
| Shift-left scanner tests      | `pnpm --filter @agent-sentinel/shift-left-scanner test`           | **6 passing**, 1 file                               |
| Shared UI component tests     | `pnpm --filter @agent-sentinel/ui test`                           | **4 passing**, 1 file                               |
| Web unit and component tests  | `pnpm --filter @agent-sentinel/web test`                          | **215 passing**, 27 files                           |
| End-to-end                    | `pnpm test:e2e`                                                   | **23 tests** across 10 Playwright specs             |
| Changed-file format check     | `pnpm exec prettier --check <changed files>`                      | **Passes**                                          |
| Repository format check       | `pnpm format:check`                                               | **Fails on 14 pre-existing unrelated files**        |
| Workspace lint and typecheck  | `pnpm lint`; `pnpm typecheck`                                     | **48 of 48 tasks pass** for each                    |
| Auth live-validator tests     | `pnpm --filter @agent-sentinel/scripts test`                      | **23 passing**, 5 files                             |
| Workspace tests               | `pnpm test`                                                       | **901 passing** across package suites               |
| Workspace build               | `pnpm build`                                                      | **25 of 25 tasks pass**                             |
| Bicep                         | `az bicep build`                                                  | Builds, with baseline linter warnings               |
| Web production build          | `pnpm --filter @agent-sentinel/web build`                         | Succeeds with a Rollup chunk-size warning (>500 kB) |
| Storybook static build        | `pnpm storybook:build`                                            | Succeeds with accessibility addon enabled           |

---

## Next unblock conditions

In dependency order. Each condition gates everything below it in its own track.

1. **Consent and four least-privilege role assignments approved** → surgically deploy images `acbb483` with `AUTH_MODE=jwt`, writes false, and the WAF unchanged.
2. **Real employee login plus read-phase live validation pass** → per-employee entitlement personalization and owner-scoped views become meaningful.
3. **Private authenticated write smoke test passes** → the `BlockApiMutationPreAuth` WAF rule can be narrowly changed, followed by public-edge write and anonymous-denial validation.
4. **Instrumented spans, Azure Monitor workspace settings, and least-privilege Logs query access are injected** → the implemented connector starts supplying real `ObservationWindow` objects; quality, reliability, and cost dimensions become evidence-backed instead of `unknown`.

Tracks 1–3 are identity- or edge-dependent; OneRAI onboarding is independent. Track 4 can proceed in parallel. See [roadmap.md](roadmap.md).

## Microsoft Agent 365 package catalog foundation

- The official Microsoft Graph v1.0 list connector is implemented as read-only, multi-source, and disabled by default.
- It composes after Foundry, optional Entra, and optional Power Platform without display-name correlation or inferred identity edges.
- Core inventory uses only documented `copilotPackage` fields; detail, package files, principal lists, beta, and all write operations remain disabled.
- Live activation has **not** occurred. It remains `authorization-required` until a Microsoft Agent 365 license and tenant-admin `CopilotPackages.Read.All` application consent are separately approved.
- IaC injects only disabled settings and grants no Microsoft Graph app role or license.

## Microsoft Defender for Cloud Apps evidence foundation

- The official tenant-specific `GET /api/v1/alerts/` and
  `GET /api/v1/activities/` list connector is implemented as read-only,
  multi-source, sequential, and disabled by default outside approved
  environment parameters.
- It composes after Agent 365. Direct provider records become standalone
  control/evidence nodes with no edges or agent attribution.
- Personal and narrative fields are stripped before domain mapping. Confidence
  `1` means direct provider observation only.
- The replacement primary source is live on API/jobs. Defender XDR tenant
  provisioning, the exact About-page API URL, and the connector UAMI
  `Investigation.Read` assignment were completed outside IaC after explicit
  approval.
- Both bounded probes report `ready`. The current 24-hour lists are empty, so
  the complete persisted snapshot contains no Defender control/evidence nodes.
- IaC injects only approved source configuration and still creates no
  permission, app role, token, secret, license, or Microsoft 365 resource.

## Microsoft Purview sensitivity-label catalog foundation

- The official Global Graph
  `GET /v1.0/security/dataSecurityAndGovernance/sensitivityLabels` connector is
  implemented as read-only, multi-tenant, sequential, and disabled by default.
- It composes after Defender for Cloud Apps. Each definition becomes a
  standalone control/evidence pair; there are no edges or agent correlations.
- Only bounded ID, display/name, color, sensitivity, priority, applicable
  targets, enabled status, and source provenance are retained. Label
  descriptions and all content, user, activity, and usage data are excluded.
- Confidence `1` means direct label-catalog observation only and makes no
  label-usage, content-protection, trust, or compliance claim.
- The primary source is live on API/jobs. Complete snapshots persist only
  bounded, privacy-reduced label definitions.

## Microsoft Teams tenant app catalog foundation

- The official Global Graph
  `GET /v1.0/appCatalogs/teamsApps?$filter=distributionMethod eq 'organization'`
  connector is implemented as read-only, multi-tenant, sequential, and disabled
  by default.
- It composes after Purview. Each catalog record becomes a standalone
  control/evidence pair with no edges or agent classification.
- Only documented `id`, `externalId`, `displayName`, `distributionMethod`, and
  source provenance are retained. App definitions, manifests, icons, files,
  users, groups, teams, chats, and installations are not read.
- Confidence `1` means direct tenant catalog observation only and makes no
  agent, deployment, installation, sideloading, distribution coverage, runtime,
  trust, tool, entitlement, or access claim.
- The primary API source has approved `AppCatalog.Read.All`, but Graph reports
  the tenant Teams backend disabled. Jobs remains off until licensing is ready.
