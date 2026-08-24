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

## Manifest Envelope (packages/connector-sdk)

**Current.** The versioned contract an operator-supplied manifest must satisfy before the custom manifest adapter will normalize it. Defined in `packages/connector-sdk/src/manifest.ts` and mirrored as Draft 2020-12 JSON Schema in `connectors/manifest/schemas/manifest.schema.json`.

### ManifestEnvelope

- `schemaVersion` – must appear in `SUPPORTED_MANIFEST_VERSIONS` (currently `1.0`); unsupported versions are rejected, never coerced
- `manifestId`, `tenantId`, optional `environmentId`
- `producedAt`: ISO 8601 datetime
- `producer`: `{ name, version?, contact? }`
- `capabilities`: AdapterCapabilityDeclaration
- `agents`, `tools`, `identities`, `dataSources`, optional `mcpDependencies` – entity declarations with manifest-local ids
- `edges`: EdgeDeclaration[] – `{ from, to, relationship }` where each endpoint is `{ kind, id }`
- `evidence`: EvidenceDeclaration[]
- optional `metadata`: bounded `Record<string, string>`

All object schemas are `.strict()`; unknown keys fail validation.

### AdapterCapabilityDeclaration

- `supportsDiscovery`: boolean
- `evidenceDepth`: `shallow` | `deep`
- `supportsRuntimeTelemetry`: boolean
- `supportsActions`: ActionDepth (`none` | `simulate` | `propose` | `execute`)

`execute` is a prohibited action depth. It parses, so an unsafe manifest is described accurately, but the connector rejects it at load time.

### EvidenceDeclaration

- `id`, `subjectId` (must reference a declared entity), `observedAt`
- `evidenceType`: `declared_configuration` | `runtime_observed`
- `confidence`: 0–1, default `0.4`, capped at `0.7` unless the evidence is `runtime_observed` **and** `supportsRuntimeTelemetry` is true **and** `evidenceDepth` is `deep`
- `claims`: bounded `Record<string, string>`

### SourceProvenance

Attached to every normalized snapshot: `producer`, `sourceObjectIds`, `observedAt`, `confidence`, `freshness` (ISO 8601 duration), `isNonAuthoritative: true`, `sourceOfTruth: false`. The last two are constants — manifest input can never assert authority.

### Bounds

| Bound                   | Limit |
| ----------------------- | ----- |
| Metadata keys           | 20    |
| Metadata value length   | 256   |
| Claim keys per evidence | 50    |
| Claim value length      | 512   |
| Entities per type       | 500   |
| Edges                   | 2000  |
| Evidence records        | 2000  |
| Manifest file size      | 5 MiB |

### Identity and idempotency

Normalized ids are `manifest::<manifestId>::<localId>` via `stableId`. `computeManifestHash` returns the hex SHA-256 of canonical JSON with recursively sorted keys, so an unchanged manifest always yields the same hash and re-ingestion is idempotent.

---

## Behavior baseline and drift types (`@agent-sentinel/domain` — `behavior-baseline.ts`)

These types are produced by `@agent-sentinel/behavior-engine` and consumed by the API behavior routes and web UX. All schemas are Zod-validated.

### ObservationSource

`'mock-synthetic'` | `'azure-monitor-otel'`

Labels every result with its provenance. `mock-synthetic` is never present in live mode responses; `azure-monitor-otel` is the future live source.

### RuntimeObservation

One sampled invocation. Fields: `id`, `tenantId`, `agentId`, `environment`, `source`, `observedAt` (ISO 8601), `latencyMs` (integer ≥ 0), `inputTokens` (integer ≥ 0), `outputTokens` (integer ≥ 0), `costUsd` (number ≥ 0, optional), `success` (boolean), `toolCallNames` (bounded string array ≤ 50). No raw prompts or unbounded payloads.

### ObservationWindow

A bounded, timestamped collection of `RuntimeObservation` objects: `id`, `agentId`, `tenantId`, `environment`, `source`, `windowStart`, `windowEnd`, `observations` (array ≤ 10,000).

### BaselineWindow

Pre-computed statistical summary of a historical window: `agentId`, `tenantId`, `environment`, `source`, `windowStart`, `windowEnd`, `sampleCount` (integer ≥ 0), `latencyMs` (`DistributionStats`, optional), `inputTokens` (`DistributionStats`, optional), `outputTokens` (`DistributionStats`, optional), `totalTokens` (`DistributionStats`, optional), `costUsd` (`DistributionStats`, optional — **never present when cost is not measured**), `successRate`, `errorRate`, `toolSequence` (`ToolSequenceSummary`), `evidenceId` (immutable evidence reference), `computedAt`.

`ToolSequenceSummary` records both the sorted unique tool set and bounded,
canonical per-invocation sequence patterns, so pure ordering changes are
detectable even when the tool set is unchanged.

### DistributionStats

`median` (number), `mad` (number ≥ 0), `zeroVariance` (boolean), `sampleCount` (integer ≥ 1).

MAD (median absolute deviation) is used instead of standard deviation because it is resistant to outliers and bounded-distribution skew.

### DriftAnalysisResult

The output of `analyzeDrift`. Fields: `analysisId`, `tenantId`, `agentId`, `environment`, `source`, `status` (`AnalysisStatus`), `computedAt`, `baselineEvidenceId` (optional), `observedEvidenceId` (optional), `dimensions` (array ≤ 10 of `DimensionDriftResult`), `coverage` (`EvidenceCoverage`, optional), `anyDrift` (boolean), `highestSeverity` (optional), `unavailableReason` (optional — explains unavailable live data or an invalid, stale, or insufficient synthetic fixture).

### AnalysisStatus

`'ready'` | `'insufficient-data'` | `'stale'` | `'invalid'`

- `ready`: analysis ran successfully on sufficient, fresh, non-duplicate data.
- `insufficient-data`: fewer than `MIN_SAMPLES` (10) observations in baseline or observed window.
- `stale`: window end is older than `STALE_WINDOW_HOURS` (168 h / 7 days).
- `invalid`: data quality check failed (e.g. timestamps invalid, duplicate ratio too high, end ≤ start) or the OTel connector is absent.

### DimensionDriftResult

One dimension's result: `dimension` (`DriftDimension`), `drifted` (boolean), `severity` (optional `DriftSeverity`), `explanation` (human-readable string citing thresholds and measured values), optional measured-value fields (`baselineMedian`, `observedMedian`, `deviationMads`, `baselineRate`, `observedRate`, `absoluteDelta`, `toolSequenceChange`).

### Bounds

| Bound                   | Limit  |
| ----------------------- | ------ |
| Observations per window | 500    |
| Dimensions per analysis | 10     |
| Tool call names per obs | 50     |
| Unique tools tracked    | 100    |
| unavailableReason       | 500 ch |

---

## Token Economics Domain Types (packages/domain/src/token-economics.ts)

### TokenEconomicsReport

Bounded report for one agent in one observation window.

- `reportId`: deterministic hash of tenant, agent, environment, source, and window
- `tenantId`, `agentId`, `environment`, `source` (mock-synthetic | azure-monitor-otel)
- `windowStart`, `windowEnd`, `computedAt`: ISO 8601
- `status`: `ready | insufficient-data | unavailable | connector-not-connected`
- `unavailableReason`: present when status is not `ready`
- `coverage`: TokenEconomicsCoverage (present when ready)
- `baselineEvidenceId`, `observedEvidenceId`: immutable references required for anomaly-backed posture
- `totalInputTokens`, `totalOutputTokens`, `totalTokens`: measured totals (present when ready)
- `medianInputTokens`, `medianOutputTokens`, `medianTotalTokens`: robust medians (present when ready)
- `measuredCostUsd`: sum of measured costUsd values only; absent when not measured (never estimated)
- `medianCostUsd`: median of cost-measured observations only
- `costPerSuccessUsd`: measured cost / successful calls within the same cost-measured population; absent when that population has zero successes
- `anomalies`: TokenEconomicsAnomaly[] (up to 20)

### TokenEconomicsCoverage

- `totalObservations`, `deduplicatedObservations`, `duplicatesRemoved`
- `successCount`, `measuredSuccessCount`, token-dimension measured counts, `costMeasuredCount`
- `costCoverage`: fraction 0-1; partial (< 1) when not all observations have measured cost

### TokenEconomicsAnomaly

- `anomalyId`: deterministic hash
- `dimension`: `input-tokens | output-tokens | total-tokens | cost`
- `severity`: `low | medium | high | critical`
- `baselineMedian`, `observedMedian`, `deviationMads` (optional, absent for zero-variance baselines)
- `evidenceIds`: baseline and observed evidence references
- `explanation`: human-readable description

## Design constraints for Token Economics

- Cost is strictly from measured RuntimeObservation.costUsd fields. Never estimated from token counts or model pricing tables.
- Partial cost coverage (costCoverage < 1) must always be surfaced to users; no extrapolation to full estate.
- `costPerSuccessUsd` is the total measured cost of the cost-measured population, including failed calls, divided by successful calls in that same population. It is absent when that population has zero successes.
- Anomaly detection reuses the same MAD-based thresholds as the drift-analysis engine (MADS_THRESHOLDS, PCT_THRESHOLDS from behavior-engine).
- No currency conversion, ROI, estimated savings, or cost avoidance calculations.
- `source: 'mock-synthetic'` must never appear in live Foundry-mode API responses.
