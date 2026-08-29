# Microsoft Teams distribution catalog connector

Status: **implemented, read-only, disabled by default, authorization pending**.
No live source, permission, application role, credential, or Microsoft 365
resource is created by this implementation.

## Official contract verified 2026-08-29

The connector uses only the supported Microsoft Graph v1.0
[List teamsApp](https://learn.microsoft.com/graph/api/appcatalogs-list-teamsapps?view=graph-rest-1.0)
API:

```http
GET https://graph.microsoft.com/v1.0/appCatalogs/teamsApps
  ?$filter=distributionMethod eq 'organization'
  &$select=id,externalId,displayName,distributionMethod
```

- Application permission: **`AppCatalog.Read.All`**, the documented
  least-privileged application permission. Tenant-admin consent is external to
  Agent Sentinel.
- Token resource scope: **`https://graph.microsoft.com/.default`**. The token
  `tid` must exactly match the configured source tenant.
- Supported query options are `$filter`, `$select`, and `$expand`. This
  connector fixes the documented organization filter and four-field select.
  Callers cannot add OData, and `$expand` is intentionally unused.
- Retained `teamsApp` properties are `id`, `externalId`, `displayName`, and
  `distributionMethod`. `id` and `externalId` use the Azure GUID shape without
  imposing RFC UUID version or variant bits.
- Collection continuation uses provider `@odata.nextLink`. Each link must use
  HTTPS, the same exact Global Graph origin, and the exact v1.0 collection path.
- Microsoft documents this API in Global, US Government L4, and US Government
  L5, but not China operated by 21Vianet. This first increment deliberately
  accepts only `https://graph.microsoft.com`; sovereign hosts require a
  separately reviewed configuration contract.
- The API returns catalog entries subject to Teams app-management policy and
  can lag publishing by 24–48 hours. It isn't an admin-view inventory.

The `teamsAppDefinition` relationship documents version and `publishingState`,
but collecting it requires `$expand`. This increment does not expand it, so
neither field is claimed or retained.

## Evidence boundary

Each organization-catalog record becomes one `control` node and one evidence
record. Confidence `1` means only that Graph directly returned that catalog
record. There are no edges.

Catalog presence does **not** prove that an entry is an agent, deployed,
installed, sideloaded, distributed to anyone, trusted, entitled, accessible,
or associated with tools. The connector does not read app definitions,
manifests, icons, package files, users, groups, teams, chats, or installations.
It therefore provides tenant app catalog evidence, not installation or
distribution coverage.

## Configuration

```dotenv
TEAMS_DISTRIBUTION_CONNECTOR_ENABLED=false
TEAMS_DISTRIBUTION_SOURCES_JSON=[{"id":"tenant-a","name":"Tenant A catalog","tenantId":"00000000-0000-0000-0000-000000000000","environment":"catalog","credential":{"mode":"federated-app","clientId":"00000000-0000-0000-0000-000000000000","managedIdentityClientId":"00000000-0000-0000-0000-000000000000"}}]
TEAMS_DISTRIBUTION_GRAPH_BASE_URL=https://graph.microsoft.com
TEAMS_DISTRIBUTION_MAX_PAGES=20
TEAMS_DISTRIBUTION_MAX_ITEMS=5000
TEAMS_DISTRIBUTION_REQUEST_TIMEOUT_MS=15000
TEAMS_DISTRIBUTION_MAX_RETRIES=2
TEAMS_DISTRIBUTION_MAX_RETRY_AFTER_MS=30000
TEAMS_DISTRIBUTION_MAX_RESPONSE_BYTES=2000000
```

Up to 50 sources are accepted. Source IDs and tenant IDs must be unique.
Credential modes are `default` and secretless `federated-app`; client secrets
aren't accepted. Legacy single-source configuration uses
`TEAMS_DISTRIBUTION_TENANT_ID` and `TEAMS_DISTRIBUTION_ENVIRONMENT`.

## Bounds and failure behavior

Pages, aggregate items across sequential sources, response bytes, timeouts,
retries, and `Retry-After` are bounded. Only HTTP 429, 500, 502, 503, and 504
are retryable, and only with an acceptable `Retry-After`. Any required next
page beyond a bound fails rather than truncating.

HTTP 403 maps to `authorization-required`; 404 and other availability failures
map to `unavailable`. Per-source health IDs are
`teams-distribution:<source-id>` with role `enrichment`. Successful sources can
contribute evidence while failed sources make connector health partial. The
jobs ingestion service intentionally does not persist partial snapshots.

Composition order is Foundry → Entra → Power Platform → Agent 365 → Defender
for Cloud Apps → Purview → Teams distribution. When disabled, the factory
returns the exact base connector.
