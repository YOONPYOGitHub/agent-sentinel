# Foundry identity-aware synthetic pilot

This runbook prepares one side-by-side validation agent. It does not migrate,
update, or delete the six legacy synthetic agents. The checked-in command is
plan-only by default and makes no Azure or Microsoft Graph request unless an
operator explicitly selects `create` or `cleanup`, adds `--apply`, and supplies
the exact confirmation string.

## Fixed pilot contract

| Item                         | Value                                       |
| ---------------------------- | ------------------------------------------- |
| Agent name                   | `agent-sentinel-identity-pilot-readonly-v1` |
| Marker                       | `[pilot:foundry-instance-identity-v1]`      |
| Pilot version                | `1`                                         |
| Semantic source              | `customer-support-safe`                     |
| Foundry API                  | Stable project data-plane `v1`              |
| Expected estate after create | Six unchanged legacy agents plus one pilot  |

The repository uses its bounded `FoundryHttpClient` rather than an agent SDK.
Both discovery and CRUD are pinned to the stable Foundry project data-plane
`v1`. The corresponding current official Python SDK is
`azure-ai-projects` 2.6.1 (released 2026-09-14); its stable
`agents.create_version` operation also defaults to `api-version=v1` and accepts
the same `definition`, `description`, `metadata`, and optional
`blueprint_reference` fields.

`customer-support-safe` is the safest existing definition to clone
semantically: it has one synthetic read-only `knowledge_search` function, no
write operation, no external transfer, no employee or other sensitive-domain
lookup, and explicit instructions prohibiting personal-data disclosure,
external sends, and writes. The pilot copies no provider object, application,
agent, version, or blueprint identifier.

The stable create request is:

```http
POST {FOUNDRY_PROJECT_ENDPOINT}/agents/agent-sentinel-identity-pilot-readonly-v1/versions?api-version=v1
Authorization: Bearer <token for https://ai.azure.com/.default>
Content-Type: application/json
```

The body printed by `pnpm foundry:identity-pilot -- plan` contains only the
fixed prompt definition and bounded metadata. It deliberately omits
`blueprint_reference` and all identity IDs. Under the current Foundry agent
object model, creating a new agent causes the service to create its unique
agent identity and blueprint. Supplying the project managed identity or any
historical provider ID is prohibited.

## Repository findings

- `@agent-sentinel/scenarios` defines exactly six synthetic agents.
  `customer-support-safe` is the only one-tool, nonsensitive, read-only option.
- `scripts/provision-agents.ts` iterates the full six-agent manifest, so it
  cannot safely create only this pilot.
- `scripts/cleanup-agents.ts` considers all six manifest names and is not an
  identity-pilot rollback command.
- `scripts/foundry-http.ts` and the live connector use the stable `v1` API and
  the `https://ai.azure.com/.default` token scope.
- Foundry discovery already maps only
  `instance_identity.principal_id` to exact runtime object authority. Blueprint
  and project identities remain descriptive and cannot produce `RUNS_AS`.
- The jobs service discovers once at startup and every five minutes by default.
- IaC creates a separate connector UAMI but doesn't establish the
  project-scoped Foundry or Microsoft Graph grants for it. Those grants remain
  explicit deployment prerequisites.
- `ENTRA_RUNS_AS_BINDINGS_JSON` must already contain the exact Foundry-to-Entra
  source boundary. No name-based or implicit `primary` binding is allowed.

## Prerequisites and permissions

Before approval, an operator must verify:

1. The target is the intended project and the stable `v1` data plane is
   available.
2. The six manifest names are the complete current agent estate, each has the
   Agent Sentinel ownership marker, and each has null `instance_identity`.
3. Project `properties.agentIdentityId` remains null and is recorded only as a
   baseline observation, never as a `RUNS_AS` candidate.
4. The fixed pilot name does not exist.
5. The configured model deployment used by `customer-support-safe` exists.
6. The creating principal has **Foundry User** at the project scope. Azure
   Resource Manager Owner alone is insufficient for Foundry data-plane CRUD.
7. The project's managed identity has the platform-required **Foundry User**
   assignment. It authenticates the service-managed blueprint; it is never a
   `RUNS_AS` endpoint and receives no downstream pilot permission.
8. Stable Graph inventory has `Application.Read.All`. Stable v1.0 subtype
   verification has approved `AgentIdentity.Read.All`; delegated nonowners also
   require the supported Agent ID Administrator role.

No downstream role assignment is expected or permitted for this basic pilot.
The function tool is a schema-only synthetic callback with no provider
connection. If a real downstream tool is added later, treat that as a separate
change and assign the least-privilege role to
`instance_identity.principal_id`, never to the project managed identity or
blueprint.

## Preview and create sequence

Run from a clean checkout at the approved commit. Store environment-specific
output only in the protected session files or the approved audit system.

```bash
set -o pipefail
pnpm install --frozen-lockfile
pnpm build
pnpm foundry:identity-pilot -- plan

export FOUNDRY_PROJECT_ENDPOINT='https://<account>.services.ai.azure.com/api/projects/<project>'
export PILOT_EVIDENCE_DIR='<absolute-session-files-directory>'
pnpm foundry:identity-pilot -- create --apply \
  --confirm CREATE:agent-sentinel-identity-pilot-readonly-v1 \
  | tee "${PILOT_EVIDENCE_DIR}/foundry-identity-pilot-create.log"
```

The create command fails closed unless the pre-create estate is exactly the six
owned manifest agents with null runtime identities. It creates only the fixed
pilot name, waits for identity material, then compares all six legacy
fingerprints before reporting success.

Expected non-null response fields:

- `instance_identity.principal_id`
- `instance_identity.client_id`
- `blueprint.principal_id`
- `blueprint.client_id`
- `blueprint_reference.type` equal to `ManagedAgentIdentityBlueprint`
- `blueprint_reference.blueprint_id`

Preserve the command's JSON output. It contains the pilot immutable ID and the
identity and blueprint IDs needed for verification and rollback.

## Graph and ingestion verification

Set values from the preserved create evidence; do not infer them from names.

```bash
export PILOT_AGENT_ID='<immutable-agent-id>'
export PILOT_PRINCIPAL_ID='<instance_identity.principal_id>'
export PILOT_CLIENT_ID='<instance_identity.client_id>'
export PILOT_BLUEPRINT_PRINCIPAL_ID='<blueprint.principal_id>'

az rest --method get \
  --resource https://ai.azure.com \
  --url "${FOUNDRY_PROJECT_ENDPOINT}/agents/agent-sentinel-identity-pilot-readonly-v1?api-version=v1"

az rest --method get \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/${PILOT_PRINCIPAL_ID}?\$select=id,appId,displayName,servicePrincipalType"

az rest --method get \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/${PILOT_PRINCIPAL_ID}/microsoft.graph.agentIdentity?\$select=id,appId,displayName,servicePrincipalType,agentIdentityBlueprintId"

az rest --method get \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/${PILOT_BLUEPRINT_PRINCIPAL_ID}?\$select=id,appId,displayName,servicePrincipalType"
```

Require exact equality:

- Foundry `principal_id` = Graph `id`
- Foundry `client_id` = Graph `appId`
- subtype `@odata.type` = `#microsoft.graph.agentIdentity`
- subtype `servicePrincipalType` = `ServiceIdentity`
- subtype `agentIdentityBlueprintId` = Foundry `blueprint.client_id`
- blueprint service-principal `id` = Foundry `blueprint.principal_id`
- blueprint service-principal `appId` = Foundry `blueprint.client_id`

Both reads use Microsoft Graph v1.0. Production correlation continues to use
the stable service-principal inventory and the exact object ID.

The jobs service discovers immediately at startup and then every
`DISCOVERY_INTERVAL_MS` (default five minutes). After create, either wait for
the next scheduled run or restart only the jobs revision under the normal
deployment procedure. Do not restart the API/web applications and do not run
the six-agent provision or cleanup commands.

Query the authenticated live read model:

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer ${AGENT_SENTINEL_ACCESS_TOKEN}" \
  -H "x-agent-sentinel-estate-id: ${AGENT_SENTINEL_ESTATE_ID}" \
  "${AGENT_SENTINEL_API_ORIGIN}/api/demo/state" \
  > "${PILOT_EVIDENCE_DIR}/pilot-state.json"

jq --arg name agent-sentinel-identity-pilot-readonly-v1 \
  '[.snapshot.nodes[] | select(.kind=="agent" and .name==$name)] | length' \
  "${PILOT_EVIDENCE_DIR}/pilot-state.json"

jq '[.snapshot.edges[] | select(.relationship=="RUNS_AS")] | length' \
  "${PILOT_EVIDENCE_DIR}/pilot-state.json"

PILOT_NODE_ID="$(
  jq -r --arg name agent-sentinel-identity-pilot-readonly-v1 \
    '.snapshot.nodes[] | select(.kind=="agent" and .name==$name) | .id' \
    "${PILOT_EVIDENCE_DIR}/pilot-state.json"
)"
IDENTITY_NODE_ID="$(
  jq -r --arg id "${PILOT_PRINCIPAL_ID}" \
    '.snapshot.nodes[] |
     select(.kind=="identity" and
       ((.metadata.providerObjectId // "") | ascii_downcase)==($id | ascii_downcase)) |
     .id' "${PILOT_EVIDENCE_DIR}/pilot-state.json"
)"
jq --arg from "${PILOT_NODE_ID}" --arg to "${IDENTITY_NODE_ID}" \
  '[.snapshot.edges[] |
    select(.relationship=="RUNS_AS" and .from==$from and .to==$to)] | length' \
  "${PILOT_EVIDENCE_DIR}/pilot-state.json"
```

Acceptance requires:

- seven authoritative Foundry agents and the original six immutable IDs;
- one pilot node with the exact Foundry principal/client metadata;
- one and only one `RUNS_AS` edge, from the pilot agent node to the Entra
  identity whose provider object ID equals `PILOT_PRINCIPAL_ID`;
- correlation diagnostics report one exact object-ID match, zero ambiguity,
  and the six legacy agents remain explicitly unmatched for missing provider
  identity IDs;
- no new `CAN_READ`, `CAN_EXFILTRATE_TO`, or other downstream authorization
  edge for the pilot.

## Rollback

First preserve the create output, Foundry GET, Graph responses, and post-refresh
snapshot in protected audit storage. Then authorize deletion with the exact
immutable pilot ID:

```bash
pnpm foundry:identity-pilot -- cleanup --apply \
  --agent-id "${PILOT_AGENT_ID}" \
  --confirm "DELETE:agent-sentinel-identity-pilot-readonly-v1:${PILOT_AGENT_ID}" \
  | tee "${PILOT_EVIDENCE_DIR}/foundry-identity-pilot-cleanup.log"
```

Cleanup refuses any legacy name, mismatched ID, missing marker, missing pilot
metadata, or incomplete identity. After matching that ID to the one fixed pilot
name, it calls the stable delete endpoint for that name, verifies the pilot is
absent, and verifies all six legacy fingerprints are unchanged.

Foundry owns the lifecycle of the service-created agent identity and blueprint.
There is no separate direct Graph deletion in this runbook. After propagation,
verify the subtype read returns `404` or the directory object is present only
in deleted items. If Foundry documents a supported orphan-cleanup operation,
use it only after proving the object IDs came from the preserved pilot evidence;
never delete by display name and never delete the project identity.

Finally allow or trigger one jobs discovery cycle and require six agents, zero
pilot `RUNS_AS` edges, and unchanged legacy IDs. Retain the audit evidence
instead of deleting it.

## Risks

- Entra identity and deletion propagation are eventually consistent.
- The `agentIdentity` subtype read needs separate `AgentIdentity.Read.All`
  approval even though it is available in Microsoft Graph v1.0.
- A create can succeed before local verification receives the identity fields;
  preserve the fixed name and provider response for controlled cleanup.
- Any real tool connection or role assignment changes the risk boundary and is
  outside this pilot.

## Official references

- [Microsoft Foundry agent identity concepts](https://learn.microsoft.com/azure/foundry/agents/concepts/agent-identity)
- [New Foundry agent object model](https://learn.microsoft.com/azure/foundry/agents/how-to/migrate-agent-applications)
- [Foundry RBAC](https://learn.microsoft.com/azure/foundry/concepts/rbac-foundry)
- [Microsoft Graph v1.0 get agentIdentity](https://learn.microsoft.com/graph/api/agentidentity-get?view=graph-rest-1.0)
- [Azure AI Projects Python SDK release history](https://github.com/Azure/azure-sdk-for-python/blob/main/sdk/ai/azure-ai-projects/CHANGELOG.md)
