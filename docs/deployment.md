# Agent Sentinel ? Deployment Guide

## Prerequisites

- Azure CLI >= 2.65 with Bicep extension
- Access to RG `rg-agent-sentinel` in `koreacentral`
- Contributor + RBAC Administrator role on the RG

## Current deployment safety

The checked-in full `platform.bicep` desired state is drifted from the live resource group. The latest
what-if proposed 54 unrelated modifications. **Do not run a full Bicep deployment** until that drift
is reconciled and separately reviewed. Images `web/api/jobs:acbb483` were verified in ACR by CI run
`33047446078`; the live ACA revision remains `8179785` because the surgical update was interrupted.
Use only a reviewed, surgical Container Apps revision/image/config update for the next auth stage.

## Infrastructure Deployment (reference only while drift is unresolved)

### Phase A ? Foundation (Network, Identity, Observability, KV, ACR)

```bash
az deployment group create \
  --mode Incremental \
  --resource-group rg-agent-sentinel \
  --template-file infra/platform.bicep \
  --parameters infra/environments/dev.parameters.bicepparam \
  --name "platform-$(date +%Y%m%d%H%M%S)"
```

### Phase B ? Data (Cosmos, PostgreSQL, Search, Service Bus)

Same command ? Bicep is idempotent for Incremental mode.

Cosmos includes the dedicated `manifest-ingestions` container with `/tenantId` partitioning and a
unique key across `/manifestId` plus `/envelope/producedAt`. Set
`COSMOS_MANIFEST_INGESTIONS_CONTAINER=manifest-ingestions` on API and jobs. Provision this container
before deploying a jobs image that lists authenticated manifest versions.

For multi-project Foundry discovery, set `agentSentinelTenantId` and
`agentSentinelEnvironment` as stable aggregate persistence boundaries and pass
`foundrySourcesJson`. Keep the existing project as source id `primary` to
preserve current identifiers. Each cross-tenant source needs a target-tenant
app registration with workload identity federation and project-scoped
`Azure AI User`; no client secret is stored in Container Apps.

Set `entraSourcesJson` with entries whose ids and tenant/environment boundaries
exactly match `foundrySourcesJson`. Cross-tenant entries use the same
managed-identity federation pattern and require target-tenant
`Application.Read.All` admin consent. Keep `entraConnectorEnabled=false` until
every intended source is authorized and the bounded Graph inventory probe is
approved.

Power Platform ResourceQuery inventory is separately disabled by
`powerPlatformConnectorEnabled=false`. Configure `powerPlatformSourcesJson` with
independent source IDs, or the legacy `powerPlatformTenantId` and
`powerPlatformEnvironment` pair. The only allowed base is
`https://api.powerplatform.com`; paging, item count, retries, timeout, and
response bytes are bounded by the corresponding `powerPlatform*` parameters.
Do not enable it or add an IaC role assignment until **Power Platform Reader**
(or an approved least-privilege ResourceQuery read RBAC role) is approved at
the intended tenant scope. See [Power Platform connector](power-platform-connector.md).

Microsoft Agent 365 package catalog inventory is independently disabled by
`agent365ConnectorEnabled=false`. Configure `agent365SourcesJson`, or the legacy
`agent365TenantId` and `agent365Environment` pair. The only accepted base is
`https://graph.microsoft.com`; all requests use the fixed v1.0 list endpoint and
bounded continuation links. Do not enable it until the tenant has a Microsoft
Agent 365 license and tenant-admin `CopilotPackages.Read.All` **application**
consent. The Bicep parameters only inject disabled configuration: they do not
grant a Graph app role, assign a license, or create tenant resources. See
[Agent 365 connector](agent365-connector.md).

Microsoft Defender for Cloud Apps evidence is independently disabled by
`defenderCloudAppsConnectorEnabled=false`. Configure
`defenderCloudAppsSourcesJson`, or the legacy tenant/environment and exact
tenant portal URL values. The IaC only injects gated, empty-by-default
configuration; it creates no permission, app role, token, secret, license, or
M365 resource. Do not enable until `Investigation.Read` application consent,
licensing/API availability, exact portal URLs, and the secretless credential
are separately approved. See
[Defender for Cloud Apps connector](defender-cloud-apps-connector.md).

Microsoft Purview sensitivity-label catalog evidence is independently disabled
by `purviewConnectorEnabled=false`. Configure `purviewSourcesJson`, or the
legacy `purviewTenantId` and `purviewEnvironment` pair. The Graph base is fixed
to `https://graph.microsoft.com`, and source identifiers are injected as empty
while disabled. IaC creates no Graph app-role assignment, permission, secret,
label, or M365 resource. Enable only after tenant-admin
`SensitivityLabel.Read` application consent and secretless credentials are
separately approved for every source. See
[Purview connector](purview-connector.md).

Set `azureMonitorSourcesJson` with entries matching Foundry source ids. Each
entry contains a workspace customer id, source tenant, source environment, and
optional federated credential. `azureMonitorConnectorEnabled` remains false
until the application UAMI has an approved read-only workspace query role and
the target agents emit validated `agent.sentinel.tenant_id`,
`gen_ai.agent.id`, and `deployment.environment.name` attributes.

### Phase C ? Foundry Embedding

Add text-embedding-3-large deployment (only this module touches AIServices).

### Phase D ? Container Apps + Application Gateway

After ACR is provisioned and images are pushed. The platform.bicep deploys:

- Container Apps (API with internal ingress, web with VNet-accessible ingress, jobs with no ingress)
- Application Gateway WAF v2 (`appgw-as-260814`) as the public edge

### Phase E ? Front Door (Active)

`fd-as-260814` routes both the web and API over its default HTTPS hostname.
See [Architecture: Azure Front Door Status](architecture.md#azure-front-door-status).

## Container Image Build and Push

The ACR (`acr260814`) has `publicNetworkAccess: Disabled` with private endpoint.
Use `az acr build` (ACR Tasks) which requires the `networkRuleBypassOptions: AzureServices` setting.
For initial bootstrapping, temporarily enable public access:

```bash
# Temporarily enable public access for push
az acr update -g rg-agent-sentinel -n acr260814 --public-network-enabled true

# Build and push with immutable git SHA tag
GIT_SHA=$(git rev-parse --short HEAD)
az acr build --registry acr260814 \
  --image agent-sentinel-web:${GIT_SHA} \
  --file apps/web/Containerfile .

az acr build --registry acr260814 \
  --image agent-sentinel-api:${GIT_SHA} \
  --file apps/api/Containerfile .

# Restore private access
az acr update -g rg-agent-sentinel -n acr260814 --public-network-enabled false

# Update parameter file with new tag
sed -i "s/param imageTag = .*/param imageTag = '${GIT_SHA}'/" infra/environments/dev.parameters.bicepparam
```

## What-if Before Deployment

Always run what-if first:

```bash
az deployment group what-if \
  --mode Incremental \
  --resource-group rg-agent-sentinel \
  --template-file infra/platform.bicep \
  --parameters infra/environments/dev.parameters.bicepparam
```

**Stop if what-if shows:**

- `Delete` on Foundry resources
- `Delete` on any existing subnet (only adds are expected)
- `Delete` on `fd-as-260814` (primary Front Door profile)

## Application Gateway Smoke Test

After deployment, verify the App Gateway endpoint:

```bash
# Get public IP
AG_IP=$(az network public-ip show -g rg-agent-sentinel -n pip-appgw-as-260814 \
  --query ipAddress -o tsv)

# Test root (SPA)
curl -sI "http://${AG_IP}/" | grep "HTTP/"
# Expected: HTTP/1.1 200 OK

# Test health probe path
curl -s "http://${AG_IP}/health"
# Expected: ok

# Test API proxy path
curl -s "http://${AG_IP}/api/connector/status"
# Expected: JSON response from API (not a network error)

# Verify API is NOT publicly reachable directly
API_FQDN=$(az containerapp show -g rg-agent-sentinel -n api-as-260814 \
  --query 'properties.configuration.ingress.fqdn' -o tsv)
echo "API FQDN: ${API_FQDN}"
# If external:false, FQDN should contain .internal. and resolve to internal IP only
```

## Authentication deployment stages

Identity activation is configuration-driven; do not edit Container Apps directly in the portal.
The Bicep defaults and checked-in development parameters remain fail-closed at
`authMode = 'disabled'` and `agentSentinelWriteEnabled = false`. The live environment was activated
through a reviewed surgical revision with JWT values while the drifted full template remains
blocked. Any reconciled deployment requires the following approved inputs:

- `authTenantId`, `authAudience`, and optional explicit `authIssuer` / `authJwksUri`
- `authSpaClientId`, `authSpaScopes`, `authSpaRedirectUri`, and
  `authSpaPostLogoutRedirectUri`
- exact `authReadScopes` and `authWriteScopes`

The active Front Door default HTTPS hostname passed the required route, origin-health, and SPA/API
smoke checks and is registered as the exact SPA redirect/logout origin. The Application Gateway is
still HTTP-only and must not be used for authentication. A custom domain is separate hardening.

Deployment order:

1. Preserve the deployed JWT values, exact redirect/logout registration, write-disabled switch, and WAF block.
2. Reconcile the live values into a reviewed deployment input without applying unrelated what-if changes.
3. Run the read phase in [security-authentication.md](security-authentication.md) after every revision.
4. After separate approval, enable writes only for a private authenticated reversible test.
5. Narrow the WAF separately, then run the complete public-edge validation and anonymous denial
   test.

Rollback restores the mutation block first, then writes false, then the last known-good Container
Apps revision. See RB-011 and RB-012 in [runbooks.md](runbooks.md).

## Never Deploy If

- What-if shows Delete/Modify on existing AIServices account, project, or model deployments
- What-if shows Delete on existing subnets
- What-if shows Delete on `fd-as-260814`
- App Gateway backend health probe fails after deploy (check AG backend health)
- What-if shows Delete on `aca-env-260814` or `web-as-260814` or `api-as-260814`

## TLS / Custom Domain Next Steps

The active Front Door default hostname already provides HTTPS and is the registered bounded auth
origin. The App Gateway endpoint remains HTTP-only. For an approved custom production domain:

1. Register a domain or use an existing one
2. Create a PFX/PEM certificate and store in Key Vault
3. Add an `applicationGatewayUserAssignedIdentity` for KV secret access
4. Add `sslCertificates` section to `application-gateway.bicep` pointing to the KV certificate
5. Add an HTTPS listener (port 443) and SSL termination
6. Add an HTTP ? HTTPS redirect rule
7. Update NSG to allow port 443 inbound on the `appgw` subnet

Until then, use Front Door HTTPS for the application; the HTTP App Gateway endpoint remains suitable only for bounded diagnostics.
