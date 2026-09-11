# Agent Sentinel ? Runbooks

## RB-001: Check Service Health

```bash
# App Gateway health
AG_IP=$(az network public-ip show -g rg-agent-sentinel -n pip-appgw-as-260814 --query ipAddress -o tsv)
curl -sI "http://${AG_IP}/health"

# App Gateway backend health
az network application-gateway show-backend-health \
  --name appgw-as-260814 \
  --resource-group rg-agent-sentinel \
  --query 'backendAddressPool[].backendHttpSettingsCollection[].servers[].{address:address,health:health}' \
  -o table

# ACA app status
az containerapp show --name web-as-260814 --resource-group rg-agent-sentinel \
  --query 'properties.runningStatus'
az containerapp show --name api-as-260814 --resource-group rg-agent-sentinel \
  --query '{status:properties.runningStatus,external:properties.configuration.ingress.external}'
```

## RB-002: Process Dead-Letter Queue

```bash
# List DLQ messages
az servicebus queue show --name findings-validation \
  --namespace-name sb-as-260814 \
  --resource-group rg-agent-sentinel \
  --query 'countDetails.deadLetterMessageCount'
```

## RB-003: Rotate Secrets

All secrets are stored in Key Vault `kv-as-260814`.

1. Generate new secret version in KV
2. ACA apps will pick up new version within 10 minutes (Key Vault reference refresh)
3. Verify app health after rotation

## RB-004: Scale ACA Apps

```bash
az containerapp update \
  --name api-as-260814 \
  --resource-group rg-agent-sentinel \
  --min-replicas 2 \
  --max-replicas 10
```

## RB-005: Emergency Rollback

```bash
# Rollback to previous ACA revision
az containerapp revision list --name web-as-260814 --resource-group rg-agent-sentinel
az containerapp ingress traffic set --name web-as-260814 --resource-group rg-agent-sentinel \
  --revision-weight previous=100
```

## RB-006: Re-index AI Search

If the search index is corrupted or needs rebuilding:

1. Delete the index: `az search index delete --name findings-index --service-name search-as-260814 ...`
2. Trigger full re-ingestion via the jobs worker with snapshot-ingestion queue
3. Monitor ingestion via Application Insights

## RB-007: App Gateway WAF Tuning

```bash
# View WAF policy details
az network application-gateway waf-policy show \
  --name waf-appgw-as-260814 \
  --resource-group rg-agent-sentinel

# Switch WAF to Detection mode (for false-positive investigation)
az network application-gateway waf-policy policy-setting update \
  --policy-name waf-appgw-as-260814 \
  --resource-group rg-agent-sentinel \
  --mode Detection

# Return to Prevention mode when done
az network application-gateway waf-policy policy-setting update \
  --policy-name waf-appgw-as-260814 \
  --resource-group rg-agent-sentinel \
  --mode Prevention
```

## RB-008: Verify Network Boundaries

```bash
# Confirm API is internal-only (external: false)
az containerapp show -g rg-agent-sentinel -n api-as-260814 \
  --query 'properties.configuration.ingress.{external:external,fqdn:fqdn}' -o json
# Expected: external=false, fqdn contains .internal.

# Confirm web is VNet-accessible (external: true, within internal ACA env)
az containerapp show -g rg-agent-sentinel -n web-as-260814 \
  --query 'properties.configuration.ingress.{external:external,fqdn:fqdn}' -o json
# Expected: external=true

# Confirm jobs has no ingress
az containerapp show -g rg-agent-sentinel -n jobs-as-260814 \
  --query 'properties.configuration.ingress' -o json
# Expected: null
```

## RB-009: Front Door Investigation

**Issue:** `fd-as-260814` origins show `deploymentStatus: NotStarted`.

```bash
# Check private link connection status
az cdn profile list -g rg-agent-sentinel --query '[].name' -o tsv

# Check Front Door origin status
az rest --method GET \
  --url "https://management.azure.com/subscriptions/66679423-9d1a-4f45-8ae3-3078b8b62e99/resourceGroups/rg-agent-sentinel/providers/Microsoft.Cdn/profiles/fd-as-260814/originGroups?api-version=2024-02-01"

# Check ACA environment private link connections
az network private-endpoint-connection list \
  --resource-group rg-agent-sentinel \
  --name aca-env-260814 \
  --type Microsoft.App/managedEnvironments
```

**Resolution path:** Open Microsoft support case. Until resolved, App Gateway WAF v2 (`appgw-as-260814`) is the active public edge.

## RB-010: Custom Domain + TLS Setup (Planned)

When a custom domain is available:

```bash
# 1. Import certificate to Key Vault
az keyvault certificate import --vault-name kv-as-260814 \
  --name appgw-tls --file cert.pfx --password <pwd>

# 2. Grant App Gateway identity access to Key Vault
# (Add UAMI with "Key Vault Secrets User" role on kv-as-260814)

# 3. Update application-gateway.bicep:
#    - Add sslCertificates pointing to KV certificate
#    - Add HTTPS listener (port 443)
#    - Add HTTP->HTTPS redirect rule
#    - Update NSG to allow 443 inbound

# 4. Deploy
az deployment group create --mode Incremental \
  --resource-group rg-agent-sentinel \
  --template-file infra/platform.bicep \
  --parameters infra/environments/dev.parameters.bicepparam
```

## RB-011: Security Gate WAF

`BlockApiMutationPreAuth` is a temporary WAF safety gate. It blocks non-`GET`/`HEAD`/`OPTIONS`
requests under `/api/`. Keep it at priority 1 and in Prevention mode while authentication is
disabled and during read-only JWT validation.

The WAF cannot authenticate an Entra access token, so do not describe removal as an
"authenticated WAF allowance." API JWT authorization is authoritative. Before changing the rule:

1. Deploy and validate JWT mode with `AGENT_SENTINEL_WRITE_ENABLED=false`.
2. Prove anonymous `401`, insufficient-role `403`, and all four role boundaries using read-only
   capability probes.
3. Enable the write switch only on an approved private validation path and complete one bounded,
   reversible authenticated write.
4. Obtain approval for an exact path/method WAF change; retain blocks for every other mutation.
5. Run the write-phase validator through the public HTTPS edge and separately prove an anonymous
   request to the allowed mutation path remains `401` at the API.

Rollback order is WAF block, writes false, last known-good Container Apps revision. Never leave
`AUTH_MODE=disabled` behind a mutation-capable public edge.

## RB-012: Auth Activation and Live Validation

The API and SPA registrations exist, including delegated read/write scopes and the four exact app
roles. The active Front Door HTTPS redirect/logout origin and read-only JWT deployment are live.
Employee login, logout, anonymous `401`, Viewer `403`, and `/api/auth/me` are validated. Remaining
role assignments and every write-path change require separate approval. OneRAI and service
onboarding are independent and do not block this engineering sequence.

1. Revalidate the registered Front Door HTTPS origin; the Application Gateway remains HTTP-only.
2. Preserve the deployed JWT configuration, writes-false switch, and RB-011 WAF block.
3. Assign isolated test principals/groups to Analyst, Approver, and Administrator.
4. Confirm `/api/auth/config` contains the expected public tenant, client, scope, and redirect
   values without secrets.
5. Supply short-lived role tokens as process environment variables and run
   `pnpm auth:validate-live`. It validates anonymous `401`, insufficient-role `403`, sanitized
   principals, and every read-only capability probe.
6. Follow RB-011 for private write validation and the separate WAF change. Run the validator with
   `AUTH_VALIDATION_PHASE=write` only against the explicitly approved mutation target.

The validator never acquires, stores, or prints tokens. Do not place token values in shell history,
Git, logs, screenshots, or reports. Record only pass/fail status and correlation IDs.

## RB-013: HTTPS Origin and App Registration

The active Front Door HTTPS route and exact registered redirect/logout URLs are evidenced. The
Application Gateway remains HTTP-only and must not be used as an authentication origin.

Revalidate the Front Door default hostname with read-only inspection before each auth activation:

- endpoint enabled and default-domain linkage enabled;
- API and web routes enabled with expected patterns;
- private-link/origin provisioning successful and origin health healthy;
- HTTPS root and `/api/auth/config` smoke tests reach this deployment.

If any item regresses, stop activation and restore the last known-good revision. Then:

1. Confirm the exact HTTPS SPA redirect URI and same-origin logout URL remain registered.
2. Set those exact values in `authSpaRedirectUri` and `authSpaPostLogoutRedirectUri`.
3. Add the origin to CORS only if the SPA and API are intentionally cross-origin.
4. Validate login, logout, token tenant/audience, certificate renewal, and RB-011 behavior.

## RB-013B: Live Entra and OTel Read Permissions

These are independent read-only source permissions. Apply only after approval.

For Entra stable inventory, resolve the tenant-local Microsoft Graph service
principal and `Application.Read.All` application role dynamically. Assign it to
the Agent Sentinel UAMI; do not request `AgentIdentity.Read.All` or any write
role during the stable v1.0 stage.

```bash
UAMI_PRINCIPAL_ID=$(az identity show -g rg-agent-sentinel \
  -n id-agent-sentinel-260814 --query principalId -o tsv)
GRAPH_SP_ID=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 \
  --query id -o tsv)
APPLICATION_READ_ALL_ID=$(az ad sp show \
  --id 00000003-0000-0000-c000-000000000000 \
  --query "appRoles[?value=='Application.Read.All'].id | [0]" -o tsv)
BODY=$(jq -n \
  --arg principalId "$UAMI_PRINCIPAL_ID" \
  --arg resourceId "$GRAPH_SP_ID" \
  --arg appRoleId "$APPLICATION_READ_ALL_ID" \
  '{principalId:$principalId,resourceId:$resourceId,appRoleId:$appRoleId}')
az rest --method POST \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/${UAMI_PRINCIPAL_ID}/appRoleAssignments" \
  --headers Content-Type=application/json \
  --body "$BODY"
```

For OTel queries, `infra/modules/identity.bicep` assigns built-in
`Log Analytics Reader` only at the configured workspace scope. It excludes
shared-key reads. Validate synthetic AppRequests before enabling
`azureMonitorConnectorEnabled`.

The Container Apps managed environment separately uses a secure workspace key
to deliver platform console logs. That control-plane sink is not exposed as an
application environment variable and is not used by the OTel query connector;
connector reads authenticate only through the UAMI role above.

## RB-013A: Surgical connector-sources readiness (not executed)

Use `infra/connector-sources.bicep` only when the existing target account is
`cosmos-as-m098047` and the existing SQL database is `agent-sentinel-db`. The
entrypoint declares both parents as `existing` and creates only their
`connector-sources` child.

```bash
export TARGET_RG='<approved-replacement-resource-group>'

# Offline structural compile.
az bicep build --file infra/connector-sources.bicep --stdout >/dev/null
az bicep build-params \
  --file infra/environments/mngenvmcap098047-connector-sources.parameters.bicepparam \
  --stdout >/dev/null

# Approval gate: expected change is one container only.
az deployment group what-if \
  --resource-group "${TARGET_RG}" \
  --template-file infra/connector-sources.bicep \
  --parameters infra/environments/mngenvmcap098047-connector-sources.parameters.bicepparam \
  --result-format FullResourcePayloads

# Run only after the reviewed what-if proves there are no unrelated changes.
az deployment group create \
  --resource-group "${TARGET_RG}" \
  --template-file infra/connector-sources.bicep \
  --parameters infra/environments/mngenvmcap098047-connector-sources.parameters.bicepparam \
  --mode Incremental
```

Approve only `/estateId`, the checked-in included/excluded paths, and the two
checked-in composite indexes. Stop if the what-if contains an account/database
write, throughput change, another container, private endpoint, identity, or role
assignment. These commands are readiness instructions and are not evidence of a
completed deployment.

## RB-014: Private CI Build Runner

### Architecture

A self-hosted GitHub Actions runner (`vm-ci-runner-as`, Standard_D2s_v3) runs inside the
`build` subnet (10.0.6.0/24) of `vnet-as-260814`. It has no public IP. Access is exclusively
via Azure Run Command (management plane). The dedicated `nat-build-as` NAT Gateway provides
stable outbound connectivity without exposing the VM to inbound Internet traffic. Runner
labels: `self-hosted,linux,x64,agent-sentinel-private`.

| Component   | Name                  | Notes                                                        |
| ----------- | --------------------- | ------------------------------------------------------------ |
| VM          | `vm-ci-runner-as`     | No public IP, Ubuntu 24.04 LTS                               |
| UAMI        | `id-ci-runner-260814` | AcrPush on acr260814 only                                    |
| NSG         | `nsg-build-as`        | All inbound denied; outbound restricted                      |
| Subnet      | `build` 10.0.6.0/24   | Inside vnet-as-260814                                        |
| NAT Gateway | `nat-build-as`        | Outbound-only connectivity for GitHub and package registries |

### Required Outbound Domains (port 443 unless noted)

| Domain                             | Purpose                                  |
| ---------------------------------- | ---------------------------------------- |
| `api.github.com`                   | Runner registration and job polling      |
| `*.actions.githubusercontent.com`  | Job artifacts and caches                 |
| `github.com`                       | git clone over HTTPS                     |
| `objects.githubusercontent.com`    | Large git objects/LFS                    |
| `*.blob.core.windows.net`          | Runner diagnostic uploads, Azure storage |
| `mcr.microsoft.com`                | Microsoft Container Registry base images |
| `registry.npmjs.org`               | pnpm package downloads                   |
| `registry-1.docker.io`             | Docker Hub base images                   |
| `auth.docker.io`                   | Docker Hub auth                          |
| `production.cloudflare.docker.com` | Docker CDN                               |
| `management.azure.com`             | ARM for Bicep what-if and deploy         |
| `login.microsoftonline.com`        | Managed identity / Entra tokens          |
| `acr260814.azurecr.io`             | Via VNet private endpoint (no internet)  |
| OS mirrors (port 80)               | `archive.ubuntu.com`, CRL endpoints      |

### Replacement-tenant runner readiness (not executed)

The target foundation parameter file is
`infra/environments/mngenvmcap098047-ci-foundation.parameters.bicepparam`. With
suffix `m098047`, `ci-foundation.bicep` resolves the existing
`vnet-as-m098047/build` subnet, existing `acrm098047`, and new
`id-ci-runner-m098047`. It contains no subscription ID, client ID, token, secret,
or SSH key material.

Required approvals, in order:

1. An operator confirms the active Azure tenant/subscription and sets
   `TARGET_RG` to the approved replacement resource group.
2. Network and registry owners confirm `vnet-as-m098047/build` and `acrm098047`
   already exist in that resource group.
3. Security reviews the what-if. Expected creates are the runner UAMI, its
   `AcrPush` assignment scoped only to `acrm098047`, runner NSG/NIC, and VM. Stop
   on changes to the VNet, ACR, application identities, or broader role scope.
4. An operator supplies an approved SSH public key only for compilation and
   deployment. Never commit it or place it in a parameter file.
5. A repository administrator approves registration of the runner with label
   `agent-sentinel-private-m098047` and configures the protected
   `replacement-validation` GitHub environment with required reviewers.
6. Any Azure permission beyond the template's ACR-scoped `AcrPush` assignment
   (including resource-group what-if or deployment rights) is a separate
   least-privilege role review. Do not infer or auto-assign it from this runbook.

```bash
export TARGET_RG='<approved-replacement-resource-group>'
export ADMIN_SSH_PUBLIC_KEY="$(cat '<approved-public-key>.pub')"

# Offline compile first.
az bicep build-params \
  --file infra/environments/mngenvmcap098047-ci-foundation.parameters.bicepparam \
  --stdout >/dev/null

# Review only; no resource is created by what-if.
az deployment group what-if \
  --resource-group "${TARGET_RG}" \
  --template-file infra/ci-foundation.bicep \
  --parameters infra/environments/mngenvmcap098047-ci-foundation.parameters.bicepparam \
  --result-format FullResourcePayloads

# Run create only after approvals 1-4 are recorded.
az deployment group create \
  --resource-group "${TARGET_RG}" \
  --template-file infra/ci-foundation.bicep \
  --parameters infra/environments/mngenvmcap098047-ci-foundation.parameters.bicepparam \
  --mode Incremental
```

After the VM exists, a repository administrator obtains a fresh registration
token and passes it directly to Run Command. The example intentionally contains
no token value:

```bash
TOKEN="$(gh api -X POST \
  /repos/YOONPYOGitHub/agent-sentinel/actions/runners/registration-token \
  --jq .token)"
az vm run-command invoke \
  --resource-group "${TARGET_RG}" \
  --name vm-ci-runner-as \
  --command-id RunShellScript \
  --scripts @scripts/bootstrap-runner.sh \
  --parameters \
    "GH_RUNNER_TOKEN=${TOKEN}" \
    'GH_RUNNER_LABELS=self-hosted,linux,x64,agent-sentinel-private-m098047' \
    'RUNNER_VERSION=2.319.1'
unset TOKEN
```

Confirm the runner is online with the exact target label before enabling any
workflow dispatch. This section records readiness instructions only; it is not
evidence that the runner or role assignment exists.

### Historical development runner provisioning

```bash
# 1. Deploy build subnet (if not already present via platform.bicep deploy):
az network vnet subnet create \
  -g rg-agent-sentinel --vnet-name vnet-as-260814 \
  --name build --address-prefixes 10.0.6.0/24

# 2. Deploy CI foundation (UAMI + NSG + VM):
az deployment group create \
  -g rg-agent-sentinel \
  -f infra/ci-foundation.bicep \
  -p location=koreacentral

# 3. Obtain short-lived runner token (1-hour TTL, never stored):
TOKEN=$(~/.local/bin/gh api -X POST \
  /repos/YOONPYOGitHub/agent-sentinel/actions/runners/registration-token \
  --jq .token)

# 4. Bootstrap runner on VM via Run Command (token passed over TLS, not persisted):
az vm run-command invoke \
  -g rg-agent-sentinel \
  --name vm-ci-runner-as \
  --command-id RunShellScript \
  --scripts @scripts/bootstrap-runner.sh \
  --parameters "GH_RUNNER_TOKEN=${TOKEN}" "RUNNER_VERSION=2.319.1"
```

### Azure Login in Workflows

Workflows use `az login --identity --client-id <RUNNER_UAMI_CLIENT_ID>`. No OIDC federation
or stored secrets are required. The runner is inside Azure; IMDS provides tokens directly.

```yaml
- name: Login to Azure (managed identity)
  run: az login --identity --client-id "${{ env.RUNNER_UAMI_CLIENT_ID }}"
- name: Login to ACR (identity - no password)
  run: az acr login --name "${{ env.ACR_NAME }}"
```

### Runner Rotation / Re-registration

```bash
# Get remove-token (different endpoint from registration-token):
REMOVE_TOKEN=$(~/.local/bin/gh api -X POST \
  /repos/YOONPYOGitHub/agent-sentinel/actions/runners/remove-token \
  --jq .token)

az vm run-command invoke \
  -g rg-agent-sentinel \
  --name vm-ci-runner-as \
  --command-id RunShellScript \
  --scripts @scripts/remove-runner.sh \
  --parameters "GH_RUNNER_TOKEN=${REMOVE_TOKEN}"

# Re-register with a fresh token:
NEW_TOKEN=$(~/.local/bin/gh api -X POST \
  /repos/YOONPYOGitHub/agent-sentinel/actions/runners/registration-token \
  --jq .token)

az vm run-command invoke \
  -g rg-agent-sentinel \
  --name vm-ci-runner-as \
  --command-id RunShellScript \
  --scripts @scripts/bootstrap-runner.sh \
  --parameters "GH_RUNNER_TOKEN=${NEW_TOKEN}" "RUNNER_VERSION=2.319.1"
```

### GitHub environment protection

The workflow dispatch allowlists `replacement-validation`; the deploy job binds
to the selected GitHub environment. Configure required reviewers in
Settings > Environments > replacement-validation before setting
`deployPlatform=true`. Repository variables must be reviewed at the same gate:
`AZURE_RESOURCE_GROUP`, `AZURE_SUBSCRIPTION_ID`, `ACR_NAME` (`acrm098047`),
`RUNNER_UAMI_CLIENT_ID`, and `PRIVATE_RUNNER_LABEL`
(`agent-sentinel-private-m098047`). The workflow rejects missing/invalid names,
a mismatched target ACR, unapproved parameter paths, and path traversal. Its
input defaults are `targetEnvironment=none`, `parameterFile=none`, and
`deployPlatform=false`.

### VM Decommission

To permanently remove the runner:

1. Remove from GitHub via the remove-runner.sh script (see above).
2. `az vm delete -g rg-agent-sentinel --name vm-ci-runner-as --yes`
3. `az network nic delete -g rg-agent-sentinel --name nic-ci-runner-as`
4. `az identity delete -g rg-agent-sentinel --name id-ci-runner-260814`
5. `az network nsg delete -g rg-agent-sentinel --name nsg-build-as`

## RB-020: Exposure Ingestion

The jobs worker (`apps/jobs`) runs the exposure ingestion loop:

1. Startup: run immediately, then every `DISCOVERY_INTERVAL_MS` ms (default 300000).
2. Steps per tick:
   - Connector discovery (`AGENT_SENTINEL_CONNECTOR=mock|foundry`).
   - Snapshot save (Cosmos in live mode, in-memory in mock mode).
   - `evaluateAllExposurePolicies` runs AS-POL-001/002/003.
   - Upsert findings (Cosmos preserves `firstSeen`).
   - Resolve findings absent from the current snapshot to `resolved`.
3. Optional Service Bus subscriber (`snapshot-ingestion`) can trigger an ad-hoc run with `withIdempotency`.
4. Environment variables: `AGENT_SENTINEL_CONNECTOR`, `AGENT_SENTINEL_TENANT_ID`, `DISCOVERY_INTERVAL_MS`, `COSMOS_ENDPOINT`, `COSMOS_DATABASE_ID`, `FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_TENANT_ID`, `FOUNDRY_ENVIRONMENT`, `SERVICE_BUS_FQDN`.
5. All Azure access uses `DefaultAzureCredential` (AAD only; no keys).

## RB-013: Bounded post-deployment demo readiness verification

Run this only after an approved deployment. It performs documented `GET` requests only; it does not deploy, mutate configuration, create traffic, or query Azure control-plane APIs.

```bash
export AGENT_SENTINEL_ACCESS_TOKEN='<short-lived read token>' # omit when AUTH_MODE is disabled
pnpm demo:verify -- \
  --url "https://${FRONT_DOOR_HOST}" \
  --token-env AGENT_SENTINEL_ACCESS_TOKEN \
  --timeout-ms 15000 \
  --max-response-bytes 4194304 \
  --expected-web-sha "${COMMIT_SHA}" \
  --expected-api-sha "${COMMIT_SHA}" \
  --expected-jobs-sha "${COMMIT_SHA}" \
  --expected-web-digest "${WEB_IMAGE_DIGEST}" \
  --expected-api-digest "${API_IMAGE_DIGEST}" \
  --expected-jobs-digest "${JOBS_IMAGE_DIGEST}" \
  --output demo-readiness.json
```

If authentication is disabled, omit `--token-env`. The token is read from the named environment variable and is never included in JSON or console output. The verifier bounds every response and runs the seven read requests in parallel under the supplied per-request timeout.

Expected concise console result:

```text
demo readiness: READY | Agent365 ready | RUNS_AS 4 | OTel 3/12 | version ready
```

The JSON result contains `overall`, categorized readiness evidence, immutable version comparisons, and bounded request outcomes. It intentionally omits package names, provider identities, access tokens, and source payloads. Exit codes are `0` ready, `3` partial, `1` blocked/unavailable/error, and `2` invalid arguments.

Interpretation:

- `ready`: exact `agent365:primary` is fresh, ready, complete, non-empty, and provenance-bound; the deployment source binding is valid; exact `RUNS_AS` evidence exists; accepted live OTel evidence includes trace/span and token/cost provenance; supplied immutable versions match.
- `partial`: evidence is incomplete but not contradicted. Zero `RUNS_AS` is partial only when exact diagnostics account for every authoritative agent as missing provider identity IDs. Zero OTel requires approved representative application traffic and is never live-ready.
- `blocked`: stale, empty, unknown, synthetic, mismatched, ambiguous, or unsafe evidence prevents a live demo claim.
- `unavailable`: required endpoints or documented response contracts could not be observed.

The web UI exposes the same categories at **Demo readiness**. It uses current API state and connector-source contracts and has no mock-success fallback.
