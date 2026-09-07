# Selected Connector Release Linkage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow globally live, fresh, ready connectors without release-link references while requiring those references for connectors selected by a passing live validation.

**Architecture:** Keep connector health validation local to the connector evidence object: ready means live and fresh, with complete live provenance. Keep deployment, snapshot, finding, readiness, and timing correlation in the manifest-level refinement that resolves exact `validation.connectorRefs`.

**Tech Stack:** TypeScript, Zod 4, Vitest 3, pnpm 10.15.1, Node.js 22

---

## File Structure

- `scripts/release-evidence-schema.test.ts`: regression and negative coverage for global versus selected connector evidence.
- `scripts/release-evidence-schema.ts`: connector-local and manifest-level release evidence invariants.
- `docs/release-evidence.md`: user-facing release evidence contract.
- `release-evidence/v1/schema.json`: generated structural schema; expected to remain unchanged after the refinement-only fix.

### Task 1: Add the regression test

**Files:**

- Modify: `scripts/release-evidence-schema.test.ts`

- [x] **Step 1: Extend the selected-connector test with an unreferenced ready OTel connector**

Replace the unreferenced unavailable connector in
`applies passing validation linkage and timing only to referenced supporting connectors`
with:

```ts
{
  connectorId: 'otel:application-insights-primary',
  classification: 'live',
  readiness: 'ready',
  freshness: 'fresh',
  observedAt: '2026-09-03T23:45:00.000Z',
  source: 'sanitized-connector-health',
  scope: { ...sanitizedScope, sourceRef: 'otel-application-insights-primary' },
  evidenceRefs: ['otel-health'],
  summary: 'This global ready connector does not support the passing validation.',
},
```

Assert that the connector remains ready and its defaulted linkage is empty:

```ts
expect(manifest.connectors[1]).toMatchObject({
  connectorId: 'otel:application-insights-primary',
  deploymentRef: null,
  snapshotRef: null,
  findingRefs: [],
  readiness: 'ready',
  observedAt: '2026-09-03T23:45:00.000Z',
})
```

- [x] **Step 2: Run the focused regression and verify RED**

Run:

```bash
source "$HOME/.nvm/nvm.sh" &&
nvm use 22 &&
pnpm --filter @agent-sentinel/scripts exec vitest run \
  release-evidence-schema.test.ts \
  -t "applies passing validation linkage and timing only to referenced supporting connectors"
```

Expected: FAIL with
`ready connector evidence must be live and fresh with deployment, snapshot, and finding references`.

### Task 2: Narrow the ready connector invariant

**Files:**

- Modify: `scripts/release-evidence-schema.ts`
- Test: `scripts/release-evidence-schema.test.ts`

- [x] **Step 1: Remove release linkage from connector-local readiness validation**

Change the ready refinement to:

```ts
if (
  value.readiness === 'ready' &&
  (value.classification !== 'live' || value.freshness !== 'fresh')
) {
  context.addIssue({
    code: 'custom',
    message: 'ready connector evidence must be live and fresh',
  })
}
```

Do not change the manifest-level `supportingConnectors` checks. Those checks
continue to require selected connectors to match `deploymentRef`, `snapshotRef`,
and `findingRefs`.

- [x] **Step 2: Run the focused regression and verify GREEN**

Run:

```bash
source "$HOME/.nvm/nvm.sh" &&
nvm use 22 &&
pnpm --filter @agent-sentinel/scripts exec vitest run \
  release-evidence-schema.test.ts \
  -t "applies passing validation linkage and timing only to referenced supporting connectors"
```

Expected: PASS.

- [x] **Step 3: Run the full release-evidence schema test file**

Run:

```bash
source "$HOME/.nvm/nvm.sh" &&
nvm use 22 &&
pnpm --filter @agent-sentinel/scripts exec vitest run release-evidence-schema.test.ts
```

Expected: all tests pass, including the existing mismatch and missing-reference
negative cases for referenced connectors.

### Task 3: Align documentation and generated schema

**Files:**

- Modify: `docs/release-evidence.md`
- Verify: `release-evidence/v1/schema.json`

- [x] **Step 1: Clarify the global and selected connector contracts**

Update the connector readiness paragraph to state:

```md
`ready` is valid only for fresh live evidence with complete live provenance.
Deployment, snapshot, and finding references are required only when a passing
live validation selects the connector in `connectorRefs`; unreferenced ready
connectors may leave those references null or empty.
```

Update the contradiction list so it explicitly says that missing or mismatched
typed linkage applies to referenced supporting connectors.

- [x] **Step 2: Verify the generated schema remains synchronized**

Run:

```bash
source "$HOME/.nvm/nvm.sh" &&
nvm use 22 &&
pnpm release-evidence:schema:check
```

Expected: PASS with no changes to `release-evidence/v1/schema.json`, because
Zod refinements are runtime cross-field rules and the nullable/array property
shape remains unchanged.

### Task 4: Run focused and repository validation

**Files:**

- Verify all modified files.

- [x] **Step 1: Run focused scripts package validation**

Run:

```bash
source "$HOME/.nvm/nvm.sh" &&
nvm use 22 &&
pnpm --filter @agent-sentinel/scripts lint &&
pnpm --filter @agent-sentinel/scripts typecheck &&
pnpm --filter @agent-sentinel/scripts test
```

Expected: all commands pass.

- [x] **Step 2: Run full repository validation**

Run:

```bash
source "$HOME/.nvm/nvm.sh" &&
nvm use 22 &&
pnpm lint &&
pnpm typecheck &&
pnpm test &&
pnpm build &&
git diff --check
```

Expected: all commands pass. Do not run E2E because this change does not affect
web workflows or routing.

### Task 5: Review and commit

**Files:**

- Commit: `scripts/release-evidence-schema.test.ts`
- Commit: `scripts/release-evidence-schema.ts`
- Commit: `docs/release-evidence.md`
- Commit: `docs/superpowers/plans/2026-09-08-selected-connector-release-linkage.md`
- Commit generated schema only if the schema check requires a real update.

- [x] **Step 1: Review the final diff and worktree**

Run:

```bash
git status --short &&
git --no-pager diff -- \
  scripts/release-evidence-schema.test.ts \
  scripts/release-evidence-schema.ts \
  docs/release-evidence.md \
  release-evidence/v1/schema.json \
  docs/superpowers/plans/2026-09-08-selected-connector-release-linkage.md
```

Expected: only the focused release-evidence changes plus the pre-existing
unrelated Bicep parameter modification in worktree status.

- [x] **Step 2: Commit the implementation without pushing**

Run:

```bash
git add \
  scripts/release-evidence-schema.test.ts \
  scripts/release-evidence-schema.ts \
  docs/release-evidence.md \
  docs/superpowers/plans/2026-09-08-selected-connector-release-linkage.md &&
git commit -m "Scope release linkage to selected connectors" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: one focused implementation commit. Do not push, merge, deploy, submit
forms, or access external systems.
