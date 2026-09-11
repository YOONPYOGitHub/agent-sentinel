# Microsoft Entra identity connector

`@agent-sentinel/entra-identity-connector` is a read-only, authorization-gated
multi-source connector. It does not share configuration or consent with
`AUTH_*` user sign-in. `AUTH_*` controls employee/API authentication;
`ENTRA_*` controls provider inventory and enrichment. Neither prefix activates
or supplies configuration for the other.

## Supported live boundary

The mandatory path uses Microsoft Graph v1.0
`GET /servicePrincipals` with an explicit field projection. It creates distinct
identity nodes and authoritative evidence. It never correlates by display name:
a `RUNS_AS` edge is emitted only when an explicit `ENTRA_RUNS_AS_BINDINGS_JSON`
entry exactly binds the estate, globally scoped Foundry and Entra source IDs,
tenant, source environments, providers, Foundry project ID, and Entra inventory
tenant. Foundry and Entra source tenants may differ when both endpoints match
their independently registered exact source metadata in the same estate. The
Foundry agent must then expose a complete, non-conflicting exact
service-principal object ID. Agent Identity object IDs are eligible only when
the separately enabled preview read confirms that classification.
Application/client-ID-only matches remain unmatched until the connector emits a
distinct application-ID authority; they never compare an application ID with a
service-principal object ID. Names, aliases, owners, tags, descriptions, shared
`primary` IDs, and fuzzy text are never correlation keys.

Microsoft Entra tenant, inventory-source, principal, and binding GUIDs are
validated as GUIDs and canonicalized to lowercase when parsed. Authority and
graph comparisons remain case-insensitive at persisted boundaries, so casing
differences cannot suppress an otherwise exact `RUNS_AS` match; malformed IDs
still fail closed.

Before any Microsoft Graph request, the client decodes the access-token payload
and requires a valid GUID `tid` claim that canonically matches the configured
source tenant. Missing, malformed, or cross-tenant tokens fail as authentication
errors without issuing the request.

Each endpoint must attach exactly one matching authoritative evidence record
whose typed authority matches node metadata for estate, source, tenant,
environment, provider, source object, provider object, source release, and
source snapshot generation. The edge must cite those exact two endpoint
records, and edge-state simulations must retain the exact registered
`runsAsBinding`. Duplicate node or evidence IDs are rejected before Entra
composition indexes them. Correlation GUID ownership is keyed by identifier
kind and the exact estate/source/tenant/environment boundary, allowing
legitimate reuse across boundaries while rejecting ambiguity within one
boundary. Unattached or multiple matching authority records and stale,
synthetic, malformed, unregistered, cross-estate, or cross-project evidence
cannot traverse `RUNS_AS`. A source tenant may differ from the estate tenant;
live request and ingestion boundaries resolve the estate independently and
validate source authority against registered source and endpoint metadata.
Microsoft Agent 365 package `appId` values remain catalog metadata and never
establish an Entra principal identity.

Optional stable capabilities are separately gated:

- `ENTRA_CONNECTOR_OWNERS_ENABLED=true` reads each inventory principal's
  `/owners` collection.
- `ENTRA_CONNECTOR_APP_ROLES_ENABLED=true` reads app roles granted to each
  inventory principal from `/appRoleAssignments`.

Both use `Application.Read.All`. They have shared page/item bounds and report a
typed degraded state on failure; stable inventory remains truthful. Sponsors
are deliberately excluded because the preview endpoint currently requires
`AgentIdentity.ReadWrite.All`, which violates this connector's read-only
least-privilege boundary.

`ENTRA_CONNECTOR_AGENT_IDENTITY_PREVIEW=true` independently enables the
Microsoft Graph beta
`/servicePrincipals/microsoft.graph.agentIdentity` endpoint. It requires
`AgentIdentity.Read.All`, is labeled preview, defaults off, and can degrade
without failing v1.0 inventory.

## Migration parity diagnostics

Inventory connectivity and migration parity are distinct:

- connectivity means the bounded Microsoft Graph v1.0 inventory read
  succeeded;
- parity additionally measures authoritative agents considered, exact
  service-principal object-ID matches, exact application/client-ID matches,
  preview-confirmed Agent Identity matches, unmatched agents, ambiguous agents,
  and emitted `RUNS_AS` edges;
- diagnostics retain the exact source ID, tenant, environment, and evidence
  references used for the result;
- owner, app-role, and preview coverage each has an independent status.

Disabled or failed optional reads do not become zero coverage. Their diagnostic
status remains `disabled`, `authorization-required`, or `degraded`, and numeric
coverage is omitted. Stable inventory and successful exact correlations remain
usable when only an optional capability fails.

All requests use `DefaultAzureCredential`, the
`https://graph.microsoft.com/.default` scope, HTTPS-only
`graph.microsoft.com`, strict projected response schemas, same-resource
next-link validation, bounded pagination, request timeouts, and retries only
for 429/500/502/503/504 responses carrying a bounded `Retry-After`. Response
bodies are streamed through a configured byte limit, with both
`Content-Length` and actual bytes enforced before JSON parsing.
Multi-source enrichment accepts at most 50 configured sources, runs at most
four source reads concurrently, and applies one 60-second aggregate deadline.
Caller cancellation is propagated through token acquisition, retry waits, and
Graph requests. Cancellation and deadline outcomes remain `cancelled`, but the
aggregator waits for every provider execution that already started to settle
before returning. Results are composed in configured source order even when
provider calls complete out of order.

## Configuration

See `.env.example`. `ENTRA_CONNECTOR_ENABLED` is reserved as the activation
gate. API `GET /api/connectors` exposes per-source readiness without marking a
healthy Foundry source failed when optional Entra enrichment is awaiting
consent. Jobs report partial success when primary discovery succeeds but Entra
does not. Stable inventory or composition failures remain partial and are not
persisted, so a transient Graph failure cannot erase the last complete state.
Optional-only degradation reports partial success but preserves the complete
stable v1.0 inventory and exact `RUNS_AS` correlations. A successful zero-row
probe or inventory remains insufficient and non-ready. There is no mock
fallback.

For multiple Foundry tenant/project sources, set `ENTRA_SOURCES_JSON` for each
directory inventory and `ENTRA_RUNS_AS_BINDINGS_JSON` for the explicit
many-project-to-one-inventory relationships. In Bicep deployments, use the
`entraRunsAsBindingsJson` parameter; `platform.bicep` validates its JSON and
projects it only to the API and jobs container apps. Entra source IDs are independent
from Foundry source IDs. One estate-scoped Entra inventory is queried once and
may be bound to multiple Foundry projects only when every binding names the
complete exact same-tenant source boundary. Identity nodes and evidence are
namespaced by the globally scoped `entra:<id>` identity; Foundry nodes use
`foundry:<id>`. Missing bindings remain unattributed and make identity coverage
partial; missing source authorization remains `authorization-required` and is
never substituted with another tenant or inventory.
Per-source health also retains a typed data state: `complete` for a non-empty
bounded inventory, `partial` when optional evidence is degraded, `empty` for a
successful zero-record inventory, `unsupported` for a disabled or unmatched
configuration, `failed` for provider/composition failure, and `cancelled` for
caller or aggregate deadline cancellation. Empty, partial, unsupported,
failed, or cancelled sources never become complete live identity coverage.

For the single-source legacy path, `ENTRA_CONNECTOR_TENANT_ID` and
`ENTRA_CONNECTOR_ENVIRONMENT` form one required tuple: configuring either
without the other is invalid. Non-empty `ENTRA_SOURCES_JSON` takes precedence
over that tuple. The same mode-aware resolver drives jobs activation and
deployment-source projection; mock mode neither parses nor exposes inactive
Entra sources.

Same-tenant sources use the default managed identity credential. Cross-tenant
sources use `credential.mode=federated-app`, the target-tenant app client ID,
and the attached UAMI (`managedIdentityClientId` or `AZURE_CLIENT_ID`) as the
secretless assertion issuer.

Next, obtain tenant-admin consent for `Application.Read.All`, configure the
tenant/environment values, then enable and validate bounded v1.0 inventory.
Separately review `AgentIdentity.Read.All` before enabling beta enrichment.

The last replacement-tenant observation recorded 6 authoritative Foundry
agents, 335 Entra identity nodes, and 0 `RUNS_AS` edges. It predates this exact
binding contract and is not validation of it. Both the historical and
replacement Foundry validation agents exposed null instance identity and null
Agent Identity blueprint reference, so no current principal attribution can be
claimed. `AUTH_MODE=disabled` is a separate corporate sign-in state and does not
affect inventory. After deployment, the integration owner must supply reviewed
explicit bindings and fresh replacement-tenant evidence before validating any
considered, unmatched, ambiguous, exact-match, or emitted-edge count.
