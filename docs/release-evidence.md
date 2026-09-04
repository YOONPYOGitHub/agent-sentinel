# Release evidence manifest

`pnpm release:evidence` generates a versioned, sanitized release evidence
manifest without calling Azure, Microsoft 365, Entra, OneRAI, or any other cloud
service. Repository-only generation is allowed offline; live validation,
connector readiness, image digest, and OneRAI claims are included only when an
operator supplies explicit sanitized JSON result files.

The current schema version is `release-evidence.v1`. It records:

- repository commit SHA, branch, dirty state, and dirty files;
- expected and deployed image tags plus optional SHA-256 digests;
- a SHA-256 hash over a safe allow-listed configuration projection;
- unit, typecheck, lint, build, E2E, and Bicep result summaries;
- sanitized live validation and connector readiness summaries;
- evidence freshness, OneRAI summary, and explicit `live`, `synthetic`,
  `tested`, `blocked`, `planned`, or `unknown` classifications.

Missing files, missing command summaries, and missing live evidence remain
`unknown` or `not-supplied`; the tool never converts them into a pass. The
loader rejects unrestricted environment dumps and fields or values shaped like
secrets, tokens, connection strings, private payloads, prompts, outputs, or raw
claims.

## Offline generation

```bash
pnpm release:evidence -- \
  --expected-image web=<new-code-sha> \
  --deployed-image web=7458b3e \
  --output /tmp/agent-sentinel-release-evidence.json
```

Use `--config-file <json> --config-key <safe-key>` to hash only reviewed,
non-secret configuration keys. Supplying a configuration file without an
allow-list is rejected.

## Sanitized live ingestion

```bash
pnpm release:evidence -- \
  --live-result /path/to/sanitized-live-summary.json \
  --output /tmp/agent-sentinel-release-evidence.json
```

Live result files must already be scrubbed. They may contain only the summary
shapes accepted by `tools/release-evidence.ts`; they must not contain tokens,
connection strings, raw provider payloads, private prompts, model outputs, or
environment dumps. Generated private/live evidence remains gitignored under
`release-evidence/private`, `release-evidence/live`, and
`release-evidence/*.json`.
