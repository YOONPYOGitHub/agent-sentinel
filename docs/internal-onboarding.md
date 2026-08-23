# Corporate onboarding

Internal onboarding runbook for Agent Sentinel. This document records the
repeatable process without storing personal contacts, tenant identifiers,
Service Tree identifiers, or app registration identifiers.

## Why Service Tree is required

Service Tree establishes accountable Microsoft ownership for the service. It
is not a billing mechanism and does not deploy or expose the application.
Corporate Microsoft Entra app registration requires the resulting Service Tree
record so that identity assets have an owner, lifecycle, and support path.

## Registration decision

Before creating a service:

1. Search for an existing service whose owning organization and product scope
   match Agent Sentinel.
2. Reuse it only when the accountable owner confirms that Agent Sentinel
   belongs to that service.
3. Do not reuse a convenient hackathon or lab service owned by an unrelated
   organization.
4. Create a new service under the confirmed owning hierarchy when no correct
   service exists.

For Agent Sentinel, unrelated hackathon and lab records were reviewed and
rejected. A new service was created under the confirmed
`MCAPS > GES Asia > Korea` hierarchy.

## Registered metadata

| Field                     | Value            |
| ------------------------- | ---------------- |
| Service name              | `Agent Sentinel` |
| Short name                | `AgentSentinel`  |
| Service type              | Online Service   |
| Service subtype           | Azure            |
| Cloud                     | Public           |
| Microsoft-owned           | Yes              |
| External-facing           | No               |
| Lifecycle                 | In Development   |
| Next stage                | Private Preview  |
| Estimated next-stage date | 2026-09-30       |

The service has a project owner for development and program management, a
second administrator for continuity, and a private team alias. Exact identities
and generated identifiers belong in approved corporate systems, not Git.

## Feature alias

Use a dedicated Microsoft 365 group rather than a personal address.

- Private membership
- Internal-only sensitivity label
- External senders disabled
- At least two owners
- Project members added with least privilege
- Alias entered in Service Tree without the `@microsoft.com` suffix

The current alias is represented in repository documentation as
`<feature-alias>@microsoft.com`. Resolve the real value in the approved
corporate directory.

## Permission and approval process

If the correct hierarchy is visible but not selectable:

1. Do not register under a different hierarchy.
2. Ask the confirmed Service Group administrator for registration permission
   or the correct placement.
3. Include the service purpose, requested hierarchy, ownership model, and
   whether a record was already created.
4. Resume only after the owner confirms the target hierarchy.
5. Record completion in [current-status.md](current-status.md), without personal
   correspondence or ticket identifiers.

Agent Sentinel completed this process and the Service Tree record now exists.

## API app registration checklist

Create a separate single-tenant API app:

- Associate it with the Agent Sentinel Service Tree record.
- Do not configure a browser redirect URI.
- Expose delegated scopes `AgentSentinel.Read` and `AgentSentinel.Write`.
- Define app roles for `Viewer`, `Analyst`, `Approver`, and `Administrator`.
- Keep role and scope identifiers in the deployment secret store.
- Grant only the permissions required by the API.

## SPA app registration checklist

Create a separate single-tenant SPA app:

- Associate it with the same Service Tree record.
- Register the Front Door HTTPS callback and logout URIs.
- Add delegated permission to the Agent Sentinel API.
- Do not add a client secret to the browser application.
- Grant tenant consent only after the requested permissions are reviewed.

## Activation and rollback

Activation:

1. Populate tenant, API audience, client, scope, and role settings through the
   deployment secret path.
2. Validate sign-in and all four roles before changing the write posture.
3. Deploy `AUTH_MODE=jwt`.
4. Confirm anonymous requests return `401` and insufficient roles return `403`.
5. Validate an authorized write path.
6. Only then narrow the pre-auth mutation WAF rule.

Rollback:

1. Restore the previous Container Apps revision or set
   `AUTH_MODE=disabled` only with `writeEnabled=false`.
2. Restore the WAF rule that blocks pre-auth mutations.
3. Revoke grants or role assignments added for the failed activation.
4. Record the observed failure without copying tokens or full claims.

See [security-authentication.md](security-authentication.md) and
[runbooks.md](runbooks.md) for operational details.

## Work that does not depend on Service Tree

The governance work queue, lifecycle evidence, runtime telemetry connector,
behavior drift, token economics, universal adapters, shift-left scanning, and
business-value evidence can proceed independently. Service Tree was a gate for
corporate identity registration, not for product development.

## Data prohibited in Git

Do not commit:

- Personal email addresses or correspondence
- Service Tree, tenant, subscription, or app registration identifiers
- Access tokens, secrets, certificates, or full token claims
- Screenshots containing corporate directory details
- Approval ticket identifiers

Store generated identifiers in approved deployment configuration or corporate
systems. Keep only sanitized completion state and placeholders in this
repository.
