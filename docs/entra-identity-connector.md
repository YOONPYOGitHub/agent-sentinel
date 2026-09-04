# Microsoft Entra identity connector

`@agent-sentinel/entra-identity-connector` is a read-only, authorization-gated
multi-source connector. It does not share configuration or consent with
`AUTH_*` user sign-in. It is wired into API and jobs images but remains
disabled in the deployed environment.

## Supported live boundary

The mandatory path uses Microsoft Graph v1.0
`GET /servicePrincipals` with an explicit field projection. It creates distinct
identity nodes and authoritative evidence. It never correlates by display name:
a `RUNS_AS` edge is emitted only when source agent metadata has exactly one
matching Entra service-principal object ID, application/client ID, or Agent
Identity ID.

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
does not; partial snapshots and finding reconciliation are not persisted, so a
transient Graph failure cannot erase the last complete state. There is no mock
fallback.

Inventory connectivity is not migration parity. The Entra composition health
diagnostics expose a typed per-source coverage summary: authoritative agents
considered, exact object-ID, app/client-ID, and enabled Agent Identity matches,
unmatched and ambiguous agents, emitted `RUNS_AS` edges, owner and app-role
coverage, preview status, and bounded evidence references. A source remains
degraded or authorization-required when those capabilities are unavailable;
inventory is not replaced with a success-shaped zero.

`AUTH_*` configuration controls corporate user sign-in and is independent of
`ENTRA_*` configuration, which controls read-only service-principal inventory
and optional enrichment. Neither configuration implies the other.

For multiple Foundry tenant/project sources, set `ENTRA_SOURCES_JSON`. Every
entry uses the same `id`, tenant, and source environment as its matching
`FOUNDRY_SOURCES_JSON` entry. Identity nodes and evidence are namespaced per
source, and correlation considers only Foundry agents with that exact source
tenant/environment. Missing source authorization remains
`authorization-required`; it is never substituted with another tenant.

Same-tenant sources use the default managed identity credential. Cross-tenant
sources use `credential.mode=federated-app`, the target-tenant app client ID,
and the attached UAMI (`managedIdentityClientId` or `AZURE_CLIENT_ID`) as the
secretless assertion issuer.

Next, obtain tenant-admin consent for `Application.Read.All`, configure the
tenant/environment values, then enable and validate bounded v1.0 inventory.
Separately review `AgentIdentity.Read.All` before enabling beta enrichment.
