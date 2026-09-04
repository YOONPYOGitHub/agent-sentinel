# Agent Sentinel development instructions

Read `agent-sentinel-product-spec.md` and `docs/copilot-agent-handoff.md` before
making changes.

## Working branch

- The active integration branch is `feature/multi-source-otel`.
- `main` is behind the integration branch. Do not implement a task from `main`
  unless the task explicitly says that `main` has been synchronized.
- Keep each task in a focused branch and pull request. Do not combine unrelated
  work packages.

## Product invariants

- The core loop is: configure connectors, discover authoritative agents,
  correlate cross-plane evidence, compute deterministic analysis, and govern
  evidence-backed findings.
- Live readiness requires real provider responses. Mock or synthetic data must
  never establish a live pass.
- Synthetic safety probes are allowed only when explicitly labeled synthetic
  and must never call destructive tools or include real secrets.
- Missing, sparse, unauthorized, stale, or unattributed evidence remains
  `unknown`, `insufficient-data`, `authorization-required`, or `degraded`.
  Never convert it to healthy.
- Preserve tenant, estate, environment, source, provider object ID, observation
  window, and evidence provenance across every boundary.
- Correlate identities and agents only through exact identifiers. Never match by
  display name.
- Keep live writes disabled unless a task explicitly includes the authenticated,
  approved, reversible write gate.
- Do not weaken private networking, ACR restrictions, WAF, RBAC, validation,
  pagination bounds, retry bounds, or timeout behavior.

## Repository conventions

- Use Node.js 22 and the pinned `pnpm@10.15.1`.
- This is a TypeScript pnpm/Turborepo monorepo.
- Reuse Zod schemas and existing repository, Fastify, React, Cosmos ETag, audit,
  and connector composition patterns.
- Keep type safety. Do not use `any`, broad catches, silent fallbacks, or
  success-shaped defaults.
- Add tests for behavior changes and update directly related documentation.
- Do not commit generated live evidence, credentials, tokens, or private data.
- Do not mutate Azure, Microsoft 365, Entra, OneRAI, DARSy, or other external
  systems. Cloud operations and real-data validation are handled by the
  integration owner after review.

## Validation

Run the narrow package checks while iterating, then before completion run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Run `pnpm test:e2e` for web workflow or routing changes. Existing repository-wide
Prettier drift is tracked separately; format only files touched by the task.

Report exactly what was implemented, tests run, remaining unknowns, and any
claim that still requires live replacement-tenant validation.
