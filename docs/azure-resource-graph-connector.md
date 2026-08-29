# Azure Resource Graph connector

The Azure Resource Graph connector contributes bounded Azure cloud-resource
inventory to Agent Sentinel without classifying any resource as an AI agent.

## Evidence boundary

The connector calls the documented GA endpoint:

```text
POST https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01
```

It uses a fixed Kusto query and retains only:

- ARM resource ID
- Name and resource type
- Azure region
- Subscription ID and resource group
- Bounded `kind`, SKU name, and managed-identity type strings

The connector does not request or retain tags, arbitrary resource properties,
keys, endpoints, connection strings, configuration payloads, or provider error
bodies.

Every record becomes one `control` node and one `Evidence` object with no graph
edges. Direct resource presence does not prove:

- AI agent classification
- Deployment or runtime activity
- Identity correlation
- Ownership
- Health, trust, security, or compliance

## Fixed resource types

The query is restricted to Azure AI and direct supporting-resource families:

- Azure Container Apps and managed environments
- Azure AI Services accounts, projects, and deployments
- Azure Machine Learning workspaces
- User-assigned managed identities
- Application Insights and Log Analytics
- Azure AI Search
- Cosmos DB
- Service Bus
- Key Vault
- Azure Container Registry

Adding another resource type is a code-reviewed contract change, not runtime
configuration.

## Authorization

Azure Resource Graph returns only resources the credential can read. Configure
exact subscription IDs for every source.

- M365 E5 is not required.
- Existing resource-scoped Azure roles can yield a partial authorized view.
- A subscription or resource-group `Reader` assignment provides broader
  inventory coverage but is a security/RBAC expansion and requires separate
  approval.
- A successful query proves reachability for the credential's authorized view;
  it does not prove complete subscription coverage.
- Cross-tenant sources use the same secretless managed-identity federation
  pattern as other connectors and require an approved target-tenant
  application/RBAC boundary.

The checked-in IaC does not create a Reader assignment.

## Configuration

The connector is disabled by default:

```text
AZURE_RESOURCE_GRAPH_CONNECTOR_ENABLED=false
AZURE_RESOURCE_GRAPH_SOURCES_JSON=
```

When enabled through the platform template with no explicit source JSON, a
single source is generated for the deployment subscription and the application
UAMI. Explicit multi-source configuration supports up to 50 source definitions
and 100 subscription IDs per source. A subscription can appear in only one
source to prevent duplicate evidence.

Safety limits:

```text
AZURE_RESOURCE_GRAPH_PAGE_SIZE=200
AZURE_RESOURCE_GRAPH_MAX_PAGES=20
AZURE_RESOURCE_GRAPH_MAX_ITEMS=5000
AZURE_RESOURCE_GRAPH_REQUEST_TIMEOUT_MS=15000
AZURE_RESOURCE_GRAPH_MAX_RETRIES=2
AZURE_RESOURCE_GRAPH_MAX_RETRY_AFTER_MS=30000
AZURE_RESOURCE_GRAPH_MAX_RESPONSE_BYTES=2000000
```

## Fail-closed behavior

- The access token tenant must match the configured source tenant.
- Every ARM ID must agree with projected subscription, resource group, provider,
  and resource type fields.
- Every returned subscription must be explicitly configured.
- Page count, requested page size, aggregate count, `totalRecords`, skip-token
  progression, response bytes, retries, and retry delay are bounded.
- Provider-declared truncation, changing totals, repeated tokens, duplicate
  resource IDs, or malformed response shapes fail the source.
- One failed optional Resource Graph source degrades connector health but does
  not replace or block the authoritative Foundry snapshot.
- Provider errors are reduced to stable reason codes and response bodies are
  discarded.

## Validation evidence

On 2026-08-29:

- The fixed query returned 64 live resources across 13 allowed resource types
  using an authorized user credential. Normalization produced 64 control nodes,
  64 evidence objects, and zero edges.
- The deployed application UAMI reported `ready` with its existing roles.
- Jobs persisted 5 UAMI-visible resources as 5 control nodes and 5 evidence
  objects with zero edges.

The difference between 64 and 5 is an authorization-coverage boundary, not
missing or healthy evidence. No broader Reader role was added.
