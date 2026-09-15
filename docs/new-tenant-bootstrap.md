# New tenant bootstrap

This guide makes the repository transferable without treating the current reference environment as a template that can be copied blindly. Another developer can clone the repository and run deterministic mock mode with **no Azure or Microsoft 365 access**. Reproducing live behavior requires independently provisioned tenant resources, accountable owners, permissions, workload identities, and operator approvals.

## Four access levels

1. **Repository-only mock/offline development** — source, local dependencies, deterministic fixtures, tests, schemas, and offline evidence tooling. No cloud account is required.
2. **Live read-only activation** — independently provisioned provider resources and least-privilege read permissions. Provider calls remain bounded and do not enable product writes.
3. **Deployment/operator access** — controlled access to build, inspect, deploy, roll back, and query the tenant's own Azure resources. This is not ordinary developer access.
4. **Approval-gated identity/write/release work** — Entra registration and consent, role assignments, public-edge mutation changes, write activation, and formal release decisions. Human approval and separate evidence are mandatory.

## Tenant input and ownership matrix

| Area                                    | Repository-only mock/offline                                  | Live read-only activation                                                                                                            | Deployment/operator access                                                                                                | Approval-gated identity/write/release work                                                                        |
| --------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Azure subscription and resource group   | Not required                                                  | Tenant chooses its own subscription, region, resource group, naming suffix, tags, and budgets                                        | Scoped Reader/Contributor or narrower custom roles on the tenant-owned resources                                          | Subscription/RG role grants and production scope expansion require owner approval                                 |
| Entra API and SPA applications          | Schemas, templates, and dry-run bootstrap work offline        | Required for employee JWT login; API and SPA are separate single-tenant apps                                                         | Operators deploy only approved non-secret IDs and redirect origins                                                        | App creation, consent, four app-role assignments, redirect changes, and write scopes are human-approved           |
| Human owner accounts                    | A normal individual Git identity is sufficient                | At least primary and secondary accountable owners are recorded in authoritative systems                                              | Named individual operator accounts use just-in-time access                                                                | Emergency access is separately controlled and audited; never share credentials                                    |
| UAMIs and workload identities           | Mock credentials only                                         | Create tenant-local identities for API/jobs/connectors with exact read permissions                                                   | Operators manage federated credentials and role assignments through reviewed IaC                                          | Permission broadening, cross-tenant federation, and credential-policy changes require approval                    |
| Azure AI Foundry                        | Fixtures are included                                         | Provision or authorize each project independently; record exact tenant, environment, endpoint, project ID, and agent IDs             | Operators validate bounded discovery and source health                                                                    | Agent identity configuration and additional project authorization require platform owners                         |
| Agent 365 licensing and Microsoft Graph | Fixtures are included                                         | Assign required Agent 365 licensing and `CopilotPackages.Read.All` to the approved workload identity; validate bounded package reads | Operators deploy the source binding and verify ready/complete persisted evidence                                          | License assignment and tenant-admin application consent are human-controlled                                      |
| Exact `RUNS_AS` identifiers             | Mock exact-ID examples are included                           | Every authoritative agent must expose an exact object ID, app/client ID, or approved Agent Identity ID                               | Operators verify unmatched and ambiguous counts; names and aliases are never fallback keys                                | Identity owners configure or disclose the exact authoritative identifiers                                         |
| Azure Monitor instrumentation and query | Representative fixtures and deterministic engines run offline | Instrument non-customer traffic with required attributes; grant bounded workspace query access                                       | Operators verify workspace binding, freshness, unsampled rows, and baseline/observed windows                              | Telemetry collection scope, retention, privacy, and query-role grants require approval                            |
| Cosmos DB                               | In-memory persistence is sufficient                           | Tenant creates its own database, containers, partition keys, indexes, and deployment-managed connector sources                       | Operators run isolated ETag/estate/source smoke checks and backups                                                        | Data-plane roles, migrations, cutovers, retention, and destructive actions require approval                       |
| ACR, Container Apps, and Front Door     | Not required                                                  | Required only for a live deployment                                                                                                  | Operators build immutable full-SHA images, record canonical digests, deploy API → jobs → web, and verify rollback         | Registry push roles, environment changes, WAF mutation rules, custom domains, and write exposure require approval |
| Defender, Purview, and Teams            | Fixtures/contracts are available                              | Each connector needs its documented tenant-local read permission and may validly return empty                                        | Operators validate bounded results without inferring agent coverage                                                       | Tenant-admin consent, privacy review, and any scope expansion remain separate decisions                           |
| GitHub Actions, OIDC, and runner        | Local commands are sufficient                                 | Optional for read-only development                                                                                                   | Tenant configures its own protected environments, OIDC trust, private runner labels/network, and minimal deployment roles | Workflow/environment approvals, runner trust, and production credentials are owner-controlled                     |
| Service Tree and OneRAI                 | Not required for independent mock development                 | Organization-specific; use the tenant's authoritative service inventory and compliance process                                       | Operators reference approved records without committing private identifiers                                               | Accountable product, security, accessibility, privacy/legal, and release owners record decisions outside Git      |

## Three-account ownership-transfer model

Use three **individually attributable** accounts or owner positions. Do not create a shared mailbox password or a shared administrator credential.

| Position        | Normal posture                                                                                                                | Transfer responsibility                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Primary owner   | Day-to-day accountable owner; least-privilege standing access plus just-in-time elevation                                     | Maintains inventory, runbooks, current approvers, and the next planned handoff                                    |
| Secondary owner | Independent backup who can review and operate after a documented handoff; no permanent broad privilege merely for convenience | Exercises restore/deploy/read-only validation periodically and can assume ownership if the primary is unavailable |
| Emergency owner | Separate break-glass identity controlled under organizational emergency-access policy; excluded from routine work             | Used only for a declared incident, monitored, reviewed immediately, and rotated/resecured after use               |

Keep at least two active human owners on Entra apps, GitHub environments, Service Tree/IcM records, subscriptions, and operational groups where the platform supports it. Prefer PIM/JIT elevation, scoped roles, expiring assignments, and approval workflows. Store recovery procedures in the approved operational system, not in Git.

## Bootstrap sequence

1. Clone the canonical branch and establish the local mock baseline.
2. Assign primary, secondary, and emergency ownership in the new organization.
3. Choose tenant-local naming, subscription, resource group, domains, regions, and data-retention rules.
4. Create tenant-local IaC parameters. Do not copy identifiers or resource names from the reference environment unless intentionally adopting those exact resources.
5. Provision data, registry, runtime, edge, and workload identities with least privilege.
6. Activate Foundry and each optional read connector independently; retain `unknown`, `blocked`, or valid-empty states honestly.
7. Run the Entra registration/bootstrap plan, obtain approvals, and activate JWT read-only with writes false.
8. Build and deploy immutable images, record full SHAs/digests, validate rollback, then capture sanitized release evidence.
9. Treat exact `RUNS_AS`, representative OTel, any write path, and human release decisions as separate gates.

## Existing offline checks

No aggregate `onboarding:check` command is added because tenant readiness spans independent owner decisions and existing domain-specific preflights. A wrapper would either duplicate them or imply that offline checks can prove live access.

```bash
pnpm install --offline --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm manifest:validate -- <absolute-manifest-path> --tenant <tenant> --environment <environment>
pnpm auth:registration-bootstrap -- --input <sanitized-input.json> --output <plan.json>
pnpm auth:preflight -- --input <sanitized-input.json> --output <plan.json>
pnpm auth:edge-preflight -- --input <sanitized-input.json> --output <report.json>
pnpm release-evidence:schema:check
pnpm release-review:schema:check
```

The auth commands are planning/preflight tools; protected workflows are the only approved apply paths. Live validators and `pnpm release-readiness:verify` are operator-only after deployment. `pnpm demo:verify` remains a compatibility alias.

## Reference-environment files

Files named `infra/environments/mngenvmcap098047-*` describe the current reference environment. They are useful examples of resource shape and sequencing, but they are **not portable defaults**. Their tenant-specific resource names and non-secret identifiers are not secrets by themselves; tokens, credentials, personal identities, private payloads, and unapproved tenant metadata still must never be committed.
