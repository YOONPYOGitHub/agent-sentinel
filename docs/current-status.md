# Current status

**Status date: 2026-08-28** · Branch: `feature/multi-foundry-connectors`

This is the authoritative dated ledger for the Agent Sentinel control plane. Every row states what is true today, not what is intended. Where a capability is absent, the ledger says so rather than describing it as pending success.

This document contains no secrets, tokens, subscription or tenant identifiers, personal contact details, or local absolute user paths.

---

## Recent delivery on `feature/governance-phase1-completion`

| Commit    | Change                                             | Effect                                                                                                                                                              |
| --------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
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

---

## Complete

| Item                                       | Evidence boundary                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full application shell and navigation      | Twelve routes plus global search are implemented with API, component, and end-to-end coverage for the work queue and established surfaces.                                                                                                                                                                                                                       |
| Mock acceptance path across every surface  | Deterministic in-repository fixtures; no Azure access required to run or test the product.                                                                                                                                                                                                                                                                       |
| Live Microsoft Foundry discovery           | **Live declared configuration only.** Agent and function-tool definitions. No runtime traces, tool authorization, or cost.                                                                                                                                                                                                                                       |
| Multi-Foundry aggregation foundation       | **Implemented; one live source configured.** Up to 50 tenant/project sources have independent credentials, stable source namespaces, aggregate estate isolation, per-source health, and fail-closed partial snapshot handling. Cross-tenant access supports secretless managed-identity federation.                                                              |
| Cosmos-backed exposure findings            | **Live.** Container `findings`, partition key `/tenantId`, upsert preserves `firstSeen`.                                                                                                                                                                                                                                                                         |
| Cosmos-backed governance posture           | **Live.** Derived from the same findings; posture tiles deep-link to the filtered findings that produced them.                                                                                                                                                                                                                                                   |
| Jobs ingestion loop                        | **Live.** Interval discovery plus optional `snapshot-ingestion` Service Bus trigger with idempotency.                                                                                                                                                                                                                                                            |
| Terra live validation, 6 of 6              | **Synthetic, operator-invoked.** `pnpm foundry:validate` exercises all six agents; never run by CI.                                                                                                                                                                                                                                                              |
| Agent inventory and assurance catalog      | **Current.** Populated from live Foundry discovery; other platforms are absent, not empty-but-clean.                                                                                                                                                                                                                                                             |
| Evidence-backed scorecard foundation       | **Partial live integration.** Agent detail and lifecycle use persisted exposures. Governance mixes declared owner/trust with exposures; release-history evidence is not connected. Cost, quality, and reliability remain `unknown` live.                                                                                                                         |
| Connector management catalog               | **Current status surface, not multi-platform support.** Foundry is the only active platform connector. Azure Monitor OTel and the offline manifest adapter have code foundations; the remaining entries are authorization-gated or planned placeholders.                                                                                                         |
| Unified live estate snapshot read model    | **Current.** Live `/api/demo/state` reads the latest jobs-persisted Cosmos snapshot for the exact configured tenant and environment. Inventory, catalog, lifecycle, trust, optimization, and observability no longer trigger an independent Foundry discovery. Missing persisted state returns explicit `503` without a mock fallback.                           |
| Unified live exposure projections          | **Current.** Live Overview always renders persisted `ExposureFinding` posture instead of the mock demo workflow. Trust, lifecycle, agent detail, exposure, and governance consume the same active exposure contract; the legacy attack-path `Finding` remains mock-only.                                                                                         |
| Entra authentication and RBAC              | **Live, read-only.** Strict API tenant/audience/issuer/JWKS/scope validation and MSAL employee login are deployed. Anonymous access returns `401`; Viewer mutation returns `403`; `/api/auth/me` returns a sanitized principal. Broader live role validation remains pending.                                                                                    |
| Azure deployment                           | **Live.** Container Apps `web`, `api`, and `jobs` run on a private ACA environment behind Front Door. Web uses the verified logout fix; API uses JWT mode; jobs remains non-interactive.                                                                                                                                                                         |
| Corporate Service Tree registration        | **Complete.** Registered under the confirmed `MCAPS > GES Asia > Korea` hierarchy with two administrators.                                                                                                                                                                                                                                                       |
| Universal custom manifest adapter          | **Implementation complete, activation pending.** Strict offline input remains available. The authenticated Administrator-only API, dedicated immutable Cosmos repository, hash idempotency, and jobs composition are implemented. Live ingestion stays blocked by writes-false and the public mutation posture.                                                  |
| Deterministic behavior-baseline engine     | **Current.** `@agent-sentinel/behavior-engine` implements median/MAD statistics, drift analysis, evidence coverage, and typed `DriftAnalysisResult`; mock mode uses labeled fixtures and live mode accepts only validated Azure Monitor OTel windows.                                                                                                            |
| Token Economics foundation                 | **Current.** `analyzeTokenEconomics()` uses measured-only populations, reconciled coverage, evidence-linked MAD anomalies, and same-population cost per success. Mock fixtures cover healthy, cost-anomaly, and missing-cost scenarios; live mode accepts validated Azure Monitor OTel windows and remains `unknown` while deployment telemetry is unconfigured. |
| Governance workflow and durable repository | **Current.** Valid transitions, explicit assignment, separation of duties, source/actor/timestamp audit evidence, bounded policy exceptions, and promote/drift-acknowledge/rollback/retire evidence transitions are enforced, Cosmos-backed, and covered through API and Playwright lifecycle tests.                                                             |
| Phase 10 shift-left scanner                | **Current, offline.** `@agent-sentinel/shift-left-scanner` and `pnpm manifest:scan` evaluate validated manifests with the unchanged runtime policy catalog and finding/evidence shapes. Deterministic pass/warn/block output and CI exit codes are available without Entra, ingestion, deployment, or network access.                                            |

---

## In progress

| Item                                         | Where it stands                                                                                                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unified inventory for future connectors      | Inventory renders any connector's records, but only the Foundry connector currently supplies live data.                                                                                                                             |
| Employee catalog entitlement personalization | The assurance overlay renders. Per-employee entitlement filtering needs an authenticated principal.                                                                                                                                 |
| Entra identity enrichment                    | Read-only Graph inventory, deterministic Foundry correlation, composite health, API/jobs wiring, packaging, and disabled-by-default IaC are implemented. Tenant-admin consent and live activation remain separate approved changes. |
| Additional Foundry sources                   | Runtime aggregation is implemented. Each target project still requires an approved credential/federation setup and `Azure AI User`; the current deployment remains the `primary` source only.                                       |
| Live role coverage                           | Employee login and Viewer boundaries are validated. Analyst, Approver, Administrator, and write-scope live-token validation remain pending before any public write-path change.                                                     |
| Manifest ingestion activation                | The dedicated container and API/jobs images are deployed. The endpoint remains blocked by writes-false; activation requires Administrator, write-scope, and exact public-edge mutation validation.                                  |
| Repository documentation                     | This rebuild. Superseded and contradictory statements are being corrected in place.                                                                                                                                                 |

---

## Blocked

| Item                                 | Blocking condition                                                                                             | Unblocks when                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Terra authenticated `POST`           | The `BlockApiMutationPreAuth` WAF rule blocks every non-`GET`/`HEAD`/`OPTIONS` request under `/api/` pre-auth. | Authenticated write scopes are validated, then the rule is narrowed. |
| WAF rule narrowing                   | Must not be relaxed until the authenticated write path is proven and anonymous mutation remains denied.        | JWT write-scope tests and an authorized remediation smoke test pass. |
| Employee entitlement personalization | Requires tenant-authorized Entra entitlement evidence beyond the now-active authenticated principal.           | Activate and validate the `entra-agent-id` connector.                |

Corporate onboarding is tracked separately in [internal-onboarding.md](internal-onboarding.md). OneRAI remains blocked on authoritative Product CVP and Frontline CELA; that process does not block engineering.

---

## Pending

| Item                                   | Status / remaining prerequisite                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Behavior baseline and drift activation | The read-only `azure-monitor-otel` connector and engine integration are implemented; deployment still needs instrumented spans, workspace configuration, and query permission. |
| Real token economics activation        | Measured token/cost mapping is implemented. Deployment remains `unknown` until the provider prerequisites are injected; no cost is estimated.                                  |
| Universal adapters                     | Ingestion and composition are implemented. First-party correlation and independent verification of claimed runtime evidence remain.                                            |
| Business-value evidence                | Requires runtime telemetry plus outcome sources.                                                                                                                               |

---

## Exact evidence boundaries

These boundaries are what keep the product honest. They are enforced in code, not only in documentation.

| Boundary                                                                                              | Enforcement                                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Foundry evidence is **declared configuration**, never observed runtime behavior.                      | Connector label plus explicit blind-spot reporting on `GET /api/connectors`.                                                     |
| The connector never infers tools, relationships, owners, or health that Foundry did not return.       | Schema validation; a malformed response fails rather than degrading to a guess.                                                  |
| A degraded connector reports degraded health; it is never replaced with mock success.                 | Connector health path in `apps/api`.                                                                                             |
| Live product surfaces read one jobs-persisted estate snapshot for the configured tenant/environment.  | Live `/api/demo/state` uses `SnapshotRepository.findLatest`; absent state returns `503`.                                         |
| Unconfigured or failed live runtime telemetry reports typed `unknown`; it never falls back to mock.   | Runtime route integration plus scorecard validation; mock cost posture is explicitly synthetic.                                  |
| Missing evidence lowers confidence and never implies safety.                                          | Product invariant, see [CONTEXT.md](CONTEXT.md).                                                                                 |
| The advisory model explains evidence; it never establishes security truth or authorizes an action.    | Grounding check plus schema validation; ungrounded output is rejected.                                                           |
| Live mode is read-only for demo routes.                                                               | Non-`GET` requests to `/api/demo/*` return `403 read_only_mode` in live mode.                                                    |
| Remediation execution requires the `executeRemediation` capability, which only `Administrator` holds. | Per-route capability guards in `apps/api/src/auth.ts`.                                                                           |
| The estate is synthetic. No production customer agents exist in the environment.                      | Six-agent manifest owned by `@agent-sentinel/scenarios`; deployment tagged `synthetic`.                                          |
| Manifest adapter claims are non-authoritative and never outrank a first-party connector.              | `sourceOfTruth: false` is a constant; declared confidence is capped at 0.7, default 0.4.                                         |
| The manifest adapter performs no network I/O; API input is inline JSON only.                          | Local paths reject URL forms before reads; API acceptance never dereferences manifest values.                                    |
| The manifest adapter cannot act on the estate.                                                        | `ManifestConnector` has no `execute()`; an `execute` action depth is rejected at load time.                                      |
| Manifest ingestion cannot cross the server-configured estate tenant or environment.                   | Acceptance binds the envelope and entity environments to server configuration; repository partitioning repeats the tenant check. |
| A non-authoritative manifest outage cannot stop authoritative discovery.                              | Jobs degrades manifest composition and persists the complete Foundry snapshot without adapter data.                              |

---

## Current Azure state

| Component                 | State on 2026-08-27                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container Apps            | `web` (external within the internal ACA environment), `api` (environment-internal only), `jobs` (no ingress). Reviewed surgical revisions are active.            |
| ACA environment           | Internal, VNet-integrated, private.                                                                                                                              |
| Data services             | Cosmos DB, PostgreSQL Flexible Server, Azure AI Search, Service Bus — all behind private endpoints or a delegated subnet.                                        |
| Manifest persistence      | Cosmos `manifest-ingestions` exists with `/tenantId` partitioning and unique `(manifestId, envelope.producedAt)` versions. No live manifest has been admitted.   |
| Platform services         | Key Vault, Azure Container Registry (public network access disabled), Application Insights.                                                                      |
| Public edge — App Gateway | **Active.** WAF v2 in Prevention mode, HTTP on port 80 only, no custom domain or TLS. Management-automated and may stop.                                         |
| Public edge — Front Door  | **Active.** Routes web and API over HTTPS and is the registered SPA redirect and logout origin.                                                                  |
| Data mode                 | `live` — the API and jobs use the Foundry connector against Cosmos.                                                                                              |
| Auth mode                 | `jwt`; employee login and Viewer read-only boundaries validated.                                                                                                 |
| Write posture             | `writeEnabled=false`, and the WAF blocks pre-auth mutations under `/api/`.                                                                                       |
| Advisory model            | `gpt-5.6-terra`, `GlobalStandard`, `NoAutoUpgrade`. Advisory output on the public edge remains **mock** until the grounded provider path is activated.           |
| Build path                | Private self-hosted GitHub Actions runner inside the VNet. May be deallocated and must be started before a build.                                                |
| Deploy path               | The runner is deallocated after CI run `33073661639`. Full Bicep is blocked by unrelated what-if modifications; use only reviewed surgical ACA revision updates. |

Endpoint host names, resource names, and operational commands are in [deployment.md](deployment.md) and [runbooks.md](runbooks.md). No subscription, tenant, or credential values are recorded in documentation.

---

## Validation baseline

Measured on 2026-08-27 on `feature/governance-phase1-completion` with Node 22.

| Suite                         | Command                                                           | Result                                              |
| ----------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| Azure Monitor connector tests | `pnpm --filter @agent-sentinel/azure-monitor-otel-connector test` | **6 passing**, 1 file                               |
| Behavior engine tests         | `pnpm --filter @agent-sentinel/behavior-engine test`              | **72 passing**, 3 files                             |
| API unit tests                | `pnpm --filter @agent-sentinel/api test`                          | **139 passing**, 11 files                           |
| Manifest connector tests      | `pnpm --filter @agent-sentinel/manifest-connector test`           | **53 passing**, 1 file                              |
| Shift-left scanner tests      | `pnpm --filter @agent-sentinel/shift-left-scanner test`           | **6 passing**, 1 file                               |
| Web unit and component tests  | `pnpm --filter @agent-sentinel/web test`                          | **197 passing**, 26 files                           |
| End-to-end                    | `pnpm test:e2e`                                                   | **23 tests** across 10 Playwright specs             |
| Changed-file format check     | `pnpm exec prettier --check <changed files>`                      | **Passes**                                          |
| Repository format check       | `pnpm format:check`                                               | **Fails on 14 pre-existing unrelated files**        |
| Workspace lint and typecheck  | `pnpm lint`; `pnpm typecheck`                                     | **32 of 32 tasks pass** for each                    |
| Auth live-validator tests     | `pnpm --filter @agent-sentinel/scripts test`                      | **20 passing**, 4 files                             |
| Workspace tests               | `pnpm test`                                                       | **539 passing**, 61 files; 1 test skipped           |
| Workspace build               | `pnpm build`                                                      | **17 of 17 tasks pass**                             |
| Bicep                         | `az bicep build`                                                  | Builds, with baseline linter warnings               |
| Web production build          | `pnpm --filter @agent-sentinel/web build`                         | Succeeds with a Rollup chunk-size warning (>500 kB) |

---

## Next unblock conditions

In dependency order. Each condition gates everything below it in its own track.

1. **Consent and four least-privilege role assignments approved** → surgically deploy images `acbb483` with `AUTH_MODE=jwt`, writes false, and the WAF unchanged.
2. **Real employee login plus read-phase live validation pass** → per-employee entitlement personalization and owner-scoped views become meaningful.
3. **Private authenticated write smoke test passes** → the `BlockApiMutationPreAuth` WAF rule can be narrowly changed, followed by public-edge write and anonymous-denial validation.
4. **Instrumented spans, Azure Monitor workspace settings, and least-privilege Logs query access are injected** → the implemented connector starts supplying real `ObservationWindow` objects; quality, reliability, and cost dimensions become evidence-backed instead of `unknown`.

Tracks 1–3 are identity- or edge-dependent; OneRAI onboarding is independent. Track 4 can proceed in parallel. See [roadmap.md](roadmap.md).
