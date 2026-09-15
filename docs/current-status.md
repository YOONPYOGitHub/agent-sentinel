# Current status

**Status date: 2026-09-15** · Integration branch: `feature/production-readiness-r1` · Deployed SHA: `7c1336bc`

This is the authoritative dated ledger for the Agent Sentinel control plane. It separates repository capability, deployed state, provider access, and evidence quality. Missing evidence is never a pass. For operating instructions and next work, use the [maintainer handoff](maintainer-handoff.md).

## Release boundary

| Boundary       | Current truth                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository     | Wednesday handoff branch `work/wednesday-handoff-astra-r1` starts at `3c30327902f925078ebfe37c4414975b73e75561`; this base is not deployed. The final PR must record its own reviewed full SHA. |
| Deployed code  | `7c1336bc7985ea7e383c335d631b7c705fffb97c` is the verified deployed integration SHA, not the current repository head. |
| Live URL       | The reference deployment is reachable at `https://agent-sentinel-dadmh3cee9edbwha.b01.azurefd.net`. This URL identifies the current reference environment, not a portable tenant default. |
| Web            | Revision `web-as-m098047--p07c1336bc`; digest `sha256:7dca740d6d7161fc57a14a0cc79a8488e25a12cf2c0ea37f8cd677188c13e267`.                                                                  |
| API            | Revision `api-as-m098047--p07c1336bc`; digest `sha256:b43991c120161b73737d492847bd2c3e8dbb6fe33408e4ac49fac6fa01de13a7`.                                                                  |
| Jobs           | Revision `jobs-as-m098047--p07c1336bc`; digest `sha256:7918fa5fc0f207e11cc7b22c0a340cb40926369265c622085bab27bddf132ecc`.                                                                 |
| Authentication | Replacement API/SPA registrations and service principals exist. `AUTH_MODE=disabled`; admin consent, user role assignment, and live JWT validation remain incomplete.                     |
| Writes         | `AGENT_SENTINEL_WRITE_ENABLED=false`. Remediation and manifest ingestion are not live capabilities.                                                                                       |
| Edge           | Front Door is the active HTTPS edge. Its WAF has no evidenced custom mutation rule. The mutation rule on the stopped Application Gateway does not protect Front Door.                     |
| Estate         | One reference Foundry source contains six synthetic validation agents and no production customer agents.                                                                                  |

A Git commit or image publication alone does not prove deployment. The immutable values above are the verified runtime boundary for this status date.

## Repository-only gap

배포 코드 `7c1336bc7985ea7e383c335d631b7c705fffb97c` 이후 handoff base까지의 차이입니다.
문서 변경이나 Git merge는 Azure revision을 갱신하지 않습니다.

| Git commit | 저장소 변경 | Azure 경계 |
| --- | --- | --- |
| `c63cded7788534c8109021a8b4b21bbbde37f081` | `7c1336bc` catalog UX 배포 사실을 문서화 | 별도 배포가 아닌 기록 |
| `614b39424880abefb3cf7e48b9f456b1a5172833` | Foundry instance identity 지원 | 미배포; 현재 exact `RUNS_AS` 0을 해소한 증거가 아님 |
| `b0dce4d1854d13ba01f86ccc041b77f01a7f2e78` | External runtime instrumentation SDK | 미배포; qualifying live telemetry 발생 증거가 아님 |
| `06ed453a43884e197e5b31ee37b8cb96a8046f71` | 격리된 Foundry identity pilot 계획·도구 | 미배포; 신규 pilot 승인·생성 없음 |
| `3c30327902f925078ebfe37c4414975b73e75561` | SDK image packaging 및 readiness timing 수정 | 미배포; handoff 작업의 Git base |

Auth scaffolding/activation hardening과 release-review v2 **도구는 이미 `7c1336bc` 배포 코드에
포함**되어 있습니다. JWT 활성화·consent/roles 완료·실제 reviewer 승인과는 별개입니다.
향후 범위는 [runtime 계약](external-runtime-instrumentation.md)과
[Foundry pilot 계약](foundry-identity-pilot.md)을 참고하되 데모 중 실행하지 않습니다.

## Wednesday freeze boundary

**2026-09-16 수요일 18:00 KST는 내부 candidate 동결 목표**입니다. 최종 `main` PR은
Catalog → synthetic Foundry 한 레코드 → Exposure evidence → Lifecycle/Release readiness를
정직하게 보여 주고 인계하는 범위이며, **전체 production go-live나 미완료 승인 면제는 아닙니다**.
현재 readiness는 partial, auth disabled, writes false이며 human release approvals는 대기 중입니다.

- 리허설·미관찰·실패는 구분하여 [5분 데모와 동결 체크리스트](maintainer-handoff.md#5-minute-demo)에 기록합니다. 이 문서 변경은 새 배포나 live 재검증을 수행한 것이 아닙니다.
- 외부 consent/roles·JWT 활성화·identity/OTel 증거·write guard·human review는 아래 [승인 backlog](#human-approvals-still-open)로 남기며, 마감 때문에 권한이나 기능을 확장하지 않습니다.
- [내부 사용자 과제](maintainer-handoff.md#small-real-user-task-protocol)는 선택 사항이며 현재 미실시입니다. 측정된 고객 시간·비용 절감은 없고 신규 Foundry pilot도 승인·생성되지 않았습니다.

## Current implementation and live state

| Area                        | Repository state                                                                                                 | Deployed/evidence state                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web, API, jobs              | TypeScript monorepo with persisted live read models                                                              | Web, API, and jobs are live behind Front Door at the same verified full SHA and immutable digests listed above.                                                                                       |
| Evidence graph and policies | Deterministic graph and `AS-POL-001..003` exposure evaluation are implemented                                    | Live findings use jobs-persisted snapshots; attack-path legacy fixtures remain mock-only.                                                                                                             |
| Governance                  | Durable cases, guarded transitions, exceptions, and audit evidence are implemented                               | Public mutation remains blocked; remediation is simulation-only.                                                                                                                                      |
| Multi-estate isolation      | Estate context, partitioning, source scoping, and mismatch rejection are implemented                             | Only the reference replacement estate is evidenced live.                                                                                                                                              |
| Connector source plane      | Strict non-secret schemas, ETags, idempotency, immutable audit, and deployment-source protection are implemented | The reference environment's `connector-sources` container and deployment-managed source bindings are provisioned and in use. New tenants must create their own isolated container and source records. |
| Authentication              | JWT validation, MSAL, four roles, preflight, registration bootstrap, and protected workflows are implemented     | Replacement registrations are created, but admin consent and the test-principal role assignment are blocked on an active Entra application-administrator role; JWT remains disabled.                  |
| Release evidence            | Versioned offline generator, schema, validator, and deterministic release-review v2 are implemented              | Tooling is included in the `7c1336bc` deployed code baseline but runs offline; this does not attest review execution. Human Security, Accessibility, OneRAI, and release decisions remain pending external gates. |
| Release readiness           | Shared operational evaluator, CLI, and web page are implemented                                                  | **Partial:** Agent 365 is ready; `RUNS_AS` has 0 edges; OTel has 0 qualifying live records; authentication is disabled; writes are false. Ready is evidence for review, not release approval.         |

## Connector ledger

Detailed state definitions and limits are in [connector availability](connector-availability.md).

| Connector                         | Current state                                      | Evidence boundary / blocker                                                                                                                                            |
| --------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure AI Foundry                  | **Connected**                                      | One source; six authoritative synthetic agents; declared configuration only.                                                                                           |
| Microsoft Entra inventory         | **Inventory connected; parity unmatched**          | 335 identity nodes; all six agents lack exact identity IDs; 0 `RUNS_AS` edges.                                                                                         |
| Azure Resource Graph              | **Connected for current authorized view**          | Five resources persisted; current scope is not proof of subscription-wide coverage.                                                                                    |
| Azure Monitor / OTel              | **Query connected; 0 qualifying live records**     | Query access exists, but there are no analysis-ready non-synthetic request/dependency/trace records with the required agent attributes and provenance.                 |
| Agent 365 package catalog         | **Deployed; ready and complete**                   | 308 packages produced 302 agent-package nodes, 6 extension-package nodes, and 308 live source-bound evidence records. Package count remains distinct from agent count. |
| Microsoft 365 / SharePoint agents | **Covered by deployed Agent 365 classification**   | Classification comes only from package metadata; there is no SharePoint scraping connector.                                                                            |
| Defender for Cloud Apps           | **Connected, valid-empty**                         | Current bounded alert/activity reads return zero records; no evidence nodes or agent joins are inferred.                                                               |
| Purview sensitivity labels        | **Connected**                                      | Twelve bounded label definitions; no usage, content, user, agent, trust, or compliance claim.                                                                          |
| Teams organization catalog        | **Connected, valid-empty**                         | Zero organization entries; no installation or distribution coverage claim.                                                                                             |
| Power Platform ResourceQuery      | **Implemented; unattended activation unsupported** | Microsoft does not provide a production-supported app-only inventory permission with enforceable scope.                                                                |
| Business outcomes                 | **Contract complete; not configured**              | No authoritative exact-correlated outcome source; value remains unknown.                                                                                               |
| Custom manifest adapter           | **Implemented; activation-gated**                  | Offline validation/scanning works; live ingestion is blocked by auth, writes, and active-edge requirements.                                                            |

## Evidence facts that must not be overstated

- The six Foundry agents are synthetic validation agents, not production customer agents.
- Foundry returns declared agent/tool configuration, not observed runtime execution or authorization decisions.
- Agent 365's 308 packages are normalized into 302 agent-package nodes and 6 extension-package nodes; package totals must not be restated as a count of executing agents.
- `/agent-catalog` shows the 302 Agent 365 agent-package nodes plus the six explicitly synthetic Foundry validation agents for operators; extension-package controls are excluded.
- `/my-agents` remains a separate fail-closed personalized surface. Authentication is disabled and no authoritative entitlement source is configured; `/api/employee/agent-catalog` provides no personalized results. Enabling login alone would not establish entitlement.
- Valid-empty Defender and Teams results prove only that bounded requests returned zero rows.
- Purview label definitions do not prove label application or compliance.
- Azure Resource Graph scope reflects current role visibility, not full subscription coverage.
- Entra inventory does not establish `RUNS_AS`; exact agent-side identity identifiers are absent.
- OTel query access does not establish analysis readiness; there are 0 qualifying live records.
- The advisory model is explanatory only and remains mock on the public edge until the grounded provider path is activated.
- Release-review v2 is offline tooling. Its generated artifacts do not prove that human reviews or live release approval occurred.
- No measured customer savings are available. The optional small internal task protocol has not been run and cannot establish customer ROI.
- The checked-in `mngenvmcap098047-*` parameter files describe the current reference environment. They are not portable defaults and are not secrets merely because they contain tenant-specific resource names or non-secret identifiers.

## Active blockers

| Blocker                   | Current fact                                                                     | Required unblock                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Replacement auth          | API/SPA registrations and service principals exist; admin consent/role assignments remain incomplete and JWT is disabled | Human review of existing registrations, least-privilege consent/assignments, then protected read-only activation and live role validation; no duplicate registration creation. |
| Front Door writes         | Active WAF has no evidenced custom mutation rule                                 | Separately review, deploy, and rediscover an exact mutation rule after read-only JWT validation; writes stay false.              |
| Repository/deployment gap | Identity support, runtime SDK, pilot tooling, and packaging/timing changes through `3c303279` are not deployed | Keep the demonstrated Azure baseline separate; any later rollout requires approved full-SHA images, digests, surgical deployment, and fresh sanitized evidence. |
| `RUNS_AS`                 | Six Foundry agents expose no exact object/app/client/Agent Identity IDs          | Source supplies an exact authoritative identifier; no fuzzy fallback is permitted.                                               |
| OTel                      | 0 qualifying live records                                                        | Produce approved non-customer, complete, fresh, unsampled baseline and observed spans with exact provenance and measured fields. |
| Private deployment        | Runner availability and deployment RBAC require operator verification            | Human starts/verifies the runner and approves the exact role/deployment scope.                                                   |
| Platform drift            | The historical full what-if showed 54 unrelated modifications                    | Do not run full Bicep; reconcile drift separately or use only a reviewed surgical workflow.                                      |
| Manifest v2 cutover       | Compatibility container remains authoritative                                    | Human validates the copy and cutover plan before changing the active container.                                                  |
| Power Platform            | No supported unattended inventory authorization                                  | Wait for a production-supported app-only permission with enforceable scope.                                                      |
| Business value            | No authoritative outcome source or measured customer savings | Configure a read-only exact-correlated outcome source before claiming business outcomes; optional internal task timing is not customer ROI. |
| OneRAI                    | Product and legal/compliance onboarding is incomplete                            | Human owners complete the authoritative review path.                                                                             |

Agent 365 package-catalog connector deployment and the reference `connector-sources` provisioning are complete; they are not active blockers. This does not establish agent runtime execution.

## Human approvals still open

1. Human review of the already-created replacement API/SPA registrations against the exact plan; registration creation itself is not pending.
2. Least-privilege consent and assignment of Viewer, Analyst, Approver, and Administrator test principals/groups.
3. Private-runner start, immutable image build, and deployment environment review.
4. Surgical read-only auth activation by digest while writes remain false.
5. Front Door mutation-rule design and deployment before any write activation.
6. Representative OTel traffic and workspace-access approval.
7. Exact authoritative identity identifiers for all six Foundry agents.
8. Optional broader Azure Resource Graph Reader scope, only if full coverage is required.
9. OneRAI/product/legal review and final release decision.
10. Security and Accessibility evidence review and explicit human decisions, separately from release-review tooling availability.

이 항목들은 production backlog이며 Wednesday candidate 동결로 승인되지 않습니다. 승인 상태·
필요 증거만 기록하고 비공개 이메일 내용·thread ID·개인 연락처는 저장소에 복사하지 않습니다.

## Validation baseline

The last complete recorded repository baseline was measured on 2026-08-31 with Node 22. It is historical and does not attest `456d01f2` or this documentation commit.

| Check               | Recorded result                                        |
| ------------------- | ------------------------------------------------------ |
| Lint                | 48/48 tasks passed                                     |
| Typecheck           | 48/48 tasks passed                                     |
| Unit/contract tests | 901 tests passed                                       |
| Build               | 25/25 tasks passed                                     |
| Playwright          | 23 tests across 10 specs passed                        |
| Storybook build     | Passed with accessibility addon enabled                |
| Bicep build         | Passed with baseline warnings                          |
| Repository Prettier | Known unrelated drift existed; touched files must pass |

A clean checkout may need `pnpm build` before isolated script tests because several workspace packages publish `dist` entry points. See [development](development.md).

## Safe next boundary

A new maintainer can clone the repository and run deterministic mock mode without Azure or Microsoft 365 access. Live reproduction is a separate operator project: provision an independent tenant boundary, assign accountable owners, create least-privilege identities and permissions, deploy immutable images, and validate source-bound evidence. Follow [new tenant bootstrap](new-tenant-bootstrap.md).

For the current reference environment, the post-freeze production path is: reproduce a clean local baseline → review existing registrations and complete approved consent/role assignments → build full-SHA images → record digests → activate read-only JWT surgically with writes false → validate all four roles and Front Door behavior → establish exact `RUNS_AS` and representative OTel evidence → generate validated sanitized release evidence → obtain independent human release decisions. This is not the Wednesday demo scope.

Do not deploy, access cloud/private data, mutate permissions, or run provider validators from an ordinary coding task.
