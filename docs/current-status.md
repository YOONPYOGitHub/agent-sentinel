# Current status

**Status date: 2026-09-14** · Canonical branch: `feature/multi-source-otel` · Official repository SHA: `6e271f5a`

This is the authoritative dated ledger for the Agent Sentinel control plane. It separates repository capability, deployed state, provider access, and evidence quality. Missing evidence is never a pass. For operating instructions and next work, use the [maintainer handoff](maintainer-handoff.md).

## Release boundary

| Boundary       | Current truth                                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository     | `6e271f5a` is the latest merged integration SHA used for this handoff.                                                                                                |
| Deployment     | `7458b3e` is the last evidenced deployed web/API/jobs tag. Its full SHA, running digests, and sanitized configuration hash are not available.                         |
| Authentication | Replacement API/SPA registrations do not exist. `AUTH_MODE=disabled`; no live employee login, role assignment, or deployed JWT validation exists.                     |
| Writes         | `AGENT_SENTINEL_WRITE_ENABLED=false`. Remediation and manifest ingestion are not live capabilities.                                                                   |
| Edge           | Front Door is the active HTTPS edge. Its WAF has no evidenced custom mutation rule. The mutation rule on the stopped Application Gateway does not protect Front Door. |
| Estate         | One live Foundry source contains six synthetic validation agents and no production customer agents.                                                                   |

Repository milestones now merged into the canonical branch are:

| Merge SHA  | Milestone                                            |
| ---------- | ---------------------------------------------------- |
| `03e54d6d` | Real-data P0 integration                             |
| `b5bc7037` | Bounded Demo Readiness verifier                      |
| `36e9bd25` | Replacement-auth readiness gate                      |
| `05e96731` | Approval-gated Entra registration bootstrap          |
| `6e271f5a` | Product README redesign and current integration head |

Their presence in Git does not prove deployment.

## Current implementation and live state

| Area                        | Repository state                                                                                                 | Deployed/evidence state                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Web, API, jobs              | Implemented as a TypeScript monorepo with persisted live read models                                             | Web/API/jobs run behind Front Door at `7458b3e`; later repository work is undeployed                                                        |
| Evidence graph and policies | Deterministic graph and `AS-POL-001..003` exposure evaluation are implemented                                    | Live findings use jobs-persisted snapshots; attack-path legacy fixtures remain mock-only                                                    |
| Governance                  | Durable cases, guarded transitions, exceptions, and audit evidence are implemented                               | Public mutation remains blocked; remediation is simulation-only                                                                             |
| Multi-estate isolation      | Estate context, partitioning, source scoping, and mismatch rejection are implemented                             | Only the default replacement estate is evidenced live                                                                                       |
| Connector source plane      | Strict non-secret schemas, ETags, idempotency, immutable audit, and deployment-source protection are implemented | The replacement `connector-sources` Cosmos container still requires approved, scoped provisioning                                           |
| Authentication              | JWT validation, MSAL, four roles, preflight, registration bootstrap, and protected workflows are implemented     | No replacement registrations or live JWT activation                                                                                         |
| Release evidence            | Versioned offline generator, schema, and validator are implemented                                               | No complete sanitized manifest binds the current deployment to full SHA, digests, and config hash                                           |
| Demo Readiness              | Shared evaluator, CLI, and web page are implemented                                                              | Must be run only after an approved deployment; current Agent 365, `RUNS_AS`, OTel, and version facts cannot produce a complete ready result |

## Connector ledger

Detailed state definitions and limits are in [connector availability](connector-availability.md).

| Connector                         | Current state                                      | Evidence boundary / blocker                                                                                                                                                                          |
| --------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure AI Foundry                  | **Connected**                                      | One source; six authoritative synthetic agents; declared configuration only                                                                                                                          |
| Microsoft Entra inventory         | **Inventory connected; parity unmatched**          | 335 identity nodes; all six agents lack exact identity IDs; 0 `RUNS_AS` edges                                                                                                                        |
| Azure Resource Graph              | **Connected for current authorized view**          | Five resources persisted; current scope is not proof of subscription-wide coverage                                                                                                                   |
| Azure Monitor / OTel              | **Query connected; telemetry insufficient**        | No analysis-ready request/dependency/trace rows; metrics lack required agent attributes; live dimensions remain unknown/insufficient                                                                 |
| Agent 365 package catalog         | **Provider access verified; runtime undeployed**   | Licensing, one assigned seat, least-privilege read permission, and one bounded successful package-list read are verified; API/jobs persistence and classified snapshot are not deployed or validated |
| Microsoft 365 / SharePoint agents | **Covered by Agent 365; undeployed**               | Classification comes only from package metadata; there is no SharePoint scraping connector                                                                                                           |
| Defender for Cloud Apps           | **Connected, valid-empty**                         | Current bounded alert/activity reads return zero records; no evidence nodes or agent joins are inferred                                                                                              |
| Purview sensitivity labels        | **Connected**                                      | Twelve bounded label definitions; no usage, content, user, agent, trust, or compliance claim                                                                                                         |
| Teams organization catalog        | **Connected, valid-empty**                         | Zero organization entries; no installation or distribution coverage claim                                                                                                                            |
| Power Platform ResourceQuery      | **Implemented; unattended activation unsupported** | Microsoft does not provide a production-supported app-only inventory permission with enforceable scope                                                                                               |
| Business outcomes                 | **Contract complete; not configured**              | No authoritative exact-correlated outcome source; value remains unknown                                                                                                                              |
| Custom manifest adapter           | **Implemented; activation-gated**                  | Offline validation/scanning works; live ingestion is blocked by auth, writes, and active-edge requirements                                                                                           |

## Evidence facts that must not be overstated

- The six Foundry agents are synthetic validation agents, not production customer agents.
- Foundry returns declared agent/tool configuration, not observed runtime execution or authorization decisions.
- A package total is a provider catalog count, not an agent count.
- Valid-empty Defender and Teams results prove only that bounded requests returned zero rows.
- Purview label definitions do not prove label application or compliance.
- Azure Resource Graph scope reflects current role visibility, not full subscription coverage.
- Entra inventory does not establish `RUNS_AS`; exact agent-side identity identifiers are absent.
- OTel query access does not establish analysis readiness; complete fresh unsampled evidence is absent.
- The advisory model is explanatory only and remains mock on the public edge until the grounded provider path is activated.

## Active blockers

| Blocker                  | Current fact                                                                     | Required unblock                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Replacement auth         | No API/SPA registrations, consent, role assignments, or deployed JWT settings    | Human approval and application of the exact bootstrap plan, then protected read-only activation and live role validation        |
| Front Door writes        | Active WAF has no evidenced custom mutation rule                                 | Separately review, deploy, and rediscover an exact mutation rule after read-only JWT validation; writes stay false              |
| Agent 365 runtime        | Provider access exists, but reviewed API/jobs code is undeployed                 | Deploy immutable reviewed digests, run one bounded ingestion, and validate source-bound persisted health/classification         |
| `RUNS_AS`                | Foundry agents expose no exact object/app/client/Agent Identity IDs              | Source supplies an exact authoritative identifier; no fuzzy fallback is permitted                                               |
| OTel                     | Current evidence is absent or insufficient                                       | Produce approved non-customer, complete, fresh, unsampled baseline and observed spans with exact provenance and measured fields |
| Private deployment       | Runner may be deallocated and lacks complete approved deployment RBAC            | Human starts/verifies the runner and approves the exact role/deployment scope                                                   |
| Platform drift           | Latest full what-if showed 54 unrelated modifications                            | Do not run full Bicep; reconcile drift separately or use only a reviewed surgical workflow                                      |
| Cosmos connector sources | Target container has not completed the scoped approval/provision/validation path | Approve an exact-container what-if, provision only that resource, and smoke-test estate/ETag behavior                           |
| Manifest v2 cutover      | Compatibility container remains authoritative                                    | Human validates the copy and cutover plan before changing the active container                                                  |
| Power Platform           | No supported unattended inventory authorization                                  | Wait for a production-supported app-only permission with enforceable scope                                                      |
| Business value           | No authoritative outcome source                                                  | Configure a read-only source with exact run/correlation/version evidence                                                        |
| OneRAI                   | Product and legal/compliance onboarding is incomplete                            | Human owners complete the authoritative review path                                                                             |

## Human approvals still open

1. Replacement API and SPA registration creation from the generated exact plan.
2. Least-privilege consent and assignment of Viewer, Analyst, Approver, and Administrator test principals/groups.
3. Private-runner start, immutable image build, and deployment environment review.
4. Scoped creation of the `connector-sources` Cosmos container.
5. Surgical read-only auth activation by digest.
6. Agent 365 API/jobs deployment and persisted-source validation.
7. Front Door mutation-rule design and deployment before any write activation.
8. Representative OTel traffic and workspace-access approval.
9. Optional broader Azure Resource Graph Reader scope, only if full coverage is required.
10. OneRAI/product/legal review and final release decision.

## Validation baseline

The last complete recorded repository baseline was measured on 2026-08-31 with Node 22. It is historical and does not attest `6e271f5a`.

| Check               | Recorded result                                        |
| ------------------- | ------------------------------------------------------ |
| Lint                | 48/48 tasks passed                                     |
| Typecheck           | 48/48 tasks passed                                     |
| Unit/contract tests | 901 tests passed                                       |
| Build               | 25/25 tasks passed                                     |
| Playwright          | 23 tests across 10 specs passed                        |
| Storybook build     | Passed with accessibility addon enabled                |
| Bicep build         | Passed with baseline warnings                          |
| Repository Prettier | Known unrelated drift existed; touched files must pass |

A clean checkout may need `pnpm build` before isolated script tests because several workspace packages publish `dist` entry points. See [development](development.md).

## Safe next boundary

The next release path is: reproduce a clean local baseline → generate and obtain human approval for the replacement registration plan → build full-SHA images on the private runner → record digests → activate read-only JWT surgically with writes false → validate all four roles and Front Door behavior → provision only the connector-source Cosmos container → deploy and validate Agent 365 API/jobs → establish exact `RUNS_AS` and OTel evidence → generate validated sanitized release evidence.

Do not deploy, access cloud/private data, mutate permissions, or run provider validators from an ordinary coding task. The exact sequence, rollback, and definitions of done are in [maintainer handoff](maintainer-handoff.md).
