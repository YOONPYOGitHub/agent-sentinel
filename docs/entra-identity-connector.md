# Microsoft Entra identity connector

`@agent-sentinel/entra-identity-connector` is a read-only, authorization-gated
foundation. It does not share configuration or consent with `AUTH_*` user
sign-in and is not activated in the deployed environment.

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
gate. The connector and `EntraEnrichmentConnector` composition are complete,
but API/jobs activation remains deliberately unwired until connector-specific
health can be exposed without making a healthy Foundry source appear failed
when an optional Entra source is awaiting consent. There is no mock fallback.

Next, obtain tenant-admin consent for `Application.Read.All`, configure the
tenant/environment values, expose composite source health in API/jobs, then
enable and validate v1.0 inventory. Separately review
`AgentIdentity.Read.All` before enabling beta enrichment.
