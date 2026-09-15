# Agent Sentinel documentation

Documentation index for the Agent Sentinel control plane. Last reviewed
**2026-09-14** against `feature/production-readiness-r1`.

Start with the [root README](../README.md) for product value and the live-vs-mock boundary. The [maintainer handoff](maintainer-handoff.md) is the single operational continuation guide.

## Recommended reading paths

- **Evaluator:** [root README](../README.md) → [product overview](product-overview.md) → [current status](current-status.md) → [connector availability](connector-availability.md) → [release evidence](release-evidence.md).
- **Maintainer or coding agent:** [maintainer handoff](maintainer-handoff.md) → [new tenant bootstrap](new-tenant-bootstrap.md) → [domain context](CONTEXT.md) → [architecture](architecture.md) → [data model](data-model.md) → [development](development.md) → [known issues](known-issues.md).
- **Operator:** [current status](current-status.md) → [new tenant bootstrap](new-tenant-bootstrap.md) → [deployment](deployment.md) → [runbooks](runbooks.md) → [security and authentication](security-authentication.md) → [supply chain](supply-chain.md) → [DR design](dr-design.md).
- **Release reviewer:** [maintainer handoff](maintainer-handoff.md) → [current status](current-status.md) → [release evidence](release-evidence.md) → [connector availability](connector-availability.md) → [known issues](known-issues.md).

## Product

| Document                                                   | Read this when you need to…                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Product overview](product-overview.md)                    | Understand personas, workflows, catalog surfaces, product boundaries, and evidence semantics. |
| [Domain context](CONTEXT.md)                               | Learn the shared vocabulary and invariants every feature must honor.                          |
| [Roadmap](roadmap.md)                                      | See code readiness, activation state, dependencies, and definitions of done.                  |
| [Product specification](../agent-sentinel-product-spec.md) | Review the durable product requirements and scope.                                            |

## Engineering

| Document                                                                | Read this when you need to…                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [Maintainer handoff](maintainer-handoff.md)                             | Continue work safely from the current repository and deployment truth.                   |
| [Architecture](architecture.md)                                         | Understand runtime topology, boundaries, and package layout.                             |
| [Data model](data-model.md)                                             | Look up domain contracts, storage models, indexes, and messaging entities.               |
| [Development](development.md)                                           | Set up WSL, run checks, and follow repository conventions.                               |
| [External runtime instrumentation](external-runtime-instrumentation.md) | Emit privacy-safe invocation spans accepted by the Azure Monitor connector.              |
| [New tenant bootstrap](new-tenant-bootstrap.md)                         | Separate mock use, live read access, operator access, approvals, and ownership transfer. |
| [Foundry live agents](foundry-live-agents.md)                           | Understand the six synthetic validation agents and operator-only lifecycle.              |
| [Agent 365 connector](agent365-connector.md)                            | Review the deployment-only package catalog contract and limits.                          |
| [Azure Resource Graph connector](azure-resource-graph-connector.md)     | Review bounded cloud-resource inventory and scope semantics.                             |
| [Entra identity connector](entra-identity-connector.md)                 | Review exact identity correlation and `RUNS_AS` rules.                                   |
| [Power Platform connector](power-platform-connector.md)                 | Review the unsupported unattended-authorization boundary.                                |
| [Defender connector](defender-cloud-apps-connector.md)                  | Review the bounded privacy-reduced alert/activity contract.                              |
| [Purview connector](purview-connector.md)                               | Review the sensitivity-label catalog and its usage blind spot.                           |
| [Teams connector](teams-distribution-connector.md)                      | Review the organization app catalog and distribution blind spot.                         |
| [Corporate onboarding](internal-onboarding.md)                          | Follow human-owned service and corporate identity onboarding.                            |

## Operations and status

| Document                                                  | Read this when you need to…                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [Current status](current-status.md)                       | Get the authoritative dated ledger of repository, deployment, connector, and blocker truth.                               |
| [Connector availability](connector-availability.md)       | Distinguish implementation, provider access, deployment, and evidence quality.                                            |
| [Known issues](known-issues.md)                           | Check named limitations and exact unblock conditions.                                                                     |
| [Deployment](deployment.md)                               | Review approved deployment boundaries and the surgical rollout path.                                                      |
| [Runbooks](runbooks.md)                                   | Execute a named operational procedure (RB-001 onward).                                                                    |
| [Security and authentication](security-authentication.md) | Review auth states, roles, active-edge requirements, and activation gates.                                                |
| [Supply chain](supply-chain.md)                           | Understand private builds, full-SHA tags, digests, and provenance.                                                        |
| [Release evidence](release-evidence.md)                   | Generate and validate sanitized release evidence plus Security, Accessibility, and OneRAI dry-run review bundles offline. |
| [DR design](dr-design.md)                                 | Review recovery objectives and failover behavior.                                                                         |

## Decisions and documentation governance

| Document                                                  | Purpose                                                |
| --------------------------------------------------------- | ------------------------------------------------------ |
| [ADR 0001](adr/0001-modular-monolith.md)                  | Modular-monolith decision.                             |
| [ADR 0002](adr/0002-evidence-first-deterministic-core.md) | Evidence-first deterministic-core decision.            |
| [Document lifecycle](document-lifecycle.md)               | Authority, review dates, archival, and deletion rules. |

## Documentation conventions

| Label                           | Meaning                                                                  |
| ------------------------------- | ------------------------------------------------------------------------ |
| **Current**                     | Implemented on the canonical branch and covered by repository evidence.  |
| **Live**                        | Observed against a real deployed service with dated, sanitized evidence. |
| **Live declared configuration** | Real provider configuration, not observed runtime behavior.              |
| **Synthetic**                   | Purpose-built validation data, never customer or production evidence.    |
| **Mock-only**                   | Deterministic in-repository fixture/provider.                            |
| **Planned**                     | Designed or ordered, not implemented.                                    |
| **Blocked**                     | A named external dependency prevents activation or validation.           |

Contributor rules:

- Never document a metric that cannot be reproduced by a repository command or sanitized observation.
- Never include secrets, credentials, tokens, personal email addresses, tenant/subscription identifiers, or user-specific absolute paths.
- Missing evidence lowers confidence; it never implies safety.
- Prefer updating an authoritative document over adding another status or handoff file.
