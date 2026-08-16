# Agent Sentinel – Runbooks

## RB-001: Check Service Health
```bash
# ACA app health
curl https://<aca-fqdn>/health

# Check ACA app status
az containerapp show --name agent-sentinel-api --resource-group rg-agent-sentinel --query 'properties.runningStatus'

# Check Cosmos DB metrics
az monitor metrics list --resource /subscriptions/.../cosmos-as-260814 --metric DocumentCount
```

## RB-002: Process Dead-Letter Queue
```bash
# List DLQ messages
az servicebus queue show --name findings-validation --namespace-name sb-as-260814 --resource-group rg-agent-sentinel --query 'countDetails.deadLetterMessageCount'

# Replay DLQ messages (use Service Bus Explorer or custom script)
```

## RB-003: Rotate Secrets
All secrets are stored in Key Vault `kv-as-260814`.
1. Generate new secret version in KV
2. ACA apps will pick up new version within 10 minutes (Key Vault reference refresh)
3. Verify app health after rotation

## RB-004: Scale ACA Apps
```bash
az containerapp update \
  --name agent-sentinel-api \
  --resource-group rg-agent-sentinel \
  --min-replicas 2 \
  --max-replicas 10
```

## RB-005: Emergency Rollback
```bash
# Rollback to previous ACA revision
az containerapp revision list --name agent-sentinel-api --resource-group rg-agent-sentinel
az containerapp ingress traffic set --name agent-sentinel-api --resource-group rg-agent-sentinel --revision-weight previous=100
```

## RB-006: Re-index AI Search
If the search index is corrupted or needs rebuilding:
1. Delete the index: `az search index delete --name findings-index --service-name search-as-260814 ...`
2. Trigger full re-ingestion via the jobs worker with snapshot-ingestion queue
3. Monitor ingestion via Application Insights
