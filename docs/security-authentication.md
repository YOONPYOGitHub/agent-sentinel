# Security and authentication

## Current posture

The authentication and RBAC implementation is present in code, but the deployed
environment remains `AUTH_MODE=disabled`. Writes remain disabled and the WAF
blocks pre-auth API mutations.

## Roles

| Role          | Capability boundary                                         |
| ------------- | ----------------------------------------------------------- |
| Viewer        | Read inventory, evidence, posture, and connector state      |
| Analyst       | Viewer plus validation, advisory, and remediation proposals |
| Approver      | Analyst plus approval decisions                             |
| Administrator | Approver plus remediation execution and configuration       |

The API validates tenant, audience, signature, scopes, and roles. It returns a
sanitized principal and never exposes raw tokens or the complete claim set.

## Activation checklist

- [x] Service Tree record created under the confirmed owning hierarchy
- [ ] Separate API and SPA app registrations created
- [ ] API read/write scopes and four app roles configured
- [ ] Front Door HTTPS callback and logout URIs registered
- [ ] Least-privilege permissions reviewed and consented
- [ ] Runtime configuration populated through the secret path
- [ ] Live employee sign-in validated
- [ ] `401` and `403` behavior validated
- [ ] All four role-to-capability mappings validated with live tokens
- [ ] `AUTH_MODE=jwt` deployed
- [ ] Authorized write smoke test passed
- [ ] WAF mutation rule narrowed without permitting anonymous writes

Do not relax the WAF or enable writes before JWT validation succeeds.

## Emergency rollback

Restore the previous deployment revision, disable writes, and restore the
pre-auth mutation block. Revoke newly granted permissions if the activation
exposed an incorrect audience, tenant, scope, or role mapping.

Corporate onboarding details are in
[internal-onboarding.md](internal-onboarding.md).
