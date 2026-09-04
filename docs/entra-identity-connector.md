# Microsoft Entra identity connector

`@agent-sentinel/entra-identity-connector` is a read-only, authorization-gated
multi-source connector. It does not share configuration or consent with
`AUTH_*` user sign-in. `AUTH_*` controls employee/API authentication;
`ENTRA_*` controls provider inventory and enrichment. Neither prefix activates
or supplies configuration for the other.

## Supported live boundary

The mandatory path uses Microsoft Graph v1.0
`GET /servicePrincipals` with an explicit field projection. It creates distinct
identity nodes and authoritative evidence. It never correlates by display name:
a `RUNS_AS` edge is emitted only when source agent metadata has exactly one
matching Entra service-principal object ID or application/client ID. Agent
Identity object IDs are eligible only when the separately enabled preview read
confirms that classification. Names, aliases, owners, tags, descriptions, and
fuzzy text are never correlation keys.

Optional stable capabilities are separately gated:

- `ENTRA_CONNECTOR_OWNERS_ENABLED=true` reads each inventory principal's
  `/owners` collection.
- `ENTRA_CONNECTOR_APP_ROLES_ENABLED=true` reads app roles granted to each
  inventory principal from `/appRoleAssignments`.

Both use `Application.Read.All`. They have shared page/item bounds and report a
typed degraded state on failure; stable inventory remains truthful. Sponsors
are deliberately excluded because the preview endpoint currently requires
`AgentIdentity.ReadWrite.All`, which violates this connector's read-only
least-privilege boundary.

`ENTRA_CONNECTOR_AGENT_IDENTITY_PREVIEW=true` independently enables the
Microsoft Graph beta
`/servicePrincipals/microsoft.graph.agentIdentity` endpoint. It requires
`AgentIdentity.Read.All`, is labeled preview, defaults off, and can degrade
without failing v1.0 inventory.

## Migration parity diagnostics

Inventory connectivity and migration parity are distinct:

- connectivity means the bounded Microsoft Graph v1.0 inventory read
  succeeded;
- parity additionally measures authoritative agents considered, exact
  service-principal object-ID matches, exact application/client-ID matches,
  preview-confirmed Agent Identity matches, unmatched agents, ambiguous agents,
  and emitted `RUNS_AS` edges;
- diagnostics retain the exact source ID, tenant, environment, and evidence
  references used for the result;
- owner, app-role, and preview coverage each has an independent status.

Disabled or failed optional reads do not become zero coverage. Their diagnostic
status remains `disabled`, `authorization-required`, or `degraded`, and numeric
coverage is omitted. Stable inventory and successful exact correlations remain
usable when only an optional capability fails.

All requests use `DefaultAzureCredential`, the
`https://graph.microsoft.com/.default` scope, HTTPS-only
`graph.microsoft.com`, strict projected response schemas, same-resource
next-link validation, bounded pagination, request timeouts, and retries only
for 429/500/502/503/504 responses carrying a bounded `Retry-After`.

## Configuration

See `.env.example`. `ENTRA_CONNECTOR_ENABLED` is reserved as the activation
gate. API `GET /api/connectors` exposes per-source readiness without marking a
healthy Foundry source failed when optional Entra enrichment is awaiting
consent. Jobs report partial success when primary discovery succeeds but Entra
does not. Stable inventory or composition failures remain partial and are not
persisted, so a transient Graph failure cannot erase the last complete state.
Optional-only degradation reports partial success but preserves the complete
stable v1.0 inventory. There is no mock fallback.

For multiple Foundry tenant/project sources, set `ENTRA_SOURCES_JSON`. Every
entry uses the same `id`, tenant, and source environment as its matching
`FOUNDRY_SOURCES_JSON` entry. Identity nodes and evidence are namespaced per
source, and correlation considers only Foundry agents with that exact source
ID, tenant, and environment. Missing source authorization remains
`authorization-required`; it is never substituted with another tenant.

Same-tenant sources use the default managed identity credential. Cross-tenant
sources use `credential.mode=federated-app`, the target-tenant app client ID,
and the attached UAMI (`managedIdentityClientId` or `AZURE_CLIENT_ID`) as the
secretless assertion issuer.

Next, obtain tenant-admin consent for `Application.Read.All`, configure the
tenant/environment values, then enable and validate bounded v1.0 inventory.
Separately review `AgentIdentity.Read.All` before enabling beta enrichment.

The current replacement-tenant baseline is 6 authoritative Foundry agents, 335
Entra identity nodes, and 0 `RUNS_AS` edges. Both the historical and replacement
Foundry validation agents expose null instance identity and null Agent Identity
blueprint reference, so zero exact matches is expected. `AUTH_MODE=disabled` is
a separate corporate sign-in state and does not affect this inventory result.
After this code is deployed, the integration owner must confirm diagnostics
report 6 considered, 6 unmatched, 0 ambiguous, 0 exact matches, and 0 emitted
edges, with owner, app-role, and preview coverage all `disabled`.
