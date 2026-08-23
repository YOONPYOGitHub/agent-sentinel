# Development

## Canonical environment

The canonical source is the WSL repository at `~/project/agent-sentinel`.
GitHub is the shared source of truth. Do not install dependencies or develop
from a OneDrive-synchronized clone.

Requirements:

- Node.js 22
- pnpm 10
- Azure CLI and Bicep for infrastructure validation

Install from the existing WSL store when offline:

```bash
pnpm install --offline --frozen-lockfile
```

## Common commands

```bash
pnpm lint
pnpm test
pnpm test:e2e
pnpm --filter @agent-sentinel/web build
```

Run live Foundry validation only when explicitly intended:

```bash
pnpm foundry:validate
```

It exercises synthetic Azure resources and is never part of CI.

## Custom manifest adapter

`connectors/manifest` (`@agent-sentinel/manifest-connector`) turns an
operator-supplied manifest into an `EstateSnapshot`. The envelope contract itself
lives in `packages/connector-sdk/src/manifest.ts` so the SDK stays the single
source of truth; the connector re-exports it rather than duplicating schemas.

```bash
pnpm --filter @agent-sentinel/manifest-connector test
pnpm manifest:validate -- /absolute/path/to/manifest.json \
  --tenant contoso-ai-lab \
  --environment production
```

The validator CLI (`tools/validate-manifest.ts`) is offline: it requires the
expected tenant binding, optionally verifies the environment binding, runs the
same strict validation as the connector, and prints the
normalized entity counts plus the deterministic SHA-256 manifest hash used for
ingestion idempotency. A worked example lives at
`connectors/manifest/examples/sample-manifest.json`.

When changing the envelope:

- Update `manifest.ts`, `connectors/manifest/schemas/manifest.schema.json`, and
  the example together. Tests assert parity between the Zod schema and the
  hand-maintained JSON Schema on the critical constraints.
- Bump `MANIFEST_SCHEMA_VERSION` and extend `SUPPORTED_MANIFEST_VERSIONS` for a
  breaking change; unsupported versions must be rejected, never coerced.
- Keep the adapter read-only. `ManifestConnector` intentionally has no
  `execute()`, and an `execute` action depth is rejected at load time.

## Contribution practice

- Work on feature branches.
- Keep deterministic policy and graph behavior independent of model access.
- Add tests for behavior changes.
- Preserve explicit live, synthetic, mock, planned, and unknown boundaries.
- Never substitute mock success when a live connector fails.
- Use immutable image tags derived from commits.

The private CI runner can be deallocated. Start it before expecting queued jobs
to run. Its managed identity is intentionally limited to image push; platform
deployment remains a separate privileged operation.
