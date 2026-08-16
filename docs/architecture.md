# Agent Sentinel – Architecture

## Overview
Agent Sentinel is a platform for discovering, mapping, and remediating AI agent exposure in enterprise environments. It consists of a React SPA (web), a Fastify REST API (api), and a background job worker (jobs) running on Azure Container Apps.

## Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Azure Front Door (Premium + WAF)             │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
           ┌────────────────────┴────────────────────┐
           ▼                                         ▼
  ┌─────────────────┐                    ┌─────────────────┐
  │  ACA: web       │                    │  ACA: api       │
  │  (nginx+React)  │◄──── REST ────────►│  (Fastify)      │
  └─────────────────┘                    └────────┬────────┘
                                                  │
           ┌────────────────┬─────────────────────┤
           ▼                ▼                     ▼
  ┌──────────────┐  ┌──────────────┐   ┌──────────────────┐
  │ Cosmos DB    │  │ PostgreSQL   │   │  AI Search (S1)  │
  │ (snapshots,  │  │ (findings,   │   │  (vector RAG)    │
  │  graph)      │  │  val. runs)  │   └──────────────────┘
  └──────────────┘  └──────────────┘
                                         ┌──────────────────┐
  ┌──────────────────────────────────────►│  AI Foundry      │
  │   ACA: jobs                          │  (gpt-5.4,       │
  │   (SB worker)                        │  embeddings)     │
  └──────────────┬──────────────────────┘└──────────────────┘
                 │
        ┌────────▼────────┐
        │  Service Bus    │
        │  (Premium)      │
        └─────────────────┘
```

## Packages
- **@agent-sentinel/domain** – Zod schemas, domain types, repository interfaces
- **@agent-sentinel/persistence** – Cosmos DB and PostgreSQL repository implementations
- **@agent-sentinel/search** – AI Search index schema, ingestion, RAG search
- **@agent-sentinel/messaging** – Service Bus event contracts, idempotency primitives
- **@agent-sentinel/graph-engine** – Attack path computation
- **@agent-sentinel/policy-engine** – Policy evaluation
- **@agent-sentinel/connector-sdk** – Connector base abstractions
- **@agent-sentinel/scenarios** – Scenario fixtures

## Security
- All inter-service communication uses Managed Identity (UAMI)
- No local auth / connection strings stored in code
- Key Vault (Premium) for secrets at rest
- Private Endpoints for all PaaS services
- VNet integration for ACA
