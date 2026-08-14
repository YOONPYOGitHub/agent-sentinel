# Agent Sentinel domain context

## Product boundary

Agent Sentinel is a cross-platform AI Agent Operations and Security control
plane. It consumes authoritative data from Microsoft and third-party systems;
it does not recreate their native administration.

## Product pillars

- **Discover:** inventory and ownership across agent platforms.
- **Govern:** policy, exceptions, approvals, and compliance evidence.
- **Protect:** exposure, validation, incidents, and response.
- **Observe:** reliability, quality, activity, latency, and cost.
- **Optimize:** evidence-backed recommendations and outcome verification.
- **Lifecycle:** release, promotion, drift, rollback, and retirement.

## Shared language

- **Agent estate:** all agents and their versions, identities, capabilities,
  owners, environments, and dependencies within a tenant.
- **Evidence graph:** typed assets and relationships whose claims always cite a
  source, confidence, freshness, and observation timestamp.
- **Attack path:** an evidence-backed sequence from an untrusted origin to a
  sensitive data asset or high-impact action.
- **Blast radius:** assets, data, actions, users, and downstream agents reachable
  from a selected node or compromised path.
- **Validation:** a bounded, non-destructive test that changes a theoretical
  finding into validated or not reproduced.
- **Remediation:** an authorized, auditable, idempotent action that reduces
  exposure and has a defined rollback posture.
- **Trust Catalog:** governed Agents, MCP servers, tools, models, and connectors
  with provenance, permissions, validation, exposure, usage, and lifecycle
  evidence.

## Invariants

- Missing evidence lowers confidence; it never implies safety.
- No finding or relationship exists without evidence.
- No impactful action executes without authorization and approval context.
- Tenant and environment boundaries apply below the UI.
- LLM output may summarize evidence but does not establish security truth.
