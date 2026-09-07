# Selected Connector Release Linkage Design

## Context

Release evidence records global connector health as well as connectors selected
to support a particular live validation. A globally healthy connector can be
`live`, `ready`, and `fresh` without participating in that validation. The
current connector-level refinement incorrectly requires every ready connector
to carry `deploymentRef`, `snapshotRef`, and `findingRefs`.

## Decision

Keep the connector-level `ready` invariant limited to `classification: live`
and `freshness: fresh`. Continue requiring complete live provenance: an
observation timestamp, source, sanitized scope, and evidence references.

Enforce release linkage only when a passing live validation names the connector
in `validation.connectorRefs`. The existing manifest-level correlation then
requires each selected connector to:

- exist by exact connector ID;
- be ready;
- match the validation deployment, snapshot, and finding references; and
- have an observation after deployment and no later than validation.

Unreferenced ready connectors, including colon-qualified IDs such as
`otel:<source>`, remain valid without deployment, snapshot, or finding
references. Their global freshness and live-provenance checks still apply.

## Alternatives Considered

1. **Recommended: narrow the connector-level refinement.** This preserves the
   existing schema and correlation boundary with the smallest behavior change.
2. Add a `supportsValidation` or connector mode field. This duplicates
   `validation.connectorRefs`, creates two sources of truth, and requires a
   schema version change.
3. Split connectors into global-health and validation-support collections. This
   makes the distinction explicit but is a breaking manifest redesign that is
   unnecessary for the current contract.

## Testing

Add regression coverage first for a passing live validation accompanied by:

- one referenced ready connector with matching release linkage; and
- one unreferenced `otel:<source>` connector that is live, ready, and fresh but
  has no deployment, snapshot, or finding references.

The manifest must pass. Existing negative tests must continue proving that a
referenced connector cannot omit or mismatch those references. The committed
JSON Schema must remain synchronized with the generated schema; no structural
schema change is expected because the reference properties remain required
manifest fields with nullable or empty values.

## Documentation

Clarify that ready connector health is globally valid when live and fresh, while
deployment, snapshot, and finding linkage is required only for connectors
selected by a passing live validation.
