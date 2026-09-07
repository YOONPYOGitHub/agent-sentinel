# Versioned sanitized release evidence

Release evidence is a versioned, machine-validated summary of what was built,
tested, expected, deployed, and observed. It is not a raw log bundle. Version
`1.0.0` is defined by
[`release-evidence/v1/schema.json`](../release-evidence/v1/schema.json) and the
stricter cross-field checks in `scripts/release-evidence-schema.ts`.

The generator is offline by design. It calls only local Git commands to read
the commit SHA and dirty state. It does not invoke validation commands, Azure,
Microsoft 365, Foundry, OneRAI, a registry, or any other network service.

## Commands

Generate repository-only evidence. Every unsupplied check, deployment, live
validation, connector, configuration, and OneRAI field remains explicitly
`not-run`, `unknown`, or `planned`:

```bash
pnpm release-evidence:generate -- \
  --output release-evidence/generated/<full-sha>.json
```

Add explicitly supplied sanitized observations:

```bash
pnpm release-evidence:generate -- \
  --input <sanitized-input.json> \
  --output release-evidence/generated/<full-sha>.json
```

Validate a manifest and ensure the committed JSON Schema is synchronized:

```bash
pnpm release-evidence:validate -- <manifest.json>
pnpm release-evidence:schema:check
```

The optional `--timestamp <ISO-8601>` generation argument exists for
reproducible repository examples. Normal release generation uses the current
time.

## Classifications and outcomes

Every evidence-bearing record uses one of these classifications:

| Classification | Meaning                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| `live`         | A sanitized summary of a real provider or deployed-system observation.                    |
| `synthetic`    | A bounded synthetic probe or fixture, never customer or production evidence.              |
| `tested`       | A local or CI repository check, or a value derived directly from tested repository state. |
| `blocked`      | A named prerequisite prevents the observation or operation.                               |
| `planned`      | No observation was supplied; this is not evidence of success.                             |

Check and validation outcomes are `pass`, `fail`, `unknown`, `blocked`, or
`not-run`. Every evaluated live-validation pass or fail requires a non-null
sanitized source, observation timestamp, scope, and at least one evidence
reference regardless of classification. OneRAI evidence requires the same
attribution when it is classified `tested` or has a `pass` or `fail` outcome.
Passing repository checks must be within the explicit freshness window and
cannot attest a dirty worktree. A passing live validation must also identify
the exact deployed candidate, snapshot, evaluated findings, and one to 20
unique supporting connector IDs in `connectorRefs`. Only those exactly
referenced connectors must be ready against the same typed references, with
exact timing order
`deployment.observedAt < connector.observedAt <= validation.observedAt`.
Unreferenced connector evidence retains its own readiness without affecting an
unrelated validation.
OneRAI classification and `syntheticOnly` must agree exactly: `synthetic`
requires `true`, `live` or `tested` requires `false`, and `planned` or `blocked`
requires `null`. Missing, stale, or unknown provenance never becomes pass.

Connector readiness is separately typed as `ready`, `degraded`, `unavailable`,
`disabled`, `authorization-required`, `insufficient-data`, `unknown`, `blocked`,
or `planned`. Connector IDs retain the connector-health identifier syntax,
including colon-qualified IDs such as `foundry:primary`; they are never
normalized to a different identity. `ready` is valid only for fresh live
evidence. Version 1 fixes the freshness window at 24 hours and records that
window explicitly in `release.freshnessWindowHours`. `fresh` and `stale` are
computed relative to `release.generatedAt`; a missing observation must remain
`unknown`. Passing OneRAI evidence is also rejected after the same 24-hour
window.

## Manifest contents

Version 1 covers:

- full Git commit SHA, dirty worktree state, generation timestamp, and explicit
  freshness window;
- expected web/API/jobs full-SHA image tags and optional SHA-256 digests;
- deployed web/API/jobs full-SHA image tags and mandatory digests for live
  deployment evidence, plus an opaque typed deployment reference;
- SHA-256 over canonical, allow-listed configuration, retaining only key names;
- lint, typecheck, unit test, build, E2E, and Bicep outcomes;
- bounded live-validation summaries with typed deployment, snapshot, finding,
  and supporting connector references;
- connector readiness and freshness linked to the same typed release
  references;
- a bounded OneRAI summary with synthetic and human-review state.

Live records retain sanitized opaque `estateRef`, `tenantRef`,
`environmentRef`, and `sourceRef` values plus bounded evidence references.
These are correlation handles, not raw provider payloads or private cloud
identifiers. All scoped records in one manifest must use the same estate,
tenant, and environment references; source references remain record-specific.

## Sanitized input

The input object is strict. Unknown properties are rejected. For generator
ergonomics, omitted nullable provenance fields, check command/completion fields,
and evidence-reference arrays are defaulted to `null` or `[]` at this input
boundary. Generated and externally validated manifests must include every field
explicitly; the output schema does not apply defaults. A representative shape
is below. The repeated `a` value represents the exact full SHA of the checked-out
release being generated:

```json
{
  "deployedImages": {
    "deploymentRef": "deployment-candidate-a",
    "classification": "live",
    "observedAt": "2026-09-04T00:00:00.000Z",
    "source": "sanitized-deployment-observation",
    "scope": {
      "estateRef": "replacement-estate",
      "tenantRef": "replacement-tenant",
      "environmentRef": "dev",
      "sourceRef": "container-apps"
    },
    "evidenceRefs": ["deployment-observation-2026-09-04"],
    "web": {
      "tag": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    "api": {
      "tag": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    },
    "jobs": {
      "tag": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "digest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    }
  },
  "safeConfiguration": {
    "AUTH_MODE": "disabled",
    "AGENT_SENTINEL_WRITE_ENABLED": false,
    "DATA_MODE": "live"
  },
  "checks": {
    "lint": {
      "classification": "tested",
      "outcome": "pass",
      "command": "pnpm lint",
      "completedAt": "2026-09-04T00:00:00.000Z",
      "summary": "Workspace lint completed."
    }
  },
  "liveValidations": [],
  "connectors": [],
  "oneRai": {
    "classification": "planned",
    "outcome": "not-run",
    "observedAt": null,
    "source": null,
    "scope": null,
    "evidenceRefs": [],
    "syntheticOnly": null,
    "automated": null,
    "cases": null,
    "defects": null,
    "humanReviewRequired": null,
    "summary": "No sanitized OneRAI summary was supplied."
  }
}
```

`expectedImages` has the same three component objects without deployment
provenance fields. Every tag is the exact lowercase 40-hex release commit SHA.
Each expected component accepts an optional canonical
`sha256:<64 lowercase hex characters>` digest. Live deployed components require
both the full release SHA tag and a digest.

### Safe configuration allow-list

Only these keys may contribute to the configuration hash:

```text
AGENT365_CONNECTOR_ENABLED
AGENT_SENTINEL_WRITE_ENABLED
AUTH_MODE
AZURE_MONITOR_OTEL_CONNECTOR_ENABLED
AZURE_RESOURCE_GRAPH_CONNECTOR_ENABLED
DATA_MODE
DEFENDER_CLOUD_APPS_CONNECTOR_ENABLED
ENTRA_CONNECTOR_ENABLED
FOUNDRY_CONNECTOR_ENABLED
MANIFEST_CONNECTOR_ENABLED
NODE_ENV
POWER_PLATFORM_CONNECTOR_ENABLED
PURVIEW_CONNECTOR_ENABLED
TEAMS_DISTRIBUTION_CONNECTOR_ENABLED
```

Values are canonicalized by sorted key and hashed with SHA-256. The manifest
retains the algorithm, hash, and sorted key names, but never the values.
Configuration classified `tested` requires a non-null hash and at least one
allow-listed key. Configuration classified `planned` requires a null hash and
an empty key list.

## Rejected content and contradictions

Input is rejected before schema parsing if it contains secret-, credential-,
authorization-, unrestricted-environment-, private-payload-, prompt-, or
output-related fields. Secret-shaped strings such as bearer credentials, JWTs,
GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` and `github_pat_` tokens, free-text
credential assignments, connection strings, credential URLs, signed URLs, and
private keys are also rejected. Error messages identify only a bounded field
path and never echo the value.

Both sanitized generator inputs and complete manifests are parsed with
duplicate-key rejection before sensitive-content scanning or schema
validation. This applies independently to every nested object and to escaped
spellings of the same decoded key, so a later property cannot overwrite and
hide an earlier secret-shaped value.

The validator also rejects contradictions including:

- a passing check without a command and completion timestamp;
- a stale passing check or any passing check attached to a dirty worktree;
- live evidence, or any evaluated live-validation pass/fail, without observation
  time, source, sanitized scope, and evidence references;
- evaluated live validation without typed deployment, snapshot, and finding
  references;
- tested or evaluated OneRAI evidence without equivalent attribution;
- configuration classification that contradicts its hash or key list;
- mismatched estate, tenant, or environment references across manifest
  evidence;
- duplicate live-validation IDs, connector IDs, or evidence references;
- timestamps later than `release.generatedAt`;
- freshness values that contradict the explicit 24-hour window;
- expected or deployed tags that do not equal the full release commit SHA;
- live deployment evidence without all three canonical image digests;
- deployed component tags that do not identify one release;
- a digest without a corresponding image tag;
- expected and deployed digests that contradict each other;
- a connector marked ready when it is not fresh and live;
- a passing live validation without a live deployed candidate, with an
  observation at or before deployment, or with a deployment reference that does
  not match the deployed candidate;
- a passing live validation without bounded supporting `connectorRefs`, with a
  connector reference that does not identify manifest connector evidence, or
  with a referenced connector whose deployment, snapshot, finding, freshness,
  classification, or readiness contradicts the validation;
- referenced supporting connector evidence observed at or before deployment,
  or after its passing live validation;
- blocked or planned evidence paired with pass;
- OneRAI classification and `syntheticOnly` values that do not agree exactly;
- any tested or evaluated OneRAI evidence without complete source, observation
  time, sanitized scope, and evidence-reference provenance;
- passing OneRAI evidence older than the 24-hour freshness window;
- defect counts greater than evaluated case counts.

Schema drift checks parse and compare canonical JSON, so property ordering and
LF/CRLF differences do not create false drift while semantic changes still
fail.

The committed
[`repository-only.json`](../release-evidence/v1/examples/repository-only.json)
example intentionally contains no live pass or deployment claim.

## Artifact handling

Generated, live, private, and local evidence belongs under ignored paths:

```text
release-evidence/generated/
release-evidence/live/
release-evidence/private/
release-evidence/**/*.local.json
```

Commit only versioned schemas and deliberately sanitized examples. Never commit
raw validation rows, prompts, outputs, environment dumps, logs, credentials,
tokens, connection strings, personal data, tenant/subscription identifiers, or
private provider payloads.

The integration owner must collect replacement-tenant observations outside the
generator, sanitize them to this contract, and validate the resulting manifest.
Repository-only CI proves tooling behavior; it does not establish a live pass.
