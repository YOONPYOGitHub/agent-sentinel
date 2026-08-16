# Agent Sentinel – DR Design

## Recovery Objectives
- RTO (Recovery Time Objective): 4 hours
- RPO (Recovery Point Objective): 1 hour

## Cosmos DB
- Automatic backups every 1 hour, retained 8 hours (periodic backup mode)
- Multi-region reads can be added for lower RTO
- Session consistency allows reads from nearest replica

## PostgreSQL
- Zone-redundant HA with standby in availability zone 2
- Automated backups: 7 days, geo-redundant
- Point-in-time restore available
- Failover: automatic (< 120s) via AZ failover

## Container Apps
- Consumption workload profile: automatic scale-to-zero + scale-out
- Multiple replicas for api and jobs in production

## Service Bus Premium
- Built-in zone redundancy (Premium tier)
- Dead-letter queue for failed messages
- Message lock duration: 5 minutes

## AI Search
- S1 tier with 1 replica (dev); add replicas for HA
- Index rebuild from source data if needed

## Runbook: Failover Steps
1. Verify PostgreSQL automatic failover completed
2. Check ACA app health endpoints
3. Verify Cosmos DB replication lag
4. Check Service Bus DLQ for unprocessed messages
5. Validate AI Search index completeness
