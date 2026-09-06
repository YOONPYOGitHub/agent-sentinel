# Cosmos Exact-Retry Race Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make concurrent identical connector-source updates and deletes return the committed idempotent result after Cosmos batch 404, 409, or 412 responses without weakening mutation or estate validation.

**Architecture:** Add a one-shot batch rendezvous to the fake Cosmos store so two repository calls deterministically complete their pre-batch reads before either batch executes. Change the Cosmos repository's expected write-conflict path to run the existing fully validated replay lookup before mapping a missing marker to the ordinary status-specific result.

**Tech Stack:** Node.js 22, TypeScript, Vitest, Azure Cosmos transactional-batch API, Zod, pnpm/Turborepo, Azure Bicep

---

## File structure

- Modify `packages/persistence/test/fake-cosmos.ts`: add a test-only one-shot batch barrier while preserving atomic fake-batch behavior.
- Modify `packages/persistence/test/connector-source-repository.test.ts`: add deterministic Cosmos-only concurrent update and delete regression tests.
- Modify `packages/persistence/src/cosmos-connector-source-repository.ts`: reconcile 404, 409, and 412 through the existing exact marker replay validation.

### Task 1: Deterministic fake Cosmos batch barrier

**Files:**
- Modify: `packages/persistence/test/fake-cosmos.ts`

- [ ] **Step 1: Add a one-shot rendezvous**

Add a private barrier record and public setup method:

```ts
interface BatchBarrier {
  arrivalsRemaining: number
  release: () => void
  released: Promise<void>
}

barrierNextBatches(count = 2): void {
  if (!Number.isSafeInteger(count) || count < 2) {
    throw new Error('A fake Cosmos batch barrier requires at least two arrivals.')
  }
  if (this.batchBarrier) {
    throw new Error('A fake Cosmos batch barrier is already active.')
  }
  let release = (): void => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  this.batchBarrier = { arrivalsRemaining: count, release, released }
}
```

Change the fake `items.batch` adapter to await a new `runBatch` method:

```ts
batch: (operations: OperationInput[], partitionKey: string) =>
  this.runBatch(operations, partitionKey),
```

Implement `runBatch` so all selected callers reach the batch boundary before execution:

```ts
private async runBatch(operations: OperationInput[], partitionKey: string) {
  const barrier = this.batchBarrier
  if (barrier) {
    barrier.arrivalsRemaining -= 1
    if (barrier.arrivalsRemaining === 0) {
      this.batchBarrier = undefined
      barrier.release()
    }
    await barrier.released
  }
  return this.batch(operations, partitionKey)
}
```

- [ ] **Step 2: Run the existing persistence test file**

Run:

```bash
pnpm --filter @agent-sentinel/persistence test -- connector-source-repository.test.ts
```

Expected: existing tests pass; the unused barrier does not change behavior.

### Task 2: Failing concurrent exact-retry regressions

**Files:**
- Test: `packages/persistence/test/connector-source-repository.test.ts`

- [ ] **Step 1: Add the identical update race test**

Create a Cosmos-only test that creates a user source, arms
`store.barrierNextBatches(2)`, and starts two calls with the same source ID,
expected ETag, patch, audit ID, idempotency key, actor, and timestamp:

```ts
const results = await Promise.all([
  repository.update(ESTATE_A, created.sourceId, created.etag, patch, operation),
  repository.update(ESTATE_A, created.sourceId, created.etag, patch, operation),
])
const applied = results.find((result) => result.status === 'applied')
const idempotent = results.find((result) => result.status === 'idempotent')
expect(applied).toMatchObject({ status: 'applied', source: { version: 2 } })
expect(idempotent).toEqual({ ...applied, status: 'idempotent' })
```

Also assert one live source, two total audits (create plus update), two total
markers, no duplicate or partial mutation documents, the winning timestamp and
ETag on the source, rejection of the same key with a different patch, and
failure on a tenant-mismatched estate.

- [ ] **Step 2: Add the identical delete race test**

Create a Cosmos-only test that arms the same barrier and starts two identical
delete calls. Assert one `applied` and one exact `idempotent` result, both with
`source: null`, one tombstoned source, two total audits, two total markers, no
partial mutation documents, rejection of a different fingerprint using the
same key, and failure on an environment-mismatched estate.

- [ ] **Step 3: Run the regression tests and verify RED**

Run:

```bash
pnpm --filter @agent-sentinel/persistence test -- connector-source-repository.test.ts
```

Expected: both new tests fail because one caller returns
`{ status: 'conflict', reason: 'etag_mismatch' }` instead of `idempotent`.

### Task 3: Replay-first expected write conflicts

**Files:**
- Modify: `packages/persistence/src/cosmos-connector-source-repository.ts`
- Test: `packages/persistence/test/connector-source-repository.test.ts`

- [ ] **Step 1: Implement the minimal conflict reconciliation**

Replace `writeConflict` with a guard for all expected Cosmos conflict statuses,
then invoke the existing exact replay validation before returning an ordinary
status:

```ts
if (code !== 404 && code !== 409 && code !== 412) {
  throw new Error(`Cosmos connector source write batch failed with status ${code}.`)
}
const replay = await this.replay(estate, logicalSourceId, mutation, fingerprint)
if (replay) return replay
if (code === 404) return { status: 'not_found' }
if (code === 412) return { status: 'conflict', reason: 'etag_mismatch' }
await this.readAudit(estate, mutation.auditId)
return { status: 'conflict', reason: 'audit_id_reuse' }
```

Do not retry the write, infer success from the source/tombstone, relax
fingerprint equality, or bypass existing marker/audit/boundary validation.

- [ ] **Step 2: Run focused persistence and domain tests**

Run:

```bash
pnpm --filter @agent-sentinel/persistence test -- connector-source-repository.test.ts
pnpm --filter @agent-sentinel/domain test -- connector-source.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 3: Run focused type and lint checks**

Run:

```bash
pnpm --filter @agent-sentinel/persistence lint
pnpm --filter @agent-sentinel/persistence typecheck
pnpm --filter @agent-sentinel/domain lint
pnpm --filter @agent-sentinel/domain typecheck
```

Expected: all four commands pass.

### Task 4: Repository validation and local commit

**Files:**
- Verify: all changed files

- [ ] **Step 1: Run all required checks under Node.js 22**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
az bicep build -f infra/platform.bicep
az bicep build -f infra/ci-foundation.bicep
git diff --check
```

Expected: all commands exit zero. Existing baseline Bicep warnings are allowed;
new Bicep errors are not.

- [ ] **Step 2: Review scope and invariants**

Run:

```bash
git status --short
git diff --stat HEAD
git diff HEAD -- packages/persistence/src/cosmos-connector-source-repository.ts packages/persistence/test/fake-cosmos.ts packages/persistence/test/connector-source-repository.test.ts
```

Expected: only the planned files changed; production behavior changes only in
expected write-conflict reconciliation.

- [ ] **Step 3: Commit locally**

Run:

```bash
git add packages/persistence/src/cosmos-connector-source-repository.ts packages/persistence/test/fake-cosmos.ts packages/persistence/test/connector-source-repository.test.ts
git commit -m "Fix concurrent Cosmos exact retries" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: a local commit is created. Do not push, merge, deploy, or mutate any
external system.
