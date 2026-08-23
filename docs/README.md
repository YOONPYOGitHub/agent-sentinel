# Agent Sentinel documentation

Documentation index for the Agent Sentinel control plane. Last reviewed **2026-08-23** against branch `feature/live-exposure`.

Start with the [root README](../README.md) for the value proposition, quick start, and the live-vs-mock truth table.

---

## Product

| Document                                | Read this when you need to…                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Product overview](product-overview.md) | Understand personas, workflows, the three catalog surfaces, the Agent 365 boundary, and the AI/LLM boundary. |
| [Domain context](CONTEXT.md)            | Learn the shared vocabulary and the invariants every feature must honour.                                    |
| [Roadmap](roadmap.md)                   | See phased delivery, what is Service Tree-dependent, and each phase's definition of done.                    |

## Engineering

| Document                                       | Read this when you need to…                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Architecture](architecture.md)                | Understand the runtime topology, network boundaries, public edges, and package layout.                  |
| [Data model](data-model.md)                    | Look up domain types, Cosmos containers, PostgreSQL tables, search indexes, and Service Bus entities.   |
| [Development](development.md)                  | Set up the canonical WSL workflow, run the test pyramid, and follow branch and commit practice.         |
| [Foundry live agents](foundry-live-agents.md)  | Provision, validate, or clean up the six synthetic Microsoft Foundry validation agents.                 |
| [Corporate onboarding](internal-onboarding.md) | Repeat Service Tree, Feature Alias, and corporate Entra onboarding without storing private identifiers. |

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
| **Current**                     | Implemented, merged on `feature/live-exposure`, and covered by tests.                                     |
| **Live**                        | Running against a real Azure service in the deployed environment.                                         |
| **Live declared configuration** | Real data read from a real source, describing what was _configured_ — not what was _observed_ at runtime. |
| **Future runtime evidence**     | Requires a telemetry connector that does not exist yet.                                                   |
| **Synthetic**                   | Backed by the six purpose-built Microsoft Foundry validation agents, not by customer workloads.           |
| **Mock-only**                   | Served by a deterministic in-repository fixture or provider.                                              |
| **Planned**                     | Designed and catalogued, not implemented.                                                                 |
| **Blocked**                     | Implemented or designed, but cannot proceed until a named external dependency clears.                     |

Additional rules for contributors:

- Never document a metric that cannot be reproduced by a command in this repository.
- Never include credentials, tokens, personal email addresses, subscription IDs, tenant IDs, or local absolute user paths. Generic WSL paths such as `~/project/agent-sentinel` are fine.
- Missing evidence lowers confidence; it never implies safety. Documentation must not describe an absent signal as a pass.
