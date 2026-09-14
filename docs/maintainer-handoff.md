# Maintainer handoff

**Operational truth as of 2026-09-14** · Canonical integration branch: `feature/production-readiness-r1` · Latest merged SHA: `456d01f2`

This is the single operational handoff for engineers and coding agents. Read [current status](current-status.md) for the dated ledger and [document lifecycle](document-lifecycle.md) before changing another status document. Versioned, sanitized release evidence overrides prose for a specific release; a repository commit never proves deployment.

## Product mission and non-negotiable evidence rules

Agent Sentinel is an evidence-first control plane that connects authoritative records for enterprise AI agents, identities, tools, data, telemetry, distribution, and cloud resources. It discovers and correlates evidence, computes deterministic exposure and assurance results, and supports auditable governance. It does not replace Agent 365, Foundry, Entra, Defender, Purview, Teams, or their authorization planes.

The required loop is **connect → discover → normalize → correlate → analyze → govern**.

Never violate these rules:

1. Mock, synthetic, empty, missing, stale, sampled, partial, or unattributed evidence cannot establish a live pass.
2. Preserve estate, tenant, environment, source, provider object ID, timestamp, freshness, confidence, and evidence references.
3. Correlate identities only by exact authoritative identifiers. Never use names, aliases, owners, or fuzzy matching.
4. Partial authoritative discovery must not overwrite the last complete snapshot or resolve earlier findings.
5. `unknown`, `insufficient-data`, `authorization-required`, `degraded`, and valid-empty are distinct states.
6. Policies and graph traversal establish security truth. The model may explain cited evidence but never create findings or authorize actions.
7. Live writes require JWT, exact capability checks, writes enabled, active-edge protection, idempotency, audit evidence, rollback, and human approval.
8. Do not broaden permissions, use preview APIs, or invent evidence to make a demo pass.

## Repository and architecture

The repository is a Node.js 22, pnpm 10, TypeScript, Turborepo monorepo.

| Area                                                                          | Responsibility                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                                                                    | React/Vite SPA, MSAL integration, operational and Demo Readiness surfaces                                                                                         |
| `apps/api`                                                                    | Fastify API, authentication/RBAC, read models, connector and governance routes                                                                                    |
| `apps/jobs`                                                                   | Scheduled/event-driven discovery, composition, snapshot persistence, policy evaluation                                                                            |
| `packages/domain`                                                             | Canonical entities, evidence, findings, estate and connector-source contracts                                                                                     |
| `packages/connector-sdk`                                                      | Connector contracts, health, manifest and demo-readiness schemas                                                                                                  |
| `packages/connector-runtime`                                                  | Source construction and bounded connector orchestration                                                                                                           |
| `connectors/*`                                                                | Read-only provider adapters for Foundry, Entra, Agent 365, Azure Monitor, Azure Resource Graph, Defender, Purview, Teams, Power Platform, outcomes, and manifests |
| `packages/persistence`                                                        | In-memory and Cosmos repositories, ETag and estate isolation behavior                                                                                             |
| `packages/policy-engine`, `packages/graph-engine`, `packages/behavior-engine` | Deterministic findings, paths, drift, reliability, and economics                                                                                                  |
| `packages/scenarios`                                                          | Explicit synthetic validation agents and fixtures                                                                                                                 |
| `packages/ui`                                                                 | Shared accessible design-system primitives and Storybook                                                                                                          |
| `packages/shift-left-scanner`, `tools`                                        | Offline manifest validation and pre-publication policy checks                                                                                                     |
| `scripts`                                                                     | Auth planning, live validators, Demo Readiness, Foundry helpers, release evidence                                                                                 |
| `infra`                                                                       | Bicep modules, environment parameters, private runner, identity, edge, and data services                                                                          |

The runtime is a modular monolith deployed as web, API, and jobs Container Apps. Jobs compose bounded connector reads into one estate snapshot in Cosmos; API surfaces read that persisted state. See [architecture](architecture.md) and [data model](data-model.md).

## Version truth

- `feature/production-readiness-r1` is the canonical integration branch for this handoff; `456d01f2` is its current integration head.
- Live base URL: `https://agent-sentinel-dadmh3cee9edbwha.b01.azurefd.net`.
- Web: SHA `372944b2e70f11050d20ca0596a5bfe1cb11e5db`, digest `sha256:ba52df80df821e67f2b8936a6f1c96bc6af881753c7187e70d0b033e66a8d1f4`.
- API: revision `api-as-m098047--p168bc0baa`, SHA `68bc0baaa346111c3f36aef07c9d7f4a7eba33ea`, digest `sha256:aa6f191623b27ebeaaca47614bae7d582579ce251a3f62de23f09263fb7af4c9`.
- Jobs: SHA `c26fe400d6f91bed897155e49d2f8e7b18b94f95`, digest `sha256:1438fd84ea10af0fd438609989875d8232ce43ff716e1d0d57be313476014648`.
- Entra staged activation hardening (`43cde6ab`) and deterministic release-review v2 (`456d01f2`) are newer than the deployed API. They are repository-ready, not deployed.

## Local WSL setup

Use a native WSL clone, not a OneDrive-mounted Windows clone.

```bash
git clone <repository-url> ~/project/agent-sentinel
cd ~/project/agent-sentinel
git switch feature/production-readiness-r1
source ~/.nvm/nvm.sh
nvm install 22
nvm use 22
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --offline --frozen-lockfile  # use normal install only when network access is approved
```

Common local commands:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e                  # web/routing changes
pnpm storybook:build           # shared UI changes
pnpm release-evidence:schema:check
git diff --check
```

Build workspace dependencies before running package tests from a clean checkout when package exports point to `dist`. Never run live validation, provisioning, cleanup, auth apply, or deployment as part of ordinary local validation.

## Test pyramid and known baseline

| Layer          | Command                                       | Known baseline                                                                                               |
| -------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Formatting     | `pnpm format:check`                           | Repository-wide check has unrelated historical drift; touched files must pass Prettier.                      |
| Static         | `pnpm lint`; `pnpm typecheck`                 | Last recorded full baseline: 48/48 tasks passed on 2026-08-31.                                               |
| Unit/contract  | `pnpm test`                                   | Last recorded full baseline: 901 passing tests on 2026-08-31.                                                |
| Build          | `pnpm build`                                  | Last recorded full baseline: 25/25 tasks passed on 2026-08-31.                                               |
| Browser        | `pnpm test:e2e`                               | Last recorded baseline: 23 tests across 10 specs. Run only when relevant.                                    |
| Infrastructure | `az bicep build -f infra/platform.bicep`      | Historical build passed with baseline warnings; no what-if or deployment is implied.                         |
| Live provider  | `pnpm foundry:validate`, auth/live validators | Operator-only, explicit, bounded, and never a CI default. Historical results do not validate a newer commit. |

Treat the dated baseline as historical, not as proof for the current commit. Record fresh command results in the pull request or release evidence.

## Current deployed state

- The reference deployment is available at `https://agent-sentinel-dadmh3cee9edbwha.b01.azurefd.net` with the immutable web/API/jobs versions in [Version truth](#version-truth).
- The active Azure edge is Front Door over HTTPS. Application Gateway is stopped and diagnostic only.
- Front Door has an active WAF policy but **no evidenced custom mutation-block rule**. The similarly named rule on the stopped Application Gateway does not protect Front Door.
- `AUTH_MODE=disabled`; there are no replacement API or SPA app registrations, no live employee login, no role assignments, and no deployed JWT activation.
- `AGENT_SENTINEL_WRITE_ENABLED=false`; remediation and manifest ingestion remain non-live.
- Foundry data mode is live against one reference source containing six synthetic validation agents and no production customer agents.
- The connector-source plane is provisioned for the reference environment.
- Agent 365 is deployed and `ready + complete`: 308 packages, 302 agent-package nodes, 6 extension-package nodes, and 308 live source-bound evidence records.
- Demo Readiness is **partial**: Agent 365 ready; `RUNS_AS` 0; qualifying live OTel records 0; authentication disabled; writes false.

## Exact connector state

| Connector                         | Current state                                         | Exact boundary / unblock                                                                                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure AI Foundry                  | **Connected**                                         | One project; six authoritative synthetic agents; declared configuration only. Additional projects need separate authorization.                                                                                                         |
| Microsoft Entra inventory         | **Inventory connected; parity unmatched**             | 335 identity nodes, but agents expose no exact identity IDs; therefore 0 `RUNS_AS` edges. Optional owner/app-role/preview reads remain separate approvals.                                                                             |
| Azure Resource Graph              | **Connected for authorized view**                     | Five resources persisted through current scoped roles; this is not full subscription coverage and creates no agent edges.                                                                                                              |
| Azure Monitor / OTel              | **Query connected; telemetry insufficient**           | Current audit has no analysis-ready request/dependency/trace rows and metrics lack required agent attributes. Baseline and observed windows each require at least ten fresh, complete, unsampled measured spans with exact provenance. |
| Agent 365 package catalog         | **Deployed; ready and complete**                      | 308 packages produced 302 agent-package nodes, 6 extension-package nodes, and 308 live source-bound evidence records. Package count is not an executing-agent count.                                                                   |
| Microsoft 365 / SharePoint agents | **Covered through deployed Agent 365 classification** | Classification is from package metadata only; no SharePoint scraping.                                                                                                                                                                  |
| Defender for Cloud Apps           | **Connected, valid-empty**                            | Bounded alert and activity reads are ready with zero current records; no agent correlation is inferred.                                                                                                                                |
| Purview sensitivity labels        | **Connected**                                         | Twelve bounded label definitions are persisted; they do not prove label usage, content protection, attribution, trust, or compliance.                                                                                                  |
| Teams organization catalog        | **Connected, valid-empty**                            | Zero organization entries; this does not prove installation or distribution coverage.                                                                                                                                                  |
| Power Platform ResourceQuery      | **Implemented; unattended activation unsupported**    | No production-supported app-only inventory authorization with enforceable scope.                                                                                                                                                       |
| Business outcomes                 | **Contract complete; not configured**                 | Value remains unknown until an authoritative source supplies exact run, correlation, or version evidence.                                                                                                                              |
| Custom manifest adapter           | **Implemented; activation-gated**                     | Offline validation/scanning works. Live ingestion requires activated auth, writes, active-edge protection, and approval.                                                                                                               |

See [connector availability](connector-availability.md) for the durable state definitions and detailed limits.

## Blocking dependencies and human-only actions

### Authentication and repository/deployment gap

- A human owner must approve the exact replacement registration plan, create the API/SPA registrations, complete least-privilege consent and assignments for Viewer, Analyst, Approver, and Administrator, and supply sanitized outputs.
- A protected deployment reviewer must approve immutable API/web digests and the surgical read-only auth activation. No coding agent may apply the plan.
- The latest Entra activation hardening and release-review v2 changes are newer than the deployed API; deploy them only through an approved immutable, surgical rollout.

### `RUNS_AS` and telemetry

- `RUNS_AS` is blocked by missing exact provider identity IDs on every authoritative Foundry agent. Only a source-local object ID, app/client ID, or separately approved Agent Identity ID can unblock it.
- OTel is blocked by missing representative, non-customer, complete, unsampled spans with required estate/source/agent/trace/span/token/cost fields and read-only workspace query access.

### Deployment, runner, Cosmos, and edge

- Full `infra/platform.bicep` deployment is prohibited: the latest what-if showed 54 unrelated modifications.
- The private runner may be deallocated, does not yet have the complete approved deployment role set, and must be explicitly started and verified before builds.
- The reference `connector-sources` container is provisioned and in use. A new tenant must provision its own isolated container and validate partition, index, estate, and ETag behavior.
- Manifest `manifest-ingestions-v2` cutover requires manual copy verification and approval; the compatibility container remains authoritative until then.
- Front Door needs a separately reviewed custom mutation rule before any write-stage readiness.
- OneRAI remains a human onboarding track requiring authoritative product and legal/compliance review. It does not block local engineering.

## Ordered next 10 tasks

1. **Reproduce the clean repository baseline.** Record Node/pnpm versions, install method, lint, typecheck, tests, build, touched-file Prettier, and `git diff --check` against one full SHA.
2. **Read the tenant-neutral bootstrap.** Assign primary, secondary, and emergency owners, then inventory tenant-local resources and permissions without copying the reference environment.
3. **Generate the replacement registration plan.** Run the offline bootstrap against sanitized input; do not apply or grant permissions locally.
4. **Complete human identity approval.** Create API/SPA registrations, consent, redirects, and four role assignments through the authoritative owner process.
5. **Build immutable release images.** Use the approved private runner, full-SHA tags, canonical digests, and protected environments.
6. **Deploy repository-only changes surgically.** Update API first, then jobs and web only as required; keep writes false and record exact revisions/digests.
7. **Validate authentication at Front Door.** Verify anonymous denial, `/api/auth/me`, all four roles, login/logout, and no-write posture.
8. **Establish exact identity and telemetry evidence.** Obtain exact agent-side identifiers for all six `RUNS_AS` edges and representative qualifying OTel records; never use fuzzy identity matching or fixtures.
9. **Generate deterministic release evidence.** Bind checks, deployed versions, connector observations, accessibility evidence, and sanitized configuration to one exact SHA.
10. **Obtain human release decisions.** Security, Accessibility, OneRAI, and release owners approve independently; otherwise readiness remains partial or blocked.

## Dangerous operations: do not do

- Do not deploy, run cloud what-if, alter cloud resources, grant permissions, create registrations, access private tenant data, or invoke live validators without explicit operator authorization.
- Do not run full `infra/platform.bicep` against the existing environment.
- Do not enable writes or rely on the stopped Application Gateway rule as Front Door protection.
- Do not use mutable image tags, retag for rollback, or claim deployment from a registry push.
- Do not infer identities, agent status, coverage, trust, or value from names, empty results, package totals, catalog definitions, or fixtures.
- Do not commit tokens, credentials, private identifiers, raw provider payloads, generated live evidence, local paths, or environment-specific auth plans.
- Do not broaden RBAC/Graph scopes or enable preview APIs merely to unblock a demo.
- Do not edit, stage, revert, normalize, or otherwise disturb unrelated changes in `infra/environments/mngenvmcap098047-foundry.parameters.bicepparam`.

## Safe deployment and rollback path

Deployment is human-approved and surgical:

1. Confirm the exact account/tenant/subscription outside repository artifacts.
2. Require a clean release worktree and full 40-hex SHA.
3. Run local checks and offline Bicep builds. Review the narrowly scoped what-if.
4. Build on the approved private runner; record canonical image digests.
5. Deploy API first by digest, verify one active revision, health, connector status, and anonymous mutation denial.
6. Deploy jobs second, verify one bounded ingestion and persisted health. Deploy web last only if needed.
7. Keep writes false. Run auth edge validation, Demo Readiness, and sanitized release-evidence validation.
8. Stop on any mismatch, stale/partial evidence, unexpected resource change, or extra active revision.

Rollback restores the previous reviewed API digest first, then jobs, then web if changed; restore the active Front Door mutation block first if a future approved rule exists, and keep writes false. Verify one active revision and the same smoke checks. Never retag images. See [deployment](deployment.md), [supply chain](supply-chain.md), and [runbooks](runbooks.md).

## Operational tools

### Demo Readiness

Use only after an approved deployment. `pnpm demo:verify -- --url <https-url> ...` performs bounded documented `GET` requests, accepts expected SHAs/digests, emits sanitized JSON, and returns `0` ready, `3` partial, `1` blocked/unavailable/error, or `2` invalid arguments. Omit the token option only while auth is disabled. The web **Demo readiness** page uses the same evaluator. See RB-013 in [runbooks](runbooks.md).

### Auth preflight and bootstrap

1. Copy the checked-in registration template to a secure untracked location.
2. Run `pnpm auth:registration-bootstrap -- --input <path> --output <plan.json>`; review only, do not apply locally.
3. After human registration approval, prepare the activation input and run `pnpm auth:preflight -- --input <path> --output <plan.json>`.
4. The protected workflows are the only apply/deploy paths. Inputs and plans are environment-specific and must not be committed.

See [security and authentication](security-authentication.md) and the auth section of [deployment](deployment.md).

### Release evidence

- Repository-only: `pnpm release-evidence:generate -- --output release-evidence/generated/<full-sha>.json`.
- With owner-supplied sanitized observations: add `--input <sanitized-input.json>`.
- Validate: `pnpm release-evidence:validate -- <manifest.json>` and `pnpm release-evidence:schema:check`.

The generator is offline and does not run tests or contact providers. Unsupplied facts remain `unknown`, `planned`, or `not-run`. Generated/private evidence is ignored and must not be committed. See [release evidence](release-evidence.md).

## Git workflow and clean-worktree expectations

- Branch from the canonical integration SHA, not stale `main`.
- Keep one bounded concern per branch and commit. Rebase/merge only as directed by the owner.
- Before editing, record `git status --short --branch`; preserve unrelated dirt byte-for-byte and unstaged.
- Format only touched files when repository-wide baseline drift exists.
- Before commit: inspect `git diff --stat`, `git diff --check`, every changed hunk, deleted-file references, and staged paths.
- Stage explicit paths. Never use `git add -A` when unrelated dirt exists.
- Commit generated plans/evidence only when the relevant specification explicitly requires a sanitized fixture.
- Do not push. The parent/integration owner inspects and publishes.

## Important files

| File                                                                | Why it matters                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `agent-sentinel-product-spec.md`                                    | Product requirements and immutable scope                       |
| `docs/CONTEXT.md`                                                   | Shared domain vocabulary and evidence invariants               |
| `docs/current-status.md`                                            | Authoritative dated operational ledger                         |
| `docs/connector-availability.md`                                    | Connector implementation/live-state matrix                     |
| `docs/known-issues.md`                                              | Named blockers and unblock conditions                          |
| `docs/architecture.md`, `docs/data-model.md`                        | Runtime topology and contracts                                 |
| `docs/development.md`, `docs/new-tenant-bootstrap.md`               | Local workflow and tenant-neutral ownership/bootstrap guidance |
| `docs/security-authentication.md`                                   | Auth states, roles, and activation checklist                   |
| `docs/deployment.md`, `docs/runbooks.md`, `docs/supply-chain.md`    | Deployment, operations, rollback, and image provenance         |
| `docs/release-evidence.md`                                          | Sanitized release-evidence contract and CLI                    |
| `infra/auth/*`                                                      | Strict registration/auth input schemas and templates           |
| `.github/workflows/*auth*`, `.github/workflows/ci-build-deploy.yml` | Protected planning and deployment workflows                    |

## Troubleshooting

- **`node_modules` missing / package entry cannot resolve:** use Node 22, run `pnpm install --offline --frozen-lockfile`, then `pnpm build` before isolated package tests that consume workspace `dist` exports.
- **Private runner job is queued:** verify the approved runner VM is running, registered, online, and carries the exact replacement label. Do not substitute a public runner for private ACR/network work.
- **Full what-if shows unrelated changes:** stop. Use the narrowly scoped template/workflow or reconcile drift through a separate reviewed task.
- **Connector says ready but data is empty:** preserve valid-empty; do not describe coverage as complete.
- **0 `RUNS_AS`:** inspect exact identity diagnostics. Missing provider IDs are expected; never add a name-based join.
- **OTel remains insufficient:** verify raw request spans, exact attributes, unsampled rows, both time windows, sample counts, freshness, and workspace binding. Metrics alone do not qualify.
- **Auth preflight blocks:** fix the input or approval evidence; do not relax schemas, use mutable tags, enable writes, or bypass the protected workflow.
- **Demo Readiness is partial/blocked:** follow its categorized requirements. Never replace a missing live category with fixtures.
- **Prettier fails on untouched files:** record the baseline and run Prettier only on touched files; do not mix cleanup into the handoff change.

## Handoff checklist

- [ ] Work starts from `feature/production-readiness-r1` at or after `456d01f2`.
- [ ] `docs/current-status.md` and connector state were read before planning.
- [ ] Repository, deployed, and evidence versions are kept separate.
- [ ] No live/cloud/private operation is assumed or performed by a coding task.
- [ ] Exact evidence and identity boundaries are preserved.
- [ ] The relevant narrow and full local checks are recorded.
- [ ] Touched Markdown passes Prettier and relative-link validation.
- [ ] Deleted/renamed document references are absent.
- [ ] Worktree is clean except explicitly preserved unrelated dirt.
- [ ] Remaining blockers, approvals, and required live validation are explicit.
