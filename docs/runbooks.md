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

BlockApiMutationPreAuth is a temporary WAF safety gate. It blocks non-GET/HEAD/OPTIONS requests
under /api/ until Microsoft Entra authentication and authorization have been validated in the
runtime. Keep the rule at priority 1 and in Prevention mode during this phase. Remove or narrow it
only after the JWT write-scope tests, App Gateway path tests, and an authorized remediation smoke
test pass; confirm anonymous mutation remains denied before closing the change.

## RB-012: Auth Architecture and Pending Steps

The API supports disabled, mock, and jwt authentication modes. Production must use jwt
with AUTH_TENANT_ID, AUTH_AUDIENCE, AUTH_READ_SCOPES, and AUTH_WRITE_SCOPES. JWT mode uses
the tenant v2 JWKS endpoint, validates issuer/audience/RS256, and accepts delegated scopes (`scp`)
or app roles (`roles`). Health and connector-status routes remain public.

Pending production steps:

1. Create the Entra API app registration and expose read/write scopes or app roles.
2. Create the web app registration, configure redirect URIs, and grant API permissions.
3. Configure the Container Apps environment variables and approved CORS origins.
4. Add browser token acquisition and Bearer forwarding, then validate least-privilege roles.
5. Complete the RB-011 gate-removal checks before enabling write operations at the edge.

## RB-013: Custom Domain, TLS, and App Registration

1. Add and verify the production DNS name.
2. Import or issue its certificate in Key Vault and grant the Application Gateway identity access.
3. Configure the HTTPS listener, SNI hostname, certificate reference, and HTTP-to-HTTPS redirect.
4. Add the final HTTPS origin to CORS_ORIGIN.
5. Add the exact HTTPS redirect URI and front-channel logout URL to the web Entra app registration.
6. Update API identifier/audience settings if the custom URI is used, and obtain admin consent.
7. Validate certificate renewal, TLS policy, login/logout, token audience, CORS, and WAF behavior.
