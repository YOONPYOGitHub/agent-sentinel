# Agent Sentinel – Data Model

## Domain Types (packages/domain)

### EstateSnapshot

Represents a point-in-time view of an agent estate.

- `tenantId`: string – tenant identifier
- `environment`: string – target environment
- `generatedAt`: ISO 8601 datetime
- `nodes`: GraphNode[] – agent graph nodes
- `edges`: GraphEdge[] – relationships
- `evidence`: Evidence[] – backing evidence

### GraphNode

- `id`, `kind` (input|agent|identity|data|mcp|tool|control)
- `name`, `description`, `environment`, `owner`
- `sensitivity`, `trust`, `evidenceIds`, `metadata`

### GraphEdge

- `id`, `from`, `to`, `relationship` (TRIGGERS|RUNS_AS|CAN_READ|CAN_CALL|CAN_EXFILTRATE_TO|PROTECTED_BY)
- `evidenceIds`, `active`, `removable`

### Finding

- `id`, `title`, `summary`, `severity` (low|medium|high|critical)
- `path`: AttackPath, `owner`, `policyId`, `detectedAt`, `recommendation`

### ValidationRun

- `id`, `findingId`, `status` (queued|running|validated|not-reproduced|failed)
- `startedAt`, `completedAt`, `syntheticCanary`, `observedAtTarget`, `trace`

## Storage Layout

### Cosmos DB (agent-sentinel-db)

| Container   | Partition Key | Purpose                |
| ----------- | ------------- | ---------------------- |
| snapshots   | /tenantId     | EstateSnapshot history |
| findings    | /tenantId     | Finding records        |
| evidence    | /tenantId     | Evidence items         |
| graph-nodes | /tenantId     | GraphNode adjacency    |
| graph-edges | /tenantId     | GraphEdge adjacency    |

### PostgreSQL (pg-as-260814)

| Table           | Purpose                               |
| --------------- | ------------------------------------- |
| findings        | Finding records with JSONB data       |
| validation_runs | ValidationRun records with JSONB data |

### AI Search (search-as-260814)

| Index          | Purpose                                |
| -------------- | -------------------------------------- |
| findings-index | Semantic + vector search over findings |

### Service Bus (sb-as-260814)

| Queue/Topic           | Purpose                      |
| --------------------- | ---------------------------- |
| findings-validation   | Validation job requests      |
| remediation-execution | Remediation job requests     |
| snapshot-ingestion    | Snapshot processing requests |
| domain-events (topic) | Fan-out domain events        |

### ExposureFinding

Represents a single declared-configuration policy violation surfaced by the Exposure surface.

- `id`, `policyId`, `policyName`, `severity` (low|medium|high|critical), `status` (open|validated|mitigated|resolved)
- `riskScore` (0..100), `title`, `summary`, `recommendation`
- `affectedAgentId`, `affectedAgentName`
- `declaredTools`, `affectedNodeIds`, `affectedEdgeIds`, `evidenceIds`, `evidenceTypes`
- `blastRadiusCount`, `blastRadiusNodeIds`
- `firstSeen`, `lastSeen` (ISO 8601 datetimes; `firstSeen` preserved on upsert)
- `sourceMode` (mock|foundry) — provenance of the underlying snapshot
- `validationStatus` (theoretical|validated|mitigated)
- `tenantId`, `snapshotId`

Cosmos DB container: `exposure-findings` (partition key `/tenantId`, upsert preserves `firstSeen`).

### GovernanceCase

Represents a deterministic governance workflow record.

- `id`, `kind` (finding-review|remediation-proposal|policy-exception|lifecycle-review)
- `title`, `description`
- `status` (open|in-review|pending-approval|approved|rejected|expired|closed)
- `createdByIdentity`, `createdByRole`, `createdAt`
- `assigneeIdentity`, `proposerIdentity`, `lastTransitionAt`
- Optional links: `findingId`, `agentId`, `policyId`
- `evidenceSnapshotIds` – evidence snapshot references carried through the workflow
- `sourceMode` (mock|foundry) and `writeEnabledAtCreation`

### GovernanceCaseTransition

Immutable audit record for each workflow step.

- `id`, `caseId`, `operation`
- `fromStatus`, `toStatus`
- `actorIdentity`, `actorRole`, `actorCapability`
- `timestamp`, optional `reason`
- `evidenceSnapshotIds`, `idempotencyKey`

The allowed transition operations are deterministic and enforced server-side:

- `open` → `pick-up`
- `in-review` → `propose`, `reject-finding`, `withdraw`
- `pending-approval` → `approve`, `reject`, `withdraw`
- `approved` → `close`
- `rejected` → `reopen`
- `expired` → `re-evaluate`
- `closed` → none

Live mode currently has no dedicated Cosmos container for this queue, so live reads are soft-boundary synthetic responses and live writes remain unavailable.
