# Connector availability

Status date: **2026-08-29**.

This ledger separates implementation state from live availability. A connector
is not described as connected merely because its code exists or an application
permission was assigned.

## State definitions

| State                         | Meaning                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Connected                     | A bounded live read succeeded and its evidence can be composed into the estate snapshot.                     |
| Configured, provider-blocked  | Code, credentials, and intended read permission exist, but the provider rejects or cannot serve the request. |
| Licensing-blocked             | The provider workload or API is unavailable until the tenant receives the prerequisite product license.      |
| Approval-required             | A new permission, role, credential, or write-path change needs explicit review before activation.            |
| Telemetry-insufficient        | The source is queryable, but measured samples do not meet the evidence threshold.                            |
| Implemented, activation-gated | Code is complete, but the deployed safety posture intentionally prevents live ingestion.                     |
| Not implemented               | No production connector exists; mock or manifest evidence must remain explicitly non-live.                   |

## Current connector matrix

| Connector                                   | Implementation         | Live state in the current tenant                          | Why it is limited                                                                                                                                                                                                 | Becomes available when                                                                                                                 | Development allowed now                                                                                                                                        |
| ------------------------------------------- | ---------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure AI Foundry Agent Service              | Complete, multi-source | **Connected**                                             | One live Foundry project is configured; additional projects need their own authorization boundary.                                                                                                                | Add an approved source credential and Azure AI User access for each project.                                                           | Discovery, strict contract validation, multi-source aggregation, source health, and declared tool metadata.                                                    |
| Microsoft Entra service-principal inventory | Complete, multi-source | **Connected**                                             | Stable v1.0 inventory is live. Current Foundry agents expose no authoritative identity ID, so `RUNS_AS` correlation is empty. Owner/app-role reads and preview Agent Identity classification are separate scopes. | Foundry exposes an exact identity ID; optional reads require separate least-privilege approval.                                        | Exact-ID correlation, bounded owner/app-role enrichment, health, and no-match UX. Do not correlate by display name.                                            |
| Azure Resource Graph                        | Complete, multi-source | **Connected for the current authorized view**             | The application UAMI query is live and persisted 5 visible resources. Its existing resource-scoped roles do not prove full subscription coverage. It does not require M365 E5.                                    | Keep the current least-privilege view, or separately approve broader Reader scope if complete subscription inventory is required.      | Fixed-query Azure AI and supporting-resource inventory, provenance, multi-subscription boundaries, and source health. Never infer that a resource is an agent. |
| Azure Monitor and OpenTelemetry             | Complete, multi-source | **Connected query path; telemetry-insufficient analysis** | The workspace query is live and 6 benign agent spans were ingested, but the baseline has 0 samples and the minimum is 10 per evaluated population.                                                                | Collect representative measured traffic across both baseline and observed windows.                                                     | Instrumentation, benign synthetic telemetry, freshness/coverage UX, drift, reliability, latency, and measured-only token economics.                            |
| Microsoft Purview sensitivity-label catalog | Complete, multi-source | **Connected**                                             | Catalog definitions do not prove label use, content protection, user activity, agent attribution, trust, or compliance.                                                                                           | A separately reviewed supported usage source supplies those facts.                                                                     | Label-definition evidence, pagination/contract safety, provenance, and catalog health.                                                                         |
| Power Platform ResourceQuery                | Complete, multi-source | **Configured, provider-blocked**                          | Dedicated read roles exist, but ResourceQuery returns HTTP 403. This is provider authorization or service-principal support, not an M365 E5 dependency proven by current evidence.                                | The role propagates or the provider/support team confirms and enables the supported service-principal read path.                       | Schema fixtures, bounded paging, sanitized failure reasons, retry behavior, and partial-source composition. Do not report inventory as empty or healthy.       |
| Microsoft Agent 365 package catalog         | Complete, multi-source | **Licensing-blocked**                                     | `CopilotPackages.Read.All` is assigned, but the current tenant lacks the active M365 E5 prerequisite and Agent 365 product license.                                                                               | The replacement tenant has active M365 E5, Agent 365 is provisioned, and the application permission is consented there.                | Package mapping, M365/SharePoint coverage, contract-drift handling, catalog UX, and tests. No live success claim.                                              |
| Microsoft 365 and SharePoint agents         | Covered by Agent 365   | **Licensing-blocked**                                     | These packages use the Agent 365 catalog. There is no separate approved SharePoint scraping connector.                                                                                                            | Agent 365 prerequisites above are satisfied.                                                                                           | Package-type classification and entitlement-safe UX without reading SharePoint content.                                                                        |
| Microsoft Teams organization app catalog    | Complete, multi-source | **Licensing-blocked**                                     | `AppCatalog.Read.All` is assigned, but the tenant Teams backend is disabled and returns `AADSTS500014`.                                                                                                           | Teams Enterprise Trial or another eligible Teams license provisions the backend, then a catalog-only live read succeeds.               | Bounded organization-catalog mapping, `not-available` classification, pagination, and tests. Do not enumerate teams, chats, users, groups, or installations.   |
| Microsoft Defender for Cloud Apps           | Complete, multi-source | **Licensing-blocked**                                     | Read permission exists, but the tenant has no active Defender for Cloud Apps workload or tenant portal.                                                                                                           | An eligible M365 E5/Defender entitlement provisions the workload and the exact portal/API origin is approved.                          | Privacy-reduced alert/activity contracts, unattributed evidence, failure handling, and tests. Do not infer agent joins.                                        |
| Custom manifest adapter                     | Complete               | **Implemented, activation-gated**                         | Offline validation and scanning work. Live API ingestion is blocked by writes-false and the public pre-auth mutation WAF rule.                                                                                    | Administrator role and write scope pass live validation, the private write smoke test succeeds, and the WAF rule is narrowly reviewed. | Offline manifests, third-party examples, first-party reconciliation, validation, and shift-left scanning.                                                      |
| MCP gateway telemetry                       | Not implemented        | **Not implemented**                                       | No approved authoritative gateway source and contract is configured.                                                                                                                                              | Select a real gateway, document its supported telemetry API/schema, and approve the read boundary.                                     | Domain contract and fixtures only after a real provider contract is selected.                                                                                  |

## Tenant transition impact

- The current Managed Environment remains usable for the hackathon and for
  license-independent Azure, Foundry, Entra, Purview, application, and telemetry
  work.
- Its Microsoft 365 licenses are deprovisioned. Additional M365 workload
  activation should target the replacement tenant rather than attempting to
  restore this tenant.
- The replacement Managed Environment request is awaiting approval and does not
  yet have a Tenant ID.
- M365 E5 alone does not automatically prove every connector available:
  - Agent 365 also needs the Agent 365 product license and Graph consent.
  - Teams needs an eligible Teams license and backend provisioning.
  - Defender needs its workload provisioned and an approved portal/API path.
  - Power Platform remains a separate ResourceQuery authorization issue.
- Exact request, tenant, subscription, and support identifiers are kept in the
  git-ignored local handoff, not this repository document.

## Activation rules

1. Keep every new connector disabled by default.
2. Use only documented read APIs and least-privilege application or Azure RBAC.
3. Validate tenant, subscription, environment, and source boundaries on every response.
4. Fail closed on malformed or truncated provider data.
5. Preserve provider failure as typed health; never replace it with mock success.
6. Map direct cloud resources as control/evidence unless an authoritative API identifies an agent.
7. Require separate approval before adding permissions, widening RBAC, enabling writes, or changing the WAF.
