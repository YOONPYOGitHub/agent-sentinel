# Current status

**Status date: 2026-08-24** · Branch: `feature/live-exposure`

This is the authoritative dated ledger for the Agent Sentinel control plane. Every row states what is true today, not what is intended. Where a capability is absent, the ledger says so rather than describing it as pending success.

This document contains no secrets, tokens, subscription or tenant identifiers, personal contact details, or local absolute user paths.

---

## Recent delivery on `feature/live-exposure`

| Commit    | Change                                             | Effect                                                                                                                                                                                |
| --------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HEAD`    | Token Economics foundation (mock mode)             | Deterministic engine, typed domain, synthetic fixtures, GET API, Optimization/Detail UI seams. Mock-mode only; live mode returns connector-not-connected. No OTel, no real telemetry. |
| `8179785` | Microsoft Entra authentication and RBAC foundation | JWT validation, four roles, per-route capability guards, SPA MSAL wiring. Not activated.                                                                                              |
| `ec43f2e` | Connector management catalog                       | Ten connectors with honest lifecycle states, capabilities, prerequisites, and readiness.                                                                                              |
| `6c12596` | Evidence-backed agent scorecards                   | Six independent assurance dimensions; live exposure drives the security dimension.                                                                                                    |
| `5ce3269` | Agent inventory and assurance catalog              | Organization-wide inventory plus the employee-facing assurance overlay.                                                                                                               |

---

## Complete

| Item                                          | Evidence boundary                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Full application shell and navigation         | Twelve routes plus global search are implemented with API, component, and end-to-end coverage for the work queue and established surfaces.                                                                                                                                                                                                                                                       |
| Mock acceptance path across every surface     | Deterministic in-repository fixtures; no Azure access required to run or test the product.                                                                                                                                                                                                                                                                                                       |
| Live Microsoft Foundry discovery              | **Live declared configuration only.** Agent and function-tool definitions. No runtime traces, tool authorization, or cost.                                                                                                                                                                                                                                                                       |
| Cosmos-backed exposure findings               | **Live.** Container `exposure-findings`, partition key `/tenantId`, upsert preserves `firstSeen`.                                                                                                                                                                                                                                                                                                |
| Cosmos-backed governance posture              | **Live.** Derived from the same findings; posture tiles deep-link to the filtered findings that produced them.                                                                                                                                                                                                                                                                                   |
| Jobs ingestion loop                           | **Live.** Interval discovery plus optional `snapshot-ingestion` Service Bus trigger with idempotency.                                                                                                                                                                                                                                                                                            |
| Terra live validation, 6 of 6                 | **Synthetic, operator-invoked.** `pnpm foundry:validate` exercises all six agents; never run by CI.                                                                                                                                                                                                                                                                                              |
| Agent inventory and assurance catalog         | **Current.** Populated from live Foundry discovery; other platforms are absent, not empty-but-clean.                                                                                                                                                                                                                                                                                             |
| Live evidence-backed scorecards               | **Current.** Security, governance, and lifecycle derive from connected evidence. Cost / Efficiency derives only from a validated, fully measured Token Economics report; it remains `unknown` in the deployed live environment. Quality and reliability remain `unknown`.                                                                                                                        |
| Connector management catalog                  | **Current.** One connector is connectable; one is `authorization-required`; one is `available-to-configure` offline; seven are `planned`.                                                                                                                                                                                                                                                        |
| Entra authentication and RBAC code foundation | **Current code, not activated.** `AUTH_MODE=disabled` is deployed.                                                                                                                                                                                                                                                                                                                               |
| Azure deployment, revision 11 on `8179785`    | **Live.** Container Apps `web`, `api`, `jobs` on a private ACA environment, with authentication disabled.                                                                                                                                                                                                                                                                                        |
| Corporate Service Tree registration           | **Complete.** Registered under the confirmed `MCAPS > GES Asia > Korea` hierarchy with two administrators.                                                                                                                                                                                                                                                                                       |
| Universal custom manifest adapter             | **Current, offline.** `@agent-sentinel/manifest-connector` normalizes an operator-supplied manifest into an `EstateSnapshot`. Non-authoritative, read-only, no ingestion endpoint.                                                                                                                                                                                                               |
| Deterministic behavior-baseline engine        | **Current, mock-mode only.** `@agent-sentinel/behavior-engine` implements median/MAD statistics, drift analysis, evidence coverage, and typed `DriftAnalysisResult`. No OTel connector yet; quality/reliability/cost remain `unknown` in live mode.                                                                                                                                              |
| Token Economics foundation (mock mode)        | **Current, mock-mode only.** `analyzeTokenEconomics()` uses measured-only populations, reconciled coverage, evidence-linked MAD anomalies, and same-population cost per success. Three synthetic fixtures cover healthy, cost-anomaly, and missing-cost scenarios. Agent Detail conditionally activates Cost / Efficiency only for validated full-coverage reports. Live mode remains `unknown`. |

---

## In progress

| Item                                         | Where it stands                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unified inventory for future connectors      | Inventory renders any connector's records, but only the Foundry connector currently supplies live data.                                                                         |
| Employee catalog entitlement personalization | The assurance overlay renders. Per-employee entitlement filtering needs an authenticated principal.                                                                             |
| Governance work queue and lifecycle workflow | Deterministic queue state, server-side transitions, separation-of-duties, immutable history, and mock fixtures are implemented on the current branch. Live persistence remains. |
| Repository documentation                     | This rebuild. Superseded and contradictory statements are being corrected in place.                                                                                             |

---

## Blocked

| Item                                                                         | Blocking condition                                                                                                      | Unblocks when                                                                                                                         |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Corporate Microsoft Entra activation                                         | The Service Tree record exists, but IcM onboarding is blocked by SFI trusted-identity and contact-profile requirements. | Supply two SC-ALT or ME service-admin identities, complete required IcM contact phone fields, onboard to IcM, then allow propagation. |
| Real employee login                                                          | Depends on the corporate app registrations above.                                                                       | Entra activation completes.                                                                                                           |
| Terra authenticated `POST`                                                   | The `BlockApiMutationPreAuth` WAF rule blocks every non-`GET`/`HEAD`/`OPTIONS` request under `/api/` pre-auth.          | Authenticated write scopes are validated, then the rule is narrowed.                                                                  |
| WAF rule narrowing                                                           | Must not be relaxed while `AUTH_MODE=disabled`, or anonymous mutation becomes possible.                                 | JWT write-scope tests and an authorized remediation smoke test pass.                                                                  |
| Employee entitlement personalization                                         | Requires an authenticated principal and Entra entitlement evidence.                                                     | Entra activation plus the `entra-agent-id` connector.                                                                                 |
| The Service Tree record was created on 2026-08-23. Generated identifiers,    |
| requester identity, contact details, and correspondence are deliberately not |
| stored in this repository. See                                               |
| [internal-onboarding.md](internal-onboarding.md).                            |

---

## Pending

| Item                                  | Not started because                                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Behavior baseline and drift detection | Engine is implemented in mock mode; live evidence still requires a runtime telemetry connector. `azure-monitor-otel` is catalogued as `planned`.                                                  |
| Real token economics telemetry        | Mock-mode foundation is implemented. Live token economics still requires a runtime telemetry connector; the cost scorecard dimension remains `unknown`, and no cost figure is estimated anywhere. |
| Universal adapters                    | The custom manifest adapter is implemented and offline-only. The authenticated ingestion API is not implemented.                                                                                  |
| Business-value evidence               | Requires runtime telemetry plus outcome sources.                                                                                                                                                  |
| Shift-left scanner                    | Deliberately sequenced after the governance lifecycle workflow so it reuses one policy definition.                                                                                                |

---

## Exact evidence boundaries

These boundaries are what keep the product honest. They are enforced in code, not only in documentation.

| Boundary                                                                                              | Enforcement                                                                                            |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Foundry evidence is **declared configuration**, never observed runtime behavior.                      | Connector label plus explicit blind-spot reporting on `GET /api/connectors`.                           |
| The connector never infers tools, relationships, owners, or health that Foundry did not return.       | Schema validation; a malformed response fails rather than degrading to a guess.                        |
| A degraded connector reports degraded health; it is never replaced with mock success.                 | Connector health path in `apps/api`.                                                                   |
| Live quality, reliability, and cost report `unknown` because no telemetry connector is connected.     | Scorecard validation in `apps/web/src/scorecard.ts`; mock cost posture is explicitly synthetic.        |
| Missing evidence lowers confidence and never implies safety.                                          | Product invariant, see [CONTEXT.md](CONTEXT.md).                                                       |
| The advisory model explains evidence; it never establishes security truth or authorizes an action.    | Grounding check plus schema validation; ungrounded output is rejected.                                 |
| Live mode is read-only for demo routes.                                                               | Non-`GET` requests to `/api/demo/*` return `403 read_only_mode` in live mode.                          |
| Remediation execution requires the `executeRemediation` capability, which only `Administrator` holds. | Per-route capability guards in `apps/api/src/auth.ts`.                                                 |
| The estate is synthetic. No production customer agents exist in the environment.                      | Six-agent manifest owned by `@agent-sentinel/scenarios`; deployment tagged `synthetic`.                |
| Manifest adapter claims are non-authoritative and never outrank a first-party connector.              | `sourceOfTruth: false` is a constant; declared confidence is capped at 0.7, default 0.4.               |
| The manifest adapter performs no network I/O and exposes no ingestion endpoint.                       | Paths containing `://` or a leading `//` are rejected before any read; only absolute local paths load. |
| The manifest adapter cannot act on the estate.                                                        | `ManifestConnector` has no `execute()`; an `execute` action depth is rejected at load time.            |

---

## Current Azure state

| Component                 | State on 2026-08-23                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Container Apps            | `web` (external within the internal ACA environment), `api` (environment-internal only), `jobs` (no ingress). Revision 11 on `8179785`.  |
| ACA environment           | Internal, VNet-integrated, private.                                                                                                      |
| Data services             | Cosmos DB, PostgreSQL Flexible Server, Azure AI Search, Service Bus — all behind private endpoints or a delegated subnet.                |
| Platform services         | Key Vault, Azure Container Registry (public network access disabled), Application Insights.                                              |
| Public edge — App Gateway | **Active.** WAF v2 in Prevention mode, HTTP on port 80 only, no custom domain or TLS. Management-automated and may stop.                 |
| Public edge — Front Door  | **Active.** The Front Door endpoint currently routes both web and API over HTTPS and is the candidate SPA redirect target.               |
| Data mode                 | `live` — the API and jobs use the Foundry connector against Cosmos.                                                                      |
| Auth mode                 | `disabled`.                                                                                                                              |
| Write posture             | `writeEnabled=false`, and the WAF blocks pre-auth mutations under `/api/`.                                                               |
| Advisory model            | `gpt-5.6-terra`, `GlobalStandard`, `NoAutoUpgrade`. Advisory output on the public edge is **mock** until Entra and WAF activation.       |
| Build path                | Private self-hosted GitHub Actions runner inside the VNet. May be deallocated and must be started before a build.                        |
| Deploy path               | The runner's managed identity holds `AcrPush` only. Automated platform deploy and what-if lack permission; ACA image updates are manual. |

Endpoint host names, resource names, and operational commands are in [deployment.md](deployment.md) and [runbooks.md](runbooks.md). No subscription, tenant, or credential values are recorded in documentation.

---

## Validation baseline

Measured on 2026-08-24 on `feature/live-exposure`.

| Suite                        | Command                                                 | Result                                              |
| ---------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| Behavior engine tests        | `pnpm --filter @agent-sentinel/behavior-engine test`    | **70 passing**, 3 files                             |
| API unit tests               | `pnpm --filter @agent-sentinel/api test`                | **127 passing**, 11 files                           |
| Manifest connector tests     | `pnpm --filter @agent-sentinel/manifest-connector test` | **53 passing**, 1 file                              |
| Web unit and component tests | `pnpm --filter @agent-sentinel/web test`                | **194 passing**, 26 files                           |
| End-to-end                   | `pnpm test:e2e`                                         | **23 tests** across 10 Playwright specs             |
| Bicep                        | `az bicep build`                                        | Builds, with baseline linter warnings               |
| Web production build         | `pnpm --filter @agent-sentinel/web build`               | Succeeds with a Rollup chunk-size warning (>500 kB) |

---

## Next unblock conditions

In dependency order. Each condition gates everything below it in its own track.

1. **Entra app registrations created** (API app with read and write scopes, SPA app with redirect URIs) → `AUTH_MODE=jwt` can be configured.
2. **`AUTH_MODE=jwt` deployed with real employee login validated** → per-employee entitlement personalization and owner-scoped views become meaningful.
3. **JWT write-scope tests plus an authorized remediation smoke test pass** → the `BlockApiMutationPreAuth` WAF rule can be narrowed, unblocking Terra authenticated `POST` and remediation execution.
4. **Custom domain and TLS on the public edge** → the HTTP-only Application Gateway listener stops being the constraint and the SPA redirect URI can be finalized.
5. **OTel connector ingestion pipeline lands** → the behavior-baseline engine (already implemented) starts receiving real `ObservationWindow` objects; quality, reliability, and cost dimensions become evidence-backed instead of `unknown`; the synthetic drift demonstration is replaced by real per-agent findings.

Tracks 1–4 are identity- or edge-dependent. Track 5 is independent and can
proceed in parallel. See [roadmap.md](roadmap.md).
