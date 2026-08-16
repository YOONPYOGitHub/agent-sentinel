# Agent Sentinel – Deployment Guide

## Prerequisites
- Azure CLI >= 2.65 with Bicep extension
- Access to RG `rg-agent-sentinel` in `koreacentral`
- Contributor + RBAC Administrator role on the RG

## Infrastructure Deployment

### Phase A – Foundation (Network, Identity, Observability, KV, ACR)
```bash
az deployment group create \
  --mode Incremental \
  --resource-group rg-agent-sentinel \
  --template-file infra/platform.bicep \
  --parameters infra/environments/dev.parameters.bicepparam \
  --name "platform-phase-a-$(date +%Y%m%d%H%M%S)"
```

### Phase B – Data (Cosmos, PostgreSQL, Search, Service Bus)
Same command – Bicep is idempotent for Incremental mode.

### Phase C – Foundry Embedding
Add text-embedding-3-large deployment (only this module touches AIServices).

### Phase D – Container Apps
After ACR is provisioned and images are pushed.

### Phase E – Front Door
After ACA apps are healthy.

## Container Image Build and Push
```bash
# Login to ACR
az acr login --name acr260814

# Build and push
docker build -f apps/api/Containerfile -t acr260814.azurecr.io/agent-sentinel-api:latest .
docker push acr260814.azurecr.io/agent-sentinel-api:latest
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
Stop if what-if shows Delete on Foundry resources.

## Never Deploy If:
- What-if shows Delete/Modify on existing AIServices account, project, or model deployments
- Front Door PL approval is pending without an approval workflow
- PG zone redundancy is unavailable in koreacentral
- Embedding quota/capacity would exceed account limits
