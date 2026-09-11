# Real-Data P0 Candidate Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the exact reviewed Agent 365, Entra `RUNS_AS`, and Azure Monitor OTel candidate tips onto `34a479d9` as one verified commit without touching the existing Foundry parameter-file modification.

**Architecture:** Apply the candidate stacks in dependency-safe semantic order: Agent 365 first to establish persisted/deployment source authority and the shared connector runtime, Entra second to establish exact identity evidence authority and graph correlation, and OTel third to extend the combined source, persistence, audit, and read-model contract. Use no-commit cherry-picks for non-overlapping history and reconstruct conflicts by retaining every candidate's authority fields, rejection rules, bounds, and fail-closed states.

**Tech Stack:** Node.js 22, pnpm 10.15.1, TypeScript, Zod, Fastify, React, Vitest, Cosmos repositories, Turborepo.

---

### Task 1: Preserve the Base and Record Candidate Coverage

**Files:**

- Preserve unstaged: `infra/environments/mngenvmcap098047-foundry.parameters.bicepparam`
- Create: `docs/superpowers/plans/2026-09-10-real-data-p0-integration.md`

- [ ] **Step 1: Verify the exact base and dirty-file boundary**

Run:

```bash
test "$(git rev-parse HEAD)" = "34a479d9352ad1bb20c34e3ea4e20a6ac3025925"
git status --short
```

Expected: the only pre-existing modification is
`infra/environments/mngenvmcap098047-foundry.parameters.bicepparam`.

- [ ] **Step 2: Verify every candidate descends from the exact base**

Run:

```bash
for tip in \
  4c55e868bcf473e71ae672cc199023f68785a861 \
  cd1e7b965d434955bffebaa936b170b76dfd8fb8 \
  6abe82c43a94f9c2178400879c2b5e85e2b74f49
do
  git merge-base --is-ancestor 34a479d9352ad1bb20c34e3ea4e20a6ac3025925 "$tip"
done
```

Expected: all commands exit zero.

### Task 2: Apply the Agent 365 Authority Stack

**Files:**

- Create: `packages/connector-runtime/**`
- Move: `apps/api/src/deployment-connector-sources.ts` to `packages/connector-runtime/src/deployment-connector-sources.ts`
- Modify: Agent 365 connector, API/jobs factories, connector SDK/domain source schemas, connector UI, tests, deployment packaging, environment examples, and Agent 365/status documentation changed by `34a479d9..4c55e868`

- [ ] **Step 1: Apply the reviewed stack without creating commits**

Run:

```bash
git cherry-pick --no-commit \
  9dc379d3fe0e9b6502e8e96ec8b0292d15b90e88 \
  01e9f54b259eac5f50ab6cd5ce219a0d087f3e20 \
  cba59f64c47f9ad7e80edec3e11853ef60106699 \
  039c49e157f221614160bbd743a2b09cbd8c90e6 \
  bb072e73f386dd3f200338d96bd32b4dc719ac74 \
  2318729b633e116c28395d5b30b83e5d03319c71 \
  1a3e68f329f6e276574a0830a316962483d297b5 \
  a9488a03ada43a5d634c98082d6145e1ac6efbce \
  5297db319fa2183e47896856945efd9c80b0b1de \
  4c55e868bcf473e71ae672cc199023f68785a861
```

Expected: the index matches the Agent 365 tip for its complete base-relative file set.

- [ ] **Step 2: Verify Agent 365 invariants in focused tests**

Run under Node.js 22 and concurrency 1:

```bash
pnpm --filter @agent-sentinel/agent365-connector test
pnpm --filter @agent-sentinel/connector-runtime test
pnpm --filter @agent-sentinel/api test -- connector-factory connectors-catalog deployment-connector-sources
pnpm --filter @agent-sentinel/jobs test -- connector-factory ingestion
pnpm --filter @agent-sentinel/web test -- connectors-api ConnectorSourceManager ConnectorsPage
```

Expected: persisted sources override deployment sources by exact estate/source authority; explicit UAMI, request bounds, health/classification, and API/jobs/web parity tests pass.

### Task 3: Apply and Reconcile Exact Entra RUNS_AS Authority

**Files:**

- Create: `packages/domain/src/evidence-authority.ts`
- Modify: Entra and Foundry connectors, domain evidence, graph/policy/scanner packages, API DemoService/exposure reads, jobs ingestion/factories, tests, and Entra/data-model docs changed by `34a479d9..cd1e7b96`

- [ ] **Step 1: Apply the reviewed Entra stack without creating commits**

Run:

```bash
git cherry-pick --no-commit \
  64b126d016a08415fd4bf3f3ff8b2a3239bc3c3d \
  0fc09bd90376a01b91dfdc2a2cff46176a895b47 \
  cd1e7b965d434955bffebaa936b170b76dfd8fb8
```

Expected: clean hunks apply automatically; overlapping API/jobs/domain files stop for manual resolution.

- [ ] **Step 2: Reconstruct shared files semantically**

For each conflict, retain both contracts:

```text
Agent 365:
  exact deployment/persisted estate source selection
  explicit UAMI and source-bound health/classification
  bounded API/jobs discovery and connector-source parity

Entra RUNS_AS:
  exact estate/source/tenant/environment/project/object/generation/release evidence
  source-scoped identifier ownership and duplicate rejection
  Agent 365 records cannot acquire Entra attribution
```

Resolve API/jobs connector construction so Agent 365 runtime selection wraps the
combined connector set, while Entra/Foundry exact evidence authority flows into
ingestion, DemoService, graph, policy, and exposure reads.

- [ ] **Step 3: Run combined Agent 365 and Entra focused tests**

Run:

```bash
pnpm --filter @agent-sentinel/domain test
pnpm --filter @agent-sentinel/entra-identity-connector test
pnpm --filter @agent-sentinel/foundry-connector test
pnpm --filter @agent-sentinel/graph-engine test
pnpm --filter @agent-sentinel/policy-engine test
pnpm --filter @agent-sentinel/shift-left-scanner test
pnpm --filter @agent-sentinel/api test -- connector-factory connectors-catalog exposure-api read-model
pnpm --filter @agent-sentinel/jobs test -- ingestion
```

Expected: exact match, duplicate rejection, scoped ownership, non-attribution,
graph, policy, API read-model, and jobs ingestion tests pass.

### Task 4: Apply and Reconcile Authoritative OTel Evidence

**Files:**

- Create: `packages/domain/src/source-project.ts`
- Create: `scripts/validate-live.test.ts`
- Modify: Azure Monitor OTel and Foundry connectors, connector SDK runtime evidence, domain source/correlation/OTel schemas, persistence repositories, API/jobs read paths, connector-source UI, behavior/economics routes, validation scripts, tests, and OTel architecture/status/development docs changed by `34a479d9..6abe82c4`

- [ ] **Step 1: Apply the reviewed OTel stack without creating commits**

Run:

```bash
git cherry-pick --no-commit \
  187bb2ce823139651f6d70d2fc4831cbfe5345cb \
  fdc225f9a3887e937de0538a243a89f78ba623b7 \
  69b5233acaf8d57057e2a400e389f6ad734df9f7 \
  e0e17abcd44d3050b0de9a89312d5c7bd11e31eb \
  0a95dbbafb6dac76022c0ceea1a4caa7c621b851 \
  5a4e504d1788019289a93fcec03bc27ff01bf442 \
  a98a9ba7fbdbf8594097116383bf6bb98b7a3b15 \
  2ec8f80fc9d86c57d458b3be3808a69007c651a4 \
  d909925245f06f1bc755cb2c4f0e21f61ce02288 \
  5610a75bc4711bc4ce2b2d90f352bb3419f4cefb \
  d06d13173964337c6777aaa092a3dfe9959a2555 \
  6abe82c43a94f9c2178400879c2b5e85e2b74f49
```

Expected: OTel-only files apply automatically; source/runtime/factory/read-model/UI/doc overlaps stop for manual resolution.

- [ ] **Step 2: Reconstruct the combined source and read-model contract**

Retain these OTel requirements alongside the prior contracts:

```text
exact project/estate/workspace provenance
migration-safe source and audit reads
immutable trace/run/tool identity
per-observation-window row/page/time bounds
refresh eligibility only for authoritative, fresh, complete windows
```

Adapt OTel deployment-source imports to
`@agent-sentinel/connector-runtime` rather than recreating the moved API-local
module. Merge connector-source Zod schemas and persistence comparison logic so
Agent 365 UAMI authority and OTel project/workspace authority are both required
where applicable. Merge DemoService and jobs ingestion so exact RUNS_AS evidence
and OTel windows coexist without projection fallback or cross-source inference.

- [ ] **Step 3: Regenerate only the lockfile representation of combined manifests**

Run:

```bash
pnpm install --lockfile-only
```

Expected: the lockfile includes connector-runtime, graph-engine, and
azure-monitor-otel workspace dependencies without unrelated version updates.

- [ ] **Step 4: Run combined focused behavior tests**

Run:

```bash
pnpm --filter @agent-sentinel/domain test
pnpm --filter @agent-sentinel/connector-sdk test
pnpm --filter @agent-sentinel/connector-runtime test
pnpm --filter @agent-sentinel/azure-monitor-otel-connector test
pnpm --filter @agent-sentinel/foundry-connector test
pnpm --filter @agent-sentinel/persistence test
pnpm --filter @agent-sentinel/behavior-engine test
pnpm --filter @agent-sentinel/api test -- behavior-api connector-source-api deployment-connector-sources read-model token-economics-api
pnpm --filter @agent-sentinel/jobs test -- connector-factory ingestion
pnpm --filter @agent-sentinel/web test -- connectors-api ConnectorSourceManager
pnpm --filter @agent-sentinel/scripts test -- validate-live
```

Expected: provenance, immutable identity, audit migration, bounds, refresh
eligibility, and combined API/jobs/web source behavior tests pass.

### Task 5: Validate the Integrated Package Graph

**Files:**

- Format only files changed by the integration
- Validate every affected workspace package

- [ ] **Step 1: Format task-owned files only**

Run:

```bash
git diff --name-only --diff-filter=ACMR 34a479d9 -- \
  ':!infra/environments/mngenvmcap098047-foundry.parameters.bicepparam' \
  | xargs pnpm exec prettier --write
```

Expected: only integration-owned text files are formatted.

- [ ] **Step 2: Run affected lint, typecheck, and build with concurrency 1**

Run:

```bash
pnpm turbo run lint typecheck build \
  --concurrency=1 \
  --filter=@agent-sentinel/agent365-connector \
  --filter=@agent-sentinel/entra-identity-connector \
  --filter=@agent-sentinel/azure-monitor-otel-connector \
  --filter=@agent-sentinel/foundry-connector \
  --filter=@agent-sentinel/connector-runtime \
  --filter=@agent-sentinel/connector-sdk \
  --filter=@agent-sentinel/domain \
  --filter=@agent-sentinel/persistence \
  --filter=@agent-sentinel/graph-engine \
  --filter=@agent-sentinel/policy-engine \
  --filter=@agent-sentinel/behavior-engine \
  --filter=@agent-sentinel/shift-left-scanner \
  --filter=@agent-sentinel/api \
  --filter=@agent-sentinel/jobs \
  --filter=@agent-sentinel/web \
  --filter=@agent-sentinel/scripts
```

Expected: all affected lint, typecheck, and build tasks pass under Node.js 22.

- [ ] **Step 3: Check whitespace and the protected dirty file**

Run:

```bash
git diff --check
git status --short
git diff --quiet -- \
  infra/environments/mngenvmcap098047-foundry.parameters.bicepparam
test $? -eq 1
```

Expected: no whitespace errors; the parameter file remains modified and unstaged.

### Task 6: Prove Candidate Equivalence and Create One Commit

**Files:**

- Stage: all integration-owned files
- Do not stage: `infra/environments/mngenvmcap098047-foundry.parameters.bicepparam`

- [ ] **Step 1: Compare each candidate's unique contract against the integrated tree**

Run:

```bash
git diff --stat 34a479d9
git diff --name-status 34a479d9
git status --short
```

Expected: every candidate base-relative path is represented directly, renamed
to the shared runtime location, or deliberately merged into a combined file;
only the protected parameter file remains outside the integration.

- [ ] **Step 2: Stage task-owned files only**

Run:

```bash
git add -A -- . \
  ':(exclude)infra/environments/mngenvmcap098047-foundry.parameters.bicepparam'
git diff --cached --check
git status --short
```

Expected: the protected parameter file is unstaged and all integration files are staged.

- [ ] **Step 3: Create the single integration commit**

Run:

```bash
git commit -m "Integrate reviewed real-data P0 stacks" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: exactly one new commit exists above `34a479d9`.

- [ ] **Step 4: Verify final state**

Run:

```bash
test "$(git rev-list --count 34a479d9..HEAD)" -eq 1
git status --short
git show --stat --oneline --decorate HEAD
```

Expected: one integration commit exists and the only unstaged file is the
pre-existing Foundry parameter file.
