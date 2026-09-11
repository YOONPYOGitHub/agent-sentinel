# Agent 365 Deployment-Only Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent 365 connector sources deployment-managed and read-only, and allow activation only through the approved existing user-assigned managed identity.

**Architecture:** Add one portable domain policy evaluator for Agent 365 source origin, enabled state, credential mode, and exact approved client ID. Reuse it in persisted runtime resolution and connector credential creation, enforce it before API repository mutations, remove Agent 365 mutation entry points from the web, and wire the dedicated managed-identity client ID only into API/jobs deployment environments.

**Tech Stack:** TypeScript, Zod, Fastify, React, Vitest, pnpm/Turborepo, Azure Bicep.

---

### Task 1: Define the shared Agent 365 activation policy

**Files:**

- Modify: `packages/domain/src/connector-source.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/test/connector-source.test.ts`

- [ ] **Step 1: Write failing policy tests**

Add table-driven tests proving:

```ts
evaluateAgent365SourcePolicy({
  connectorType: 'agent365',
  origin: 'deployment',
  enabled: true,
  credential: {
    mode: 'managed-identity',
    managedIdentityClientId: AGENT365_APPROVED_MANAGED_IDENTITY_CLIENT_ID,
  },
})
```

is active, while user origin, default, federated-app, Key Vault, and a different
managed-identity client ID return stable typed inactive reasons. Also prove
disabled approved deployment sources remain inactive.

- [ ] **Step 2: Run the focused domain test and verify RED**

Run:

```bash
pnpm --filter @agent-sentinel/domain test -- connector-source
```

Expected: failure because the policy exports do not exist.

- [ ] **Step 3: Implement and export the policy**

Add:

```ts
export const AGENT365_APPROVED_MANAGED_IDENTITY_CLIENT_ID = '59dbea72-1e91-403a-89cf-e02cdb8da350'
```

and a typed evaluator whose precedence is deployment origin, enabled state,
managed-identity mode, then exact client ID. Non-Agent-365 sources return a
not-applicable decision.

- [ ] **Step 4: Run the focused domain test and verify GREEN**

Run the same command and expect all connector-source tests to pass.

### Task 2: Apply the policy to runtime and deployment projection

**Files:**

- Modify: `packages/connector-runtime/src/agent365-runtime.ts`
- Modify: `packages/connector-runtime/src/deployment-connector-sources.ts`
- Modify: `packages/connector-runtime/test/agent365-runtime.test.ts`
- Modify: `connectors/agent365/src/index.ts`
- Modify: `connectors/agent365/test/composition.test.ts`
- Modify: `apps/api/test/deployment-connector-sources.test.ts`

- [ ] **Step 1: Write failing runtime and connector tests**

Cover deployment-origin approved UAMI activation and visible inactive bindings
for user origin, default, federated app, Key Vault reference, and arbitrary
managed identity. Verify `sourceId` remains the configuration identity and only
deployment `runtimeBinding.bindingSourceId` supplies runtime provenance.

Add connector credential tests proving only the approved managed identity can
construct a credential and that `AZURE_CLIENT_ID` never supplies Agent 365
identity metadata.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm --filter @agent-sentinel/connector-runtime test -- agent365-runtime
pnpm --filter @agent-sentinel/agent365-connector test -- composition
pnpm --filter @agent-sentinel/api test -- deployment-connector-sources
```

- [ ] **Step 3: Reuse the domain evaluator**

Replace runtime-local credential activation checks with the shared decision and
map its typed reasons into source health. Apply the same evaluator before
creating an Agent 365 credential. Make deployment credential projection
explicitly avoid `AZURE_CLIENT_ID` for Agent 365.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same commands and expect all selected tests to pass.

### Task 3: Fail closed before API mutation

**Files:**

- Modify: `apps/api/src/connector-source-routes.ts`
- Modify: `apps/api/test/connector-source-api.test.ts`

- [ ] **Step 1: Write failing API tests**

Use a recording repository to prove Agent 365 POST and PATCH/enable/disable/
DELETE requests return the stable deployment-only policy error without calling
`create`, `update`, or `delete`, and without adding an audit record. Keep GET,
audit GET, and connection-status GET readable.

- [ ] **Step 2: Run the API contract test and verify RED**

Run:

```bash
pnpm --filter @agent-sentinel/api test -- connector-source-api
```

- [ ] **Step 3: Enforce policy before mutation context creation**

Reject Agent 365 create bodies immediately because API-created records are
user-origin. For PATCH and DELETE, read the source first and reject a user-origin
Agent 365 record before generating mutation metadata or calling a repository
write method. Preserve all other provider CRUD behavior.

- [ ] **Step 4: Run the API contract test and verify GREEN**

Run the same command and expect all connector-source API tests to pass.

### Task 4: Make Agent 365 read-only in the web

**Files:**

- Modify: `apps/web/src/components/ConnectorSourceManager.tsx`
- Modify: `apps/web/src/components/ConnectorSourceManager.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Prove Agent 365 is absent from the Add Source type selector, user-origin legacy
Agent 365 cards have no Edit/Enable/Disable/Delete controls, deployment Agent
365 cards remain visible, and connection evidence can still be checked.

- [ ] **Step 2: Run the focused web test and verify RED**

Run:

```bash
pnpm --filter @agent-sentinel/web test -- ConnectorSourceManager
```

- [ ] **Step 3: Remove Agent 365 mutation affordances**

Filter Agent 365 from create options and suppress all mutation controls for
Agent 365 cards regardless of persisted origin. Render an explicit
deployment-managed read-only notice while retaining source identity, enabled
state, credential metadata, and evidence/readiness controls.

- [ ] **Step 4: Run the focused web test and verify GREEN**

Run the same command and expect all selected tests to pass.

### Task 5: Wire API/jobs deployment identity and update contracts

**Files:**

- Modify: `infra/modules/container-apps.bicep`
- Modify: `infra/platform.bicep`
- Modify: `infra/environments/mngenvmcap098047.parameters.bicepparam`
- Modify: relevant infra contract test discovered in the repository
- Modify: `docs/agent365-connector.md`
- Modify: `docs/deployment.md`
- Modify: `docs/current-status.md`
- Modify: `docs/copilot-agent-handoff.md`

- [ ] **Step 1: Write failing infra contract assertions**

Assert `AGENT365_MANAGED_IDENTITY_CLIENT_ID` is populated from the existing
connector UAMI for API/jobs only, Agent 365 remains default-off generally, and
the replacement candidate specifies the exact approved client ID without
creating identities or permissions.

- [ ] **Step 2: Run the focused infra contract test and verify RED**

Run the repository's narrow infra contract test command for the changed Bicep
files.

- [ ] **Step 3: Add deployment plumbing**

Pass the existing connector UAMI client ID into the container-app module and
append `AGENT365_MANAGED_IDENTITY_CLIENT_ID` only to API/jobs environments.
Set the replacement candidate to the exact approved ID without touching
`infra/environments/mngenvmcap098047-foundry.parameters.bicepparam`.

- [ ] **Step 4: Update documentation**

Document deployment-only source management, exact approved-UAMI activation,
typed inactive legacy records, no ambient fallback, and the remaining manual
deployment/live-validation requirements.

- [ ] **Step 5: Run the focused infra contract test and verify GREEN**

Run the same narrow contract command and expect it to pass.

### Task 6: Focused verification and commit

**Files:**

- Validate all task-owned files.
- Preserve unstaged: `infra/environments/mngenvmcap098047-foundry.parameters.bicepparam`

- [ ] **Step 1: Run requested focused package tests**

```bash
pnpm --filter @agent-sentinel/domain test -- connector-source
pnpm --filter @agent-sentinel/agent365-connector test -- composition mapping client
pnpm --filter @agent-sentinel/connector-runtime test -- agent365-runtime
pnpm --filter @agent-sentinel/api test -- connector-source-api connector-factory deployment-connector-sources connectors-catalog read-model
pnpm --filter @agent-sentinel/jobs test -- connector-factory ingestion
pnpm --filter @agent-sentinel/web test -- connectors-api ConnectorSourceManager ConnectorsPage
```

- [ ] **Step 2: Run scoped typechecks**

```bash
pnpm turbo run typecheck --concurrency=1 \
  --filter=@agent-sentinel/domain \
  --filter=@agent-sentinel/agent365-connector \
  --filter=@agent-sentinel/connector-runtime \
  --filter=@agent-sentinel/api \
  --filter=@agent-sentinel/jobs \
  --filter=@agent-sentinel/web
```

- [ ] **Step 3: Check formatting, whitespace, and protected-file preservation**

Format only changed task-owned files, then run:

```bash
git diff --check
git diff --ignore-space-at-eol --exit-code -- \
  infra/environments/mngenvmcap098047-foundry.parameters.bicepparam
git status --short
```

Expected: no whitespace errors; the protected parameter file remains the sole
unstaged pre-existing change and is unchanged except for its original line
endings.

- [ ] **Step 4: Commit only focused task files**

Stage explicit task-owned paths, exclude the protected parameter file, verify
the staged diff, and commit with:

```text
Enforce deployment-only Agent 365 activation

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

- [ ] **Step 5: Report exact evidence**

Report the resulting commit SHA, exact focused commands and pass counts,
protected-file state, no live-success claim, and remaining independent
architecture/security/deployment/live replacement-tenant review requirements.
