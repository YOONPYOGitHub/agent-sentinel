# Microsoft Defender for Cloud Apps connector

**Status:** implemented, read-only, multi-source, and disabled by default. No live
tenant, permission, role, token, secret, license, or other Microsoft 365/Azure
resource is created by this connector or its IaC.

## Verified official contract

Contract reviewed against Microsoft Learn on **2026-08-28**:

- The [Defender for Cloud Apps REST API overview](https://learn.microsoft.com/en-us/defender-cloud-apps/api-introduction)
  documents tenant API URLs as
  `https://<tenant>.<region>.portal.cloudappsecurity.com/api`, a default and
  maximum list size of 100, and a throttle of 30 requests/minute/tenant. Obtain
  the exact API URL in Microsoft Defender portal **Settings > Cloud Apps >
  System > About**; do not derive it from a tenant name.
- [Application-context access](https://learn.microsoft.com/en-us/defender-cloud-apps/api-authentication-application)
  is the supported unattended OAuth flow. The resource application ID is
  `05a65629-4c1b-48c1-a78b-804c4abdd4af`; the documented v2 client-credential
  scope is `05a65629-4c1b-48c1-a78b-804c4abdd4af/.default` (without an
  `api://` prefix). The least read application permission for activities and
  alerts is `Investigation.Read`, granted by tenant admin.
- The official list contracts are `GET /api/v1/alerts/` and
  `GET /api/v1/activities/`; see [list alerts](https://learn.microsoft.com/en-us/defender-cloud-apps/api-alerts-list)
  and [list activities](https://learn.microsoft.com/en-us/defender-cloud-apps/api-activities-list).
  Requests use only connector-generated `date.gte`, `sortDirection=desc`,
  `sortField=date`, `skip`, and `limit` URL-encoded parameters. `hasNext=true`
  advances `skip` by the returned record count; `false` ends that list.
- The retained alert fields come from the documented
  [alert properties](https://learn.microsoft.com/en-us/defender-cloud-apps/api-alerts):
  `_id`, `timestamp`, `severityValue`, `statusValue`,
  `resolutionStatusValue`, `stories`, `intent`, and safe service/policy IDs and
  policy type shown in the official list response. Activity retention is
  restricted to the non-personal ID/time/action/service/policy fields named by
  the official [activity filters](https://learn.microsoft.com/en-us/defender-cloud-apps/api-activities).
- Microsoft's newer [large activity scan guidance](https://learn.microsoft.com/en-us/defender-cloud-apps/api-activities-investigate-script)
  uses POST scan mode and `nextQueryFilters`. This first increment deliberately
  implements only bounded GET lists and never accepts provider-generated
  continuation filters.

Legacy MDCA API tokens are deprecated and are **not accepted**. The connector
uses Bearer OAuth application context only.

## Configuration

`DEFENDER_CLOUD_APPS_CONNECTOR_ENABLED=false` is the default. When enabled,
configure `DEFENDER_CLOUD_APPS_SOURCES_JSON`, or all legacy primary values:
tenant ID, local environment label, and either API base URL or portal hostname.

```json
[
  {
    "id": "security-a",
    "name": "Security tenant A",
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "environment": "production-security",
    "portalHostname": "tenant.region.portal.cloudappsecurity.com",
    "credential": {
      "mode": "federated-app",
      "clientId": "00000000-0000-0000-0000-000000000000",
      "managedIdentityClientId": "00000000-0000-0000-0000-000000000000"
    }
  }
]
```

The example values are placeholders. Use the exact portal shown by the tenant.
The sanitizer accepts only HTTPS roots matching the documented two-label tenant
and region form under `portal.cloudappsecurity.com`. Credentials, explicit
ports, paths, query strings, fragments, the global portal, alternate suffixes,
and duplicated tenant/portal boundaries are rejected. `environment` is only a
local aggregate label; it is not sent to MDCA.

| Environment variable                     | Default                |
| ---------------------------------------- | ---------------------- |
| `DEFENDER_CLOUD_APPS_SOURCES_JSON`       | unset                  |
| `DEFENDER_CLOUD_APPS_TENANT_ID`          | unset                  |
| `DEFENDER_CLOUD_APPS_ENVIRONMENT`        | unset                  |
| `DEFENDER_CLOUD_APPS_API_BASE_URL`       | unset                  |
| `DEFENDER_CLOUD_APPS_PORTAL_HOSTNAME`    | unset                  |
| `DEFENDER_CLOUD_APPS_LOOKBACK_HOURS`     | 24                     |
| `DEFENDER_CLOUD_APPS_PAGE_SIZE`          | 100                    |
| `DEFENDER_CLOUD_APPS_MAX_PAGES`          | 20 per resource family |
| `DEFENDER_CLOUD_APPS_MAX_ITEMS`          | 4000                   |
| `DEFENDER_CLOUD_APPS_REQUEST_TIMEOUT_MS` | 15000                  |
| `DEFENDER_CLOUD_APPS_MAX_RETRIES`        | 2                      |
| `DEFENDER_CLOUD_APPS_MAX_RETRY_AFTER_MS` | 30000                  |
| `DEFENDER_CLOUD_APPS_MAX_RESPONSE_BYTES` | 2000000                |

One to 50 unique tenants are accepted. Sources and alerts/activities are read
sequentially. Page count is aggregate across both lists for a source; item count
is aggregate across both lists and every source. Any `hasNext` at a configured
maximum fails with `bounds`; no complete snapshot is silently truncated.
Only throttling status 429 is retried, and only with a valid bounded
`Retry-After`.

`credential.mode=default` uses `DefaultAzureCredential` bound to the source
tenant. `federated-app` reuses the secretless managed-identity assertion
pattern. No client-secret or legacy-token field is accepted.

## Privacy and evidence semantics

Before any provider record reaches the domain snapshot, additive fields are
stripped and only the bounded allowlist is retained. The connector never
persists or logs provider bodies, alert titles/descriptions/evidence, activity
descriptions/raw audits, usernames, UPNs/email, IPs, locations, device/session
IDs, file names/URLs, or entity labels.

Each retained record becomes a standalone `control` node with one evidence
record. IDs are deterministic SHA-256-derived source namespaces. There are no
edges and no attachment to agent nodes: MDCA exposes no supported
agent-specific correlation key, so names, users, IPs, or app display names are
never used as joins. Confidence `1` means only that MDCA directly returned the
record; summaries explicitly say the evidence is unattributed. No trust,
runtime, health, or remediation outcome is inferred.

## Failure and activation behavior

Stable health reasons are `authentication`, `authorization`, `license-required`
when a supported contract can identify it, `not-available`, `bounds`,
`timeout`, `malformed-response`, `network`, or `request-failed:<status>`.
Current list contracts do not document a reliable license-specific error body,
so 403 maps to authorization-required and 404 maps to unavailable without
inspecting private error narratives. Authentication, authorization, and any
reliably identified license requirement map to `authorization-required`.

Composition order is Foundry → Entra → Power Platform → Agent 365 → MDCA.
Disabled mode returns the exact base connector. Any enabled authoritative MDCA
source failure marks the snapshot partial; jobs return successful base/other
additions for diagnosis but refuse snapshot persistence and finding
reconciliation. The connector delegates existing base execute behavior and
adds no MDCA write path.

Activation requires a separate approval for licensing/API availability, exact
tenant portal URLs, target-tenant application consent, and the existing
secretless credential. Do not enable the gate until a bounded connection test
and privacy review pass.
