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
| Container | Partition Key | Purpose |
|-----------|---------------|---------|
| snapshots | /tenantId | EstateSnapshot history |
| findings | /tenantId | Finding records |
| evidence | /tenantId | Evidence items |
| graph-nodes | /tenantId | GraphNode adjacency |
| graph-edges | /tenantId | GraphEdge adjacency |

### PostgreSQL (pg-as-260814)
| Table | Purpose |
|-------|---------|
| findings | Finding records with JSONB data |
| validation_runs | ValidationRun records with JSONB data |

### AI Search (search-as-260814)
| Index | Purpose |
|-------|---------|
| findings-index | Semantic + vector search over findings |

### Service Bus (sb-as-260814)
| Queue/Topic | Purpose |
|------------|---------|
| findings-validation | Validation job requests |
| remediation-execution | Remediation job requests |
| snapshot-ingestion | Snapshot processing requests |
| domain-events (topic) | Fan-out domain events |
