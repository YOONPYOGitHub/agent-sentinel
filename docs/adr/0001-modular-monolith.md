# ADR 0001: Start as a modular monolith

- Status: Accepted
- Date: 2026-08-14

## Context

Agent Sentinel spans ingestion, evidence graphs, policy evaluation, attack-path
analysis, validation, approvals, remediation, and a web console. Premature
service boundaries would slow feedback and make domain changes expensive.

## Decision

Use a TypeScript monorepo with independently testable packages and two initial
deployables: a React web application and a Fastify API. Background behavior uses
explicit application services and ports so it can move to workers later.

## Consequences

- Domain boundaries are enforced through package APIs and dependency direction.
- The first vertical slice runs without cloud infrastructure.
- Connector, persistence, event bus, and remediation ports remain replaceable.
- Services may be extracted only after measured scaling or ownership needs.
