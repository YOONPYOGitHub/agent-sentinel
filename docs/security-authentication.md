# Security and authentication

## Current posture

The API JWT validator, four-role RBAC, SPA MSAL integration, redirect bridge,
and token-driven live validator are implemented and tested in repository code.
That implementation state is not the deployed state.

The last evidenced replacement deployment uses `AUTH_MODE=disabled` and
`AGENT_SENTINEL_WRITE_ENABLED=false`. The `BlockApiMutationPreAuth` WAF rule
still blocks every non-`GET`/`HEAD`/`OPTIONS` request under `/api/`. Historical
read-only employee JWT validation from the previous deployment does not prove
authentication in the replacement deployment.

The corporate API and SPA registrations are reusable, but replacement Front
Door redirect/logout registration and runtime JWT parameters still require
approved activation and fresh live validation.

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

Before stage 1, copy `infra/auth/replacement-auth-activation.template.json` outside the repository,
replace every placeholder with approved non-secret values, and run:

```bash
pnpm auth:preflight -- --input /secure/local/path/auth-activation.json \
  --output auth-activation-plan.json
```

The input contract is checked in at `infra/auth/auth-activation-input.schema.json`. The command is
offline, rejects secret/token-shaped fields, validates the exact Front Door origin, redirect and
logout paths, tenant-derived v2 issuer/JWKS, disjoint scopes, four exact roles, estate grants,
writes-false, WAF-block posture, commit SHA, and immutable API/web digests. Exit code `0` means the
sanitized plan is ready for human review; exit code `2` means blocked. It does not inspect or mutate
Entra or Azure.

1. **Read-only activation — pending in the replacement deployment.** Register
   the exact replacement HTTPS redirect/logout URIs, inject the fail-closed JWT
   settings with writes false, then prove anonymous `401`, Viewer `403`,
   `/api/auth/me`, sign-in, and logout.
2. **Complete role validation.** Assign least-privilege test principals/groups for Analyst,
   Approver, and Administrator and verify every documented capability boundary. Do not assign
   broad groups by default.
3. **Validate a private write.** On an approved private endpoint, set the write switch only for the
   bounded test and run an authenticated, reversible write. The public WAF block remains intact.
4. **Narrow the WAF.** Only after the private test passes, approve the smallest path/method change.
   Repeat the full validator through the public HTTPS edge and prove anonymous mutation is still
   denied. Never treat WAF as JWT validation; API authorization remains authoritative.

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

- [x] Separate API and SPA app registrations created
- [x] API read/write scopes and four exact app roles created
- [x] Typed fail-closed API, SPA, deployment, and validation configuration prepared locally
- [ ] Replacement HTTPS redirect and logout origin approved and evidenced
- [ ] Replacement redirect and logout URIs registered
- [ ] Replacement read-only delegated permission reviewed and usable by the validation principal
- [ ] Test principals/groups assigned to all four roles
- [ ] `AUTH_MODE=jwt` deployed to the replacement environment with writes disabled and WAF unchanged
- [ ] Replacement employee sign-in, logout, anonymous `401`, Viewer `403`, and `/api/auth/me` validated
- [ ] Analyst, Approver, Administrator, and all four role boundaries validated with live tokens
- [ ] Private authenticated write smoke test passed
- [ ] WAF rule narrowly changed and public anonymous denial revalidated

OneRAI or corporate service onboarding can proceed independently; it does not block local auth
engineering. It also does not substitute for identity, consent, role-assignment, deployment, or WAF
approval.

## Emergency rollback

1. Restore `BlockApiMutationPreAuth` in Prevention mode before any other relaxation is reverted.
2. Set `AGENT_SENTINEL_WRITE_ENABLED=false` and restore the last known-good Container Apps revision.
3. Return to `AUTH_MODE=disabled` only while writes remain false and the full mutation block is in
   place.
4. Remove incorrect role assignments or consent grants through the approved identity process.
5. Record status codes and correlation IDs only; never copy tokens, personal claims, or secrets.
