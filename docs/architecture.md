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

| Resource        | Ingress Type | Accessible From         | Notes                                |
|-----------------|-------------|-------------------------|--------------------------------------|
| web-as-260814   | external:true | VNet (App Gateway)    | Port 80; App Gateway terminates HTTP |
| api-as-260814   | external:false | ACA env only          | Only reachable via nginx proxy       |
| jobs-as-260814  | none         | Not reachable           | SB-triggered jobs only               |
| Cosmos DB       | Private EP   | VNet private-endpoints subnet | No public access                |
| PostgreSQL      | Delegated subnet | VNet database subnet  | No public access                     |
| AI Search       | Private EP   | VNet private-endpoints subnet | No public access                |
| Service Bus     | Private EP   | VNet private-endpoints subnet | No public access                |
| Key Vault       | Private EP   | VNet private-endpoints subnet | No public access                |
| ACR             | Private EP   | VNet private-endpoints subnet | publicNetworkAccess: Disabled    |

## VNet Subnets (10.0.0.0/16)

| Subnet           | CIDR          | Purpose                          |
|------------------|---------------|----------------------------------|
| apps             | 10.0.0.0/23   | ACA environment (delegated)      |
| private-endpoints | 10.0.2.0/24  | Private endpoints for PaaS       |
| database         | 10.0.3.0/24   | PostgreSQL Flexible Server       |
| integration      | 10.0.4.0/24   | Reserved for future integrations |
| appgw            | 10.0.5.0/24   | Application Gateway WAF v2       |

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
- **@agent-sentinel/connector-sdk** ? Connector base abstractions
- **@agent-sentinel/scenarios** ? Scenario fixtures

## Security

- All inter-service communication uses Managed Identity (UAMI)
- No local auth / connection strings stored in code
- Key Vault (Premium) for secrets at rest
- Private Endpoints for all PaaS services
- VNet integration for ACA (internal environment)
- **API Container App uses internal-only ingress** ? unreachable from internet or VNet directly
- WAF v2 in Prevention mode (OWASP 3.2 + Bot Manager) on public entry point

## Next Steps

1. **Custom domain + TLS (Immediate priority):** Obtain a domain name, provision a TLS certificate in Key Vault, configure an HTTPS listener on App Gateway, and update the HTTP listener to redirect to HTTPS. Until this is done, the public endpoint is HTTP-only.
2. **Front Door investigation:** Open a Microsoft support case for `fd-as-260814` `deploymentStatus: NotStarted` for ACA private-link origins in `koreacentral`. If resolved, migrate production traffic back to Front Door (global CDN + DDoS).
3. **HTTPS-only policy:** After TLS is configured, add an App Gateway rewrite rule to enforce HTTPS.
