# Entra migration parity diagnostics design

## Scope

Restore code-side migration-parity diagnostics for the existing read-only
Microsoft Entra connector and its Foundry composition. The change is limited to
the Entra connector/composition, connector health exposure, focused API/jobs
composition tests, and directly related documentation. It does not change
Microsoft Graph permissions, app registrations, authentication activation,
preview activation, deployment configuration, or any external system.

The current replacement-tenant facts remain the validation baseline:

- Foundry inventory contains 6 authoritative agents.
- Entra stable inventory contains 335 identity nodes.
- The current composed snapshot contains 0 `RUNS_AS` edges.
- Historical and replacement Foundry validation agents expose neither an
  instance identity nor an Agent Identity blueprint reference.
- Corporate user authentication is a separate `AUTH_*` concern and remains
  disabled.

## Considered approaches

### 1. Infer parity from graph totals

Count agents, identity nodes, and `RUNS_AS` edges after composition.

This is small, but it cannot explain which exact identifier type matched, why a
record was unmatched, whether duplicates caused ambiguity, or which optional
capability failed. It also risks presenting zero optional records as successful
coverage. This approach is rejected.

### 2. Add a separate diagnostics API and persistence model

Create a dedicated Entra parity endpoint and persist diagnostic records beside
snapshots.

This would support rich querying, but it expands the API and persistence scope,
duplicates connector health state, and is unnecessary for migration validation.
This approach is rejected for this work package.

### 3. Attach typed diagnostics to existing connector health and graph metadata

Compute deterministic per-source diagnostics during Entra composition, expose
the aggregate through the existing `ConnectorHealthReport`, and annotate
correlated or uncorrelated agent nodes through the existing string metadata
contract.

This is the selected approach. It keeps one source of truth, requires no new
route, preserves current response compatibility through optional fields, and
lets API and jobs consumers report the same measured state.

## Health contract

Extend connector source health with an optional, discriminated diagnostics
object for exact identity correlation. The Entra diagnostic contains:

- source ID, tenant ID, and source environment;
- authoritative agents considered;
- disjoint exact-match counts for service-principal object ID,
  application/client ID, and preview-confirmed Agent Identity ID;
- unmatched and ambiguous agent counts;
- emitted `RUNS_AS` edge count;
- owner, app-role, and preview capability coverage;
- stable, sanitized failure reasons;
- evidence references used by the considered agents, matched identities,
  app-role assignments, and preview classifications.

Exact-match categories use deterministic precedence when multiple identifiers
on one agent resolve to the same identity:

1. preview-confirmed Agent Identity ID;
2. service-principal object ID;
3. application/client ID.

The categories are therefore disjoint and, together with unmatched and
ambiguous, account for all authoritative agents considered.

Capability coverage is status-bearing. Counts are present only after a
successful provider read. Disabled, unauthorized, malformed, or otherwise
degraded reads do not emit success-shaped zero counts.

## Correlation rules

Correlation considers only authoritative agent nodes inside the exact configured
source tenant and environment. It never uses display names, aliases, owners,
descriptions, tags, or fuzzy text.

Supported exact identifiers are:

- service-principal object ID:
  `entraServicePrincipalId` or `servicePrincipalId`;
- application/client ID:
  `entraAppId`, `appId`, `entraClientId`, or `clientId`;
- Agent Identity object ID:
  `entraAgentIdentityId` or `agentIdentityId`, only when preview classification
  is enabled and the identity is confirmed by preview evidence.

Invalid or missing identifiers are unmatched. If exact identifiers resolve to
more than one identity, the agent is ambiguous and no edge is emitted. If all
valid identifiers resolve to one identity, exactly one `RUNS_AS` edge is
emitted with the union of source-agent and identity evidence.

Aggregate composition keeps Entra identity IDs and evidence source-scoped.
Agents outside the configured source boundary are not considered, even when an
identifier value happens to match another source.

## Graph metadata

Every considered authoritative agent receives a bounded correlation status:

- `matched`;
- `unmatched`;
- `ambiguous`.

Matched agents also receive the exact match kind and identity node ID.
Unmatched agents distinguish missing authoritative identifiers from exact
identifiers with no source-local match. Ambiguous agents record only a stable
reason code, not candidate names or provider payloads.

Identity nodes retain their existing correlation metadata. No display-name or
owner value becomes a correlation key.

## Optional capability degradation

Stable Microsoft Graph v1.0 service-principal inventory is the authoritative
base capability. Owner, app-role, and Agent Identity preview reads are
independent capabilities.

If an optional read fails:

- stable inventory and successful exact correlations remain in the snapshot;
- only that capability reports degraded or authorization-required status;
- its coverage counts are omitted rather than reported as zero;
- connector health remains degraded for operators;
- the health report does not mark authoritative discovery partial solely
  because an optional capability failed, so jobs may persist the complete
  stable inventory;
- no previous stable inventory is erased by an optional failure.

If stable inventory, source configuration, source boundary validation, or
composition fails, the source remains partial/unavailable and jobs retain the
previous complete snapshot.

## API and jobs composition

`GET /api/connectors` continues returning the existing connectors collection.
The optional source diagnostics flow through its health object. Entra catalog
state maps all-degraded enabled sources to `degraded`, not `unavailable`, when
stable inventory remains available.

Jobs return the same connector health in `IngestionResult`. Optional-only
degradation produces a persisted, partially succeeded run rather than treating
the authoritative inventory as incomplete. Stable inventory failures still
prevent persistence and reconciliation.

No new route, mutation, permission, registration, or credential setting is
introduced.

## Tests

Connector tests cover:

- one exact service-principal object-ID match;
- one exact app/client-ID match;
- one preview-confirmed Agent Identity match;
- missing and invalid identifiers;
- duplicate exact values and conflicting exact identifiers;
- duplicate identity records;
- cross-tenant, cross-environment, and cross-source attempts;
- preview disabled, unauthorized, and malformed/degraded states;
- owner and app-role partial failures;
- evidence references and accounting invariants;
- exactly one emitted edge for one exact identity.

API tests verify the diagnostics survive `GET /api/connectors`, degraded Entra
inventory is not mislabeled unavailable, and no secret-bearing fields are
introduced.

Jobs tests verify optional-only degradation persists stable inventory while a
stable Entra inventory failure remains non-persisting partial discovery.

## Documentation and live validation

Update the Entra connector documentation and status guidance to state:

- `AUTH_*` controls employee/API authentication and is independent of
  `ENTRA_*`;
- inventory connectivity proves only that the bounded Entra read succeeded;
- migration parity additionally requires exact identifier coverage and emitted
  `RUNS_AS` edges;
- zero current correlations are expected while all six Foundry agents lack
  authoritative identity identifiers;
- optional capability states must be reviewed independently.

After integration and deployment, the integration owner must run replacement
tenant validation and confirm:

1. `AUTH_MODE=disabled` and writes remain disabled.
2. Foundry reports 6 authoritative agents considered.
3. Entra reports 335 identity nodes from stable v1.0 inventory.
4. Exact object-ID, app/client-ID, and Agent Identity match counts are all zero.
5. Unmatched is 6, ambiguous is zero, and emitted `RUNS_AS` edges are zero.
6. Owner, app-role, and preview capabilities report `disabled`, not available
   with zero coverage.
7. Evidence references identify the six Foundry configuration records used for
   the unmatched result.
