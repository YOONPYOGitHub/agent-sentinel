# Known issues

Last reviewed **2026-08-23**.

| ID     | Issue                                                      | Impact                                                                        | Unblock condition                                                               |
| ------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| KI-001 | Deployed auth mode is disabled                             | No real employee identity or role enforcement in Azure                        | Complete API/SPA registration and the authentication activation checklist       |
| KI-002 | WAF blocks all pre-auth API mutations                      | Authenticated Terra POST and remediation execution cannot use the public edge | Validate JWT write scopes, then narrow the rule                                 |
| KI-003 | Runtime telemetry connector is planned                     | Quality, reliability, cost, drift, and token economics remain unknown         | Implement `azure-monitor-otel`                                                  |
| KI-004 | Governance work queue is not implemented                   | Posture is read-only; approvals and exception lifecycle are absent            | Complete the persistent approval-gated workflow                                 |
| KI-005 | Only Foundry supplies live inventory data                  | Cross-platform inventory coverage is incomplete                               | Authorize and implement additional connectors                                   |
| KI-006 | Application Gateway is HTTP-only and management-controlled | It is unsuitable as the final sign-in redirect and may stop                   | Use the active Front Door HTTPS edge; add final domain ownership when available |
| KI-007 | Private CI runner may be deallocated                       | Queued builds do not start until the VM runs                                  | Start the runner before builds or add approved scheduling                       |
| KI-008 | Runner identity has image-push permission only             | Automated infrastructure deployment and what-if fail                          | Grant separately reviewed deployment RBAC or retain manual deployment           |

Missing evidence is an expected state, not a healthy state. Do not close an
issue by replacing a failed live signal with mock data.
