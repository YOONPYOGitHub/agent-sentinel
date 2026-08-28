# Microsoft Purview sensitivity-label connector

**Status:** implemented, read-only, multi-tenant, and disabled by default. No
live tenant, Graph permission, app-role assignment, token, secret, label, or
other Microsoft 365/Azure resource is created or changed.

## Verified official contract

Contract reviewed against Microsoft Learn on **2026-08-28**:

- [List sensitivityLabels](https://learn.microsoft.com/graph/api/tenantdatasecurityandgovernance-list-sensitivitylabels?view=graph-rest-1.0)
  documents tenant catalog retrieval as
  `GET https://graph.microsoft.com/v1.0/security/dataSecurityAndGovernance/sensitivityLabels`.
  The API is available only in the Global service, not US Government L4/L5 or
  China.
- The least privileged application permission is `SensitivityLabel.Read`, with
  tenant-admin consent. The official permissions reference lists application
  role ID `3b8e7aad-f6e3-4299-83f8-6fc6a5777f0b`. The client requests only
  `https://graph.microsoft.com/.default`.
- [sensitivityLabel](https://learn.microsoft.com/graph/api/resources/security-sensitivitylabel?view=graph-rest-1.0)
  documents `id`, `displayName`, `name`, `color`, `sensitivity`, `priority`,
  `applicableTo`, and `isEnabled`. Only these bounded catalog fields are
  retained. `priority` is the documented ordering value and `isEnabled` is
  represented as enabled/disabled status.
- [Microsoft Graph paging](https://learn.microsoft.com/graph/paging) requires
  following `@odata.nextLink` until absent. The connector accepts it only when
  the HTTPS origin and exact v1.0 list path remain unchanged.

This connector never calls a single-label/detail route, beta, activity
explorer, usage, content, label application, compute-rights, download, file
scan, or write API. It supplies no caller-controlled OData. Provider-generated
continuation query values are replayed unchanged only after boundary
validation.

## Configuration

`PURVIEW_CONNECTOR_ENABLED=false` is the default. When enabled, configure
`PURVIEW_SOURCES_JSON`, or the legacy `PURVIEW_TENANT_ID` and
`PURVIEW_ENVIRONMENT` pair:

```json
[
  {
    "id": "governance-a",
    "name": "Governance tenant A",
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "environment": "production-governance",
    "credential": {
      "mode": "federated-app",
      "clientId": "00000000-0000-0000-0000-000000000000",
      "managedIdentityClientId": "00000000-0000-0000-0000-000000000000"
    }
  }
]
```

The GUIDs are placeholders. One to 50 sources are accepted, with unique source
IDs and tenants. Azure GUID validation deliberately accepts the full GUID
shape rather than RFC-version-restricted UUID validation. `environment` is a
local provenance label and is not sent to Microsoft Graph.

| Environment variable         | Default                       |
| ---------------------------- | ----------------------------- |
| `PURVIEW_SOURCES_JSON`       | unset                         |
| `PURVIEW_TENANT_ID`          | unset                         |
| `PURVIEW_ENVIRONMENT`        | unset                         |
| `PURVIEW_GRAPH_BASE_URL`     | `https://graph.microsoft.com` |
| `PURVIEW_MAX_PAGES`          | 20                            |
| `PURVIEW_MAX_ITEMS`          | 5000 aggregate                |
| `PURVIEW_REQUEST_TIMEOUT_MS` | 15000                         |
| `PURVIEW_MAX_RETRIES`        | 2                             |
| `PURVIEW_MAX_RETRY_AFTER_MS` | 30000                         |
| `PURVIEW_MAX_RESPONSE_BYTES` | 2000000 per response          |

The Graph base is fixed to the exact credential-free Global origin. Sources
are collected sequentially. A page, item, byte, timeout, or continuation limit
fails the source rather than returning a truncated complete snapshot. Only
429, 500, 502, 503, and 504 can be retried, and only with a valid bounded
`Retry-After`. Tokens must be JWTs whose `tid` exactly matches the configured
tenant; opaque and cross-tenant tokens fail closed.

`credential.mode=default` uses `DefaultAzureCredential` bound to the source
tenant. `federated-app` exchanges a user-assigned managed-identity assertion
through `ClientAssertionCredential`. Client secrets and certificates embedded
in source JSON are rejected.

## Privacy and evidence semantics

Sensitivity-label definitions are tenant governance metadata, but their names
can reveal classification vocabulary. Additive Graph fields are tolerated
within the byte limit and stripped before mapping. Descriptions, tooltips,
rights, protection settings, principals, labeled files/content, users,
activities, and usage are not persisted.

Each observed label creates one deterministic source-namespaced `control` node
and one evidence record. No agent-specific correlation key exists, so the
connector creates no agent node, relationship, edge, or name-based join.
Confidence `1` means only that the tenant catalog directly returned the label
definition. It does not mean the label is used, content is protected, an agent
accesses it, or any trust/compliance requirement is met.

## Failure and activation behavior

Stable health reasons are `authentication`, `authorization`, `not-available`,
`bounds`, `timeout`, `malformed-response`, `network`, and
`request-failed:<status>`. HTTP 403 maps to `authorization-required`; 404 maps
to unavailable. Provider error narratives are not logged or retained.

Composition order is Foundry → Entra → Power Platform → Agent 365 → Defender
for Cloud Apps → Purview. Disabled mode returns the exact Defender/base
connector. Successful additions may be returned for diagnosis, but any enabled
authoritative Purview failure marks health partial. Jobs consequently refuse
snapshot persistence and finding reconciliation for that incomplete run.
There is no mock fallback or Purview write path.

Activation requires separate approval and tenant-admin
`SensitivityLabel.Read` application consent for every source. IaC only exposes
disabled, empty-by-default configuration and intentionally creates no Graph
app-role assignment. Activity/usage evidence is not an activation prerequisite
because this connector does not collect it.
