# Document lifecycle

Last reviewed **2026-09-14**.

## Authority classes

- **Current operational truth:** `current-status.md`, `connector-availability.md`, `known-issues.md`, and `maintainer-handoff.md`. These require a review date and must agree on repository, deployment, connector, and blocker state.
- **Durable product and engineering reference:** the product specification, `CONTEXT.md`, ADRs, architecture, data model, development, security, deployment, runbooks, supply chain, release evidence, DR, onboarding, and connector documents. Update these when their contract or procedure changes.
- **Design/history:** accepted ADRs and explicitly historical evidence may remain when they explain a durable decision. They must not present themselves as current operational state.
- **Ephemeral plans:** implementation plans, scratch specifications, review notes, and superseded handoffs are not long-term documentation.

## Maintenance rules

1. Update the existing authoritative document; do not create a parallel status ledger or handoff.
2. Date claims that can become stale and name the evidence boundary: repository, deployed, provider-observed, synthetic, or planned.
3. After implementation merges, fold durable behavior into reference docs and delete unreferenced plans/specs.
4. Archive only material with lasting decision value. Otherwise delete it and remove every reference.
5. Before merge, validate relative links, search for removed paths, run Prettier on touched Markdown, and reconcile contradictions across the four current-truth documents.
6. Never retain secrets, private identifiers, personal contacts, raw provider data, or local absolute user paths in documentation.
