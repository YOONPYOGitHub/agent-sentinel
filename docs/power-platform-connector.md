# Power Platform ResourceQuery connector

**Implementation status:** complete on `feature/production-readiness-r1`; disabled and
not activated in the live deployment. The Copilot Studio resource schema is
preview overall, and Microsoft does not currently document a supported
unattended authorization path for ResourceQuery inventory.

## Evidence boundary

The read-only `@agent-sentinel/power-platform-connector` inventories Copilot Studio and Microsoft 365 Copilot Agent Builder agents through the official Power Platform API:

- `POST https://api.powerplatform.com/resourcequery/resources/query?api-version=2024-10-01`
- token scope `https://api.powerplatform.com/.default`
- fixed `PowerPlatformResources` query with
  `type == 'microsoft.copilotstudio/agents'` and the configured
  `properties.environmentId` boundary

Callers cannot supply KQL, clauses, hosts, paths, or query parameters. The connector consumes only bounded core inventory fields. It does not scrape web pages or call private APIs. Preview connector, channel, and authentication details are not treated as authoritative findings.

Each record becomes one authoritative agent node and one live evidence record at confidence 1. Identity IDs returned by ResourceQuery remain metadata only. The connector never infers tools, trust, entitlements, runtime behavior, correlations, or `RUNS_AS` edges.

## Authorization

The supported inventory contract currently uses delegated Power Platform API
permission `ResourceQuery.Resources.Read` plus a supported Microsoft Entra role.
For agent-only inventory, **AI Reader** is the least-privileged listed role.

Power Platform RBAC is preview, its current built-in roles are tenant-scoped,
and Microsoft explicitly states that those roles are not supported for Power
Platform inventory access. Consequently, **Power Platform Reader does not
authorize this connector's ResourceQuery inventory call**. A request-body
environment filter limits returned records but is not an authorization
boundary.

See the official
[inventory access requirements](https://learn.microsoft.com/power-platform/admin/power-platform-inventory#access-requirements),
[permission reference](https://learn.microsoft.com/power-platform/admin/programmability-permission-reference),
and
[Power Platform RBAC limitations](https://learn.microsoft.com/power-platform/admin/security/role-based-access-control).
This repository creates no Power Platform role assignment and must not use the
legacy over-privileged `New-PowerAppManagementApp` registration as a workaround.

## Configuration

`POWER_PLATFORM_CONNECTOR_ENABLED=false` is the default. When enabled, configure either `POWER_PLATFORM_SOURCES_JSON` or both legacy primary values:

```json
[
  {
    "id": "studio-production",
    "name": "Studio production",
    "tenantId": "00000000-0000-4000-8000-000000000000",
    "environment": "environment-id",
    "credential": {
      "mode": "federated-app",
      "clientId": "00000000-0000-4000-8000-000000000000",
      "managedIdentityClientId": "00000000-0000-4000-8000-000000000000"
    }
  }
]
```

Source IDs are independent of Foundry project IDs. `credential` is optional and defaults to secretless `DefaultAzureCredential`; `federated-app` uses a managed-identity token-exchange assertion. Up to 50 unique tenant/environment sources are accepted.

| Setting                                                   |                                               Default |
| --------------------------------------------------------- | ----------------------------------------------------: |
| `POWER_PLATFORM_API_BASE_URL`                             | `https://api.powerplatform.com` (only accepted value) |
| `POWER_PLATFORM_TENANT_ID` / `POWER_PLATFORM_ENVIRONMENT` |                           unset legacy primary source |
| `POWER_PLATFORM_PAGE_SIZE`                                |                                                   100 |
| `POWER_PLATFORM_MAX_PAGES`                                |                                                    20 |
| `POWER_PLATFORM_MAX_ITEMS`                                |                                                  5000 |
| `POWER_PLATFORM_REQUEST_TIMEOUT_MS`                       |                                                 15000 |
| `POWER_PLATFORM_MAX_RETRIES`                              |                                                     2 |
| `POWER_PLATFORM_MAX_RETRY_AFTER_MS`                       |                                                 30000 |
| `POWER_PLATFORM_MAX_RESPONSE_BYTES`                       |                                               2000000 |

## Failure and composition behavior

Only `429`, `500`, `502`, `503`, and `504` are retryable, and only with a valid bounded `Retry-After`. Timeouts, response bytes, pages, items, page size, and continuation tokens are bounded. ResourceQuery's `resultTruncated=0` continues only with a new bounded skip token; `resultTruncated=1` completes the query. Source health IDs use `power-platform:<source-id>` with role `discovery` and sanitized reasons.

Composition order is Foundry, then Entra, then Power Platform. This prevents Power Platform identity metadata from creating accidental Entra correlations. Successful source snapshots retain connector, source name, tenant, environment, environment ID, resource type, and provider object provenance under the base estate boundary. Any enabled source failure makes health partial; jobs returns the usable snapshot but refuses persistence and reconciliation.

## Activation checklist

1. Wait for Microsoft to document production-supported app-only inventory
   authorization.
2. Confirm that the supported authorization can enforce the intended tenant and
   environment boundary; a query filter alone is insufficient.
3. Configure all intended source boundaries and secretless credentials.
4. Run connection and bounded inventory validation without changing source
   resources.
5. Review per-source health and provenance.
6. Enable through a separately reviewed Container Apps configuration change.

Delegated operator validation may use `ResourceQuery.Resources.Read` and AI
Reader with a one-record, fixed-type, fixed-environment query, but it does not
prove that the unattended Agent Sentinel runtime is authorized. No live
activation has occurred.
