# Microsoft Foundry live agents

Agent Sentinel can discover agents from Microsoft Foundry without replacing the
Foundry control plane. The integration is read-only at runtime: remediation
execution is explicitly rejected. Provisioning and cleanup are separate,
operator-invoked scripts.

## Prerequisites

- Node.js 22 and pnpm 10.15.1
- Azure CLI sign-in or another `DefaultAzureCredential` source
- The deployed Foundry project endpoint from the `foundryProjectEndpoint`
  infrastructure output
- `Foundry User` access scoped to the project for the operator running agent
  provisioning or cleanup. Azure Resource Manager `Owner` alone does not grant
  Foundry agent data-plane access.

Copy `.env.example` values into your shell. Do not put credentials or API keys
in source files. The integration uses Microsoft Entra tokens.

```bash
export FOUNDRY_PROJECT_ENDPOINT='https://<account>.services.ai.azure.com/api/projects/<project>'
export AZURE_TENANT_ID='<tenant-id>'
export AGENT_SENTINEL_ENVIRONMENT='development'
```

## Scenario manifest

`@agent-sentinel/scenarios` owns the strict six-agent manifest. Per-agent
SHA-256 hashes are canonical and stable. Provisioned agents carry the manifest
hash in metadata and both `[managed-by:agent-sentinel]` and the full hash in
their descriptions so drift and ownership are explicit.

## Provision and cleanup

These commands make live changes and must be run only by an authorized
operator. They are not part of build or test.

```bash
pnpm build
pnpm foundry:provision
pnpm foundry:cleanup          # dry-run; makes no changes
pnpm foundry:cleanup -- --apply
```

Provision only after the target project and every model deployment referenced by
the manifest exist. A replacement tenant gets new agent identities and version
IDs; never copy historical agent identity IDs or old versions. The manifest
recreates only the six current synthetic definitions and does not require
unreferenced experimental model deployments.

Provisioning confirms matching agents by immutable ID. A matching owned version
is unchanged; a definition change creates a new version and never patches an
existing agent. Cleanup defaults to dry-run and requires both an exact manifest
name and the ownership marker. Metadata or a matching name alone can never make
an unrelated agent eligible for deletion.

The provisioning operator role is tenant-local. Assign it to the operator in the
replacement project; never add a replacement-tenant account to the historical
tenant as part of migration.

## API selection and connector health

The API defaults to the mock connector. The legacy single-project settings
remain supported:

```bash
export AGENT_SENTINEL_CONNECTOR=foundry
export FOUNDRY_PROJECT_ENDPOINT='...'
export FOUNDRY_TENANT_ID='...'
export FOUNDRY_ENVIRONMENT='production'
pnpm dev
```

Invalid modes or missing Foundry settings stop startup rather than silently
falling back. `GET /api/connectors/status` returns the selected mode,
capabilities, permissions, API maturity, known blind spots, and a measured
connection result. The web **Connectors** page presents the same evidence.

The connector validates Foundry responses and safely follows same-origin,
same-collection `nextLink` and body/header continuation tokens. Live discovery
is bounded to 100 pages, 10,000 agents, 4 MiB per response, 16 MiB across the
discovery run, and 30 seconds per request. Repeated continuations, malformed
pages, oversized responses, timeouts, and aborts fail the affected source with
a stable reason code. No agents accumulated before that failure are promoted.
The connector maps each completed source object to evidence and an estate agent;
it does not infer tools, relationships, owners, or health that Foundry did not
return.

### Multiple tenants and projects

Set a stable aggregate estate boundary and provide a JSON source array:

```bash
export AGENT_SENTINEL_CONNECTOR=foundry
export AGENT_SENTINEL_TENANT_ID='<stable-estate-id>'
export AGENT_SENTINEL_ENVIRONMENT='portfolio'
export FOUNDRY_ENVIRONMENT='portfolio'
export FOUNDRY_SOURCES_JSON='[
  {
    "id": "primary",
    "name": "Current Foundry project",
    "projectEndpoint": "https://<account-a>.services.ai.azure.com/api/projects/<project-a>",
    "tenantId": "<tenant-a>",
    "environment": "production"
  },
  {
    "id": "tenant-b-project",
    "name": "Tenant B validation",
    "projectEndpoint": "https://<account-b>.services.ai.azure.com/api/projects/<project-b>",
    "tenantId": "<tenant-b>",
    "environment": "validation",
    "credential": {
      "mode": "federated-app",
      "clientId": "<app-client-id-in-tenant-b>",
      "managedIdentityClientId": "<optional-source-uami-client-id>"
    }
  }
]'
```

Use source id `primary` for the existing project to preserve its node and
finding identifiers. Additional sources are namespaced by source id. Every
node records `sourceConnectorId`, source tenant, project, and environment.
Connector health records the aggregate estate tenant/environment plus the exact
source connector, source tenant/environment, provider, and project object ID.

Same-tenant sources can use the default managed identity/developer credential.
Cross-tenant sources use secretless workload identity federation: create an app
in the target tenant, configure a federated identity credential that trusts the
Agent Sentinel managed identity assertion, and grant that app `Azure AI User`
on the target project. A source without authorization reports unavailable; if
any configured discovery source fails, the aggregate reports degraded and jobs
does not promote the incomplete snapshot.

## Live validation

Live validation is intentionally opt-in and is never run by CI:

```bash
pnpm build
pnpm foundry:validate
```

The runner looks up all six current immutable agents by ID and exercises benign,
agent-specific behavior, prompt-injection, and harmful-content probes through
the Responses API. It reports service content filters separately from
agent-level refusals. Local function calls receive synthetic outputs only; no
external operation is performed. It writes `scripts/live-validation-report.json`.
A missing agent, empty answer, unsafe outcome, or incomplete run fails.

## Limitations and troubleshooting

- Agent CRUD uses project `v1`. Live invocation isolates the current SDK-derived
  wire assumption as `POST /openai/responses?api-version=v1` with a root
  `agent_reference`; this should be rechecked if the service rejects that shape.
- Runtime traces, tool authorization, and cost require separate authoritative
  telemetry connectors; they are reported as blind spots.
- HTTP/RBAC failures are reported as degraded health and are not replaced with
  mock success.
- A `403` requires project-scoped role review. A malformed response indicates
  API contract drift and fails schema validation.
- Always run cleanup when the six scenario agents are no longer needed to
  avoid leaving project resources behind.
