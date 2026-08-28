# Microsoft Agent 365 package catalog connector

The `@agent-sentinel/agent365-connector` package is a read-only, disabled-by-default, multi-tenant inventory connector for the official Microsoft Graph v1.0 Agent 365 Package Management API. Implementation does **not** mean deployment activation: licensing and tenant-admin application consent remain separately blocked.

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

## Authorization gate

Before enabling any source, separately approve:

1. A Microsoft Agent 365 license for the tenant.
2. Microsoft Graph **application** permission `CopilotPackages.Read.All` with tenant-admin consent.
3. A default credential or secretless federated-app credential bound to the exact source tenant.

Every acquired Graph access token must carry a `tid` claim exactly matching the configured source tenant; a home-tenant managed identity token cannot be mislabeled as an external-tenant result.

The API is documented for the Global service only. No IaC in this repository grants a Graph app role, creates a license, or changes a tenant. A `403` is `authorization-required`; a recognized `LicenseRequired` response retains the more specific sanitized reason code while using the same actionable readiness. A list-endpoint `404` remains unavailable.

## Configuration

```dotenv
AGENT365_CONNECTOR_ENABLED=false
AGENT365_SOURCES_JSON=
AGENT365_TENANT_ID=
AGENT365_ENVIRONMENT=
AGENT365_GRAPH_BASE_URL=https://graph.microsoft.com
AGENT365_MAX_PAGES=20
AGENT365_MAX_ITEMS=5000 # aggregate cap across all configured sources
AGENT365_REQUEST_TIMEOUT_MS=15000
AGENT365_MAX_RETRIES=2
AGENT365_MAX_RETRY_AFTER_MS=30000
AGENT365_MAX_RESPONSE_BYTES=2000000
```

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

`credential.mode` can be `default` or `federated-app`. No secret field is accepted. Legacy `AGENT365_TENANT_ID` plus `AGENT365_ENVIRONMENT` creates source `primary` when JSON is absent. `AGENT365_GRAPH_BASE_URL` accepts exactly `https://graph.microsoft.com` (an optional trailing slash is normalized); credentials, ports, paths, query strings, fragments, and alternate clouds are rejected.

## Evidence and composition

Composition order is Foundry → optional Entra → optional Power Platform → optional Agent 365. Agent 365 source IDs are independent and never correlate to Entra by display name.

Packages with documented agent signals (`Copilot` in `supportedHosts`, or `bot`, `declarativeAgent`, or `customEngineAgent` in `elementTypes`) become agent nodes. Other packages become honestly labeled extension-package control nodes, not fabricated agents. Mapping preserves only validated package metadata and source tenant/environment provenance. It emits no edges and infers no runtime behavior, trust, tools, identity, entitlements, principals, or effective access.

Every record has confidence `1` and freshness `live` because it is a direct package-catalog observation. IDs are deterministic SHA-256-derived, source-namespaced values. Sources are collected sequentially and `AGENT365_MAX_ITEMS` caps the aggregate additions. Any enabled source failure makes health partial while preserving the base snapshot and successful additions; jobs refuse persistence/reconciliation of partial authoritative snapshots. Disabled mode returns the exact base connector object.
