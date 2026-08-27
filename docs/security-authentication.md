# Security and authentication

## Current posture

The API and SPA authentication foundation is implemented but deliberately inactive. The deployed
configuration remains `AUTH_MODE=disabled`, `AGENT_SENTINEL_WRITE_ENABLED=false`, and the
`BlockApiMutationPreAuth` WAF rule still blocks every non-`GET`/`HEAD`/`OPTIONS` request under
`/api/`.

The single-tenant API and SPA app registrations now exist. The API exposes the delegated read and
write scopes and the four app roles below. The SPA requests those API permissions, but no redirect
or logout URI, tenant consent, role assignment, or runtime activation has been applied.

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

## Temporary redirect-host decision

The repository does **not** establish a safe deployed HTTPS redirect URI today:

- Azure Front Door has a default HTTPS hostname in the template, but repository deployment records
  say its private-link origin provisioning is `NotStarted` and it is not routing traffic.
- The active Application Gateway endpoint is HTTP-only. It is not an acceptable production SPA
  redirect URI.

Do not register the Front Door hostname merely because the resource emits one. It is eligible as a
temporary development redirect only after read-only Azure checks show the endpoint enabled, both
routes linked to the default domain, private-link/origin provisioning successful, origin health
healthy, and an unauthenticated HTTPS SPA smoke test succeeds. Otherwise provision an approved
HTTPS custom domain first. Keep redirect parameters empty until one condition is evidenced.

## Staged activation

Each stage is a separate approved change. Stop and roll back on any mismatch.

1. **Establish the HTTPS origin.** Record evidence for the Front Door prerequisites above or finish
   the custom-domain/TLS path. Register that exact SPA redirect URI and same-origin logout URI.
2. **Approve identity grants.** Review delegated permissions, grant the required tenant consent,
   and assign one least-privilege test principal/group per app role. Do not assign broad groups by
   default.
3. **Activate authentication only.** Deploy the typed values with `AUTH_MODE=jwt` while retaining
   `AGENT_SENTINEL_WRITE_ENABLED=false` and the WAF mutation block. Verify employee login,
   anonymous `401`, Viewer `403`, and the four read-only capability boundaries.
4. **Validate a private write.** On an approved private endpoint, set the write switch only for the
   bounded test and run an authenticated, reversible write. The public WAF block remains intact.
5. **Narrow the WAF.** Only after the private test passes, approve the smallest path/method change.
   Repeat the full validator through the public HTTPS edge and prove anonymous mutation is still
   denied. Never treat WAF as JWT validation; API authorization remains authoritative.

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
pnpm auth:validate-live
```

For the approved write phase, additionally set `AUTH_VALIDATION_PHASE=write`,
`AUTH_VALIDATION_WRITE_METHOD`, `AUTH_VALIDATION_WRITE_PATH`, optional JSON
`AUTH_VALIDATION_WRITE_BODY`, and the exact 2xx `AUTH_VALIDATION_WRITE_EXPECTED_STATUS`. Choose a
bounded, reversible target from the approved test plan; the script intentionally does not guess a
mutation endpoint or resource identifier.

## Activation checklist

- [x] Separate API and SPA app registrations created
- [x] API read/write scopes and four exact app roles created
- [x] Typed fail-closed API, SPA, deployment, and validation configuration prepared locally
- [x] Approved HTTPS redirect and logout origin evidenced
- [x] Redirect and logout URIs registered
- [ ] Least-privilege delegated permissions reviewed and consented
- [ ] Test principals/groups assigned to all four roles
- [ ] `AUTH_MODE=jwt` deployed with writes disabled and WAF unchanged
- [ ] Live employee sign-in, `401`, `403`, and four role boundaries validated
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
