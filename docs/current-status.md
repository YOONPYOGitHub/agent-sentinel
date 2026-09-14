# Current status

**Status date: 2026-09-14** · Integration branch: `feature/production-readiness-r1` · Integration SHA: `456d01f2`

This is the authoritative dated ledger for the Agent Sentinel control plane. It separates repository capability, deployed state, provider access, and evidence quality. Missing evidence is never a pass. For operating instructions and next work, use the [maintainer handoff](maintainer-handoff.md).

## Release boundary

| Boundary       | Current truth                                                                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository     | `456d01f2` is the current integration head. Staged Entra activation hardening (`43cde6ab`) and deterministic release-review v2 (`456d01f2`) are repository changes after the deployed API and are not deployed. |
| Live URL       | The reference deployment is reachable at `https://agent-sentinel-dadmh3cee9edbwha.b01.azurefd.net`. This URL identifies the current reference environment, not a portable tenant default.                       |
| Web            | Deployed SHA `372944b2e70f11050d20ca0596a5bfe1cb11e5db`; digest `sha256:ba52df80df821e67f2b8936a6f1c96bc6af881753c7187e70d0b033e66a8d1f4`.                                                                      |
| API            | Active revision `api-as-m098047--p168bc0baa`; deployed SHA `68bc0baaa346111c3f36aef07c9d7f4a7eba33ea`; digest `sha256:aa6f191623b27ebeaaca47614bae7d582579ce251a3f62de23f09263fb7af4c9`.                        |
| Jobs           | Deployed SHA `c26fe400d6f91bed897155e49d2f8e7b18b94f95`; digest `sha256:1438fd84ea10af0fd438609989875d8232ce43ff716e1d0d57be313476014648`.                                                                      |
| Authentication | `AUTH_MODE=disabled`; no live employee login, role assignment, or deployed JWT validation exists.                                                                                                               |
| Writes         | `AGENT_SENTINEL_WRITE_ENABLED=false`. Remediation and manifest ingestion are not live capabilities.                                                                                                             |
| Edge           | Front Door is the active HTTPS edge. Its WAF has no evidenced custom mutation rule. The mutation rule on the stopped Application Gateway does not protect Front Door.                                           |
| Estate         | One reference Foundry source contains six synthetic validation agents and no production customer agents.                                                                                                        |

A Git commit or image publication alone does not prove deployment. The immutable values above are the verified runtime boundary for this status date.

## Current implementation and live state

| Area                        | Repository state                                                                                                 | Deployed/evidence state                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web, API, jobs              | TypeScript monorepo with persisted live read models                                                              | Web, API, and jobs are live behind Front Door at the distinct immutable versions listed above. Repository-only auth hardening and release-review v2 are newer than the deployed API.                  |
| Evidence graph and policies | Deterministic graph and `AS-POL-001..003` exposure evaluation are implemented                                    | Live findings use jobs-persisted snapshots; attack-path legacy fixtures remain mock-only.                                                                                                             |
| Governance                  | Durable cases, guarded transitions, exceptions, and audit evidence are implemented                               | Public mutation remains blocked; remediation is simulation-only.                                                                                                                                      |
| Multi-estate isolation      | Estate context, partitioning, source scoping, and mismatch rejection are implemented                             | Only the reference replacement estate is evidenced live.                                                                                                                                              |
| Connector source plane      | Strict non-secret schemas, ETags, idempotency, immutable audit, and deployment-source protection are implemented | The reference environment's `connector-sources` container and deployment-managed source bindings are provisioned and in use. New tenants must create their own isolated container and source records. |
| Authentication              | JWT validation, MSAL, four roles, preflight, registration bootstrap, and protected workflows are implemented     | No replacement registrations or live JWT activation. The latest staged activation hardening is not deployed.                                                                                          |
| Release evidence            | Versioned offline generator, schema, validator, and deterministic release-review v2 are implemented              | Release-review v2 is repository-only. Human Security, Accessibility, OneRAI, and release decisions remain external gates.                                                                             |
| Demo Readiness              | Shared evaluator, CLI, and web page are implemented                                                              | **Partial:** Agent 365 is ready; `RUNS_AS` has 0 edges; OTel has 0 qualifying live records; authentication is disabled; writes are false.                                                             |

## Connector ledger

Detailed state definitions and limits are in [connector availability](connector-availability.md).

| Connector                         | Current state                                      | Evidence boundary / blocker                                                                                                                                            |
| --------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure AI Foundry                  | **Connected**                                      | One source; six authoritative synthetic agents; declared configuration only.                                                                                           |
| Microsoft Entra inventory         | **Inventory connected; parity unmatched**          | 335 identity nodes; all six agents lack exact identity IDs; 0 `RUNS_AS` edges.                                                                                         |
| Azure Resource Graph              | **Connected for current authorized view**          | Five resources persisted; current scope is not proof of subscription-wide coverage.                                                                                    |
| Azure Monitor / OTel              | **Query connected; 0 qualifying live records**     | Query access exists, but there are no analysis-ready non-synthetic request/dependency/trace records with the required agent attributes and provenance.                 |
| Agent 365 package catalog         | **Deployed; ready and complete**                   | 308 packages produced 302 agent-package nodes, 6 extension-package nodes, and 308 live source-bound evidence records. Package count remains distinct from agent count. |
| Microsoft 365 / SharePoint agents | **Covered by deployed Agent 365 classification**   | Classification comes only from package metadata; there is no SharePoint scraping connector.                                                                            |
| Defender for Cloud Apps           | **Connected, valid-empty**                         | Current bounded alert/activity reads return zero records; no evidence nodes or agent joins are inferred.                                                               |
| Purview sensitivity labels        | **Connected**                                      | Twelve bounded label definitions; no usage, content, user, agent, trust, or compliance claim.                                                                          |
| Teams organization catalog        | **Connected, valid-empty**                         | Zero organization entries; no installation or distribution coverage claim.                                                                                             |
| Power Platform ResourceQuery      | **Implemented; unattended activation unsupported** | Microsoft does not provide a production-supported app-only inventory permission with enforceable scope.                                                                |
| Business outcomes                 | **Contract complete; not configured**              | No authoritative exact-correlated outcome source; value remains unknown.                                                                                               |
| Custom manifest adapter           | **Implemented; activation-gated**                  | Offline validation/scanning works; live ingestion is blocked by auth, writes, and active-edge requirements.                                                            |

## Evidence facts that must not be overstated

- The six Foundry agents are synthetic validation agents, not production customer agents.
- Foundry returns declared agent/tool configuration, not observed runtime execution or authorization decisions.
- Agent 365's 308 packages are normalized into 302 agent-package nodes and 6 extension-package nodes; package totals must not be restated as a count of executing agents.
- Valid-empty Defender and Teams results prove only that bounded requests returned zero rows.
- Purview label definitions do not prove label application or compliance.
- Azure Resource Graph scope reflects current role visibility, not full subscription coverage.
- Entra inventory does not establish `RUNS_AS`; exact agent-side identity identifiers are absent.
- OTel query access does not establish analysis readiness; there are 0 qualifying live records.
- The advisory model is explanatory only and remains mock on the public edge until the grounded provider path is activated.
- Release-review v2 is offline tooling. Its generated artifacts do not prove that human reviews or live release approval occurred.
- The checked-in `mngenvmcap098047-*` parameter files describe the current reference environment. They are not portable defaults and are not secrets merely because they contain tenant-specific resource names or non-secret identifiers.

## Active blockers

| Blocker                   | Current fact                                                                     | Required unblock                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Replacement auth          | No API/SPA registrations, consent, role assignments, or deployed JWT settings    | Human approval and application of the exact bootstrap plan, followed by protected read-only activation and live role validation. |
| Front Door writes         | Active WAF has no evidenced custom mutation rule                                 | Separately review, deploy, and rediscover an exact mutation rule after read-only JWT validation; writes stay false.              |
| Repository/deployment gap | Entra activation hardening and release-review v2 are newer than the deployed API | Build immutable images from an approved full SHA, record digests, deploy surgically, and capture fresh sanitized evidence.       |
| `RUNS_AS`                 | Six Foundry agents expose no exact object/app/client/Agent Identity IDs          | Source supplies an exact authoritative identifier; no fuzzy fallback is permitted.                                               |
| OTel                      | 0 qualifying live records                                                        | Produce approved non-customer, complete, fresh, unsampled baseline and observed spans with exact provenance and measured fields. |
| Private deployment        | Runner availability and deployment RBAC require operator verification            | Human starts/verifies the runner and approves the exact role/deployment scope.                                                   |
| Platform drift            | The historical full what-if showed 54 unrelated modifications                    | Do not run full Bicep; reconcile drift separately or use only a reviewed surgical workflow.                                      |
| Manifest v2 cutover       | Compatibility container remains authoritative                                    | Human validates the copy and cutover plan before changing the active container.                                                  |
| Power Platform            | No supported unattended inventory authorization                                  | Wait for a production-supported app-only permission with enforceable scope.                                                      |
| Business value            | No authoritative outcome source                                                  | Configure a read-only source with exact run/correlation/version evidence.                                                        |
| OneRAI                    | Product and legal/compliance onboarding is incomplete                            | Human owners complete the authoritative review path.                                                                             |

Agent 365 runtime and the reference `connector-sources` provisioning are complete; they are not active blockers.

## Human approvals still open

1. Replacement API and SPA registration creation from the generated exact plan.
2. Least-privilege consent and assignment of Viewer, Analyst, Approver, and Administrator test principals/groups.
3. Private-runner start, immutable image build, and deployment environment review.
4. Surgical read-only auth activation by digest while writes remain false.
5. Front Door mutation-rule design and deployment before any write activation.
6. Representative OTel traffic and workspace-access approval.
7. Exact authoritative identity identifiers for all six Foundry agents.
8. Optional broader Azure Resource Graph Reader scope, only if full coverage is required.
9. OneRAI/product/legal review and final release decision.

## Validation baseline

The last complete recorded repository baseline was measured on 2026-08-31 with Node 22. It is historical and does not attest `456d01f2` or this documentation commit.

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

A new maintainer can clone the repository and run deterministic mock mode without Azure or Microsoft 365 access. Live reproduction is a separate operator project: provision an independent tenant boundary, assign accountable owners, create least-privilege identities and permissions, deploy immutable images, and validate source-bound evidence. Follow [new tenant bootstrap](new-tenant-bootstrap.md).

For the current reference environment, the next release path is: reproduce a clean local baseline → obtain human approval for replacement registrations → build full-SHA images → record digests → activate read-only JWT surgically with writes false → validate all four roles and Front Door behavior → establish exact `RUNS_AS` and representative OTel evidence → generate validated sanitized release evidence.

Do not deploy, access cloud/private data, mutate permissions, or run provider validators from an ordinary coding task.
