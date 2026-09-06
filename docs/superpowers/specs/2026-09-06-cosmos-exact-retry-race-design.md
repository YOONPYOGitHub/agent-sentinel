# Cosmos exact-retry race design

## Scope

Fix connector-source Cosmos writes at commit `1a92047` so concurrent identical
updates and deletes return one `applied` result and one exact `idempotent`
result. Preserve strict causal timestamps, application and Cosmos ETags,
delete tombstones, immutable audits, atomic batches, and exact estate, tenant,
and environment binding.

## Root cause

Concurrent identical calls can both read no idempotency marker and the same
source ETag. The winning transactional batch writes the source or tombstone,
audit, and idempotency marker. The losing batch then receives 404, 409, or 412
before it reaches its marker create. The current write-conflict path re-reads
the marker only for 409, so a 404 or 412 can incorrectly return `not_found` or
`etag_mismatch` even though the identical mutation committed.

## Considered approaches

1. **Replay-first terminal conflict reconciliation (selected).** For every
   expected batch conflict code, re-read and fully validate the scoped
   idempotency marker before mapping the status to its ordinary result. This is
   the smallest change and uses the existing exact fingerprint, audit, and
   boundary validation.
2. Retry the transactional batch after 404 or 412. This adds unnecessary
   writes and still loses against the committed marker, while increasing the
   chance of returning a misleading conflict.
3. Infer success from the current source or tombstone. This cannot prove that
   the same mutation won and would weaken idempotency-key and audit binding.

## Design

`writeConflict` will handle 404, 409, and 412 through one replay-first path.
It will call the existing marker replay routine, which:

- reads the marker from the exact estate partition and hashed idempotency key;
- rejects a different fingerprint as `idempotency_key_reuse`;
- validates marker estate, tenant, environment, document type, source ID, and
  referenced audit;
- reconstructs the exact result from the immutable audit.

Only when no marker exists will the handler return the status-specific normal
outcome: `not_found` for 404, `etag_mismatch` for 412, or `audit_id_reuse` for
409 after retaining the existing audit check. No result will be inferred from
the changed source document alone.

## Deterministic tests

The fake Cosmos store will expose one-shot batch barriers that pause selected
connector-source batches after their pre-batch reads and release them together.
Tests will run identical update and delete calls through that barrier and
assert:

- exactly one `applied` and one `idempotent` result with identical source/audit
  payloads;
- one source or tombstone, one mutation audit, and one marker, with no partial
  documents;
- strict causal timestamp, ETag, and tombstone behavior remains unchanged;
- reuse of the key with a different mutation fingerprint is rejected;
- the same key and logical source in another estate cannot observe or replay
  the winner.

The barrier is test-only and does not alter production timing or retry policy.
