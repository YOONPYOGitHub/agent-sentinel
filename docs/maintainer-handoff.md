# Maintainer handoff

**Operational truth as of 2026-09-15** · Canonical integration branch: `feature/production-readiness-r1`

This is the single operational handoff for engineers and coding agents. Read [current status](current-status.md) for the dated ledger and [document lifecycle](document-lifecycle.md) before changing another status document. Versioned, sanitized release evidence overrides prose for a specific release; a repository commit never proves deployment.

## Product mission and non-negotiable evidence rules

Agent Sentinel is an evidence-first control plane that connects authoritative records for enterprise AI agents, identities, tools, data, telemetry, distribution, and cloud resources. It discovers and correlates evidence, computes deterministic exposure and assurance results, and supports auditable governance. It does not replace Agent 365, Foundry, Entra, Defender, Purview, Teams, or their authorization planes.

The required loop is **connect → discover → normalize → correlate → analyze → govern**.

Never violate these rules:

1. Mock, synthetic, empty, missing, stale, sampled, partial, or unattributed evidence cannot establish a live pass.
2. Preserve estate, tenant, environment, source, provider object ID, timestamp, freshness, confidence, and evidence references.
3. Correlate identities only by exact authoritative identifiers. Never use names, aliases, owners, or fuzzy matching.
4. Partial authoritative discovery must not overwrite the last complete snapshot or resolve earlier findings.
5. `unknown`, `insufficient-data`, `authorization-required`, `degraded`, and valid-empty are distinct states.
6. Policies and graph traversal establish security truth. The model may explain cited evidence but never create findings or authorize actions.
7. Live writes require JWT, exact capability checks, writes enabled, active-edge protection, idempotency, audit evidence, rollback, and human approval.
8. Do not broaden permissions, use preview APIs, or invent evidence to make a demo pass.

## Repository and architecture

The repository is a Node.js 22, pnpm 10, TypeScript, Turborepo monorepo.

| Area                                                                          | Responsibility                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                                                                    | React/Vite SPA, MSAL integration, operational and Release readiness surfaces                                                                                      |
| `apps/api`                                                                    | Fastify API, authentication/RBAC, read models, connector and governance routes                                                                                    |
| `apps/jobs`                                                                   | Scheduled/event-driven discovery, composition, snapshot persistence, policy evaluation                                                                            |
| `packages/domain`                                                             | Canonical entities, evidence, findings, estate and connector-source contracts                                                                                     |
| `packages/connector-sdk`                                                      | Connector contracts, health, manifest and operational readiness evaluator (`demo-readiness` compatibility export)                                                 |
| `packages/connector-runtime`                                                  | Source construction and bounded connector orchestration                                                                                                           |
| `connectors/*`                                                                | Read-only provider adapters for Foundry, Entra, Agent 365, Azure Monitor, Azure Resource Graph, Defender, Purview, Teams, Power Platform, outcomes, and manifests |
| `packages/persistence`                                                        | In-memory and Cosmos repositories, ETag and estate isolation behavior                                                                                             |
| `packages/policy-engine`, `packages/graph-engine`, `packages/behavior-engine` | Deterministic findings, paths, drift, reliability, and economics                                                                                                  |
| `packages/scenarios`                                                          | Explicit synthetic validation agents and fixtures                                                                                                                 |
| `packages/ui`                                                                 | Shared accessible design-system primitives and Storybook                                                                                                          |
| `packages/shift-left-scanner`, `tools`                                        | Offline manifest validation and pre-publication policy checks                                                                                                     |
| `scripts`                                                                     | Auth planning, live validators, Release readiness, Foundry helpers, release evidence                                                                              |
| `infra`                                                                       | Bicep modules, environment parameters, private runner, identity, edge, and data services                                                                          |

The runtime is a modular monolith deployed as web, API, and jobs Container Apps. Jobs compose bounded connector reads into one estate snapshot in Cosmos; API surfaces read that persisted state. See [architecture](architecture.md) and [data model](data-model.md).

## Version truth

- `feature/production-readiness-r1` is the canonical integration branch for this handoff; `7c1336bc7985ea7e383c335d631b7c705fffb97c` is the verified deployed head.
- Live base URL: `https://agent-sentinel-dadmh3cee9edbwha.b01.azurefd.net`.
- Web: revision `web-as-m098047--p07c1336bc`, digest `sha256:7dca740d6d7161fc57a14a0cc79a8488e25a12cf2c0ea37f8cd677188c13e267`.
- API: revision `api-as-m098047--p07c1336bc`, digest `sha256:b43991c120161b73737d492847bd2c3e8dbb6fe33408e4ac49fac6fa01de13a7`.
- Jobs: revision `jobs-as-m098047--p07c1336bc`, digest `sha256:7918fa5fc0f207e11cc7b22c0a340cb40926369265c622085bab27bddf132ecc`.
- All three components report SHA `7c1336bc7985ea7e383c335d631b7c705fffb97c`; authentication and writes remain disabled.
- Wednesday handoff branch: `work/wednesday-handoff-astra-r1`, based on `3c30327902f925078ebfe37c4414975b73e75561`. This repository base is **not deployed**. See the exact [Git/Azure gap](current-status.md#repository-only-gap); the final PR must record its own reviewed full SHA separately.

## 5-minute demo

목표는 **“어떤 레코드인지 → 노출 판단의 근거가 무엇인지 → 무엇이 아직 부족한지”**를
한 흐름으로 설명하는 것입니다. [제품 명세](../agent-sentinel-product-spec.md)의 전체
공격 검증·실제 remediation 시나리오를 현재 배포가 달성했다고 주장하지 않습니다.
진행 전 [동결 체크리스트](#frozen-candidate-checklist)를 확인합니다.

| 시간 | 화면과 조작 | 말할 내용 / 하지 않을 주장 |
| --- | --- | --- |
| 0:00–0:45 | **Catalog** (`/agent-catalog`)의 요약과 source 구분을 확인합니다. | “302개 Agent 365 agent-package 레코드와 6개 Foundry synthetic 레코드입니다.” **308개 운영 중인 production agent**라고 말하지 않습니다. Agent 365 자체 package 총수 308에는 별도의 extension control 6개가 포함됩니다. |
| 0:45–1:30 | Source를 **Microsoft Foundry**로 선택하고 `sales`를 검색해 `sales-research-vulnerable` (Sales Research Vulnerable)을 찾습니다. **Synthetic / test** 표시를 확인한 뒤 제목을 눌러 상세로 이동합니다. | “이것은 합성 검증용 Sales Research Vulnerable의 선언된 설정입니다.” `crm_read`·`external_send`가 보이면 선언된 도구라고 설명합니다. 실제 CRM 접근·외부 전송·실행 신원을 증명하지 않습니다. 이름은 탐색용이며 identity join 근거가 아닙니다. |
| 1:30–3:00 | **Exposure** (`/exposure`)에서 같은 agent의 finding을 열고 **Evidence provenance / Evidence drawer**의 출처, 관측 시각·최신성, 참조, **Declared configuration only**를 확인합니다. | “정책이 이 설정을 왜 조사 대상으로 판단했는지 근거를 추적합니다.” exact `RUNS_AS`와 qualifying runtime telemetry가 없으므로 실제 침해·완성된 권한 경로·검증된 유출이라고 말하지 않습니다. finding이 없으면 없다고 기록하며 다른 fixture로 채우지 않습니다. |
| 3:00–4:00 | **Lifecycle** (`/lifecycle`)에서 같은 agent의 current-version evidence와 누락 항목을 확인합니다. | “현재 버전의 증거를 모아 다음 검토를 돕습니다.” **Current-version evidence, not full release orchestration** 경계를 설명합니다. `Published` 등 원본 상태를 Sentinel의 승인·승격·rollback 실행으로 해석하지 않습니다. |
| 4:00–5:00 | **Release readiness** (`/release-readiness`)에서 Agent 365, identity, OTel, version 항목을 확인하고 마무리합니다. | “기록된 배포 기준은 partial입니다. Agent 365는 ready지만 `RUNS_AS` 0, qualifying live OTel 0이며 auth disabled / writes false입니다.” 화면이 더 나쁜 상태면 그대로 설명합니다. `Ready`가 보여도 human release approval이나 production go-live는 아닙니다. |

**No-op / read-only 시연:** 조회·필터·상세·drawer 열기/닫기만 수행합니다. agent 호출,
검증 traffic 생성, `Preview response`, AI narrative 생성, 승인·실행·승격·삭제는 이
5분 경로에서 제외합니다. 쓰기 요청을 보내 차단을 시험하지도 않습니다. Preview는
지원되더라도 simulation이지 실제 수정 증거가 아닙니다.

**Unavailable 대응:** source/finding/endpoint가 없거나 stale·denied·unavailable이면
사유와 마지막 관측 시각을 읽고 해당 주장을 중단합니다. 일시 오류는 한 번만 재시도하고,
계속 실패하면 [현재 상태](current-status.md)를 **날짜가 있는 기록**으로 설명합니다.
필요하면 별도로 준비된 [로컬 mock](../README.md#quick-start)으로 전환하되 “오프라인
합성 예시이며 live 검증이 아니다”라고 먼저 알립니다. 자동 fallback·화면 위장·증거 없는
pass는 금지합니다. 빈 화면/오류만 남는 경우는 graceful 처리 성공이 아니라 미해결 결함입니다.

## Demo Q&A

1. **Agent 365가 있는데 왜 필요한가요?** Agent 365의 registry·관리·entitlement를 복제하지 않습니다. Sentinel은 그 package 증거와 Foundry·Entra·보안 원본을 함께 보고, 플랫폼 간 관계의 근거와 누락을 조사·릴리스 판단에 연결합니다. 현재 catalog 연결은 실행·설치·사용 권한의 증명이 아닙니다.
2. **Entra보다 더 정확한 신원을 알아내나요?** 아닙니다. Entra가 신원·권한의 원본입니다. Sentinel은 양쪽의 authoritative exact ID가 맞을 때만 연결합니다. 현재 Foundry agent 쪽 ID가 없어 `RUNS_AS`는 0이며, 이름이나 owner로 보완하지 않습니다.
3. **Defender를 대체하거나 실제 공격을 탐지했나요?** 아닙니다. Defender의 탐지 증거를 소비하고 결정론적 설정·그래프 분석을 보완합니다. 현재 bounded Defender 결과는 valid-empty이며, Exposure의 선언 기반 finding을 탐지된 사고나 검증된 공격으로 말할 수 없습니다.
4. **Live connector이면 실행을 실시간으로 보고 있나요?** Foundry live 읽기는 실제 서비스의 **정적 선언 설정**을 가져온다는 뜻입니다. 실제 실행 주장은 별도 non-synthetic trace/span과 정확한 귀속이 필요하며 현재 qualifying live OTel은 0입니다. [Runtime SDK](external-runtime-instrumentation.md)는 저장소에만 있고 아직 배포되지 않았습니다.
5. **Catalog 308과 Agent 365 308은 같은 숫자인가요?** 아닙니다. Catalog는 **302 Agent 365 agent-package + 6 Foundry synthetic**입니다. Agent 365 source는 **302 agent-package + 6 extension control = 308 package**이며 extension은 agent catalog에서 제외됩니다. 어느 쪽도 running production agent 수가 아닙니다.
6. **Catalog에 보이면 내가 쓸 수 있나요?** 운영 catalog는 estate의 증거 목록이고 **My agents**는 개인별 접근 목록입니다. 현재 auth가 꺼져 있고 authoritative entitlement source도 구성되지 않아 개인 목록은 fail-closed입니다. 로그인 활성화만으로 entitlement가 생기거나 접근 권한을 부여하지 않습니다.
7. **Lifecycle이나 Ready가 있으면 자동 출시·수정이 되나요?** 아닙니다. Lifecycle은 current-version evidence이며 full release orchestration이 아닙니다. auth scaffolding과 release-review 도구는 배포 코드에 포함됐지만 활성화·사람 승인은 별개입니다. writes false, consent/roles 미완료, Security·Accessibility·OneRAI·Release 승인 대기 상태입니다.
8. **얼마나 시간이나 비용을 절약했나요?** 아직 측정된 고객 절감 성과는 없습니다. 가치 가설은 “흩어진 증거를 찾고 누락을 판정하는 작업을 줄인다”입니다. 아래 [소규모 사용자 과제](#small-real-user-task-protocol)로 실제 시간과 정답을 관찰할 수 있지만, 미실시·실패·학습 효과를 숨기거나 고객 ROI로 확대하지 않습니다.

## Frozen-candidate checklist

**내부 동결 목표: 2026-09-16 수요일 18:00 KST.** 최종 `main` PR은 정직하게 시연하고
인계할 candidate를 동결하는 것이며 **전체 production go-live가 아닙니다**. 외부 승인
미완료는 [승인 backlog](current-status.md#human-approvals-still-open)에 남깁니다.
아래 항목은 실제 관찰과 검토 기록이 있을 때만 체크하며, 이 문서 작성으로 완료되지 않습니다.

- [ ] 최종 PR의 full Git SHA·검증 일시·로컬 확인 결과와 [Azure SHA/revision/digest](#version-truth)를 별도 기록했다. Git base `3c303279`와 Azure `7c1336bc`를 동일 버전으로 쓰지 않았고 [미배포 변경](current-status.md#repository-only-gap)을 명시했다.
- [ ] Catalog → 명시적 synthetic Foundry 한 레코드 → Exposure evidence → Lifecycle → Release readiness를 5분 내 리허설하고, 같은 source/agent와 관측 시각을 추적했다. 숫자 302+6과 Agent 365 308의 차이를 설명했다.
- [ ] `RUNS_AS` 0, qualifying OTel 0, auth disabled, writes false, personal entitlement 미구성, human approval 대기를 화면/설명에서 숨기지 않았다. 신규 Foundry pilot은 승인·생성되지 않았음을 명시했다.
- [ ] No-op 경로에서 조회만 했으며 runtime 호출·remediation·권한 변경·배포가 없었다. 실제 write 차단 검증을 수행했다고 주장하지 않았다.
- [ ] 누락·stale·unavailable·오류의 실제 표시와 복귀 경로를 확인했다. live 실패를 mock pass로 치환하지 않았고, 미관찰 상태는 `not-run`으로 남겼다.
- [ ] 핵심 경로의 키보드 이동·drawer 닫기와 1440×900 / 1920×1080 표시를 확인했다. 미수행 접근성 검토를 승인으로 표기하지 않았다.
- [ ] [Rollback 진입점](#safe-deployment-and-rollback-path)과 담당 operator, 이전 reviewed digest를 확인했다. 시연 장애는 먼저 중단하며, 실제 rollback은 별도 human approval로만 진행한다.
- [ ] 수정 문서의 Prettier·relative links·`git diff --check`와 설치된 의존성 범위의 `auth-readiness-docs` / `edge-routing` 결과를 기록했다. 미실행·기존 실패·문구 불일치는 PR에 남겼고 doc-only 변경에 full build/test를 추가하지 않았다.
- [ ] 선택적 사용자 과제는 실제 관측 또는 `미실시`로 기록했다. 고객 절감 수치·비공개 내용·reviewer 연락처나 이메일 thread ID는 넣지 않았다.
- [ ] 동결 후 backlog에 consent/roles·JWT 활성화, exact identity·OTel 증거, 미배포 코드, active-edge write guard, human release approvals를 남겼다. 새 기능·권한 확대·pilot 생성으로 마감 범위를 늘리지 않았다.

## Small real-user task protocol

현재 상태는 **미실시: 참여자·시간·정답 관측 없음**입니다. 다음은 선택적 내부 usability
확인이며 Foundry pilot 승인이나 고객 성과 측정이 아닙니다. 이 문서 작업에서는 모집·연락하지 않습니다.

1. **대상·동의:** 운영/보안/agent owner 역할의 내부 자원자 2–3명만 선택적으로 참여합니다. 목적·기록 항목·언제든 중단 가능함을 설명하고 사전 동의를 받습니다. 이름 대신 P1–P3를 사용하며 녹음·화면 수집은 기본적으로 하지 않습니다. 고객 데이터·개인 메시지·메일·토큰·tenant/provider ID는 수집하지 않습니다.
2. **고정 과제:** 동일한 `sales-research-vulnerable` synthetic 자료로 “source와 synthetic 여부, 선언된 도구 두 개, Exposure 근거와 관측 시각, exact 실행 신원/telemetry 유무, 현재 출시 판단과 blocker”를 찾아 출처와 함께 설명하게 합니다. 실제 agent 호출이나 수정은 하지 않습니다.
3. **Before / After:** 같은 범위·시점의 승인된 비민감 합성 증거를 사용합니다. Before는 원본별로 분리된 자료를 수동 대조하고, After는 위 Sentinel 읽기 경로를 사용합니다. 각 5분 상한으로 과제 제시부터 답 제출까지 초시계로 **실제 초**를 잽니다. 동일 자료를 준비할 수 없으면 비교를 미실시로 남깁니다. 참가자별 순서를 번갈아 배정하고 실제 순서·도움·재시도를 기록해 학습 효과를 드러냅니다.
4. **정확성:** 고정 과제의 다섯 항목을 각각 출처까지 맞히면 1점(0–5)으로 기록합니다. synthetic을 production으로, 설정을 실행으로, partial을 release approval으로 해석한 오류는 점수와 별도로 남깁니다. 답안 기준은 당시 승인된 자료와 [현재 증거 경계](current-status.md#evidence-facts-that-must-not-be-overstated)이며 관측 없는 값은 채점 근거로 만들지 않습니다.
5. **관측·보고:** 기존 검토 기록에 `참가자 코드 / 동의 / 순서 / Before 초·정답(0–5) / After 초·정답(0–5) / 오류·도움·timeout`만 남깁니다. 미완료는 `timeout`, 미참여는 `미실시`이며 0초나 성공으로 대체하지 않습니다. 실제 차이 `Before−After`와 개별 정답 변화만 보고하고, n=2–3의 편의 표본·학습 효과·합성 과제라는 한계를 병기합니다. 개선이 없거나 느려진 결과도 보존하며 고객 절감·일반 ROI를 주장하지 않습니다.

## Local WSL setup

Use a native WSL clone, not a OneDrive-mounted Windows clone.

```bash
git clone <repository-url> ~/project/agent-sentinel
cd ~/project/agent-sentinel
git switch feature/production-readiness-r1
source ~/.nvm/nvm.sh
nvm install 22
nvm use 22
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --offline --frozen-lockfile  # use normal install only when network access is approved
```

Common local commands:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e                  # web/routing changes
pnpm storybook:build           # shared UI changes
pnpm release-evidence:schema:check
git diff --check
```

Build workspace dependencies before running package tests from a clean checkout when package exports point to `dist`. Never run live validation, provisioning, cleanup, auth apply, or deployment as part of ordinary local validation.

## Test pyramid and known baseline

| Layer          | Command                                       | Known baseline                                                                                               |
| -------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Formatting     | `pnpm format:check`                           | Repository-wide check has unrelated historical drift; touched files must pass Prettier.                      |
| Static         | `pnpm lint`; `pnpm typecheck`                 | Last recorded full baseline: 48/48 tasks passed on 2026-08-31.                                               |
| Unit/contract  | `pnpm test`                                   | Last recorded full baseline: 901 passing tests on 2026-08-31.                                                |
| Build          | `pnpm build`                                  | Last recorded full baseline: 25/25 tasks passed on 2026-08-31.                                               |
| Browser        | `pnpm test:e2e`                               | Last recorded baseline: 23 tests across 10 specs. Run only when relevant.                                    |
| Infrastructure | `az bicep build -f infra/platform.bicep`      | Historical build passed with baseline warnings; no what-if or deployment is implied.                         |
| Live provider  | `pnpm foundry:validate`, auth/live validators | Operator-only, explicit, bounded, and never a CI default. Historical results do not validate a newer commit. |

Treat the dated baseline as historical, not as proof for the current commit. Record fresh command results in the pull request or release evidence.

## Current deployed state

- The reference deployment is available at `https://agent-sentinel-dadmh3cee9edbwha.b01.azurefd.net` with the immutable web/API/jobs versions in [Version truth](#version-truth).
- The active Azure edge is Front Door over HTTPS. Application Gateway is stopped and diagnostic only.
- Front Door has an active WAF policy but **no evidenced custom mutation-block rule**. The similarly named rule on the stopped Application Gateway does not protect Front Door.
- Replacement API/SPA registrations and service principals exist. `AUTH_MODE=disabled`; admin consent, test-principal role assignment, live employee login, and deployed JWT validation remain incomplete.
- `AGENT_SENTINEL_WRITE_ENABLED=false`; remediation and manifest ingestion remain non-live.
- Foundry data mode is live against one reference source containing six synthetic validation agents and no production customer agents.
- The connector-source plane is provisioned for the reference environment.
- Agent 365 is deployed and `ready + complete`: 308 packages, 302 agent-package nodes, 6 extension-package nodes, and 308 live source-bound evidence records.
- Release readiness is **partial**: Agent 365 ready; `RUNS_AS` 0; qualifying live OTel records 0; authentication disabled; writes false. Ready would still require separate human release approval.

## Exact connector state

| Connector                         | Current state                                         | Exact boundary / unblock                                                                                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure AI Foundry                  | **Connected**                                         | One project; six authoritative synthetic agents; declared configuration only. Additional projects need separate authorization.                                                                                                         |
| Microsoft Entra inventory         | **Inventory connected; parity unmatched**             | 335 identity nodes, but agents expose no exact identity IDs; therefore 0 `RUNS_AS` edges. Optional owner/app-role/preview reads remain separate approvals.                                                                             |
| Azure Resource Graph              | **Connected for authorized view**                     | Five resources persisted through current scoped roles; this is not full subscription coverage and creates no agent edges.                                                                                                              |
| Azure Monitor / OTel              | **Query connected; telemetry insufficient**           | Current audit has no analysis-ready request/dependency/trace rows and metrics lack required agent attributes. Baseline and observed windows each require at least ten fresh, complete, unsampled measured spans with exact provenance. |
| Agent 365 package catalog         | **Deployed; ready and complete**                      | 308 packages produced 302 agent-package nodes, 6 extension-package nodes, and 308 live source-bound evidence records. Package count is not an executing-agent count.                                                                   |
| Microsoft 365 / SharePoint agents | **Covered through deployed Agent 365 classification** | Classification is from package metadata only; no SharePoint scraping.                                                                                                                                                                  |
| Defender for Cloud Apps           | **Connected, valid-empty**                            | Bounded alert and activity reads are ready with zero current records; no agent correlation is inferred.                                                                                                                                |
| Purview sensitivity labels        | **Connected**                                         | Twelve bounded label definitions are persisted; they do not prove label usage, content protection, attribution, trust, or compliance.                                                                                                  |
| Teams organization catalog        | **Connected, valid-empty**                            | Zero organization entries; this does not prove installation or distribution coverage.                                                                                                                                                  |
| Power Platform ResourceQuery      | **Implemented; unattended activation unsupported**    | No production-supported app-only inventory authorization with enforceable scope.                                                                                                                                                       |
| Business outcomes                 | **Contract complete; not configured**                 | Value remains unknown until an authoritative source supplies exact run, correlation, or version evidence.                                                                                                                              |
| Custom manifest adapter           | **Implemented; activation-gated**                     | Offline validation/scanning works. Live ingestion requires activated auth, writes, active-edge protection, and approval.                                                                                                               |

See [connector availability](connector-availability.md) for the durable state definitions and detailed limits.

## Blocking dependencies and human-only actions

### Authentication and repository/deployment gap

- Replacement API/SPA registrations and service principals already exist. A human owner must review them against the approved plan, complete least-privilege consent and assignments for Viewer, Analyst, Approver, and Administrator, and supply sanitized outputs; do not create duplicate registrations.
- A protected deployment reviewer must approve immutable API/web digests and the surgical read-only auth activation. No coding agent may apply the plan.
- Auth scaffolding/activation hardening and release-review v2 tooling are included in the `7c1336bc` deployed code baseline. Tool availability is not JWT activation, a completed review, or approval. The actual newer, undeployed identity/SDK/pilot changes are listed in the [Git/Azure gap](current-status.md#repository-only-gap).

### `RUNS_AS` and telemetry

- `RUNS_AS` is blocked by missing exact provider identity IDs on every authoritative Foundry agent. Only a source-local object ID, app/client ID, or separately approved Agent Identity ID can unblock it.
- OTel is blocked by missing representative, non-customer, complete, unsampled spans with required estate/source/agent/trace/span/token/cost fields and read-only workspace query access.

### Deployment, runner, Cosmos, and edge

- Full `infra/platform.bicep` deployment is prohibited: the latest what-if showed 54 unrelated modifications.
- The private runner may be deallocated, does not yet have the complete approved deployment role set, and must be explicitly started and verified before builds.
- The reference `connector-sources` container is provisioned and in use. A new tenant must provision its own isolated container and validate partition, index, estate, and ETag behavior.
- Manifest `manifest-ingestions-v2` cutover requires manual copy verification and approval; the compatibility container remains authoritative until then.
- Front Door needs a separately reviewed custom mutation rule before any write-stage readiness.
- OneRAI remains a human onboarding track requiring authoritative product and legal/compliance review. It does not block local engineering.

## Post-freeze production backlog

These are separately approved production follow-ups, not prerequisites to call the bounded Wednesday demo candidate frozen. Do not mark them complete or expand the freeze scope to obtain outside approvals.

1. **Reproduce the clean repository baseline.** Record Node/pnpm versions, install method, lint, typecheck, tests, build, touched-file Prettier, and `git diff --check` against one full SHA.
2. **Read the tenant-neutral bootstrap.** Assign primary, secondary, and emergency owners, then inventory tenant-local resources and permissions without copying the reference environment.
3. **Reconcile the existing replacement registrations.** Review the exact offline bootstrap plan against owner-supplied sanitized outputs; do not recreate registrations or grant permissions locally.
4. **Complete human identity approval.** Validate redirects and complete consent and four role assignments through the authoritative owner process; registrations already exist.
5. **Build immutable release images.** Use the approved private runner, full-SHA tags, canonical digests, and protected environments.
6. **Deploy repository-only changes surgically.** Update API first, then jobs and web only as required; keep writes false and record exact revisions/digests.
7. **Validate authentication at Front Door.** Verify anonymous denial, `/api/auth/me`, all four roles, login/logout, and no-write posture.
8. **Establish exact identity and telemetry evidence.** Obtain exact agent-side identifiers for all six `RUNS_AS` edges and representative qualifying OTel records; never use fuzzy identity matching or fixtures.
9. **Generate deterministic release evidence.** Bind checks, deployed versions, connector observations, accessibility evidence, and sanitized configuration to one exact SHA.
10. **Obtain human release decisions.** Security, Accessibility, OneRAI, and release owners approve independently; otherwise readiness remains partial or blocked.

## Dangerous operations: do not do

- Do not deploy, run cloud what-if, alter cloud resources, grant permissions, create registrations, access private tenant data, or invoke live validators without explicit operator authorization.
- Do not run full `infra/platform.bicep` against the existing environment.
- Do not enable writes or rely on the stopped Application Gateway rule as Front Door protection.
- Do not use mutable image tags, retag for rollback, or claim deployment from a registry push.
- Do not infer identities, agent status, coverage, trust, or value from names, empty results, package totals, catalog definitions, or fixtures.
- Do not commit tokens, credentials, private identifiers, raw provider payloads, generated live evidence, local paths, or environment-specific auth plans.
- Do not broaden RBAC/Graph scopes or enable preview APIs merely to unblock a demo.
- Do not edit, stage, revert, normalize, or otherwise disturb unrelated changes in `infra/environments/mngenvmcap098047-foundry.parameters.bicepparam`.

## Safe deployment and rollback path

Deployment is human-approved and surgical:

1. Confirm the exact account/tenant/subscription outside repository artifacts.
2. Require a clean release worktree and full 40-hex SHA.
3. Run local checks and offline Bicep builds. Review the narrowly scoped what-if.
4. Build on the approved private runner; record canonical image digests.
5. Deploy API first by digest, verify one active revision, health, connector status, and anonymous mutation denial.
6. Deploy jobs second, verify one bounded ingestion and persisted health. Deploy web last only if needed.
7. Keep writes false. Run auth edge validation, Release readiness, and sanitized release-evidence validation.
8. Stop on any mismatch, stale/partial evidence, unexpected resource change, or extra active revision.

Rollback restores the previous reviewed API digest first, then jobs, then web if changed; restore the active Front Door mutation block first if a future approved rule exists, and keep writes false. Verify one active revision and the same smoke checks. Never retag images. See [deployment](deployment.md), [supply chain](supply-chain.md), and [runbooks](runbooks.md).

## Operational tools

### Release readiness

Use only after an approved deployment. `pnpm release-readiness:verify -- --url <https-url> ...` performs bounded documented `GET` requests, accepts expected SHAs/digests, emits sanitized JSON, and returns `0` ready, `3` partial, `1` blocked/unavailable/error, or `2` invalid arguments. Omit the token option only while auth is disabled. The web **Release readiness** page uses the same evaluator. Ready is evidence for human release review, not approval. `pnpm demo:verify` remains a compatibility alias. See RB-013 in [runbooks](runbooks.md).

### Auth preflight and bootstrap

1. Copy the checked-in registration template to a secure untracked location.
2. Run `pnpm auth:registration-bootstrap -- --input <path> --output <plan.json>`; review only, do not apply locally.
3. After human registration approval, prepare the activation input and run `pnpm auth:preflight -- --input <path> --output <plan.json>`.
4. The protected workflows are the only apply/deploy paths. Inputs and plans are environment-specific and must not be committed.

See [security and authentication](security-authentication.md) and the auth section of [deployment](deployment.md).

### Release evidence

- Repository-only: `pnpm release-evidence:generate -- --output release-evidence/generated/<full-sha>.json`.
- With owner-supplied sanitized observations: add `--input <sanitized-input.json>`.
- Validate: `pnpm release-evidence:validate -- <manifest.json>` and `pnpm release-evidence:schema:check`.

The generator is offline and does not run tests or contact providers. Unsupplied facts remain `unknown`, `planned`, or `not-run`. Generated/private evidence is ignored and must not be committed. See [release evidence](release-evidence.md).

## Git workflow and clean-worktree expectations

- Branch from the canonical integration SHA, not stale `main`.
- Keep one bounded concern per branch and commit. Rebase/merge only as directed by the owner.
- Before editing, record `git status --short --branch`; preserve unrelated dirt byte-for-byte and unstaged.
- Format only touched files when repository-wide baseline drift exists.
- Before commit: inspect `git diff --stat`, `git diff --check`, every changed hunk, deleted-file references, and staged paths.
- Stage explicit paths. Never use `git add -A` when unrelated dirt exists.
- Commit generated plans/evidence only when the relevant specification explicitly requires a sanitized fixture.
- Do not push. The parent/integration owner inspects and publishes.

## Important files

| File                                                                | Why it matters                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `agent-sentinel-product-spec.md`                                    | Product requirements and immutable scope                       |
| `docs/CONTEXT.md`                                                   | Shared domain vocabulary and evidence invariants               |
| `docs/current-status.md`                                            | Authoritative dated operational ledger                         |
| `docs/connector-availability.md`                                    | Connector implementation/live-state matrix                     |
| `docs/known-issues.md`                                              | Named blockers and unblock conditions                          |
| `docs/architecture.md`, `docs/data-model.md`                        | Runtime topology and contracts                                 |
| `docs/development.md`, `docs/new-tenant-bootstrap.md`               | Local workflow and tenant-neutral ownership/bootstrap guidance |
| `docs/security-authentication.md`                                   | Auth states, roles, and activation checklist                   |
| `docs/deployment.md`, `docs/runbooks.md`, `docs/supply-chain.md`    | Deployment, operations, rollback, and image provenance         |
| `docs/release-evidence.md`                                          | Sanitized release-evidence contract and CLI                    |
| `infra/auth/*`                                                      | Strict registration/auth input schemas and templates           |
| `.github/workflows/*auth*`, `.github/workflows/ci-build-deploy.yml` | Protected planning and deployment workflows                    |

## Troubleshooting

- **`node_modules` missing / package entry cannot resolve:** use Node 22, run `pnpm install --offline --frozen-lockfile`, then `pnpm build` before isolated package tests that consume workspace `dist` exports.
- **Private runner job is queued:** verify the approved runner VM is running, registered, online, and carries the exact replacement label. Do not substitute a public runner for private ACR/network work.
- **Full what-if shows unrelated changes:** stop. Use the narrowly scoped template/workflow or reconcile drift through a separate reviewed task.
- **Connector says ready but data is empty:** preserve valid-empty; do not describe coverage as complete.
- **0 `RUNS_AS`:** inspect exact identity diagnostics. Missing provider IDs are expected; never add a name-based join.
- **OTel remains insufficient:** verify raw request spans, exact attributes, unsampled rows, both time windows, sample counts, freshness, and workspace binding. Metrics alone do not qualify.
- **Auth preflight blocks:** fix the input or approval evidence; do not relax schemas, use mutable tags, enable writes, or bypass the protected workflow.
- **Release readiness is partial/blocked:** follow its categorized requirements. Never replace a missing live category with fixtures or treat ready as release approval.
- **Prettier fails on untouched files:** record the baseline and run Prettier only on touched files; do not mix cleanup into the handoff change.

## Handoff checklist

- [ ] The reviewed integration base and working branch are recorded; this Wednesday handoff starts at `3c30327902f925078ebfe37c4414975b73e75561` on `work/wednesday-handoff-astra-r1`.
- [ ] `docs/current-status.md` and connector state were read before planning.
- [ ] Repository, deployed, and evidence versions are kept separate.
- [ ] No live/cloud/private operation is assumed or performed by a coding task.
- [ ] Exact evidence and identity boundaries are preserved.
- [ ] Relevant local checks are recorded; doc-only changes use narrow checks, not full tests/builds.
- [ ] Touched Markdown passes Prettier and relative-link validation.
- [ ] Deleted/renamed document references are absent.
- [ ] Worktree is clean except explicitly preserved unrelated dirt.
- [ ] Remaining blockers, approvals, and required live validation are explicit.
