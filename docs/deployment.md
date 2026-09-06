# Agent Sentinel ? Deployment Guide

## Prerequisites

- Azure CLI >= 2.65 with Bicep extension
- Access to RG `rg-agent-sentinel` in `koreacentral`
- Contributor + RBAC Administrator role on the RG

## Current deployment safety

The last evidenced deployed web/API/jobs image boundary is the short tag
`7458b3e`. Its full 40-hex SHA and three running image digests have not been
supplied in sanitized evidence, so later commits are code state only and this
guide does not claim them as deployed. The checked-in full `platform.bicep`
desired state is drifted from the live resource group. The latest what-if
proposed 54 unrelated modifications. **Do not run a full Bicep deployment**
until that drift is reconciled and separately reviewed. Use only a reviewed,
surgical Container Apps revision/image/config update for the next auth stage.

## Replacement tenant portability

The existing development environment deliberately pins its historical application,
connector, Teams, and Foundry resource names in
`infra/environments/dev.parameters.bicepparam`. These overrides prevent an
incremental deployment from replacing identities whose names predate the current
suffix.

For a replacement tenant, create a separate environment parameter file and:

1. Set a new, unique `suffix`.
2. Do not copy `applicationIdentityName`, `connectorIdentityName`,
   `teamsIdentityName`, or `foundryAccountName` from the development file unless
   adopting resources that already exist under those exact names. Empty values
   derive new names from `suffix`.
3. Set tenant-specific authentication and connector source identifiers. Keep each
   license- or consent-gated connector disabled until its documented prerequisite
   is verified in the replacement tenant.
4. Build one immutable web image. The web Container App injects
   `API_UPSTREAM=api-as-<suffix>` at runtime, so the image does not need to be
   rebuilt for a different API Container App name.
5. Deploy `infra/ci-foundation.bicep` with the same suffix if a private build
   runner is required; its identity name is derived from that suffix.
6. Run a complete what-if against the new resource group and review all role
   assignments before creation. The current development resource group's
   unresolved drift prohibition does not transfer to an empty replacement
   resource group.

This is a clean IaC recreation, not an in-place tenant migration. Do not copy
tenant IDs, principal IDs, federated credentials, Graph consent, or license state
from the existing tenant.

The Data AI Lab replacement tenant is represented by two checked-in, non-secret
parameter files:

- `infra/environments/mngenvmcap098047-foundry.parameters.bicepparam` creates the
  tenant-local Foundry account and project first.
- `infra/environments/mngenvmcap098047.parameters.bicepparam` describes the
  platform with a new suffix and tenant boundary. Writes and authentication
  remain disabled; its explicitly enabled read connectors require the separate
  permissions and validation described below.

Do not run either deployment from an Azure CLI context that still targets the
historical tenant. Confirm the exact tenant, subscription, and account first.
The platform parameter file intentionally contains no subscription ID because
the target subscription is selected by the deployment command.

The API and SPA registrations are also recreated, not transferred. Create both
as single-tenant applications in the replacement tenant after the new Front Door
HTTPS origin is known. Preserve the exact scopes and roles from
`security-authentication.md`, register the new origin on the SPA only, and inject
the new IDs through the `auth*` parameters. Keep `authMode = 'disabled'` and
`agentSentinelWriteEnabled = false` until the replacement registration and
read-only sign-in checks pass.

Foundry agents are workload data and are not created by Bicep. After the
replacement project and its manifest-referenced model deployments are ready,
grant the provisioning operator `Foundry User` on that project and run:

```bash
FOUNDRY_PROJECT_ENDPOINT='https://ais-agent-sentinel-m098047.services.ai.azure.com/api/projects/agent-sentinel-pjt' \
  pnpm foundry:provision
```

This creates only the six current repository-managed synthetic definitions.
Do not migrate historical version IDs, agent identity IDs, or unreferenced
experimental models from the old tenant. Confirm jobs persists a six-agent
snapshot before treating the replacement application as functionally ready.

The replacement environment enables Azure Resource Graph and Azure Monitor after
their resource-scoped RBAC exists. It also enables bounded Entra service
principal, Purview sensitivity-label, and Teams organization-catalog reads only
after their exact replacement-tenant application permissions are assigned to
the three separate managed identities. Defender for Cloud Apps is enabled only
after Defender XDR tenant provisioning, exact About-page API discovery, and its
separately approved application role. Owners, app-role enrichment, preview Agent
Identity APIs, Agent 365, Power Platform, authentication, and writes remain
disabled. Historical app-role assignments never transfer to the new managed
identities.

The latest replacement validation on **2026-09-01 14:23 KST** reports all seven
configured read sources as `ready`: Foundry, Entra, Defender for Cloud Apps,
Purview, Azure Resource Graph, Teams organization catalog, and Azure Monitor
OTel. The Defender and Teams reads are valid-empty: zero returned records do not
prove agent attribution, installation, distribution, trust, or broader
coverage. Agent 365 is intentionally excluded. Power Platform, manifest
ingestion, and business outcomes are not activation omissions: they remain
blocked by, respectively, unsupported unattended authorization, the write/auth
safety gate, and absence of an authoritative source.

## Infrastructure Deployment (reference only while drift is unresolved)

### Phase A ? Foundation (Network, Identity, Observability, KV, ACR)

Set `WEB_IMAGE_DIGEST`, `API_IMAGE_DIGEST`, and `JOBS_IMAGE_DIGEST` to the
canonical digests verified in the private ACR before compiling a checked-in
`.bicepparam` file or running this reference command.

```bash
az deployment group create \
  --mode Incremental \
  --resource-group rg-agent-sentinel \
  --template-file infra/platform.bicep \
  --parameters infra/environments/dev.parameters.bicepparam \
  --parameters webImageDigest="${WEB_IMAGE_DIGEST}" \
  --parameters apiImageDigest="${API_IMAGE_DIGEST}" \
  --parameters jobsImageDigest="${JOBS_IMAGE_DIGEST}" \
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
Do not enable it or add an IaC role assignment while Microsoft documents only
delegated `ResourceQuery.Resources.Read` plus a supported Entra role for
inventory. Preview Power Platform RBAC roles, including Power Platform Reader,
are explicitly unsupported for inventory access, and an environment query
filter is not an authorization boundary. See
[Power Platform connector](power-platform-connector.md).

Microsoft Agent 365 package catalog inventory is independently disabled by
`agent365ConnectorEnabled=false`. Configure `agent365SourcesJson`, or the legacy
`agent365TenantId` and `agent365Environment` pair. The only accepted base is
`https://graph.microsoft.com`; all requests use the fixed v1.0 list endpoint and
bounded continuation links. Do not enable it until the tenant has a Microsoft
Agent 365 license and tenant-admin `CopilotPackages.Read.All` **application**
consent. The Bicep parameters only inject disabled configuration: they do not
grant a Graph app role, assign a license, or create tenant resources. See
[Agent 365 connector](agent365-connector.md).

Microsoft Defender for Cloud Apps evidence remains independently default-disabled
by `defenderCloudAppsConnectorEnabled=false`. Configure
`defenderCloudAppsSourcesJson`, or the legacy tenant/environment and exact
tenant portal URL values. The replacement environment enables its approved
source with the exact About-page hostname and connector UAMI. The IaC creates no
permission, app role, token, secret, license, or M365 resource. Do not enable
another source until `Investigation.Read` application consent, licensing/API
availability, exact portal URL, and the secretless credential are separately
approved. See
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

Microsoft Teams tenant app catalog evidence is disabled by default through
`teamsDistributionConnectorEnabled=false`. Configure
`teamsDistributionSourcesJson`, or the legacy `teamsDistributionTenantId` and
`teamsDistributionEnvironment` pair. The Graph base is fixed to
`https://graph.microsoft.com`, and source identifiers are injected as empty
while disabled. IaC creates no Graph app-role assignment, permission, secret,
Teams app, or Microsoft 365 resource. The replacement primary source is enabled
on API/jobs after approval of tenant-admin `AppCatalog.Read.All` and its
secretless credential. Its **2026-09-01 14:23 KST** result is `ready` and
valid-empty with zero organization catalog entries. Enable any additional
source only after the same approvals. This reads organization catalog metadata
only; it does not prove agent, deployment, installation, sideloading,
distribution, trust, or coverage. See
[Teams distribution connector](teams-distribution-connector.md).

Set `azureMonitorSourcesJson` with entries matching Foundry source ids. Each
entry contains a workspace customer id, source tenant, source environment, and
optional federated credential. `azureMonitorConnectorEnabled` remains false
until the application UAMI has an approved read-only workspace query role and
the target agents emit validated `agent.sentinel.tenant_id`,
`gen_ai.agent.id`, and `deployment.environment.name` attributes.

The identity module also declares separate read-only connector and Teams
managed identities. Container Apps attach them only to API/jobs. When Purview
is enabled without explicit source JSON, the deployment generates the primary
tenant source with the connector identity; Teams uses its separate identity.
Microsoft 365 application and directory roles remain tenant-admin operations
documented in the connector runbooks rather than ARM/Bicep assignments.

### Phase C ? Foundry Embedding

Add text-embedding-3-large deployment (only this module touches AIServices).

### Phase D ? Container Apps + Regional Diagnostic Gateway

After ACR is provisioned and images are pushed. The platform.bicep deploys:

- Container Apps (API with internal ingress, web with VNet-accessible ingress, jobs with no ingress)
- Application Gateway WAF v2 (`appgw-as-260814`) as an optional regional
  diagnostic edge

### Phase E ? Front Door (Active)

`fd-as-260814` routes both the web and API over its default HTTPS hostname.
See [Architecture: Azure Front Door Status](architecture.md#azure-front-door-status).

## Container Image Build and Push

The ACR (`acr260814`) has `publicNetworkAccess: Disabled` with private endpoint.
Do not enable public registry access for builds. Use the private self-hosted
runner and `.github/workflows/ci-build-deploy.yml`. A manual dispatch requires
one exact 40-hex commit SHA; the workflow validates and resolves that commit
once, checks out the same resolved SHA for validation, image builds, what-if,
and deployment, and never interpolates the dispatch input directly into a
shell command.

All three images are tagged with the full resolved commit SHA for traceability.
After each push, the workflow resolves the tag through
`az acr repository show` and rejects any result that is not a canonical
`sha256:<64 lowercase hex>` digest. The protected what-if and deployment pass
the three verified component digests as `webImageDigest`, `apiImageDigest`, and
`jobsImageDigest`. Bicep combines only those digests with the private ACR login
server and component repository names, so each Container App revision uses an
immutable `acr260814.azurecr.io/<repository>@sha256:<digest>` reference rather
than a tag.

After deployment, the workflow requires exactly one active revision per
Container App and compares that revision's web, API, or jobs image reference to
the corresponding verified ACR digest. A registry digest alone proves only
what was pushed; this active-revision check binds and verifies what was
deployed. Record live deployment evidence only after the sanitized observation
also supplies the full release SHA, all three running image digests, source,
observation time, scope, and evidence references to the
[release-evidence manifest](release-evidence.md).

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

## Front Door Smoke Test

After deployment, verify the active Front Door endpoint:

```bash
# Resolve the generated endpoint instead of pinning a tenant-specific hostname
FD_HOST=$(az afd endpoint show -g rg-agent-sentinel \
  --profile-name fd-as-260814 \
  --endpoint-name agent-sentinel \
  --query hostName -o tsv)

# Test root (SPA)
curl -sI "https://${FD_HOST}/" | grep "HTTP/"
# Expected: HTTP/2 200

# Test health probe path
curl -s "https://${FD_HOST}/health"
# Expected: ok

# Test API proxy path
curl -s "https://${FD_HOST}/api/connector/status"
# Expected: JSON response from API (not a network error)

# Anonymous mutations must fail closed at WAF or authentication
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST "https://${FD_HOST}/api/demo/reset"
# Expected: 401 or 403

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
- Front Door origin health or any SPA/API smoke route fails after deploy
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
