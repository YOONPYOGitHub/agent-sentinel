# Security and authentication

## Current posture

The API JWT validator, four-role RBAC, SPA MSAL integration, redirect bridge,
and token-driven live validator are implemented and tested in repository code.
That implementation state is not the deployed state.

The last evidenced replacement deployment uses `AUTH_MODE=disabled` and
`AGENT_SENTINEL_WRITE_ENABLED=false`. Replacement API and SPA app registrations do not yet exist.
Historical read-only employee JWT validation and prior-tenant registrations do not prove
replacement authentication.

The active public edge is Azure Front Door. Its WAF policy currently has managed rules but no
evidenced `BlockApiMutationPreAuth` custom rule. That rule exists on the stopped, HTTP-only
Application Gateway and does **not** protect Front Door traffic. The current safe read-only posture
therefore relies on the API write switch remaining false; write activation is prohibited until an
active Front Door mutation rule is reviewed, present, and verified together with JWT.

The repository now contains a disabled-by-default Front Door contract at
`infra/auth/frontdoor-authenticated-mutation-guard.contract.json`. It enumerates the exact public
mutation path/method pairs and blocks requests whose `Authorization` header is missing or is not a
three-segment Bearer-token shape. It creates no `Allow` rule and no `/api/*` wildcard. Token shape is
only an edge guard: the API remains the authority for JWT signature, tenant, audience, scope, role,
and write-switch enforcement.

## Roles

| Role          | Exact app-role value          | Capability boundary                                         |
| ------------- | ----------------------------- | ----------------------------------------------------------- |
| Viewer        | `AgentSentinel.Viewer`        | Read inventory, evidence, posture, and connector state      |
| Analyst       | `AgentSentinel.Analyst`       | Viewer plus validation, advisory, and remediation proposals |
| Approver      | `AgentSentinel.Approver`      | Analyst plus approval decisions                             |
| Administrator | `AgentSentinel.Administrator` | Approver plus remediation execution and configuration       |

Only the exact prefixed app-role values are accepted. The read delegated scope grants Viewer and
the write delegated scope grants Analyst at most; scopes never imply Approver or Administrator.
The API validates signature, exact tenant, audience, issuer, RS256, scopes, and roles. It exposes
only a sanitized principal.

## Runtime configuration contract

JWT startup fails closed unless all required values are present and valid. Live identifiers belong
in deployment parameters or approved configuration, not committed source.

| Setting                             | Requirement in JWT mode                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `AUTH_TENANT_ID`                    | Single-tenant directory UUID                                                   |
| `AUTH_AUDIENCE`                     | Exact `api://` or HTTPS application ID URI                                     |
| `AUTH_ISSUER`                       | Optional exact HTTPS issuer; empty derives the tenant-specific Entra v2 issuer |
| `AUTH_JWKS_URI`                     | Optional exact HTTPS JWKS URI; empty derives tenant-specific v2 discovery      |
| `AUTH_READ_SCOPES`                  | Non-empty exact `scp` claim values                                             |
| `AUTH_WRITE_SCOPES`                 | Non-empty, non-overlapping exact `scp` claim values                            |
| `AUTH_SPA_CLIENT_ID`                | SPA application UUID                                                           |
| `AUTH_SPA_SCOPES`                   | Fully qualified configured API scopes; empty requests read only                |
| `AUTH_SPA_REDIRECT_URI`             | Exact registered HTTPS URI, or `http://localhost` for local development        |
| `AUTH_SPA_POST_LOGOUT_REDIRECT_URI` | Same-origin exact post-logout URI                                              |

The API publishes these public SPA values at `/api/auth/config`. The SPA rejects a configuration
whose redirect origin differs from the origin serving the application. Silent token-renewal errors
are not converted into anonymous requests.

## Redirect-host decision

The active Azure Front Door HTTPS origin routes both the SPA and API and is the
intended replacement redirect and same-origin logout origin. The Application
Gateway endpoint remains HTTP-only and is not an acceptable authentication
origin. Redirect registration and JWT activation must be validated together;
route health alone does not establish authentication.

## Staged activation

Each stage is a separate approved change. Stop and roll back on any mismatch.

Before runtime activation, create the replacement registrations. Copy
`infra/auth/replacement-entra-registration-bootstrap.template.json` outside the repository, replace
placeholders with approved non-secret values, and generate a plan:

```bash
pnpm auth:registration-bootstrap -- \
  --input /secure/local/path/entra-registration-input.json \
  --output entra-registration-plan.json
```

The plan performs bounded Graph discovery, fails closed on ambiguous exact-name candidates and
historical/wrong-origin SPA entries, and contains deterministic request shapes for the API app and
service principal, delegated Read/Write scopes, four roles, SPA app and service principal, exact
redirect/logout URLs, and SPA Read access. It creates no secrets, certificates, consent grants,
groups, or role assignments. Apply requires the reviewed plan artifact, the exact tenant
confirmation, `APPROVE_ENTRA_REGISTRATION_BOOTSTRAP`, and the protected
`entra-registration-bootstrap` environment. Rollback deletes only directory objects created by
operation IDs from that plan.

Then copy `infra/auth/replacement-auth-activation.template.json` outside the repository and run the
offline runtime plan:

```bash
pnpm auth:preflight -- --input /secure/local/path/auth-activation.json \
  --output auth-activation-plan.json
```

After approved registration/runtime changes, run the bounded active-edge inspection from
`infra/auth/replacement-active-edge-preflight.template.json`:

```bash
pnpm auth:edge-preflight -- --input /secure/local/path/active-edge-input.json \
  --output active-edge-preflight.json
```

The active-edge report explicitly selects one safe read-only policy: one unambiguous associated
Front Door Prevention policy with the exact contract digest and rules, or `writeEnabled=false` with
no write activation allowed. Write-stage readiness always blocks on missing or multiple security
policies/WAF policies, digest drift, duplicate rules, any API `Allow` rule, inactive JWT, or a true
write switch.

1. **Read-only activation — pending in the replacement deployment.** Register
   the exact replacement HTTPS redirect/logout URIs, inject the fail-closed JWT
   settings with writes false, then prove anonymous `401`, Viewer `403`,
   `/api/auth/me`, sign-in, and logout.
2. **Complete role validation.** Assign least-privilege test principals/groups for Analyst,
   Approver, and Administrator and verify every documented capability boundary. Do not assign
   broad groups by default.
3. **Create the active-edge anonymous guard.** Review the exact contract digest, Bicep what-if, and
   `frontDoorAuthenticatedMutationGuardEnabled=true` parameter without changing the write switch.
   Deploy it separately from auth activation, then rediscover the one policy and all exact rules.
4. **Validate a bounded write.** Only after JWT and the reviewed Front Door contract both pass, use an
   approved private endpoint for one reversible write. Any later Front Door exception is a separate
   approval and must preserve anonymous API denial. WAF never replaces API authorization.
5. **Activate public writes separately.** A later reviewed deployment may change only
   `AGENT_SENTINEL_WRITE_ENABLED`; this repository change does not enable or deploy that switch.

The custom manifest ingestion endpoint is independently gated by JWT mode, the Administrator
`configure` capability, and `AGENT_SENTINEL_WRITE_ENABLED=true`. Its manifest tenant/environment
come from server estate configuration, never request fields or token claims. The token tenant
authenticates the caller and can legitimately differ from the Azure estate tenant.

## Repeatable live validation

The validator does not acquire, persist, or print tokens. Supply short-lived tokens and the tested
endpoint through the process environment. Read phase checks anonymous `401`, an insufficient-role
`403`, `/api/auth/me`, and every capability for all four roles:

```bash
AUTH_VALIDATION_BASE_URL=https://<approved-host> \
AUTH_VALIDATION_VIEWER_TOKEN=<short-lived-token> \
AUTH_VALIDATION_ANALYST_TOKEN=<short-lived-token> \
AUTH_VALIDATION_APPROVER_TOKEN=<short-lived-token> \
AUTH_VALIDATION_ADMINISTRATOR_TOKEN=<short-lived-token> \
AUTH_VALIDATION_EXPECTED_REDIRECT_ORIGIN=https://<approved-host> \
AUTH_VALIDATION_EXPECTED_API_SHA=<40-hex-sha> \
AUTH_VALIDATION_EXPECTED_API_IMAGE_DIGEST=sha256:<64-hex-digest> \
AUTH_VALIDATION_EXPECTED_WEB_SHA=<40-hex-sha> \
AUTH_VALIDATION_EXPECTED_WEB_IMAGE_DIGEST=sha256:<64-hex-digest> \
pnpm auth:validate-live
```

Expected web/API/jobs SHA and digest variables are optional and independently selectable. When
present, `/api/status` must match them. When `AUTH_VALIDATION_EXPECTED_REDIRECT_ORIGIN` is present,
the validator checks `/api/auth/config` for exactly `<origin>/auth-redirect.html` and
`<origin>/` before sending any token-bearing probes. JSON responses are capped at 256 KiB by
default; `AUTH_VALIDATION_MAX_RESPONSE_BYTES` may be set from 1024 through 1048576.

For the approved write phase, additionally set `AUTH_VALIDATION_PHASE=write`,
`AUTH_VALIDATION_WRITE_METHOD`, `AUTH_VALIDATION_WRITE_PATH`, optional JSON
`AUTH_VALIDATION_WRITE_BODY`, and the exact 2xx `AUTH_VALIDATION_WRITE_EXPECTED_STATUS`. Choose a
bounded, reversible target from the approved test plan; the script intentionally does not guess a
mutation endpoint or resource identifier.

## Activation checklist

- [ ] Replacement API and SPA app registrations created through the approved bootstrap plan
- [ ] Replacement API Read/Write scopes and four exact app roles created
- [x] Typed fail-closed API, SPA, registration, deployment, edge-preflight, and validation configuration prepared locally
- [ ] Replacement HTTPS redirect and logout origin approved and evidenced
- [ ] Replacement redirect and logout URIs registered
- [ ] Replacement read-only delegated permission reviewed and usable by the validation principal
- [ ] Test principals/groups assigned to all four roles
- [ ] `AUTH_MODE=jwt` deployed with reviewed image digests and writes disabled
- [ ] Replacement employee sign-in, logout, anonymous `401`, Viewer `403`, and `/api/auth/me` validated
- [ ] Analyst, Approver, Administrator, and all four role boundaries validated with live tokens
- [ ] Private authenticated write smoke test passed
- [ ] Exact Front Door contract digest and Bicep what-if approved
- [ ] Disabled-by-default Front Door anonymous-mutation guard deployed and rediscovered
- [ ] Public anonymous denial revalidated before any separate write-switch approval

OneRAI or corporate service onboarding can proceed independently; it does not block local auth
engineering. It also does not substitute for identity, consent, role-assignment, deployment, or WAF
approval.

## Emergency rollback

1. Set `AGENT_SENTINEL_WRITE_ENABLED=false` first and verify `/api/status`; do not remove or relax the
   Front Door anonymous guard while the write state is unknown.
2. Restore the reviewed Front Door Prevention-mode contract and digest. Do not rely on the stopped
   Application Gateway rule.
3. Restore the last known-good Container Apps revisions and immutable image digests.
4. Return to `AUTH_MODE=disabled` only while writes remain false; no public write activation is
   permitted without an active reviewed Front Door mutation rule.
5. Remove incorrect role assignments or consent grants through the approved identity process.
6. Record status codes and correlation IDs only; never copy tokens, personal claims, or secrets.
