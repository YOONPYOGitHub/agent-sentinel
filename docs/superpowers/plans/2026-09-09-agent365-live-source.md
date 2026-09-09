# Agent 365 Live Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the existing read-only Agent 365 package catalog from exact estate-scoped persisted connector sources with bounded cancellation, honest package classification, source-linked health, and matching API/jobs behavior.

**Architecture:** Move immutable deployment-source projection into a shared connector-runtime package, then add a focused Agent 365 runtime resolver that combines deployment and persisted records without activating unrelated connector types. Extend the Agent 365 client and composition layer to expose measured, cancellable source outcomes, and inject the same resolved runtime into API and jobs factories while preserving environment-only compatibility.

**Tech Stack:** TypeScript, Node.js 22.23.2, pnpm 10.15.1, Zod, Vitest, Fastify, Azure Identity, Cosmos repository interfaces, Turborepo.

---

## File structure

- Create `packages/connector-runtime/package.json`: shared runtime package manifest.
- Create `packages/connector-runtime/tsconfig.json`: package TypeScript configuration.
- Move `apps/api/src/deployment-connector-sources.ts` to
  `packages/connector-runtime/src/deployment-connector-sources.ts`: immutable
  deployment-source projection and repository overlay shared by API and jobs.
- Create `packages/connector-runtime/src/agent365-runtime.ts`: bounded,
  estate-scoped Agent 365 source resolution and runtime health decoration.
- Create `packages/connector-runtime/src/index.ts`: package exports.
- Create `packages/connector-runtime/test/agent365-runtime.test.ts`: runtime
  source pagination, activation, estate isolation, and deployment overlay tests.
- Modify `connectors/agent365/src/schemas.ts`: per-source execution limits and
  typed package classification.
- Modify `connectors/agent365/src/client.ts`: caller cancellation and measured
  page/record collection.
- Modify `connectors/agent365/src/normalize.ts`: classification metadata and
  exact provenance.
- Modify `connectors/agent365/src/index.ts`: bounded multi-source aggregation,
  typed health, and direct runtime config construction.
- Modify the three Agent 365 test files for cancellation, classification,
  empty/error states, and aggregate behavior.
- Modify `apps/api/src/connector-factory.ts` and its tests: persisted Agent 365
  runtime injection while preserving environment-only behavior.
- Modify `apps/api/src/app.ts`: resolve the default estate from the combined
  connector-source repository before creating the live service.
- Modify `apps/jobs/src/connector-factory.ts`, `apps/jobs/src/worker.ts`, and
  tests: resolve the same source view before every ingestion.
- Modify API/jobs package manifests and `pnpm-lock.yaml`: add the shared runtime
  workspace dependency.
- Modify `.env.example`, `docs/agent365-connector.md`,
  `docs/connector-availability.md`, and `docs/copilot-agent-handoff.md`: describe
  runtime activation and replacement-tenant validation boundaries.

### Task 1: Shared immutable deployment source package

**Files:**

- Create: `packages/connector-runtime/package.json`
- Create: `packages/connector-runtime/tsconfig.json`
- Create: `packages/connector-runtime/src/index.ts`
- Move: `apps/api/src/deployment-connector-sources.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/test/deployment-connector-sources.test.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/jobs/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Move deployment projection without behavior changes**

Use `apply_patch` move syntax so history and content remain intact:

```text
*** Update File: apps/api/src/deployment-connector-sources.ts
*** Move to: packages/connector-runtime/src/deployment-connector-sources.ts
```

Rename the local `EstateRegistry` dependency to a package-owned structural type:

```ts
export interface ConnectorRuntimeEstateRegistry {
  readonly estates: readonly EstateContext[]
}
```

Change `buildDeploymentConnectorSources()` to accept
`ConnectorRuntimeEstateRegistry`. Keep `DeploymentConnectorSourceRepository`
behavior byte-for-byte compatible.

- [ ] **Step 2: Add the package manifest and exports**

Create `packages/connector-runtime/package.json`:

```json
{
  "name": "@agent-sentinel/connector-runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "lint": "eslint src test",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@agent-sentinel/agent365-connector": "workspace:*",
    "@agent-sentinel/azure-monitor-otel-connector": "workspace:*",
    "@agent-sentinel/azure-resource-graph-connector": "workspace:*",
    "@agent-sentinel/defender-cloud-apps-connector": "workspace:*",
    "@agent-sentinel/domain": "workspace:*",
    "@agent-sentinel/entra-identity-connector": "workspace:*",
    "@agent-sentinel/foundry-connector": "workspace:*",
    "@agent-sentinel/power-platform-connector": "workspace:*",
    "@agent-sentinel/purview-connector": "workspace:*",
    "@agent-sentinel/teams-distribution-connector": "workspace:*"
  }
}
```

Create `packages/connector-runtime/src/index.ts`:

```ts
export {
  buildDeploymentConnectorSources,
  DeploymentConnectorSourceRepository,
} from './deployment-connector-sources.js'
export type { ConnectorRuntimeEstateRegistry } from './deployment-connector-sources.js'
```

Use the same `extends: "../../tsconfig.base.json"` package pattern as sibling
packages in `packages/connector-runtime/tsconfig.json`.

- [ ] **Step 3: Repoint API imports and tests**

Replace imports from `./deployment-connector-sources.js` with:

```ts
import {
  buildDeploymentConnectorSources,
  DeploymentConnectorSourceRepository,
} from '@agent-sentinel/connector-runtime'
```

Update the deployment-source test to import from the shared package. Add
`@agent-sentinel/connector-runtime: workspace:*` to API and jobs dependencies.

- [ ] **Step 4: Install workspace links and run compatibility tests**

Run:

```bash
pnpm install --lockfile-only
pnpm --filter @agent-sentinel/api test -- deployment-connector-sources.test.ts
```

Expected: the existing deployment-source projection tests pass unchanged.

### Task 2: Runtime source resolution for Agent 365

**Files:**

- Create: `packages/connector-runtime/src/agent365-runtime.ts`
- Create: `packages/connector-runtime/test/agent365-runtime.test.ts`
- Modify: `packages/connector-runtime/src/index.ts`

- [ ] **Step 1: Write failing bounded-resolution tests**

Create fixtures for one exact estate and a repository whose `list()` records
every `(limit, cursor)` call. Add tests asserting:

```ts
expect(result.bindings.map((binding) => binding.sourceId)).toEqual([
  'agent365-deployment',
  'agent365-user',
  'agent365-disabled',
])
expect(result.activeSources.map((source) => source.id)).toEqual([
  'agent365-deployment',
  'agent365-user',
])
expect(result.bindings[2]?.activation).toEqual({
  status: 'inactive',
  reason: 'source-disabled',
})
```

Add failure tests for:

```ts
await expect(resolveAgent365Runtime(...mismatchedEstate)).rejects.toThrow(
  'does not match the requested estate boundary',
)
await expect(resolveAgent365Runtime(...nonAdvancingRepository)).rejects.toThrow(
  'pagination did not advance',
)
await expect(resolveAgent365Runtime(...moreThan1000Sources)).rejects.toThrow(
  'exceeds the runtime maximum',
)
```

Add a credential-mode test asserting a `default` or
`key-vault-secret-reference` record is inactive with
`dedicated-workload-identity-required`.

- [ ] **Step 2: Run the new test and verify failure**

Run:

```bash
pnpm --filter @agent-sentinel/connector-runtime test -- agent365-runtime.test.ts
```

Expected: FAIL because `resolveAgent365Runtime` is not exported.

- [ ] **Step 3: Implement exact runtime binding types**

Define:

```ts
export type Agent365RuntimeInactiveReason =
  'source-disabled' | 'dedicated-workload-identity-required'

export interface Agent365RuntimeBinding {
  readonly estateId: string
  readonly tenantId: string
  readonly environment: string
  readonly sourceId: string
  readonly displayName: string
  readonly origin: 'deployment' | 'user'
  readonly sourceVersion: number
  readonly sourceEtag: string
  readonly activation:
    | { readonly status: 'active' }
    | {
        readonly status: 'inactive'
        readonly reason: Agent365RuntimeInactiveReason
      }
}

export interface ResolvedAgent365Runtime {
  readonly config: Agent365Config | undefined
  readonly bindings: readonly Agent365RuntimeBinding[]
}
```

Implement `resolveAgent365Runtime(repository, estate, options)` with defaults:

```ts
const pageSize = 100
const maxSources = 1_000
```

For every page:

```ts
const source = connectorSourceDefinitionSchema.parse(value)
if (
  source.estateId !== estate.id ||
  source.tenantId !== estate.tenantId ||
  source.environment !== estate.environment
) {
  throw new Error(
    `Connector source ${source.sourceId} does not match the requested estate boundary.`,
  )
}
```

Only `connectorType === 'agent365'` contributes bindings. Active records become
`Agent365SourceConfig` values carrying exact source limits and credentials:

```ts
{
  id: source.sourceId,
  name: source.displayName,
  tenantId: source.tenantId,
  environment: source.environment,
  graphBaseUrl: source.configuration.graphBaseUrl,
  limits: source.configuration.limits,
  credential:
    source.credential.mode === 'managed-identity'
      ? {
          mode: 'managed-identity',
          managedIdentityClientId: source.credential.managedIdentityClientId,
        }
      : {
          mode: 'federated-app',
          clientId: source.credential.clientId,
          managedIdentityClientId: source.credential.managedIdentityClientId,
        },
}
```

Return `config: undefined` when no active Agent 365 source exists, while still
returning inactive bindings.

- [ ] **Step 4: Export and pass resolver tests**

Export the runtime types and function from `src/index.ts`, then run:

```bash
pnpm --filter @agent-sentinel/connector-runtime test -- agent365-runtime.test.ts
```

Expected: PASS.

### Task 3: Agent 365 source schema and package classification

**Files:**

- Modify: `connectors/agent365/src/schemas.ts`
- Modify: `connectors/agent365/src/normalize.ts`
- Modify: `connectors/agent365/test/mapping.test.ts`

- [ ] **Step 1: Write failing classification tests**

Add:

```ts
expect(
  classifyAgent365Package({
    id: 'P_m365',
    displayName: 'M365 agent',
    supportedHosts: ['M365'],
    elementTypes: ['DeclarativeAgent'],
  }),
).toEqual(['agent365-agent', 'm365-declarative-agent'])

expect(
  classifyAgent365Package({
    id: 'P_sharepoint',
    displayName: 'SharePoint agent',
    supportedHosts: ['sharePoint'],
    elementTypes: ['declarativeAgent'],
  }),
).toEqual(['agent365-agent', 'sharepoint-declarative-agent'])

expect(classifyAgent365Package(extension)).toEqual(['extension-package'])
```

Assert the mapped node metadata includes:

```ts
packageClassifications: '["agent365-agent","m365-declarative-agent"]'
```

and that the extension remains `kind: 'control'`.

- [ ] **Step 2: Run the mapping test and verify failure**

Run:

```bash
pnpm --filter @agent-sentinel/agent365-connector test -- mapping.test.ts
```

Expected: FAIL because `classifyAgent365Package` does not exist.

- [ ] **Step 3: Add per-source limits and credentials**

Extend `agent365SourceConfigSchema`:

```ts
const sourceCredentialSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('default'),
    managedIdentityClientId: azureGuidSchema.optional(),
  }),
  z.strictObject({
    mode: z.literal('managed-identity'),
    managedIdentityClientId: azureGuidSchema,
  }),
  z.strictObject({
    mode: z.literal('federated-app'),
    clientId: azureGuidSchema,
    managedIdentityClientId: azureGuidSchema.optional(),
  }),
])

export const agent365SourceConfigSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().trim().min(1).max(100),
  tenantId: tenantIdSchema,
  environment: environmentSchema,
  graphBaseUrl: z.string().transform(sanitizeAgent365GraphBaseUrl).default(AGENT365_GRAPH_ORIGIN),
  limits: agent365LimitsSchema,
  credential: sourceCredentialSchema.optional(),
})
```

When parsing environment configuration, inject the environment-level Graph base
and limits into every source so existing JSON remains valid.

- [ ] **Step 4: Implement deterministic classification**

Add:

```ts
export type Agent365PackageClassification =
  'agent365-agent' | 'm365-declarative-agent' | 'sharepoint-declarative-agent' | 'extension-package'

export function classifyAgent365Package(item: CopilotPackage): Agent365PackageClassification[] {
  const declarative = containsIgnoreCase(item.elementTypes, 'declarativeAgent')
  const agent =
    containsIgnoreCase(item.supportedHosts, 'copilot') ||
    ['bot', 'bots', 'declarativeagent', 'customengineagent'].some((type) =>
      containsIgnoreCase(item.elementTypes, type),
    )
  if (!agent) return ['extension-package']
  return [
    'agent365-agent',
    ...(declarative && containsIgnoreCase(item.supportedHosts, 'm365')
      ? (['m365-declarative-agent'] as const)
      : []),
    ...(declarative && containsIgnoreCase(item.supportedHosts, 'sharepoint')
      ? (['sharepoint-declarative-agent'] as const)
      : []),
  ]
}
```

Use the result for `isAgentPackage`, `inventoryEntityType`, and the serialized
`packageClassifications` metadata. Preserve one node per provider package.

- [ ] **Step 5: Pass mapping/configuration tests**

Run:

```bash
pnpm --filter @agent-sentinel/agent365-connector test -- mapping.test.ts
```

Expected: PASS.

### Task 4: Cancellable measured Graph collection

**Files:**

- Modify: `connectors/agent365/src/client.ts`
- Modify: `connectors/agent365/test/client.test.ts`

- [ ] **Step 1: Write failing cancellation and measurement tests**

Add a test that aborts before collection:

```ts
const controller = new AbortController()
controller.abort()
await expect(client.collect(undefined, controller.signal)).rejects.toMatchObject({
  code: 'cancelled',
})
expect(fetcher).not.toHaveBeenCalled()
```

Add tests that capture the signal passed to `getToken()` and `fetch()`, abort
during a pending fetch, and abort during Retry-After sleep. Add:

```ts
await expect(client.collectMeasured()).resolves.toMatchObject({
  packages: [item],
  pages: 1,
  records: 1,
})
```

- [ ] **Step 2: Run the client test and verify failure**

Run:

```bash
pnpm --filter @agent-sentinel/agent365-connector test -- client.test.ts
```

Expected: FAIL on the missing overload, measurement type, and `cancelled` code.

- [ ] **Step 3: Implement signal composition**

Add `'cancelled'` to `Agent365ErrorCode` and:

```ts
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new Agent365ConnectorError('cancelled', 'Agent 365 collection was cancelled.')
  }
}
```

Use `AbortSignal.any([externalSignal, timeoutController.signal])` when both
signals exist. Map an external abort to `cancelled` and the connector-owned
deadline to `timeout`.

Replace the uninterruptible sleep signature with:

```ts
sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
```

and implement the default sleep with an abort listener that clears the timer.

- [ ] **Step 4: Return measured results without breaking `collect()`**

Define:

```ts
export interface Agent365Collection {
  readonly packages: CopilotPackage[]
  readonly pages: number
  readonly records: number
}
```

Keep:

```ts
async collect(maximum?: number, signal?: AbortSignal): Promise<CopilotPackage[]> {
  return (await this.collectMeasured(maximum, signal)).packages
}
```

Implement `collectMeasured()` by returning the existing page counter and
provider record count.

- [ ] **Step 5: Pass client tests**

Run:

```bash
pnpm --filter @agent-sentinel/agent365-connector test -- client.test.ts
```

Expected: PASS.

### Task 5: Bounded aggregation and typed source health

**Files:**

- Modify: `connectors/agent365/src/index.ts`
- Modify: `connectors/agent365/test/composition.test.ts`

- [ ] **Step 1: Write failing source-state tests**

Add composition tests for:

```ts
expect(emptyHealth).toMatchObject({
  readiness: 'degraded',
  dataState: 'empty',
  pages: 1,
  records: 0,
  reason: 'empty',
})
expect(cancelledHealth).toMatchObject({
  readiness: 'unavailable',
  dataState: 'cancelled',
  reason: 'cancelled',
})
```

Create three delayed source fetchers and assert no more than two execute
concurrently. Add an aggregate-deadline test that leaves a source pending and
expects `duration-exceeded`.

- [ ] **Step 2: Run composition tests and verify failure**

Run:

```bash
pnpm --filter @agent-sentinel/agent365-connector test -- composition.test.ts
```

Expected: FAIL because Agent 365 sources are still sequential and do not expose
data state or measurements.

- [ ] **Step 3: Add aggregation limits**

Extend `Agent365Config` with:

```ts
aggregation: z.strictObject({
  maxConcurrency: z.number().int().min(1).max(10).default(2),
  maxDurationMs: z.number().int().min(100).max(300_000).default(60_000),
})
```

Parse optional environment variables:

```dotenv
AGENT365_MAX_CONCURRENCY=2
AGENT365_MAX_DURATION_MS=60000
```

- [ ] **Step 4: Use `aggregateLiveSources`**

Change `Agent365InventoryConnector.discover(request?)` to call
`collectMeasured(request?.maxRecords, request?.signal)`.

In `Agent365CompositionConnector.discover(request?)`, invoke:

```ts
const aggregation = await aggregateLiveSources({
  sources: this.sources.filter((state) => state.connector !== undefined),
  limits: {
    maxSources: 50,
    maxConcurrency: this.config.aggregation.maxConcurrency,
    maxDurationMs: this.config.aggregation.maxDurationMs,
    maxPagesPerSource: Math.min(
      request?.maxPages ?? Number.MAX_SAFE_INTEGER,
      Math.max(...this.config.sources.map((source) => source.limits.maxPages)),
    ),
    maxRecordsPerSource: Math.min(
      request?.maxRecords ?? Number.MAX_SAFE_INTEGER,
      Math.max(...this.config.sources.map((source) => source.limits.maxItems)),
    ),
  },
  signal: request?.signal,
  execute: async (state, context) => {
    const discovered = await state.connector!.discover({
      signal: context.signal,
      maxPages: context.maxPages,
      maxRecords: context.maxRecords,
    })
    const measurement = state.connector!.getLastMeasurement()
    return {
      state: measurement.records === 0 ? 'empty' : 'complete',
      value: discovered,
      pages: measurement.pages,
      records: measurement.records,
      evidenceIds: discovered.evidence.map((item) => item.id),
      ...(measurement.records === 0 ? { reason: 'empty' } : {}),
    }
  },
  failureReason: safeAgent365FailureReason,
})
```

Map outcomes to source health with exact provenance:

```ts
provenance: {
  estateTenantId: base.tenantId,
  estateEnvironment: base.environment,
  sourceConnectorId: state.source.id,
  sourceTenantId: state.source.tenantId,
  sourceEnvironment: state.source.environment,
  provider: 'microsoft-graph-agent365-package-catalog',
  providerObjectId: AGENT365_PACKAGES_PATH,
}
```

Only `complete` outcomes are ready. `empty` is degraded,
authorization/license errors are authorization-required, and failed/cancelled
outcomes are unavailable.

- [ ] **Step 5: Preserve partial snapshot safety**

Merge only successful `complete` and `empty` source snapshots. Set connector
health `partial: true` whenever any enabled source is not `complete`. This keeps
the existing jobs persistence guard effective.

- [ ] **Step 6: Pass all connector tests**

Run:

```bash
pnpm --filter @agent-sentinel/agent365-connector test
```

Expected: PASS.

### Task 6: API persisted-source activation

**Files:**

- Modify: `apps/api/src/connector-factory.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/test/connector-factory.test.ts`
- Modify: `apps/api/test/connectors-catalog.test.ts`

- [ ] **Step 1: Write failing factory parity tests**

Add a repository fixture containing one enabled Agent 365 source with:

```ts
credential: {
  mode: 'managed-identity',
  managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
}
```

Call:

```ts
const result = await createConfiguredConnectorForEstate(estate, repository, foundryEnvironment, {
  credentialFactory: () => testCredential,
  agent365CredentialFactory: () => testCredential,
  agent365Client: {
    fetcher: () => Promise.resolve(Response.json({ value: [] })),
  },
})
```

Assert health contains exact ID `agent365:agent365-live` and not an
environment-only Agent 365 source.

- [ ] **Step 2: Run the API factory test and verify failure**

Run:

```bash
pnpm --filter @agent-sentinel/api test -- connector-factory.test.ts
```

Expected: FAIL because `createConfiguredConnectorForEstate` is missing.

- [ ] **Step 3: Inject resolved Agent 365 config**

Add an optional factory field:

```ts
agent365Runtime?: ResolvedAgent365Runtime
```

At the Agent 365 composition point:

```ts
const agent365 =
  options.agent365Runtime === undefined
    ? createOptionalAgent365Connector(powerPlatform, env, agent365Options)
    : createAgent365RuntimeConnector(powerPlatform, options.agent365Runtime, agent365Options)
```

Implement:

```ts
export async function createConfiguredConnectorForEstate(
  estate: EstateContext,
  repository: ConnectorSourceRepository,
  env: NodeJS.ProcessEnv = process.env,
  options: ConfiguredConnectorOptions = {},
) {
  const agent365Runtime = await resolveAgent365Runtime(repository, estate)
  return createConfiguredConnector(env, { ...options, agent365Runtime })
}
```

The runtime connector helper must append inactive source health without
executing those records.

- [ ] **Step 4: Use persisted sources in live API startup**

Make `configuredService()` async and accept the connector-source repository.
When `resolvedDataMode === 'live'` and the repository exists, call
`createConfiguredConnectorForEstate`; otherwise retain
`createConfiguredConnector()`.

Do not add provider calls to `/api/connectors`. It must continue reading
persisted jobs health in live mode.

- [ ] **Step 5: Pass API focused tests**

Run:

```bash
pnpm --filter @agent-sentinel/api test -- connector-factory.test.ts connectors-catalog.test.ts deployment-connector-sources.test.ts
```

Expected: PASS.

### Task 7: Jobs persisted-source activation and health persistence

**Files:**

- Modify: `apps/jobs/src/connector-factory.ts`
- Modify: `apps/jobs/src/worker.ts`
- Modify: `apps/jobs/test/connector-factory.test.ts`
- Modify: `apps/jobs/test/ingestion.test.ts`

- [ ] **Step 1: Write failing jobs parity tests**

Use the same persisted source fixture as the API test and assert:

```ts
const connector = await buildConnectorForEstate(estate, repository, foundryEnvironment, options)
expect(connector.getConnectorHealth?.().sources).toEqual(
  expect.arrayContaining([expect.objectContaining({ id: 'agent365:agent365-live' })]),
)
```

Add an ingestion test where Agent 365 returns an empty catalog and assert:

```ts
expect(result.persisted).toBe(false)
expect(result.connectorHealth?.sources).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      id: 'agent365:agent365-live',
      dataState: 'empty',
    }),
  ]),
)
```

- [ ] **Step 2: Run jobs tests and verify failure**

Run:

```bash
pnpm --filter @agent-sentinel/jobs test -- connector-factory.test.ts ingestion.test.ts
```

Expected: FAIL because jobs do not load connector-source persistence.

- [ ] **Step 3: Add the shared jobs factory**

Implement:

```ts
export async function buildConnectorForEstate(
  estate: EstateContext,
  repository: ConnectorSourceRepository,
  environment: NodeJS.ProcessEnv = process.env,
  options: JobsConnectorOptions = {},
): Promise<AgentConnector> {
  const deploymentSources = buildDeploymentConnectorSources(
    environment,
    { estates: [estate] },
    'live',
  )
  const runtimeRepository =
    deploymentSources.length === 0
      ? repository
      : new DeploymentConnectorSourceRepository(repository, deploymentSources)
  const agent365Runtime = await resolveAgent365Runtime(runtimeRepository, estate)
  return buildConnector('foundry', environment, {
    ...options,
    agent365Runtime,
  })
}
```

- [ ] **Step 4: Add connector-source repository to the worker**

Extend `buildRepositories()` to return:

```ts
connectorSources: mode === 'mock'
  ? new InMemoryConnectorSourceRepository()
  : new CosmosConnectorSourceRepository(client, {
      databaseId,
      containerId: process.env['COSMOS_CONNECTOR_SOURCES_CONTAINER']?.trim() || 'connector-sources',
    })
```

Move connector creation inside `runOnce()`:

```ts
const connector =
  connectorMode === 'foundry'
    ? await buildConnectorForEstate(estate, connectorSources, process.env)
    : buildConnector('mock', process.env)
const service = new IngestionService(connector, snapshots, exposures, options)
await service.run()
```

This re-resolves enabled records for every ingestion without changing external
systems.

- [ ] **Step 5: Pass jobs tests**

Run:

```bash
pnpm --filter @agent-sentinel/jobs test -- connector-factory.test.ts ingestion.test.ts
```

Expected: PASS.

### Task 8: Documentation and integration configuration

**Files:**

- Modify: `.env.example`
- Modify: `docs/agent365-connector.md`
- Modify: `docs/connector-availability.md`
- Modify: `docs/copilot-agent-handoff.md`

- [ ] **Step 1: Add aggregate bound examples**

Add:

```dotenv
AGENT365_MAX_CONCURRENCY=2
AGENT365_MAX_DURATION_MS=60000
```

Do not edit either replacement-tenant parameter file.

- [ ] **Step 2: Update connector documentation**

Document:

- persisted enabled connector-source activation for API and jobs;
- managed identity/federated-app-only persisted runtime credentials;
- immutable deployment sources sharing the same resolver;
- two-source concurrency and aggregate duration bounds;
- `complete`, `empty`, `failed`, and `cancelled` states;
- Agent 365, M365 declarative, SharePoint declarative, and extension package
  classifications;
- the verified permission/license/provider facts as supplied by the integration
  owner without claiming deployment validation.

State explicitly:

```text
The integration owner observed HTTP 200 and 306 catalog packages using the
replacement-tenant managed identity. That historical provider observation does
not prove this commit is deployed or that every returned package is an agent.
```

- [ ] **Step 3: Format touched documentation**

Run:

```bash
pnpm exec prettier --write \
  .env.example \
  docs/agent365-connector.md \
  docs/connector-availability.md \
  docs/copilot-agent-handoff.md \
  docs/superpowers/specs/2026-09-09-agent365-live-source-design.md \
  docs/superpowers/plans/2026-09-09-agent365-live-source.md
```

Expected: only listed files are formatted.

### Task 9: Focused validation and implementation commit

**Files:**

- All touched implementation, test, package, and documentation files.

- [ ] **Step 1: Confirm the requested runtime**

Run:

```bash
node --version
pnpm --version
```

Expected:

```text
v22.23.2
10.15.1
```

- [ ] **Step 2: Run focused tests with concurrency two**

Run:

```bash
pnpm --workspace-concurrency=2 --filter @agent-sentinel/agent365-connector test
pnpm --workspace-concurrency=2 --filter @agent-sentinel/connector-runtime test
pnpm --workspace-concurrency=2 --filter @agent-sentinel/api test -- \
  connector-factory.test.ts \
  deployment-connector-sources.test.ts \
  connectors-catalog.test.ts
pnpm --workspace-concurrency=2 --filter @agent-sentinel/jobs test -- \
  connector-factory.test.ts \
  ingestion.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 3: Run affected lint and typecheck**

Run:

```bash
pnpm --workspace-concurrency=2 --filter @agent-sentinel/agent365-connector lint
pnpm --workspace-concurrency=2 --filter @agent-sentinel/agent365-connector typecheck
pnpm --workspace-concurrency=2 --filter @agent-sentinel/connector-runtime lint
pnpm --workspace-concurrency=2 --filter @agent-sentinel/connector-runtime typecheck
pnpm --workspace-concurrency=2 --filter @agent-sentinel/api lint
pnpm --workspace-concurrency=2 --filter @agent-sentinel/api typecheck
pnpm --workspace-concurrency=2 --filter @agent-sentinel/jobs lint
pnpm --workspace-concurrency=2 --filter @agent-sentinel/jobs typecheck
```

Expected: all affected checks pass.

- [ ] **Step 4: Run formatting and diff checks**

Run:

```bash
pnpm exec prettier --check \
  connectors/agent365/src \
  connectors/agent365/test \
  packages/connector-runtime \
  apps/api/src/app.ts \
  apps/api/src/connector-factory.ts \
  apps/api/test/connector-factory.test.ts \
  apps/api/test/deployment-connector-sources.test.ts \
  apps/api/test/connectors-catalog.test.ts \
  apps/jobs/src/connector-factory.ts \
  apps/jobs/src/worker.ts \
  apps/jobs/test/connector-factory.test.ts \
  apps/jobs/test/ingestion.test.ts \
  .env.example \
  docs/agent365-connector.md \
  docs/connector-availability.md \
  docs/copilot-agent-handoff.md
git diff --check
```

Expected: formatting and whitespace checks pass.

- [ ] **Step 5: Verify preserved parameter dirt and no external changes**

Run:

```bash
git status --short
git diff --name-only 34a479d9..HEAD
git diff --name-only
```

Expected:

- `infra/environments/mngenvmcap098047-foundry.parameters.bicepparam` remains
  modified but unstaged.
- No Azure/M365/Entra deployment, permission, secret, or generated evidence file
  is staged.

- [ ] **Step 6: Commit implementation**

Stage only implementation-owned files, excluding the dirty parameter file:

```bash
git add \
  .env.example \
  apps/api \
  apps/jobs \
  connectors/agent365 \
  packages/connector-runtime \
  docs/agent365-connector.md \
  docs/connector-availability.md \
  docs/copilot-agent-handoff.md \
  pnpm-lock.yaml
git commit -m "Activate persisted Agent 365 live sources" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 7: Inspect the final commit and worktree**

Run:

```bash
git --no-pager show --stat --oneline HEAD
git status --short
```

Expected: the implementation commit contains no replacement-tenant parameter
file, and the only remaining worktree dirt is the preserved parameter change.
