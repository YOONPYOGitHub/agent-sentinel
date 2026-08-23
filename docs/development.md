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
