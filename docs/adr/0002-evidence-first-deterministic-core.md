# ADR 0002: Use an evidence-first deterministic core

- Status: Accepted
- Date: 2026-08-14

## Context

Security findings and automated responses must be explainable and reproducible.
An LLM-only implementation would introduce non-determinism and unsupported
claims.

## Decision

Represent assets and relationships as typed evidence. Use deterministic policy
rules and graph traversal for findings, risk factors, paths, and blast radius.
LLMs may later summarize structured evidence but cannot create uncited facts or
authorize actions.

## Consequences

- Unit tests can prove security behavior without model access.
- Every UI claim can deep-link to evidence.
- Missing connector data is visible as reduced confidence.
- LLM integration can be added without changing the security source of truth.
