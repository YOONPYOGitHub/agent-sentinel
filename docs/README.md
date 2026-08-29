# Agent Sentinel documentation

Documentation index for the Agent Sentinel control plane. Last reviewed **2026-08-28** against branch `feature/multi-source-otel`.

Start with the [root README](../README.md) for the value proposition, quick start, and the live-vs-mock truth table.

---

## Product

| Document                                | Read this when you need to…                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Product overview](product-overview.md) | Understand personas, workflows, the three catalog surfaces, the Agent 365 boundary, and the AI/LLM boundary. |
| [Domain context](CONTEXT.md)            | Learn the shared vocabulary and the invariants every feature must honour.                                    |
| [Roadmap](roadmap.md)                   | See phased delivery, what is Service Tree-dependent, and each phase's definition of done.                    |

## Engineering

| Document                                                              | Read this when you need to…                                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [Architecture](architecture.md)                                       | Understand the runtime topology, network boundaries, public edges, the custom manifest adapter, and package layout.                   |
| [Data model](data-model.md)                                           | Look up domain types, the manifest envelope contract, Cosmos containers, PostgreSQL tables, search indexes, and Service Bus entities. |
| [Development](development.md)                                         | Set up the canonical WSL workflow, run the test pyramid, follow branch and commit practice, and develop the custom manifest adapter.  |
| [Foundry live agents](foundry-live-agents.md)                         | Provision, validate, or clean up the six synthetic Microsoft Foundry validation agents.                                               |
| [Power Platform connector](power-platform-connector.md)               | Configure and review the disabled-by-default ResourceQuery inventory connector and its authorization boundary.                        |
| [Agent 365 connector](agent365-connector.md)                          | Review the disabled-by-default Graph v1.0 package catalog contract, licensing, consent, bounds, and evidence semantics.               |
| [Defender for Cloud Apps connector](defender-cloud-apps-connector.md) | Review the disabled-by-default OAuth alert/activity evidence contract, privacy boundary, bounds, and activation gate.                 |
| [Purview connector](purview-connector.md)                             | Review the disabled-by-default Graph v1.0 sensitivity-label catalog, privacy model, bounds, and tenant-consent gate.                  |
| [Teams distribution connector](teams-distribution-connector.md)       | Review the disabled-by-default Graph v1.0 organization app catalog evidence contract and its explicit installation blind spot.        |
| [Corporate onboarding](internal-onboarding.md)                        | Repeat Service Tree, Feature Alias, and corporate Entra onboarding without storing private identifiers.                               |

## Operations

| Document                                                  | Read this when you need to…                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [Deployment](deployment.md)                               | Deploy infrastructure, build images on the private runner, or perform a surgical Container App update. |
| [Runbooks](runbooks.md)                                   | Execute a named operational procedure (RB-001 onward).                                                 |
| [Supply chain](supply-chain.md)                           | Understand immutable image tagging, the private build path, and registry retention.                    |
| [DR design](dr-design.md)                                 | Review recovery objectives and failover behaviour.                                                     |
| [Security and authentication](security-authentication.md) | Review threat boundaries, Entra roles, auth states, and the activation checklist.                      |

## Decisions

| Document                                                  | Decision                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| [ADR 0001](adr/0001-modular-monolith.md)                  | Start as a modular monolith with independently testable packages.     |
| [ADR 0002](adr/0002-evidence-first-deterministic-core.md) | Use an evidence-first deterministic core; LLMs summarize, never rule. |

## Status

| Document                            | Read this when you need to…                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Current status](current-status.md) | Get the dated ledger of what is complete, in progress, blocked, and pending, plus the validation baseline. |
| [Known issues](known-issues.md)     | Check a known limitation, its impact, and its unblock condition before filing a defect.                    |

---

## Documentation conventions

Every statement in these documents carries an explicit maturity label. The labels are used consistently and mean exactly this:

| Label                           | Meaning                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Current**                     | Implemented on `feature/multi-source-otel` and covered by tests.                                          |
| **Live**                        | Running against a real Azure service in the deployed environment.                                         |
| **Live declared configuration** | Real data read from a real source, describing what was _configured_ — not what was _observed_ at runtime. |
| **Future runtime evidence**     | Requires an implemented telemetry connector to be configured against an authorized measured source.       |
| **Synthetic**                   | Backed by the six purpose-built Microsoft Foundry validation agents, not by customer workloads.           |
| **Mock-only**                   | Served by a deterministic in-repository fixture or provider.                                              |
| **Planned**                     | Designed and catalogued, not implemented.                                                                 |
| **Blocked**                     | Implemented or designed, but cannot proceed until a named external dependency clears.                     |

Additional rules for contributors:

- Never document a metric that cannot be reproduced by a command in this repository.
- Never include credentials, tokens, personal email addresses, subscription IDs, tenant IDs, or local absolute user paths. Generic WSL paths such as `~/project/agent-sentinel` are fine.
- Missing evidence lowers confidence; it never implies safety. Documentation must not describe an absent signal as a pass.
