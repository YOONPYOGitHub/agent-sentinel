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
  --output release-evidence/generated/<short-sha>.json
```

Add explicitly supplied sanitized observations:

```bash
pnpm release-evidence:generate -- \
  --input <sanitized-input.json> \
  --output release-evidence/generated/<short-sha>.json
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
`not-run`. A pass is rejected when its required command, timestamp, source,
scope, or evidence reference is missing. Missing files and commands never
become pass.

Connector readiness is separately typed as `ready`, `degraded`,
`authorization-required`, `insufficient-data`, `unknown`, `blocked`, or
`planned`. `ready` is valid only for fresh live evidence.

## Manifest contents

Version 1 covers:

- full Git commit SHA, dirty worktree state, and generation timestamp;
- expected web/API/jobs image tags and optional SHA-256 digests;
- deployed web/API/jobs image tags and optional SHA-256 digests;
- SHA-256 over canonical, allow-listed configuration, retaining only key names;
- lint, typecheck, unit test, build, E2E, and Bicep outcomes;
- bounded live-validation summaries;
- connector readiness and freshness;
- a bounded OneRAI summary with synthetic and human-review state.

Live records retain sanitized opaque `estateRef`, `tenantRef`,
`environmentRef`, and `sourceRef` values plus bounded evidence references.
These are correlation handles, not raw provider payloads or private cloud
identifiers.

## Sanitized input

The input object is strict. Unknown properties are rejected. A representative
shape is:

```json
{
  "deployedImages": {
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
    "web": { "tag": "7458b3e", "digest": null },
    "api": { "tag": "7458b3e", "digest": null },
    "jobs": { "tag": "7458b3e", "digest": null }
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
provenance fields. Each component accepts a bounded tag and optional canonical
`sha256:<64 lowercase hex characters>` digest.

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

## Rejected content and contradictions

Input is rejected before schema parsing if it contains secret-, credential-,
authorization-, unrestricted-environment-, private-payload-, prompt-, or
output-related fields. Secret-shaped strings such as bearer credentials, JWTs,
connection strings, credential URLs, signed URLs, and private keys are also
rejected. Error messages identify only a bounded field path and never echo the
value.

The validator also rejects contradictions including:

- a passing check without a command and completion timestamp;
- live evidence without observation time, source, sanitized scope, and evidence
  references;
- deployed component tags that do not identify one release;
- a digest without a corresponding image tag;
- a connector marked ready when it is not fresh and live;
- blocked or planned evidence paired with pass;
- live OneRAI classification for a synthetic-only evaluation;
- defect counts greater than evaluated case counts.

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
