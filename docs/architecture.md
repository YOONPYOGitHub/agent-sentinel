# Agent Sentinel ? Architecture

## Overview

Agent Sentinel is a platform for discovering, mapping, and remediating AI agent exposure in enterprise environments. It consists of a React SPA (web), a Fastify REST API (api), and a background job worker (jobs) running on Azure Container Apps in a fully private internal VNet environment.

## Public Endpoint

**Active public edge: Application Gateway WAF v2** (`appgw-as-260814` in `koreacentral`)

> **? TLS LIMITATION (Temporary):** The current public listener is **HTTP on port 80** only. No custom domain certificate is configured. This is an explicitly temporary smoke-test endpoint. Production use requires a custom domain + TLS certificate (see [Next Steps](#next-steps)).

```
Internet (HTTP/80)
    ?
    ?
????????????????????????????????????????????????????
?  Application Gateway WAF v2 (appgw-as-260814)    ?
?  Public IP: pip-appgw-as-260814 (Standard, zone- ?
?  redundant 1/2/3, koreacentral)                  ?
?  WAF Policy: waf-appgw-as-260814                 ?
?  OWASP 3.2 + Bot Manager 1.0, Prevention mode    ?
?  Autoscale: min 1 / max 3                        ?
?  Backend pool: web-as-260814 FQDN only           ?
?  API is NOT in any backend pool                  ?
????????????????????????????????????????????????????
                        ? HTTP:80 (Host: web FQDN)
                        ?
              ????????????????????
              ? ACA Environment  ?  internal=true, VNet-integrated
              ? aca-env-260814   ?  subnet: 10.0.0.0/23 (apps)
              ?                  ?  staticIp: 10.0.0.174
              ????????????????????
                       ?
        ???????????????????????????????????
        ?                                 ?
??????????????????????                   ? (no direct access)
?  web-as-260814     ?  external: true   ?
?  nginx + React SPA ?  (VNet-visible)   ?
?  port: 80          ?                   ?
?  /api/* ? proxy   ?????????????????????? http://api-as-260814
??????????????????????                   ? (ACA service discovery)
                                         ?
                                ???????????????????????
                                ?  api-as-260814       ?
                                ?  Fastify REST API    ?
                                ?  external: false     ?
                                ?  (env-internal only) ?
                                ?  port: 3001          ?
                                ???????????????????????
                                           ?
            ?????????????????????????????????????????????????????????
            ?                              ?                         ?
  ?????????????????????        ????????????????????    ????????????????????????
  ?  Cosmos DB        ?        ?  PostgreSQL       ?    ?  AI Search (S1)      ?
  ?  (private EP)     ?        ?  (private subnet) ?    ?  (private EP)        ?
  ?????????????????????        ????????????????????    ????????????????????????

  ??????????????????????????????????????????????????????????????????????????
  ?  jobs-as-260814  (no ingress, Service Bus-triggered, min replicas: 0) ?
  ??????????????????????????????????????????????????????????????????????????
```

## Network Boundary Enforcement

| Resource       | Ingress Type     | Accessible From               | Notes                                |
| -------------- | ---------------- | ----------------------------- | ------------------------------------ |
| web-as-260814  | external:true    | VNet (App Gateway)            | Port 80; App Gateway terminates HTTP |
| api-as-260814  | external:false   | ACA env only                  | Only reachable via nginx proxy       |
| jobs-as-260814 | none             | Not reachable                 | SB-triggered jobs only               |
| Cosmos DB      | Private EP       | VNet private-endpoints subnet | No public access                     |
| PostgreSQL     | Delegated subnet | VNet database subnet          | No public access                     |
| AI Search      | Private EP       | VNet private-endpoints subnet | No public access                     |
| Service Bus    | Private EP       | VNet private-endpoints subnet | No public access                     |
| Key Vault      | Private EP       | VNet private-endpoints subnet | No public access                     |
| ACR            | Private EP       | VNet private-endpoints subnet | publicNetworkAccess: Disabled        |

## VNet Subnets (10.0.0.0/16)

| Subnet            | CIDR        | Purpose                          |
| ----------------- | ----------- | -------------------------------- |
| apps              | 10.0.0.0/23 | ACA environment (delegated)      |
| private-endpoints | 10.0.2.0/24 | Private endpoints for PaaS       |
| database          | 10.0.3.0/24 | PostgreSQL Flexible Server       |
| integration       | 10.0.4.0/24 | Reserved for future integrations |
| appgw             | 10.0.5.0/24 | Application Gateway WAF v2       |

## Azure Front Door Status

**Primary profile `fd-as-260814` is preserved but NOT routing production traffic.**

Known issue: Azure Front Door Premium private-link origins consistently show `deploymentStatus: NotStarted` for ACA environments in `koreacentral`. The origins never reach `Approved` state, making the premium Private Link routing path non-functional.

Evidence:

- Profile: `fd-as-260814` (Premium_AzureFrontDoor)
- Both `og-api` and `og-web` origin groups fail to activate private links
- This is a platform-level issue; no code or policy change resolves it

**Resolution:** App Gateway WAF v2 is used as the working regional public entry point while `fd-as-260814` is retained for a future support investigation with Microsoft.

Temporary diagnostic profile `fd-as-260814-v2` was deleted after App Gateway validation.

## Nginx Reverse Proxy (web-as-260814)

The web container runs nginx which:

1. Serves the React SPA for all non-`/api/` and non-`/health` paths
2. Reverse-proxies `/api/*` to `http://api-as-260814` (ACA same-environment service discovery)
3. Exposes `/health` ? HTTP 200 (used by App Gateway health probe)

The API container is never directly addressable from the public internet or from the VNet; the only path is `AppGW ? web nginx ? api`.

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
