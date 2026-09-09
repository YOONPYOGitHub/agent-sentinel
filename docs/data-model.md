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
- Foundry declared inventory defaults agent trust to `conditional` (or
  `untrusted` for known external transfer capabilities). Trust content embedded
  in a Foundry inventory payload is discarded. `trusted` requires a separately
  authenticated server-side assessment whose agent, source, tenant, and
  environment subject binding exactly matches the authoritative inventory
  object.
- Public composition input cannot assert authentication or assessment time. The
  server requires a verified authentication context, stamps the assessment with
  its injected clock, derives source mode from evidence types, and reevaluates
  freshness against the discovery clock whenever trust is applied. Every
  required plane must cite its own exactly bound evidence, and the runtime plane
  must cite non-synthetic `observed_runtime` evidence. Future-dated, synthetic,
  stale, unknown, missing, mismatched, unauthenticated, or incomplete assessment
  evidence cannot produce `trusted`.

### GraphEdge

- `id`, `from`, `to`, `relationship` (TRIGGERS|RUNS_AS|CAN_READ|CAN_CALL|CAN_EXFILTRATE_TO|PROTECTED_BY)
- `evidenceIds`, `active`, `removable`
- Exact Entra `RUNS_AS` edges additionally persist `runsAsBinding`, containing
  the complete Foundry agent and Entra identity endpoint authorities plus the
  exact GUID identifier and match kind. Object-ID and Agent Identity bindings
  must equal the evidence-backed service-principal object authority.
  Application-ID-only matches fail closed until a distinct application-ID
  authority contract is available; an application ID is never compared with a
  service-principal object ID. Each endpoint `evidenceIds` array must contain
  exactly one matching registered authority record, and the edge must cite
  those exact two endpoint records. Simulated edge-state variants must retain
  the exact registered `runsAsBinding`. Live authority indexing rejects
  duplicate node, edge, or evidence IDs, identifier ambiguity within the same
  identifier-kind and exact estate/source/tenant/environment boundary,
  unattached authority citations, and stale, synthetic, malformed, or
  generation/release-mismatched evidence.

### EvidenceAuthority

Authoritative Foundry and Entra evidence may carry a strict typed authority:
`estateId`, globally scoped `sourceId` (`foundry:<id>` or `entra:<id>`),
source `tenantId` and `environment`, provider, exact provider source object
(Foundry project or Entra inventory tenant), exact provider object (agent or
service principal), `snapshotGeneratedAt`, and `sourceRelease`. The same values
are copied into node metadata so persisted graph traversal can verify both
endpoints without display-name, owner, or source-ID fallback.
The request or ingestion boundary supplies `EstateContext` independently of the
candidate snapshot. Source authority is validated against its registered exact
source and endpoint metadata rather than requiring its tenant to equal the
estate tenant, so explicitly registered cross-tenant and custom-estate sources
remain valid. The authority index is built once and reused for policy, path,
blast-radius, and simulation analysis.

### Finding

- `id`, `title`, `summary`, `severity` (low|medium|high|critical)
- `path`: AttackPath, `owner`, `policyId`, `detectedAt`, `recommendation`

### ValidationRun

- `id`, `findingId`, `status` (queued|running|validated|not-reproduced|failed)
- `startedAt`, `completedAt`, `syntheticCanary`, `observedAtTarget`, `trace`

## Storage Layout

### Cosmos DB (agent-sentinel-db)

| Container         | Partition Key | Purpose                                      |
| ----------------- | ------------- | -------------------------------------------- |
| snapshots         | /tenantId     | EstateSnapshot history                       |
| findings          | /tenantId     | Finding records                              |
| evidence          | /tenantId     | Evidence items                               |
| graph-nodes       | /tenantId     | GraphNode adjacency                          |
| graph-edges       | /tenantId     | GraphEdge adjacency                          |
| governance-cases  | /tenantId     | Cases, immutable transitions, and retry keys |
| connector-sources | /estateId     | Estate bindings, sources, audit, retry keys  |

### ConnectorSourceDefinition

The dormant configuration-plane record for one connector source preserves
`estateId`, data tenant/environment, stable source ID, connector type, immutable
deployment/user origin, strict non-secret configuration, safe credential
identity/reference metadata, evidence-bound test status, version/ETag, actors,
and timestamps. Deployment-origin records are immutable.

The `connector-sources` container stores one immutable tenant/environment binding
plus source, append-only audit, and idempotency documents under each `/estateId`
partition using estate-scoped SHA-256 physical IDs and native Cosmos ETag
concurrency. The first source creation atomically creates the binding with the
source, audit, and retry marker. Later creates transactionally require that
binding, so concurrent attempts cannot redefine an estate or leave partial
records. Every document envelope repeats `estateId`, `tenantId`, and
`environment`; point reads, lists, audit reads, and idempotent replays require all
three values to match the requested estate before returning data. Deletes retain
a hidden tombstone so a source identity cannot be recreated. Exact committed
update and delete retries replay their immutable audit result; all new update
and delete audit timestamps must be strictly later than the prior source
`updatedAt`, so audit order is causal and cannot be influenced by caller-selected
audit IDs. Existing deployment JSON remains the active runtime source until a
later activation task.

Source lists use repository-backed seek pagination ordered by `sourceId`; audit
lists seek by the stable `(occurredAt, id)` tuple. API pages request `limit + 1`
records to determine whether a continuation exists. Idempotency markers remain
point reads, so retry resolution is independent of audit list size.

The connector-source API lists and reads records only through the authorized
request estate. User-origin create, update, and delete operations require an
authenticated Administrator, explicit `AGENT_SENTINEL_WRITE_ENABLED=true`,
idempotency keys, and strong ETag preconditions. API callers cannot set estate
boundaries, origin, actors, audit timestamps, or connection-test results.
Verified JWT `idtyp=app` callers are recorded as service principals by object
ID, while delegated callers are recorded as users.
Deployment-origin records remain immutable and non-deletable. The connection
test endpoint is status-only: it returns stored, labeled evidence and reports
untested sources as `unknown` with unavailable evidence; it does not invoke a
provider or synthesize success. Deployment JSON remains the connector runtime
source and is not activated from these dormant records. Existing
`*_SOURCES_JSON` definitions are projected into API reads as immutable
deployment-origin records without being copied into mutable persistence.

Azure Monitor source writes require an explicit `sourceProjectId`. Legacy
persisted Azure Monitor records that predate that field are decoded through a
read-only compatibility model. If exactly one deployment-origin source matches
the full estate, tenant, environment, source ID, workspace, and remaining
configuration, its authoritative project ID hydrates the read model. Otherwise
the record is returned disabled with `migration-required` status, no prior
passing test state, and no mutation controls. Repository listing does not guess
a project ID or fail merely because the legacy field is absent. New source
configuration, runtime provenance/state, connector input, and web form
validation share one trimmed `sourceProjectId` boundary with a maximum length
of 200 characters.

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
- `sourceMode` (mock|foundry|manifest) — provenance of the underlying snapshot; manifest findings remain non-authoritative
- `validationStatus` (theoretical|validated|mitigated)
- `tenantId`, `snapshotId`

Cosmos DB container: `findings` (partition key `/tenantId`, upsert preserves `firstSeen`).

### RemediationPreview

Represents a simulation-only route change. It never authorizes or executes a
provider write.

- `before` and `after` contain deterministically analyzed risk and blast radius.
- `impact.riskReduction` is the difference between analyzed before and residual
  risk; it is not an assumed full reduction.
- `residualFindings` and `residualRoutes` retain alternate active exposure after
  the simulated edge removal.
- `uncertainty` cites stale, unknown, synthetic, declared-only, theoretical, or
  missing analysis evidence, unsupported policy coverage, and no-op or partial
  target coverage.
- `citedEvidence` carries the available evidence used by the deterministic
  analysis. Missing references remain explicit in `uncertainty`.
- `beforeGraph` and `afterGraph` preserve the same evidence-backed comparison
  scope, with target edges disabled only in the simulated snapshot.
- A finding with no currently active target route returns a deterministic no-op
  preview with unchanged risk and zero risk reduction, while retaining current
  residual findings, routes, uncertainty, and evidence rather than returning a
  route conflict.

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

Live mode stores the queue in the dedicated `governance-cases` Cosmos container. A
repository instance is bound to one configured tenant and every point read, query,
and transactional batch supplies that `/tenantId` partition key.

The container uses three document envelopes:

- `governance-case`: `id=case:<caseId>`, `tenantId`, monotonic `version`,
  normalized `searchText`, and the current `case`.
- `governance-case-transition`: `id=transition:<transitionId>`, `tenantId`,
  `caseId`, append `sequence`, and the immutable `transition`, including its
  evidence snapshot references and authorization context.
- `governance-case-idempotency`: a SHA-256-derived id scoped to case creation or
  one case's transitions, plus `caseId` and `transitionId`. These documents are
  create-only retry/conflict guards and do not contain the raw key.

Creation atomically creates all three relevant documents. A state transition
atomically replaces the current case with `If-Match` on its Cosmos ETag and creates
the transition and idempotency documents. A stale writer returns a state conflict;
history is never replaced or deleted. List pages are capped at 200 and ordered by
`lastTransitionAt` descending, then case id ascending. Transition history is ordered
by append sequence ascending, then transition id ascending.

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

### ManifestIngestionRecord

Immutable accepted version stored in Cosmos `manifest-ingestions`, partitioned by `/tenantId`:

- server-controlled estate `tenantId` and `environmentId`
- `manifestId`, canonical SHA-256 `manifestHash`, producer `producedAt`
- server `ingestedAt` and sanitized authenticated `ingestedBySubject`
- validated `ManifestEnvelope` and normalized non-authoritative `EstateSnapshot`

The hash is the retry idempotency key. `(manifestId, envelope.producedAt)` is unique, so two
different payloads cannot claim the same producer version timestamp. Jobs lists distinct manifest
ids and reads only each newest producer version before composition.

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

Labels every result with its provenance. `mock-synthetic` is never present in live mode responses; `azure-monitor-otel` identifies rows strictly mapped from the configured Azure Monitor Logs source.

### RuntimeObservation

One sampled invocation. Fields: `id`, `tenantId`, `agentId`, `environment`, `source`, `observedAt` (ISO 8601), `latencyMs` (integer ≥ 0), `inputTokens` (integer ≥ 0), `outputTokens` (integer ≥ 0), `costUsd` (number ≥ 0, optional), `success` (boolean), `toolCallNames` (bounded string array ≤ 50), and optional `correlations` (at most one each of `agent-run-id`, `correlation-id`, and `agent-version`). Correlation arrays are canonicalized in that fixed kind order; duplicate kinds are rejected. No raw prompts or unbounded payloads.

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
- `invalid`: data quality check failed (e.g. timestamps invalid, duplicate ratio too high, end ≤ start), the OTel connector is unconfigured, or its provider query/row contract failed.

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

## Representative OpenTelemetry evidence

`@agent-sentinel/domain` defines bounded contracts for representative trace,
span, and metric evidence. The Azure Monitor OTel connector can normalize
sanitized provider pages without network access and deterministically group
claims only when the provider resource ID, source agent ID, trace ID, and span
ID match exactly.

Every normalized record preserves:

- estate ID, estate tenant, and estate environment;
- connector source ID, source tenant, and source environment;
- provider resource and provider agent IDs;
- OTel trace and span IDs plus the provider observation timestamp;
- `live` or `synthetic` classification;
- sampling state/rate and raw, delta, cumulative, or pre-aggregated semantics;
- one bounded invocation, latency, error, input-token, output-token, cost, or
  unsupported claim.

An analysis-ready invocation requires one compatible trace invocation claim,
span latency and error claims, and raw metric claims for input tokens, output
tokens, and measured USD cost. It is projected into `RuntimeObservation` with
structured `otelProvenance`; the backing `Evidence` retains up to 500 exact
invocation records and the full bounded quality summary. A supplied
`correlation-id` is preserved exactly; the trace ID is used as its fallback only
when that correlation kind is absent.

`OtelWindowQuality.status` is `available`, `unknown`, or `degraded`. Empty input
is `unknown`. Invalid or missing IDs, sampling, unknown sampling, partial
records, stale/future timestamps, unsupported signals or claims, aggregated
metrics, duplicates, mixed classification, and incomplete pagination are
`degraded`. Drift, baseline, and token-economics analysis reject non-available
quality, so these conditions cannot become a healthy or successful result.
Synthetic records remain synthetic after normalization and are removed from
live behavior analysis.

| Bound                            | Limit  |
| -------------------------------- | ------ |
| Provider pages                   | 20     |
| Records per page                 | 500    |
| Records per normalization        | 10,000 |
| Projected invocations per window | 500    |
| Evidence records per invocation  | 6      |

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
- `costPerSuccessUsd`: total cost of the entire cost-measured population, including failed calls, divided by successes in that same population; absent when that population has zero successes
- `anomalies`: TokenEconomicsAnomaly[] (up to 20)

### TokenEconomicsCoverage

- `totalObservations`, `deduplicatedObservations`, `duplicatesRemoved`
- `successCount`, `measuredSuccessCount`, token-dimension measured counts, `costMeasuredCount`
- `costCoverage`: fraction 0-1; partial (< 1) when not all observations have measured cost
- `exactCorrelationCount`, `exactCorrelationCoverage`: observations carrying an
  agent-run or correlation identifier; this reports runtime linkability, not an
  outcome join, and agent-version alone is not exact

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
