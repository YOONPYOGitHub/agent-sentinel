# Power Platform ResourceQuery connector

**Implementation status:** complete on `feature/multi-source-otel`; disabled and not activated in the live deployment. The Copilot Studio resource schema is preview overall.

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

Service-principal access uses Power Platform RBAC, not a Microsoft Graph application permission. Each intended tenant scope requires **Power Platform Reader**, or an approved least-privilege ResourceQuery read RBAC role. This repository creates no role assignment. Activation must remain off until the scope and assignment receive separate approval.

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

1. Obtain approval for the exact tenant scope and least-privilege read role.
2. Configure all intended source boundaries and secretless credentials.
3. Run connection and bounded inventory validation without changing source resources.
4. Review per-source health and provenance.
5. Enable through a separately reviewed Container Apps configuration change.

No live activation has occurred.
