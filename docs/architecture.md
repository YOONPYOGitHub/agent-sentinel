# Agent Sentinel ? Architecture

## Overview

Agent Sentinel is a platform for discovering, mapping, and remediating AI agent exposure in enterprise environments. It consists of a React SPA (web), a Fastify REST API (api), and a background job worker (jobs) running on Azure Container Apps in a fully private internal VNet environment.

## Public Endpoint

**Active public edge: Azure Front Door Premium** (`fd-as-260814`)

Front Door provides the HTTPS endpoint and WAF boundary. Its private-link
origin is the VNet-visible web Container App; the API remains environment-only
and is reached exclusively through the web nginx proxy. Application Gateway is
a regional HTTP diagnostic edge and may be stopped when it is not needed.

```text
Internet (HTTPS)
    |
Azure Front Door Premium + WAF
    |
Private Link to internal ACA environment
    |
web-as-260814 (nginx + React SPA)
    |
    +-- /api/* --> api-as-260814 (ACA service discovery, no public ingress)

jobs-as-260814 has no ingress and uses private platform services.
```

## Network Boundary Enforcement

| Resource       | Ingress Type     | Accessible From               | Notes                              |
| -------------- | ---------------- | ----------------------------- | ---------------------------------- |
| web-as-260814  | external:true    | Front Door private link, VNet | Port 80 inside the ACA environment |
| api-as-260814  | external:false   | ACA env only                  | Only reachable via nginx proxy     |
| jobs-as-260814 | none             | Not reachable                 | SB-triggered jobs only             |
| Cosmos DB      | Private EP       | VNet private-endpoints subnet | No public access                   |
| PostgreSQL     | Delegated subnet | VNet database subnet          | No public access                   |
| AI Search      | Private EP       | VNet private-endpoints subnet | No public access                   |
| Service Bus    | Private EP       | VNet private-endpoints subnet | No public access                   |
| Key Vault      | Private EP       | VNet private-endpoints subnet | No public access                   |
| ACR            | Private EP       | VNet private-endpoints subnet | publicNetworkAccess: Disabled      |

## VNet Subnets (10.0.0.0/16)

| Subnet            | CIDR        | Purpose                          |
| ----------------- | ----------- | -------------------------------- |
| apps              | 10.0.0.0/23 | ACA environment (delegated)      |
| private-endpoints | 10.0.2.0/24 | Private endpoints for PaaS       |
| database          | 10.0.3.0/24 | PostgreSQL Flexible Server       |
| integration       | 10.0.4.0/24 | Reserved for future integrations |
| appgw             | 10.0.5.0/24 | Application Gateway WAF v2       |

## Azure Front Door Status

**Primary profile `fd-as-260814` is the active HTTPS edge.**

Front Door uses one private-link origin and one `/*` route: the VNet-visible web
Container App. Nginx serves the SPA and proxies `/api/*` to the
environment-only API through ACA service discovery.

Front Door must never target the API Container App directly. Internal ACA
ingress is reachable only by other apps in the same ACA environment; a direct
private-link origin returns `404 Unavailable` even while the API replica is
healthy.

## Nginx Reverse Proxy (web-as-260814)

The web container runs nginx which:

1. Serves the React SPA for all non-`/api/` and non-`/health` paths
2. Reverse-proxies `/api/*` to `http://api-as-260814` (ACA same-environment service discovery)
3. Exposes `/health` as HTTP 200 for edge health probes

The API container is never directly addressable from the public internet or
from the VNet. The supported path is `Front Door -> web nginx -> API`. App
Gateway remains available only as the bounded regional diagnostic edge.

## Packages

- **@agent-sentinel/domain** ? Zod schemas, domain types, repository interfaces
- **@agent-sentinel/persistence** ? Cosmos DB and PostgreSQL repository implementations
- **@agent-sentinel/search** ? AI Search index schema, ingestion, RAG search
- **@agent-sentinel/messaging** ? Service Bus event contracts, idempotency primitives
- **@agent-sentinel/graph-engine** ? Attack path computation
- **@agent-sentinel/policy-engine** ? Policy evaluation
- **@agent-sentinel/connector-sdk** ? Connector base abstractions and the versioned manifest envelope contract
- **@agent-sentinel/scenarios** ? Scenario fixtures
- **@agent-sentinel/manifest-connector** ? Read-only custom manifest validation, normalization, and non-authoritative estate composition
- **@agent-sentinel/azure-monitor-otel-connector** - Read-only Azure Monitor Logs query adapter that strictly maps OTel `AppRequests` rows into tenant/agent/environment/time-bound `ObservationWindow` objects. It performs no ingestion or Azure resource mutation.
- **@agent-sentinel/behavior-engine** - Deterministic behavior-baseline, drift, and measured-only token economics engine (median/MAD statistics, tool-sequence drift, reconciled coverage, evidence-linked cost anomalies). Depends on `@agent-sentinel/domain`. No network I/O, pricing lookup, or LLM.
- **@agent-sentinel/ui** - Shared Agent Sentinel design tokens and typed React primitives for KPI, status, freshness, and data-state presentation. Storybook provides isolated realistic states with accessibility checks.
- **@agent-sentinel/tools** ? Offline developer CLIs (manifest validation)

## Custom Manifest Adapter

The custom manifest adapter ingests agent inventory that no first-party connector covers. It is deliberately the weakest-privilege connector in the system:

```
operator manifest (authenticated API, inline object, or absolute local file)
  -> file-loader        path safety, size cap, regular-file check; no network, no URLs
  -> validator          schema version, strict Zod, action depth, tenant, environment
  -> normalizer         EstateSnapshot + SourceProvenance (sourceOfTruth: false)
  -> manifest-ingestions immutable Cosmos versions, hash idempotency
  -> jobs               latest version per manifest + Foundry snapshot composition
  -> existing graph/policy pipeline
```

Boundaries that hold by construction:

- **Authenticated ingress only.** `POST /api/manifests/ingestions` requires JWT mode, Administrator `configure`, and the deployment write gate. There is no unauthenticated ingestion path.
- **No egress.** Any path containing `://` or a leading `//` is rejected before I/O, so the adapter cannot be steered into an SSRF fetch.
- **No action.** `ManifestConnector` implements discovery and evidence only. It has no `execute()`, and a manifest declaring `supportsActions: 'execute'` is rejected.
- **No authority.** Provenance is pinned to `sourceOfTruth: false` and `isNonAuthoritative: true`. Declared claims are capped at confidence 0.7 (default 0.4) and only rise when the manifest declares deep runtime telemetry.
- **Estate-scoped.** The envelope and every entity environment must match server-controlled estate tenant/environment values. The authenticated token tenant establishes caller identity and may differ from the Azure estate tenant.
- **Availability isolation.** Manifest repository or composition failure degrades only the optional source; jobs still persists the authoritative Foundry snapshot.

## Connector health measurements

Jobs persist the connector health report produced by each completed discovery,
including partial runs whose snapshot is intentionally not promoted. Each
measurement is keyed and queried by estate ID, data tenant, environment, and
connector ID. Cosmos stores immutable timestamped measurements in the snapshots
container under the existing tenant partition and derives document IDs from a
SHA-256 hash of the canonical scope-and-time tuple; the in-memory adapter
follows the same boundary contract for local execution and tests.

In live mode, `GET /api/connectors` reads the latest persisted measurement for
the authorized request estate and active connector. It does not probe providers
on the request path and does not fall back to process-local or synthetic health.
An absent measurement remains unavailable. Runtime telemetry health is omitted
until it has an independently persisted, exact estate-, tenant-, environment-,
and source-scoped measurement; process-local runtime connector state never
enters the live response. Non-default estates also omit default-estate project
endpoints and unscoped business-outcome health.

## Security

- All inter-service communication uses Managed Identity (UAMI)
- No local auth / connection strings stored in code
- Key Vault (Premium) for secrets at rest
- Private Endpoints for all PaaS services
- VNet integration for ACA (internal environment)
- **API Container App uses internal-only ingress** ? unreachable from internet or VNet directly
- WAF v2 in Prevention mode (OWASP 3.2 + Bot Manager) on public entry point

## Token Economics Analysis

The token economics analysis engine (`@agent-sentinel/behavior-engine`) reuses the same MAD-based statistical infrastructure as the drift-analysis engine.

### Evidence boundaries

| Boundary                     | State                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Token economics engine       | Implemented. Deterministic MAD-based analysis, deduplication, coverage tracking.                                  |
| Mock synthetic fixtures      | Three agents (hr-policy-agent, code-review-copilot, sales-research-agent) with healthy/anomaly/no-cost scenarios. |
| GET /api/token-economics/... | Implemented. Mock returns synthetic; foundry returns connector-not-connected.                                     |
| OTel runtime query connector | Implemented. Activates only with complete Azure Monitor configuration and restricted Logs query permission.       |
| Cost mapping                 | Implemented for measured `agent.sentinel.cost.usd`; absent values stay unknown and are never estimated.           |
| Live efficiency scorecard    | Unlocked only when the configured provider returns valid, sufficiently covered measured windows.                  |

### Mode boundaries

- **Mock mode**: Returns deterministic synthetic reports labeled `[SYNTHETIC]`. Includes three agents with measured cost, anomaly, and missing-cost examples.
- **Foundry mode, unconfigured**: Returns typed `connector-not-connected`. Provider failure or invalid rows return typed `unavailable`/`invalid`. Neither path falls back to synthetic data.
- **Unknown agent**: Returns `insufficient-data`, not invented success data.

## Next Steps

1. **Activate Entra identity evidence:** Complete tenant-admin consent and bounded v1.0 inventory validation before enabling the connector.
2. **Reconcile infrastructure drift:** The full Bicep what-if includes unrelated modifications and must not be applied until reviewed against live state.
3. **Custom domain hardening:** Add an approved custom domain/TLS policy when required; the active Front Door default HTTPS origin is sufficient for the current bounded auth validation.
