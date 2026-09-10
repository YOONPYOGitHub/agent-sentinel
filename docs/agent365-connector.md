# Microsoft Agent 365 package catalog connector

The `@agent-sentinel/agent365-connector` package is a read-only,
disabled-by-default, multi-tenant inventory connector for the official
Microsoft Graph v1.0 Agent 365 Package Management API. Enabled persisted
connector-source records are resolved for the exact estate by both API and jobs;
deployment JSON remains an immutable compatibility source. Estate-scoped
factories always pass that exact resolved runtime, including an empty runtime,
so environment configuration cannot reactivate a source outside the requested
estate. Environment-only fallback remains available only to non-estate entry
points.

## Verified GA contract (2026-08-28)

Official Microsoft Learn references:

- [Package Management API overview](https://learn.microsoft.com/microsoft-365/copilot/extensibility/api/admin-settings/package/overview)
- [List Copilot packages](https://learn.microsoft.com/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackages-list)
- [Get Copilot package details](https://learn.microsoft.com/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-get)
- [`copilotPackage` resource](https://learn.microsoft.com/microsoft-365/copilot/extensibility/api/admin-settings/package/resources/copilotpackage)
- [`copilotPackageDetail` resource](https://learn.microsoft.com/microsoft-365/copilot/extensibility/api/admin-settings/package/resources/copilotpackagedetail)

The connector calls only:

```http
GET https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages
Authorization: Bearer <application token for https://graph.microsoft.com/.default>
```

The list returns a `copilotPackage` collection and standard `@odata.nextLink`. The documented list fields are `id`, `displayName`, `type`, `shortDescription`, `isBlocked`, `supportedHosts`, `lastModifiedDateTime`, `publisher`, `availableTo`, `deployedTo`, `elementTypes`, `platform`, `version`, `manifestVersion`, `manifestId`, `appId`, and `assetId`. The stream-valued `zipFile` is never requested or persisted.

The Learn list contract documents `$filter`, but not `$select`; therefore this implementation sends no query on the first request rather than assuming unsupported `$select` behavior. It accepts only provider-issued continuation URLs on the same Graph origin and exact v1.0 list path. It never accepts caller URLs, filters, or OData expressions.

Detail reads are not necessary for core inventory and are explicitly disabled. The connector does not call `/beta`, package write operations, private endpoints, or admin-center endpoints. It does not read or retain `allowedUsersAndGroups`, `acquireUsersAndGroups`, element definitions, or package files.

## Authorization and current evidence

Each enabled source requires:

1. A Microsoft Agent 365 license for the tenant.
2. Microsoft Graph **application** permission `CopilotPackages.Read.All` with tenant-admin consent.
3. An explicit user-assigned managed identity client ID. Cross-tenant sources
   additionally require a secretless federated-app client ID bound to the exact
   source tenant.

The integration owner verified on 2026-09-09 that the `AGENT_365` subscription
has five seats with one assigned, connector UAMI client ID
`59dbea72-1e91-403a-89cf-e02cdb8da350` has the
`CopilotPackages.Read.All` application permission, and one bounded
managed-identity request to the list endpoint returned HTTP 200 with 306
packages. This is provider-access evidence, not proof that this commit is
deployed, that ingestion has persisted those packages, or that all 306 packages
are agents.

Every acquired Graph access token must carry a `tid` claim exactly matching the configured source tenant; a home-tenant managed identity token cannot be mislabeled as an external-tenant result.

The API is documented for the Global service only. No IaC in this repository grants a Graph app role, creates a license, or changes a tenant. A `403` is `authorization-required`; a recognized `LicenseRequired` response retains the more specific sanitized reason code while using the same actionable readiness. A list-endpoint `404` remains unavailable.

## Configuration

```dotenv
AGENT365_CONNECTOR_ENABLED=false
AGENT365_SOURCES_JSON=
AGENT365_TENANT_ID=
AGENT365_ENVIRONMENT=
AGENT365_MANAGED_IDENTITY_CLIENT_ID=00000000-0000-0000-0000-000000000000
AGENT365_GRAPH_BASE_URL=https://graph.microsoft.com
AGENT365_MAX_PAGES=20
AGENT365_MAX_ITEMS=5000 # aggregate cap across all configured sources
AGENT365_REQUEST_TIMEOUT_MS=15000
AGENT365_MAX_RETRIES=2
AGENT365_MAX_RETRY_AFTER_MS=30000
AGENT365_MAX_RESPONSE_BYTES=2000000
AGENT365_MAX_CONCURRENCY=2
AGENT365_MAX_DURATION_MS=60000
```

`AGENT365_MAX_RETRY_AFTER_MS` has a strict maximum of `60000`. The same bound
is enforced by deployment environment parsing, persisted connector-source API
validation, the web input, and runtime resolution; persisted API-valid values
therefore cannot widen Agent 365 Graph retry behavior. Deployment projection
also preserves `AGENT365_MAX_CONCURRENCY` (1–10) and
`AGENT365_MAX_DURATION_MS` (100–300000) for repository-backed runtime
resolution rather than replacing operator values with defaults. The web
connector-source create and edit form exposes both aggregation limits, restores
persisted values during edit, and applies the same numeric bounds before the
strict API schema validates the request.

`AGENT365_SOURCES_JSON` accepts 1–50 source objects with unique tenant IDs. The
catalog is tenant-wide, so the same tenant cannot be configured twice under
different local environment labels:

```json
[
  {
    "id": "tenant-a",
    "name": "Tenant A Agent 365",
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "environment": "production",
    "credential": {
      "mode": "federated-app",
      "clientId": "00000000-0000-0000-0000-000000000000",
      "managedIdentityClientId": "00000000-0000-0000-0000-000000000000"
    }
  }
]
```

Runtime configuration accepts only explicit `managed-identity` or
`federated-app` credentials. Persisted records without a dedicated workload
identity remain visible but inactive. No secret field is accepted. Legacy
scalar configuration requires `AGENT365_TENANT_ID`, `AGENT365_ENVIRONMENT`, and
`AGENT365_MANAGED_IDENTITY_CLIENT_ID`; it creates source `primary` when JSON is
absent. `AGENT365_GRAPH_BASE_URL` accepts exactly
`https://graph.microsoft.com` (an optional trailing slash is normalized);
credentials, ports, paths, query strings, fragments, and alternate clouds are
rejected.

Persisted sources are read through bounded, advancing pagination. Deployment
sources are overlaid through the same repository contract and remain immutable.
If a deployment and user source target the same tenant-wide catalog, the
deployment source remains authoritative and the duplicate user source is
inactive.

## Evidence and composition

Composition order is Foundry → optional Entra → optional Power Platform → optional Agent 365. Agent 365 source IDs are independent and never correlate to Entra by display name.

Packages with documented agent signals (`Copilot` in `supportedHosts`, or
`bot`, `declarativeAgent`, or `customEngineAgent` in `elementTypes`) become
agent nodes. Declarative-agent packages hosted in `M365` or `SharePoint` receive
additional `m365-declarative-agent` or `sharepoint-declarative-agent`
classification. Other packages become honestly labeled extension-package
control nodes, not fabricated agents. A package produces one node even when it
has multiple classifications. Mapping preserves only validated package
metadata and exact estate/source tenant/environment/package provenance. It
emits no edges and infers no runtime behavior, trust, tools, identity,
entitlements, principals, or effective access.

Every record has confidence `1` and freshness `live` because it is a direct
package-catalog observation. IDs are deterministic SHA-256-derived,
source-namespaced values. At most two sources execute concurrently by default,
with a bounded aggregate duration and per-source page, item, response-byte,
retry, and request-timeout limits. `AGENT365_MAX_RESPONSE_BYTES` is enforced
both for each response and as one concurrency-safe aggregate budget across all
Agent 365 sources and pages in an operation. The aggregate uses measured body
bytes rather than `Content-Length`, and exhaustion is terminal for queued
sources. Caller cancellation reaches token acquisition, HTTP requests, and
retry waits.

Source health records exact source IDs, catalog endpoint provenance, page and
record counts, and typed `complete`, `empty`, `failed`, or `cancelled` states. A
successful empty catalog remains `empty`/degraded rather than complete
discovery. Any enabled source that is not complete makes health partial while
preserving the base snapshot and successful additions; jobs refuse
persistence/reconciliation of partial authoritative snapshots. Disabled mode
returns the exact base connector object.

Persisted health reconciliation first expires every enabled connector source
when the measurement is stale. It then applies Agent 365 source-set fingerprint
changes only to `agent365:` sources, so an Agent 365 mismatch cannot leave an
expired non-Agent365 source ready.
