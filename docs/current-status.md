# Current status

**Status date: 2026-08-30** · Branch: `feature/multi-source-otel`

This is the authoritative dated ledger for the Agent Sentinel control plane. Every row states what is true today, not what is intended. Where a capability is absent, the ledger says so rather than describing it as pending success.

This document contains no secrets, tokens, subscription or tenant identifiers, personal contact details, or local absolute user paths.

Connector implementation, blocker type, and activation conditions are tracked
in [connector-availability.md](connector-availability.md).

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
| `849b40b` | Entra Graph live-contract correction               | Accepts bounded `@odata.type` metadata and Azure application GUIDs, allowing the full primary-tenant service-principal inventory to validate.                       |
| `495a5f0` | Sanitized connector failure diagnostics            | Preserves stable provider reason codes in source health and jobs logs without exposing provider payloads.                                                           |
| `9acff50` | Benign telemetry-only validation mode              | Separates six-agent AppRequests validation from safety probes that may be stopped by provider policy.                                                               |

---

## Complete

| Item                                       | Evidence boundary                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full application shell and navigation      | Thirteen routes plus global search are implemented with API, component, and end-to-end coverage for the work queue and established surfaces.                                                                                                                                                                                                                     |
| Mock acceptance path across every surface  | Deterministic in-repository fixtures; no Azure access required to run or test the product.                                                                                                                                                                                                                                                                       |
| Live Microsoft Foundry discovery           | **Live declared configuration only.** Agent and function-tool definitions. No runtime traces, tool authorization, or cost.                                                                                                                                                                                                                                       |
| Multi-Foundry aggregation foundation       | **Implemented; one live source configured.** Up to 50 tenant/project sources have independent credentials, stable source namespaces, aggregate estate isolation, per-source health, and fail-closed partial snapshot handling. Cross-tenant access supports secretless managed-identity federation.                                                              |
| Multi-source OTel routing foundation       | **Live for the primary source.** Aggregate agent ids resolve through the persisted snapshot to exact source workspace/tenant/environment/provider-agent bindings. Workspace-scoped UAMI reads return measured windows and typed `insufficient-data` when samples are sparse.                                                                                     |
| Cosmos-backed exposure findings            | **Live.** Container `findings`, partition key `/tenantId`, upsert preserves `firstSeen`.                                                                                                                                                                                                                                                                         |
| Cosmos-backed governance posture           | **Live.** Derived from the same findings; posture tiles deep-link to the filtered findings that produced them.                                                                                                                                                                                                                                                   |
| Jobs ingestion loop                        | **Live.** Interval discovery plus optional `snapshot-ingestion` Service Bus trigger with idempotency.                                                                                                                                                                                                                                                            |
| Terra live validation, 6 of 6              | **Synthetic, operator-invoked.** `pnpm foundry:validate` exercises all six agents; never run by CI.                                                                                                                                                                                                                                                              |
| Agent inventory and assurance catalog      | **Current.** Populated from live Foundry discovery; other platforms are absent, not empty-but-clean.                                                                                                                                                                                                                                                             |
| Evidence-backed scorecard foundation       | **Partial live integration.** Agent detail and lifecycle use persisted exposures. Governance mixes declared owner/trust with exposures; release-history evidence is not connected. Cost, quality, and reliability remain `unknown` live.                                                                                                                         |
| Connector management catalog               | **Current status surface.** Primary Foundry discovery, Entra inventory, and Azure Monitor OTel are connected. The manifest adapter remains activation-gated; other platform entries are authorization-gated or planned placeholders.                                                                                                                             |
| Unified live estate snapshot read model    | **Current.** Live `/api/demo/state` reads the latest jobs-persisted Cosmos snapshot for the exact configured tenant and environment. Inventory, catalog, lifecycle, trust, optimization, and observability no longer trigger an independent Foundry discovery. Missing persisted state returns explicit `503` without a mock fallback.                           |
| Unified live exposure projections          | **Current.** Live Overview always renders persisted `ExposureFinding` posture instead of the mock demo workflow. Trust, lifecycle, agent detail, exposure, and governance consume the same active exposure contract; the legacy attack-path `Finding` remains mock-only.                                                                                         |
| Entra authentication and RBAC              | **Live, read-only.** Strict API tenant/audience/issuer/JWKS/scope validation and MSAL employee login are deployed. Anonymous access returns `401`; Viewer mutation returns `403`; `/api/auth/me` returns a sanitized principal. Broader live role validation remains pending.                                                                                    |
| Entra identity enrichment                  | **Live for the primary source.** `Application.Read.All` reads 539 validated service principals into the complete Cosmos snapshot. Optional owners, app roles, and preview APIs remain disabled. Current Foundry agents expose no matching identity metadata, so `RUNS_AS` correlation is correctly empty rather than inferred.                                   |
| Azure Resource Graph inventory             | **Live for the current authorized view.** A fixed GA REST query maps only bounded Azure AI/supporting-resource fields to unattributed control/evidence records. User validation returned 64 resources; the narrower application UAMI persisted 5 visible resources and zero inferred edges without a new Reader assignment.                                      |
| Cloud resource inventory surface           | **Current.** A dedicated route exposes only Azure Resource Graph control nodes with text/type/group/location/subscription filters and cited evidence. It labels RBAC-limited coverage explicitly and makes no agent, health, trust, or compliance inference.                                                                                                     |
| Power Platform agent inventory             | **Configured; provider authorization pending.** The official ResourceQuery connector uses a dedicated read-only managed identity and exact environment boundary, but the service still returns `403`. No inventory is persisted until the source reports ready.                                                                                                  |
| Defender for Cloud Apps evidence           | **Permission ready; licensing pending.** The dedicated identity has read-only investigation permission, but the tenant has no Defender for Cloud Apps subscription or portal. The connector remains disabled pending managed-environment licensing.                                                                                                              |
| Purview sensitivity-label catalog          | **Live, read-only.** The dedicated identity and `SensitivityLabel.Read` source are active on API/jobs. Bounded nested label definitions are composed as unattributed control evidence, and complete jobs snapshots persist without content, usage, user, agent, trust, or compliance claims.                                                                     |
| Teams tenant app catalog                   | **Permission ready; licensing pending.** `AppCatalog.Read.All` is assigned to a dedicated identity and the source is configured on API. Graph reports the tenant Teams backend disabled (`AADSTS500014`), so jobs activation is withheld until the Teams trial is provisioned.                                                                                   |
| Azure deployment                           | **Live.** Container Apps `web`, `api`, and `jobs` run on a private ACA environment behind Front Door. Web uses the verified logout fix; API uses JWT mode; jobs remains non-interactive.                                                                                                                                                                         |
| Corporate Service Tree registration        | **Complete.** Registered under the confirmed `MCAPS > GES Asia > Korea` hierarchy with two administrators.                                                                                                                                                                                                                                                       |
| Universal custom manifest adapter          | **Implementation complete, activation pending.** Strict offline input remains available. The authenticated Administrator-only API, dedicated immutable Cosmos repository, hash idempotency, and jobs composition are implemented. Live ingestion stays blocked by writes-false and the public mutation posture.                                                  |
| Deterministic behavior-baseline engine     | **Current.** `@agent-sentinel/behavior-engine` implements median/MAD statistics, drift analysis, evidence coverage, and typed `DriftAnalysisResult`; mock mode uses labeled fixtures and live mode accepts only validated Azure Monitor OTel windows.                                                                                                            |
| Token Economics foundation                 | **Current.** `analyzeTokenEconomics()` uses measured-only populations, reconciled coverage, evidence-linked MAD anomalies, and same-population cost per success. Mock fixtures cover healthy, cost-anomaly, and missing-cost scenarios; live mode accepts validated Azure Monitor OTel windows and remains `unknown` while deployment telemetry is unconfigured. |
| Governance workflow and durable repository | **Current.** Valid transitions, explicit assignment, separation of duties, source/actor/timestamp audit evidence, bounded policy exceptions, and promote/drift-acknowledge/rollback/retire evidence transitions are enforced, Cosmos-backed, and covered through API and Playwright lifecycle tests.                                                             |
| Phase 10 shift-left scanner                | **Current, offline.** `@agent-sentinel/shift-left-scanner` and `pnpm manifest:scan` evaluate validated manifests with the unchanged runtime policy catalog and finding/evidence shapes. Deterministic pass/warn/block output and CI exit codes are available without Entra, ingestion, deployment, or network access.                                            |

---

## In progress

| Item                                         | Where it stands                                                                                                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unified inventory for future connectors      | Inventory renders any connector's records. Purview now supplies live governance controls; Power Platform and Teams remain provider-gated after read-only role assignment.                          |
| Azure Resource Graph coverage                | The connector is live with 5 UAMI-visible resources. Complete subscription coverage remains optional and requires separate approval for broader Reader RBAC.                                       |
| Azure Monitor measured windows               | Query health is ready and 6 benign spans were ingested across 6 agents. Exact-match runtime graph projection and explicit evidence typing are implemented; drift and economics remain `insufficient-data` because the baseline has 0 samples and the minimum population is 10. |
| Employee catalog entitlement personalization | The assurance overlay renders. Per-employee entitlement filtering needs an authenticated principal.                                                                                                |
| Additional Foundry sources                   | Runtime aggregation is implemented. Each target project still requires an approved credential/federation setup and `Azure AI User`; the current deployment remains the `primary` source only.      |
| Live role coverage                           | Employee login and Viewer boundaries are validated. Analyst, Approver, Administrator, and write-scope live-token validation remain pending before any public write-path change.                    |
| Manifest ingestion activation                | The dedicated container and API/jobs images are deployed. The endpoint remains blocked by writes-false; activation requires Administrator, write-scope, and exact public-edge mutation validation. |
| Repository documentation                     | This rebuild. Superseded and contradictory statements are being corrected in place.                                                                                                                |

---

## Blocked

| Item                                 | Blocking condition                                                                                             | Unblocks when                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Terra authenticated `POST`           | The `BlockApiMutationPreAuth` WAF rule blocks every non-`GET`/`HEAD`/`OPTIONS` request under `/api/` pre-auth. | Authenticated write scopes are validated, then the rule is narrowed.                                           |
| WAF rule narrowing                   | Must not be relaxed until the authenticated write path is proven and anonymous mutation remains denied.        | JWT write-scope tests and an authorized remediation smoke test pass.                                           |
| Employee entitlement personalization | Requires tenant-authorized Entra entitlement evidence beyond the now-active authenticated principal.           | Activate and validate the `entra-agent-id` connector.                                                          |
| Power Platform inventory activation  | Dedicated identity roles are assigned, but ResourceQuery still returns `403`.                                  | Allow role propagation and resolve service-principal inventory authorization before jobs activation.           |
| Defender for Cloud Apps activation   | Read permission exists, but the tenant lacks the required subscription and portal.                             | Provision the approved managed-environment M365 E5 trial, then discover the exact portal and validate privacy. |
| Agent 365 package activation         | Read permission exists, but the tenant lacks the required M365 E5 prerequisite and Agent 365 license.          | Provision the approved managed-environment trials, then run bounded catalog validation.                        |
| Teams tenant app catalog activation  | Read permission exists, but Graph reports the tenant Teams backend disabled.                                   | Provision the approved Teams Enterprise trial, then validate catalog-only evidence before jobs activation.     |

Corporate onboarding is tracked separately in [internal-onboarding.md](internal-onboarding.md). OneRAI remains blocked on authoritative Product CVP and Frontline CELA; that process does not block engineering.

---

## Pending

| Item                                   | Status / remaining prerequisite                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Behavior baseline and drift activation | The read-only connector, exact-match graph projection, and engine integration are implemented. Live analysis remains insufficient until each evaluated baseline and observed population contains at least 10 non-synthetic measured spans. |
| Real token economics activation        | Measured token/cost mapping is implemented. Deployment remains `unknown` until the provider prerequisites are injected; no cost is estimated.                                  |
| Universal adapters                     | Ingestion and composition are implemented. First-party correlation and independent verification of claimed runtime evidence remain.                                            |
| Business-value evidence                | Requires runtime telemetry plus outcome sources.                                                                                                                               |

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

- CI run `33260110723` produced immutable web, API, and jobs images for
  `5feffda`; all three healthy revisions were deployed on 2026-08-30.
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
| Deploy path               | CI run `33260110723` built immutable `5feffda` images; reviewed surgical ACA revisions for web, API, and jobs are healthy on that tag. Full Bicep remains gated by production approval and what-if review. |

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

## Microsoft Agent 365 package catalog foundation

- The official Microsoft Graph v1.0 list connector is implemented as read-only, multi-source, and disabled by default.
- It composes after Foundry, optional Entra, and optional Power Platform without display-name correlation or inferred identity edges.
- Core inventory uses only documented `copilotPackage` fields; detail, package files, principal lists, beta, and all write operations remain disabled.
- Live activation has **not** occurred. It remains `authorization-required` until a Microsoft Agent 365 license and tenant-admin `CopilotPackages.Read.All` application consent are separately approved.
- IaC injects only disabled settings and grants no Microsoft Graph app role or license.

## Microsoft Defender for Cloud Apps evidence foundation

- The official tenant-specific `GET /api/v1/alerts/` and
  `GET /api/v1/activities/` list connector is implemented as read-only,
  multi-source, sequential, and disabled by default.
- It composes after Agent 365. Direct provider records become standalone
  control/evidence nodes with no edges or agent attribution.
- Personal and narrative fields are stripped before domain mapping. Confidence
  `1` means direct provider observation only.
- Live activation has **not** occurred. It remains `authorization-required`
  pending licensing/API availability, exact portal URLs, and tenant-admin
  `Investigation.Read` application consent.
- IaC injects only disabled settings and creates no permission, role, token,
  secret, license, or Microsoft 365 resource.

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
