<a id="agent-sentinel--data-model"></a>

# Agent Sentinel 데이터 모델

<a id="domain-types-packagesdomain"></a>

## 도메인 타입(packages/domain)

<a id="estatesnapshot"></a>

### EstateSnapshot: 자산군 스냅샷

특정 시점의 에이전트 자산군을 나타낸다.

- `tenantId`: string — 테넌트 식별자
- `environment`: string — 대상 환경
- `generatedAt`: ISO 8601 날짜 및 시간
- `nodes`: GraphNode[] — 에이전트 그래프 노드
- `edges`: GraphEdge[] — 관계
- `evidence`: Evidence[] — 근거 증거

<a id="graphnode"></a>

### GraphNode: 그래프 노드

- `id`, `kind` (input|agent|identity|data|mcp|tool|control)
- `name`, `description`, `environment`, `owner`
- `sensitivity`, `trust`, `evidenceIds`, `metadata`
- Foundry의 선언된 인벤토리는 에이전트 신뢰도를 기본적으로 `conditional`로 설정한다
  (알려진 외부 전송 기능이 있으면 `untrusted`). Foundry 인벤토리 페이로드에 포함된 신뢰 정보는
  폐기한다. `trusted`를 부여하려면 별도로 인증된 서버 측 평가가 필요하며, 해당 평가의
  에이전트·소스·테넌트·환경 대상 바인딩이 권위 있는 인벤토리 객체와 정확히 일치해야 한다.
- 공개 합성 입력은 인증 여부나 평가 시간을 주장할 수 없다. 서버는 검증된 인증 맥락을 요구하고,
  주입된 시계로 평가 시각을 기록하며, 증거 타입에서 소스 모드를 도출하고, 신뢰를 적용할 때마다
  발견 시계를 기준으로 최신성을 재평가한다. 필요한 각 평면은 정확히 바인딩된 자체 증거를
  인용해야 하며, 런타임 평면은 비합성 `observed_runtime` 증거를 인용해야 한다.
  미래 시각, 합성, 오래됨, 알 수 없음, 누락, 불일치, 미인증, 불완전 상태의 평가 증거는
  `trusted`를 만들 수 없다.

<a id="graphedge"></a>

### GraphEdge: 그래프 간선

- `id`, `from`, `to`, `relationship` (TRIGGERS|RUNS_AS|CAN_READ|CAN_CALL|CAN_EXFILTRATE_TO|PROTECTED_BY)
- `evidenceIds`, `active`, `removable`
- 정확히 일치하는 Entra `RUNS_AS` 간선은 `runsAsBinding`을 추가로 영속화한다.
  여기에는 Foundry 에이전트와 Entra ID 엔드포인트의 완전한 권위 정보, 정확한 GUID 식별자,
  일치 유형이 포함된다. Object-ID 및 Agent Identity 바인딩은 증거로 뒷받침되는 서비스 주체
  객체 권위 정보와 같아야 한다. Application-ID만 일치하는 경우에는 별도의 application-ID
  권위 계약이 마련될 때까지 차단한다. 애플리케이션 ID를 서비스 주체 객체 ID와 비교하지 않는다.
  각 엔드포인트의 `evidenceIds` 배열에는 일치하는 등록된 권위 레코드가 정확히 하나 있어야 하며,
  간선은 바로 그 두 엔드포인트 레코드를 인용해야 한다. 시뮬레이션된 간선 상태 변형도
  등록된 정확한 `runsAsBinding`을 유지해야 한다. 실환경 권위 인덱싱은 중복된 노드·간선·증거 ID,
  동일한 식별자 유형과 정확한 자산군/소스/테넌트/환경 경계 안의 식별자 모호성,
  연결되지 않은 권위 인용, 어느 쪽 엔드포인트 노드나 증거에든 명시된 비권위 또는 합성/테스트
  표시, 오래되었거나 형식이 잘못되었거나 생성 세대/릴리스가 불일치하는 증거를 거부한다.

<a id="evidenceauthority"></a>

### EvidenceAuthority: 증거 권위 정보

권위 있는 Foundry 및 Entra 증거는 엄격한 타입의 권위 정보를 포함할 수 있다.
`estateId`, 전역 범위의 `sourceId`(`foundry:<id>` 또는 `entra:<id>`),
소스의 `tenantId`와 `environment`, 공급자, 정확한 공급자 소스 객체
(Foundry 프로젝트 또는 Entra 인벤토리 테넌트), 정확한 공급자 객체(에이전트 또는 서비스 주체),
`snapshotGeneratedAt`, `sourceRelease`가 이에 해당한다. 같은 값을 노드 메타데이터에 복사하므로,
영속화된 그래프를 탐색할 때 표시 이름, 소유자, 소스 ID로 대체하지 않고 양쪽 엔드포인트를 검증할 수 있다.
요청 또는 수집 경계는 후보 스냅샷과 독립적으로 `EstateContext`를 제공한다.
소스 권위 정보는 소스 테넌트가 자산군 테넌트와 같도록 요구하는 대신 등록된 정확한 소스 및
엔드포인트 메타데이터와 대조해 검증하므로, 명시적으로 등록된 테넌트 간 소스와 사용자 지정
자산군 소스도 유효하다. 권위 인덱스는 한 번 구축하여 정책, 경로, 영향 반경, 시뮬레이션 분석에 재사용한다.

<a id="evidence-source-status"></a>

### 증거 소스 상태

증거에는 `status`(`live|stale|unknown`), 정확한 소스 ID, 준비 상태, 데이터 상태,
확인 시각, 민감 정보를 제거한 사유를 포함하는 타입 지정 `sourceStatus`가 들어갈 수 있다.
보존된 Agent 365 패키지 증거는 API 스냅샷을 읽을 때마다 이 상태와 함께 투영된다.
`live`가 되려면 정확한 현재 소스가 `ready`이면서 `complete`여야 하고, 영속화된 상태 정보가
동일한 스냅샷 생성 세대 및 정규화된 증거 다이제스트와 바인딩되어야 한다.
바인딩되지 않은 레거시 상태 정보는 보존 증거를 승격할 수 없지만, 바인딩되지 않은 실패나
저하 상태 정보는 여전히 강등에 사용할 수 있다. 그 밖의 모든 소스 상태 또는 소스 상태 누락은
증거 최신성을 `stale`로 설정하며 실환경 그래프 권위를 확립할 수 없다.

<a id="finding"></a>

### Finding: 발견 사항

- `id`, `title`, `summary`, `severity` (low|medium|high|critical)
- `path`: AttackPath, `owner`, `policyId`, `detectedAt`, `recommendation`

<a id="validationrun"></a>

### ValidationRun: 검증 실행

- `id`, `findingId`, `status` (queued|running|validated|not-reproduced|failed)
- `startedAt`, `completedAt`, `syntheticCanary`, `observedAtTarget`, `trace`

<a id="storage-layout"></a>

## 저장소 구성

<a id="cosmos-db-agent-sentinel-db"></a>

### Cosmos DB 저장소(agent-sentinel-db)

| 컨테이너         | 파티션 키 | 용도                                      |
| ----------------- | ------------- | -------------------------------------------- |
| snapshots         | /tenantId     | EstateSnapshot 이력                       |
| findings          | /tenantId     | Finding 레코드                              |
| evidence          | /tenantId     | Evidence 항목                               |
| graph-nodes       | /tenantId     | GraphNode 인접 관계                          |
| graph-edges       | /tenantId     | GraphEdge 인접 관계                          |
| governance-cases  | /tenantId     | 사례, 불변 전이, 재시도 키 |
| connector-sources | /estateId     | 자산군 바인딩, 소스, 감사, 재시도 키  |

<a id="connectorsourcedefinition"></a>

### ConnectorSourceDefinition: 커넥터 소스 정의

커넥터 소스 하나에 대한 비활성 구성 평면 레코드는 `estateId`, 데이터 테넌트/환경,
안정적인 소스 ID, 커넥터 타입, 변경 불가능한 배포/사용자 기원, 엄격한 비밀 비포함 구성,
안전한 자격 증명 ID/참조 메타데이터, 증거에 바인딩된 테스트 상태, 버전/ETag, 행위자,
타임스탬프를 보존한다. 배포 기원 레코드는 변경 불가능한 `runtimeBinding.bindingSourceId`를
포함할 수 있다. 이를 통해 구성 평면의 네임스페이스 지정이 공급자에 사용하는 ID, 증거 ID,
상태 ID, 출처를 바꾸지 않도록 한다. 배포 기원 레코드는 불변이며, 사용자 기원 레코드는
배포 런타임 바인딩을 주장할 수 없다.

`connector-sources` 컨테이너는 자산군 범위의 SHA-256 물리 ID와 Cosmos 기본 ETag 동시성
제어를 사용하여 각 `/estateId` 파티션 아래 불변 테넌트/환경 바인딩 하나와 소스, 추가 전용
감사, 멱등성 문서를 저장한다. 첫 소스를 생성할 때 소스·감사·재시도 표시와 함께 바인딩을
원자적으로 생성한다. 이후 생성은 트랜잭션 안에서 이 바인딩을 요구하므로, 동시 시도로 자산군을
재정의하거나 부분 레코드를 남길 수 없다. 모든 문서 봉투는 `estateId`, `tenantId`,
`environment`를 반복해서 담는다. 단건 읽기, 목록, 감사 읽기, 멱등 재생은 세 값 모두 요청한
자산군과 일치해야 데이터를 반환한다. 삭제 시 숨겨진 삭제 표식을 남겨 같은 소스 ID를
재생성할 수 없게 한다. 정확히 같은 커밋된 업데이트·삭제 재시도는 불변 감사 결과를 재생한다.
새로운 업데이트·삭제 감사 타임스탬프는 모두 이전 소스의 `updatedAt`보다 엄격히 늦어야 하므로,
감사 순서는 인과관계를 따르며 호출자가 선택한 감사 ID의 영향을 받지 않는다.
이후 활성화 작업이 이루어질 때까지 기존 배포 JSON을 활성 런타임 소스로 유지한다.

소스 목록은 `sourceId` 순서의 리포지토리 기반 탐색 페이지 매김을 사용하고,
감사 목록은 안정적인 `(occurredAt, id)` 튜플로 탐색한다. API 페이지는 다음 페이지가 있는지
판단하기 위해 `limit + 1`개 레코드를 요청한다. 멱등성 표시는 단건 읽기를 유지하므로,
재시도 처리는 감사 목록 크기와 무관하다.

커넥터 소스 API는 인가된 요청 자산군을 통해서만 레코드를 나열하고 읽는다.
사용자 기원 생성·업데이트·삭제에는 인증된 Administrator, 명시적인
`AGENT_SENTINEL_WRITE_ENABLED=true`, 멱등성 키, 강한 ETag 사전 조건이 필요하다.
API 호출자는 자산군 경계, 기원, 행위자, 감사 타임스탬프, 연결 테스트 결과를 설정할 수 없다.
검증된 JWT `idtyp=app` 호출자는 객체 ID를 기준으로 서비스 주체로 기록하고,
위임 호출자는 사용자로 기록한다. 배포 기원 레코드는 계속 불변이며 삭제할 수 없다.
연결 테스트 엔드포인트는 상태만 제공한다. 저장되고 레이블이 지정된 증거를 반환하며,
테스트되지 않은 소스는 증거 사용 불가와 함께 `unknown`으로 보고한다.
공급자를 호출하거나 성공 결과를 합성하지 않는다. 배포 JSON이 커넥터 런타임 소스로 유지되며,
이 비활성 레코드에서 활성화되지는 않는다. 기존 `*_SOURCES_JSON` 정의는 변경 가능한
영속 저장소에 복사하지 않고, API 읽기 시 불변 배포 기원 레코드로 투영한다.
개별 프로젝트가 다른 공급자 테넌트나 환경에 있어도 Foundry 포트폴리오 배포 소스는 포트폴리오의
`estateTenantId`와 `estateEnvironment`에 속한다. 중첩 Foundry 구성은 정확한 공급자 테넌트,
환경, 프로젝트 엔드포인트, 범위가 제한된 프로젝트 ID를 유지한다.
출력된 Foundry 권위 메타데이터도 동일한 공급자 경계를 유지하며, 스냅샷은 포트폴리오 자산군 범위로 유지된다.

Azure Monitor 소스 쓰기에는 명시적인 `sourceProjectId`가 필요하다. 이 필드가 도입되기 전에
영속화된 레거시 Azure Monitor 레코드는 읽기 전용 호환성 모델로 디코딩한다.
전체 자산군, 테넌트, 환경, 소스 ID, 워크스페이스, 나머지 구성과 정확히 일치하는 배포 기원
소스가 하나뿐이면, 해당 소스의 권위 있는 프로젝트 ID로 읽기 모델을 보완한다.
그렇지 않으면 레코드를 비활성 상태로 반환하며, `migration-required` 상태를 지정하고
이전 테스트 통과 상태나 변경 컨트롤은 제공하지 않는다. 리포지토리 목록 조회는 프로젝트 ID를
추측하지 않으며 레거시 필드가 없다는 이유만으로 실패하지 않는다.
새 소스 구성, 런타임 출처/상태, 커넥터 입력, 웹 양식 검증은 앞뒤 공백을 제거하고
최대 200자로 제한한 동일한 `sourceProjectId` 경계를 공유한다.

<a id="postgresql-pg-as-260814"></a>

### PostgreSQL 저장소(pg-as-260814)

| 테이블           | 용도                               |
| --------------- | ------------------------------------- |
| findings        | JSONB 데이터가 포함된 Finding 레코드       |
| validation_runs | JSONB 데이터가 포함된 ValidationRun 레코드 |

<a id="ai-search-search-as-260814"></a>

### AI Search 검색 저장소(search-as-260814)

| 인덱스          | 용도                                |
| -------------- | -------------------------------------- |
| findings-index | 발견 사항에 대한 의미 체계 + 벡터 검색 |

<a id="service-bus-sb-as-260814"></a>

### Service Bus 메시징(sb-as-260814)

| 큐/토픽           | 용도                      |
| --------------------- | ---------------------------- |
| findings-validation   | 검증 작업 요청      |
| remediation-execution | 개선 조치 작업 요청     |
| snapshot-ingestion    | 스냅샷 처리 요청 |
| domain-events (토픽) | 도메인 이벤트 팬아웃        |

<a id="exposurefinding"></a>

### ExposureFinding: 노출 발견 사항

노출 화면에서 제시하는 선언된 구성의 개별 정책 위반을 나타낸다.

- `id`, `policyId`, `policyName`, `severity` (low|medium|high|critical), `status` (open|validated|mitigated|resolved)
- `riskScore` (0..100), `title`, `summary`, `recommendation`
- `affectedAgentId`, `affectedAgentName`
- `declaredTools`, `affectedNodeIds`, `affectedEdgeIds`, `evidenceIds`, `evidenceTypes`
- `blastRadiusCount`, `blastRadiusNodeIds`
- `firstSeen`, `lastSeen` (ISO 8601 날짜 및 시간; upsert 시 `firstSeen` 보존)
- `sourceMode` (mock|foundry|manifest) — 기반 스냅샷의 출처. 매니페스트 발견 사항은 비권위적 상태를 유지한다.
- `validationStatus` (theoretical|validated|mitigated)
- `tenantId`, `snapshotId`

Cosmos DB 컨테이너: `findings`(파티션 키 `/tenantId`, upsert 시 `firstSeen` 보존).

<a id="remediationpreview"></a>

### RemediationPreview: 개선 조치 미리 보기

시뮬레이션 전용 경로 변경을 나타낸다. 공급자 쓰기를 인가하거나 실행하지 않는다.

- `before`와 `after`는 결정론적으로 분석한 위험과 영향 반경을 포함한다.
- `impact.riskReduction`은 분석된 변경 전 위험과 잔여 위험의 차이이며, 전체 위험이 제거된다고 가정한 값이 아니다.
- `residualFindings`와 `residualRoutes`는 시뮬레이션으로 간선을 제거한 뒤에도 활성 상태인 대체 노출을 유지한다.
- `uncertainty`는 오래됨, 알 수 없음, 합성, 선언 전용, 이론적 상태 또는 누락된 분석 증거,
  지원하지 않는 정책 커버리지, 무변경 또는 부분 대상 커버리지를 인용한다.
- `citedEvidence`는 결정론적 분석에 사용한 가용 증거를 담는다.
  누락된 참조는 `uncertainty`에 명시적으로 남긴다.
- `beforeGraph`와 `afterGraph`는 동일한 증거 기반 비교 범위를 보존하며,
  대상 간선은 시뮬레이션 스냅샷에서만 비활성화한다.
- 현재 활성 대상 경로가 없는 발견 사항은 경로 충돌을 반환하는 대신, 위험이 그대로이고
  위험 감소가 0인 결정론적 무변경 미리 보기를 반환한다. 이때 현재 잔여 발견 사항,
  경로, 불확실성, 증거를 유지한다.

<a id="governancecase"></a>

### GovernanceCase: 거버넌스 사례

결정론적 거버넌스 워크플로 레코드를 나타낸다.

- `id`, `kind` (finding-review|remediation-proposal|policy-exception|lifecycle-review)
- `title`, `description`
- `status` (open|in-review|pending-approval|approved|rejected|expired|closed)
- `createdByIdentity`, `createdByRole`, `createdAt`
- `assigneeIdentity`, `proposerIdentity`, `lastTransitionAt`
- 선택적 링크: `findingId`, `agentId`, `policyId`
- `evidenceSnapshotIds` — 워크플로 전반에 전달되는 증거 스냅샷 참조
- `sourceMode` (mock|foundry) 및 `writeEnabledAtCreation`

<a id="governancecasetransition"></a>

### GovernanceCaseTransition: 거버넌스 사례 전이

각 워크플로 단계의 불변 감사 레코드이다.

- `id`, `caseId`, `operation`
- `fromStatus`, `toStatus`
- `actorIdentity`, `actorRole`, `actorCapability`
- `timestamp`, 선택적 `reason`
- `evidenceSnapshotIds`, `idempotencyKey`

허용되는 전이 작업은 결정론적이며 서버 측에서 강제한다.

- `open` → `pick-up`
- `in-review` → `propose`, `reject-finding`, `withdraw`
- `pending-approval` → `approve`, `reject`, `withdraw`
- `approved` → `close`
- `rejected` → `reopen`
- `expired` → `re-evaluate`
- `closed` → 없음

실환경 모드는 큐를 전용 `governance-cases` Cosmos 컨테이너에 저장한다.
리포지토리 인스턴스는 구성된 테넌트 하나에 바인딩되며, 모든 단건 읽기·쿼리·트랜잭션 배치는
해당 `/tenantId` 파티션 키를 제공한다.

컨테이너는 세 가지 문서 봉투를 사용한다.

- `governance-case`: `id=case:<caseId>`, `tenantId`, 단조 증가하는 `version`,
  정규화된 `searchText`, 현재 `case`.
- `governance-case-transition`: `id=transition:<transitionId>`, `tenantId`,
  `caseId`, 추가 순서인 `sequence`, 증거 스냅샷 참조와 인가 맥락을 포함한 불변 `transition`.
- `governance-case-idempotency`: 사례 생성 또는 한 사례의 전이 범위로 제한된
  SHA-256 파생 ID와 `caseId`, `transitionId`. 이 문서는 생성 전용 재시도/충돌 방지 장치이며
  원본 키를 포함하지 않는다.

생성 시 관련 문서 세 개를 모두 원자적으로 만든다. 상태 전이는 Cosmos ETag에 대한
`If-Match`를 사용해 현재 사례를 원자적으로 교체하고 전이·멱등성 문서를 생성한다.
오래된 상태에 기반한 쓰기는 상태 충돌을 반환하며, 이력은 교체하거나 삭제하지 않는다.
목록 페이지는 최대 200개로 제한하고 `lastTransitionAt` 내림차순, 사례 ID 오름차순으로 정렬한다.
전이 이력은 추가 순서 오름차순, 전이 ID 오름차순으로 정렬한다.

<a id="manifest-envelope-packagesconnector-sdk"></a>

## 매니페스트 봉투(packages/connector-sdk)

**현재 계약.** 사용자 지정 매니페스트 어댑터가 정규화하기 전에 운영자 제공 매니페스트가 충족해야 하는 버전 지정 계약이다. `packages/connector-sdk/src/manifest.ts`에 정의하며, `connectors/manifest/schemas/manifest.schema.json`에 Draft 2020-12 JSON Schema로 동일하게 반영한다.

<a id="manifestenvelope"></a>

### ManifestEnvelope: 매니페스트 봉투 타입

- `schemaVersion` — `SUPPORTED_MANIFEST_VERSIONS`에 있어야 한다(현재 `1.0`). 지원하지 않는 버전은 거부하며 강제 변환하지 않는다.
- `manifestId`, `tenantId`, 선택적 `environmentId`
- `producedAt`: ISO 8601 날짜 및 시간
- `producer`: `{ name, version?, contact? }`
- `capabilities`: AdapterCapabilityDeclaration
- `agents`, `tools`, `identities`, `dataSources`, 선택적 `mcpDependencies` — 매니페스트 로컬 ID를 사용하는 엔터티 선언
- `edges`: EdgeDeclaration[] — `{ from, to, relationship }`, 각 엔드포인트는 `{ kind, id }`
- `evidence`: EvidenceDeclaration[]
- 선택적 `metadata`: 범위가 제한된 `Record<string, string>`

모든 객체 스키마는 `.strict()`이며, 알 수 없는 키는 검증에 실패한다.

<a id="adaptercapabilitydeclaration"></a>

### AdapterCapabilityDeclaration: 어댑터 기능 선언

- `supportsDiscovery`: boolean
- `evidenceDepth`: `shallow` | `deep`
- `supportsRuntimeTelemetry`: boolean
- `supportsActions`: ActionDepth (`none` | `simulate` | `propose` | `execute`)

`execute`는 금지된 작업 수준이다. 안전하지 않은 매니페스트를 정확히 설명할 수 있도록 파싱은 허용하지만, 커넥터는 로드 시 거부한다.

<a id="evidencedeclaration"></a>

### EvidenceDeclaration: 증거 선언

- `id`, `subjectId`(선언된 엔터티를 참조해야 함), `observedAt`
- `evidenceType`: `declared_configuration` | `runtime_observed`
- `confidence`: 0–1, 기본값 `0.4`. 증거가 `runtime_observed`이고 **동시에** `supportsRuntimeTelemetry`가 true이며 **동시에** `evidenceDepth`가 `deep`인 경우를 제외하면 상한은 `0.7`
- `claims`: 범위가 제한된 `Record<string, string>`

<a id="sourceprovenance"></a>

### SourceProvenance: 소스 출처

모든 정규화된 스냅샷에 부착한다. `producer`, `sourceObjectIds`, `observedAt`, `confidence`, `freshness`(ISO 8601 기간), `isNonAuthoritative: true`, `sourceOfTruth: false`. 마지막 두 값은 상수이므로 매니페스트 입력은 권위를 주장할 수 없다.

<a id="manifestingestionrecord"></a>

### ManifestIngestionRecord: 매니페스트 수집 레코드

`/tenantId`로 파티션된 Cosmos `manifest-ingestions`에 저장하는, 수락된 불변 버전:

- 서버가 제어하는 자산군의 `tenantId`와 `environmentId`
- `manifestId`, 정규화된 SHA-256 `manifestHash`, 생산자의 `producedAt`
- 서버의 `ingestedAt` 및 민감 정보를 제거한 인증된 `ingestedBySubject`
- 검증된 `ManifestEnvelope` 및 정규화된 비권위적 `EstateSnapshot`

해시가 재시도 멱등성 키이다. `(manifestId, envelope.producedAt)`은 유일하므로 서로 다른 두
페이로드가 같은 생산자 버전 타임스탬프를 주장할 수 없다. jobs는 고유 매니페스트 ID를 나열하고
합성 전에 각 ID의 최신 생산자 버전만 읽는다.

<a id="bounds"></a>

### 한도

| 제한 항목                   | 한도 |
| ----------------------- | ----- |
| 메타데이터 키           | 20    |
| 메타데이터 값 길이   | 256   |
| 증거당 주장 키 | 50    |
| 주장 값 길이      | 512   |
| 타입별 엔터티       | 500   |
| 간선                   | 2000  |
| 증거 레코드        | 2000  |
| 매니페스트 파일 크기      | 5 MiB |

<a id="identity-and-idempotency"></a>

### 식별과 멱등성

정규화된 ID는 `stableId`를 통해 `manifest::<manifestId>::<localId>` 형태가 된다. `computeManifestHash`는 키를 재귀적으로 정렬한 정규 JSON의 SHA-256을 16진수로 반환하므로, 변경되지 않은 매니페스트는 항상 같은 해시를 생성하고 재수집은 멱등적이다.

---

<a id="behavior-baseline-and-drift-types-agent-sentineldomain--behavior-baselinets"></a>

## 행동 기준선 및 드리프트 타입(`@agent-sentinel/domain` — `behavior-baseline.ts`)

이 타입은 `@agent-sentinel/behavior-engine`에서 생성하고 API 행동 경로와 웹 UX에서 사용한다.
모든 스키마는 Zod로 검증한다.

<a id="observationsource"></a>

### ObservationSource: 관찰 소스

`'mock-synthetic'` | `'azure-monitor-otel'`

모든 결과에 출처 레이블을 부여한다. 실환경 모드 응답에는 `mock-synthetic`이 절대 포함되지 않는다.
`azure-monitor-otel`은 구성된 Azure Monitor Logs 소스에서 엄격히 매핑된 행을 식별한다.

<a id="runtimeobservation"></a>

### RuntimeObservation: 런타임 관찰값

표본으로 수집한 호출 하나이다. 필드: `id`, `tenantId`, `agentId`, `environment`, `source`, `observedAt`(ISO 8601), `latencyMs`(정수 ≥ 0), `inputTokens`(정수 ≥ 0), `outputTokens`(정수 ≥ 0), `costUsd`(숫자 ≥ 0, 선택 사항), `success`(boolean), `toolCallNames`(최대 50개의 제한된 문자열 배열), 선택적 `correlations`(`agent-run-id`, `correlation-id`, `agent-version` 각각 최대 하나). 상관관계 배열은 이 고정 유형 순서로 정규화하며, 중복 유형은 거부한다. 원본 프롬프트나 크기가 제한되지 않은 페이로드는 포함하지 않는다.

<a id="observationwindow"></a>

### ObservationWindow: 관찰 윈도

크기가 제한되고 타임스탬프가 지정된 `RuntimeObservation` 객체 모음:
`id`, `agentId`, `tenantId`, `environment`, `source`, `windowStart`, `windowEnd`, `observations`(배열 ≤ 10,000).

<a id="baselinewindow"></a>

### BaselineWindow: 기준선 윈도

과거 윈도에 대해 미리 계산한 통계 요약:
`agentId`, `tenantId`, `environment`, `source`, `windowStart`, `windowEnd`, `sampleCount`(정수 ≥ 0), `latencyMs`(`DistributionStats`, 선택 사항), `inputTokens`(`DistributionStats`, 선택 사항), `outputTokens`(`DistributionStats`, 선택 사항), `totalTokens`(`DistributionStats`, 선택 사항), `costUsd`(`DistributionStats`, 선택 사항 — **비용을 측정하지 않았다면 절대 포함하지 않음**), `successRate`, `errorRate`, `toolSequence`(`ToolSequenceSummary`), `evidenceId`(불변 증거 참조), `computedAt`.

`ToolSequenceSummary`는 정렬된 고유 도구 집합과 크기가 제한된 호출별 정규 순서 패턴을
모두 기록하므로, 도구 집합이 바뀌지 않아도 순서만 달라진 경우를 감지할 수 있다.

<a id="distributionstats"></a>

### DistributionStats: 분포 통계

`median`(숫자), `mad`(숫자 ≥ 0), `zeroVariance`(boolean), `sampleCount`(정수 ≥ 1).

MAD(중앙값 절대 편차)는 이상치와 경계가 있는 분포의 비대칭에 강하므로 표준편차 대신 사용한다.

<a id="driftanalysisresult"></a>

### DriftAnalysisResult: 드리프트 분석 결과

`analyzeDrift`의 출력이다. 필드: `analysisId`, `tenantId`, `agentId`, `environment`, `source`, `status`(`AnalysisStatus`), `computedAt`, `baselineEvidenceId`(선택 사항), `observedEvidenceId`(선택 사항), `dimensions`(`DimensionDriftResult` 배열 ≤ 10), `coverage`(`EvidenceCoverage`, 선택 사항), `anyDrift`(boolean), `highestSeverity`(선택 사항), `unavailableReason`(선택 사항 — 사용할 수 없는 실환경 데이터 또는 잘못되거나 오래되거나 부족한 합성 픽스처를 설명).

<a id="analysisstatus"></a>

### AnalysisStatus: 분석 상태

`'ready'` | `'insufficient-data'` | `'stale'` | `'invalid'`

- `ready`: 충분하고 최신이며 중복되지 않은 데이터로 분석을 성공적으로 실행했다.
- `insufficient-data`: 기준선 또는 관찰 윈도의 관찰값이 `MIN_SAMPLES`(10)개 미만이다.
- `stale`: 윈도 종료 시각이 `STALE_WINDOW_HOURS`(168시간 / 7일)보다 오래되었다.
- `invalid`: 데이터 품질 검사 실패(예: 잘못된 타임스탬프, 지나치게 높은 중복 비율, 종료 ≤ 시작), OTel 커넥터 미구성, 또는 공급자 쿼리/행 계약 실패.

<a id="dimensiondriftresult"></a>

### DimensionDriftResult: 차원별 드리프트 결과

단일 차원의 결과: `dimension`(`DriftDimension`), `drifted`(boolean), `severity`(선택적 `DriftSeverity`), `explanation`(임계값과 측정값을 인용하는 사람이 읽을 수 있는 문자열), 선택적 측정값 필드(`baselineMedian`, `observedMedian`, `deviationMads`, `baselineRate`, `observedRate`, `absoluteDelta`, `toolSequenceChange`).

<a id="bounds-1"></a>

### 한도

| 제한 항목                   | 한도  |
| ----------------------- | ------ |
| 윈도당 관찰값 | 500    |
| 분석당 차원 | 10     |
| 관찰값당 도구 호출 이름 | 50     |
| 추적하는 고유 도구    | 100    |
| unavailableReason       | 500자 |

---

<a id="representative-opentelemetry-evidence"></a>

## 대표 OpenTelemetry 증거

`@agent-sentinel/domain`은 대표 추적·스팬·메트릭 증거의 범위가 제한된 계약을 정의한다.
Azure Monitor OTel 커넥터는 네트워크 접근 없이 민감 정보를 제거한 공급자 페이지를 정규화할 수
있으며, 공급자 리소스 ID, 소스 에이전트 ID, 추적 ID, 스팬 ID가 정확히 일치할 때만
주장을 결정론적으로 묶는다.

모든 정규화된 레코드는 다음을 보존한다.

- 자산군 ID, 자산군 테넌트, 자산군 환경
- 커넥터 소스 ID, 소스 테넌트, 소스 환경
- 공급자 리소스 ID와 공급자 에이전트 ID
- OTel 추적·스팬 ID와 공급자 관찰 타임스탬프
- `live` 또는 `synthetic` 분류
- 샘플링 상태/비율과 원시·델타·누적·사전 집계 의미 체계
- 범위가 제한된 호출, 지연 시간, 오류, 입력 토큰, 출력 토큰, 비용 또는 지원하지 않는 주장 하나

분석 준비가 된 호출에는 호환되는 추적 호출 주장 하나, 스팬 지연 시간 및 오류 주장,
입력 토큰·출력 토큰·실측 USD 비용의 원시 메트릭 주장이 필요하다.
이를 구조화된 `otelProvenance`와 함께 `RuntimeObservation`으로 투영한다.
근거 `Evidence`는 최대 500개의 정확한 호출 레코드와 범위가 제한된 전체 품질 요약을 보존한다.
제공된 `correlation-id`는 정확히 보존하며, 해당 상관관계 유형이 없을 때만 추적 ID를 대체값으로 사용한다.

자산군 스냅샷 영속 쓰기는 스냅샷 스키마 버전 2를 사용하며 엄격성을 유지한다.
Cosmos 쓰기, 인메모리 쓰기, Cosmos 버전 2 읽기는 모두 스키마 파싱 후 동일한 맥락 검증기를 실행한다.
모든 중첩 OTel 호출은 대상 자산군 ID·테넌트·환경, 스냅샷 `generatedAt`, 호출 관찰 시각,
런타임 증거 소스 메타데이터, 정확한 권위 있는 에이전트 하나 및 선언된 구성 소스 바인딩과
일치해야 한다. 인용된 모든 선언된 구성 레코드는 권위 있고 비합성이어야 하며,
정확한 자산군·소스·테넌트·환경·프로젝트·공급자·객체·생성 세대 경계와 일관되어야 한다.
올바른 선언 하나가 모순되는 다른 인용 선언을 가릴 수 없다.
구조적으로 유효하더라도 자산군·생성 세대·소스를 넘나드는 출처 정보는 영속화나 버전 2 조회 전에 거부한다.
저장된 스키마 버전에 따라 현재 스키마 파싱 전에 읽기 경로를 선택한다.
버전 2는 엄격하게 파싱하고, 버전이 없거나 버전 1인 스냅샷은 레거시 마이그레이터를 사용한다.
레거시 런타임 호출에서 누락된 `sourceProjectId`, `snapshotGeneratedAt`, `toolCallNames`는
권위 있는 에이전트 하나와 선언된 증거 레코드가 예상 자산군 ID 및 영속화된 정확한 테넌트·소스·환경·
공급자 에이전트와 일치할 때만 보완할 수 있다. 누락된 도구 이름은 빈 목록으로 보완한다.
비어 있는 버전 1 호출 증거, 자산군 간 출처 정보, 이 정확한 맥락이 없는 증거는 사용 가능한
OTel 호출 페이로드 없이 비권위적인 `migration-required` 알 수 없음 증거로만 보존한다.

정확한 소스와 에이전트에 대한 현재 원격 분석 결과를 받으면, 현재의 빈 결과·부분 결과·오래된 결과·
완전한 결과를 적용하기 전에 같은 경계의 이전 투영 런타임 증거를 제거한다.
다른 소스나 에이전트의 증거는 보존하므로, 매니페스트 검증은 현재의 유효한 빈 결과를 받은 뒤
오래된 관찰값을 재사용할 수 없다.

`OtelWindowQuality.status`는 `available`, `unknown`, `degraded` 중 하나이다.
빈 입력은 `unknown`이다. 잘못되거나 누락된 ID, 샘플링, 알 수 없는 샘플링, 부분 레코드,
오래된/미래 타임스탬프, 지원하지 않는 신호나 주장, 집계 메트릭, 중복, 혼합 분류,
불완전한 페이지 매김은 `degraded`이다. 드리프트·기준선·토큰 경제성 분석은 가용 상태가 아닌
품질을 거부하므로 이러한 조건이 정상 또는 성공 결과로 바뀔 수 없다.
합성 레코드는 정규화 후에도 합성으로 유지하며 실환경 행동 분석에서 제거한다.

| 제한 항목                            | 한도  |
| -------------------------------- | ------ |
| 공급자 페이지                   | 20     |
| 페이지당 레코드                 | 500    |
| 정규화당 레코드        | 10,000 |
| 윈도당 투영 호출 | 500    |
| 호출당 증거 레코드  | 6      |

---

<a id="token-economics-domain-types-packagesdomainsrctoken-economicsts"></a>

## 토큰 경제성 도메인 타입(packages/domain/src/token-economics.ts)

<a id="tokeneconomicsreport"></a>

### TokenEconomicsReport: 토큰 경제성 보고서

관찰 윈도 하나의 에이전트 하나에 대한 범위가 제한된 보고서이다.

- `reportId`: 테넌트, 에이전트, 환경, 소스, 윈도의 결정론적 해시
- `tenantId`, `agentId`, `environment`, `source` (mock-synthetic | azure-monitor-otel)
- `windowStart`, `windowEnd`, `computedAt`: ISO 8601
- `status`: `ready | insufficient-data | unavailable | connector-not-connected`
- `unavailableReason`: 상태가 `ready`가 아닐 때 포함
- `coverage`: TokenEconomicsCoverage(준비 상태일 때 포함)
- `baselineEvidenceId`, `observedEvidenceId`: 이상에 근거한 상태 판단에 필요한 불변 참조
- `totalInputTokens`, `totalOutputTokens`, `totalTokens`: 실측 합계(준비 상태일 때 포함)
- `medianInputTokens`, `medianOutputTokens`, `medianTotalTokens`: 강건 중앙값(준비 상태일 때 포함)
- `measuredCostUsd`: 실측 costUsd 값만 합산. 측정하지 않았으면 생략하며 절대 추정하지 않음
- `medianCostUsd`: 비용이 측정된 관찰값만의 중앙값
- `costPerSuccessUsd`: 실패한 호출을 포함한 전체 비용 측정 모집단의 총비용을 같은 모집단의 성공 횟수로 나눈 값. 해당 모집단의 성공 횟수가 0이면 생략
- `anomalies`: TokenEconomicsAnomaly[] (최대 20개)

<a id="tokeneconomicscoverage"></a>

### TokenEconomicsCoverage: 토큰 경제성 커버리지

- `totalObservations`, `deduplicatedObservations`, `duplicatesRemoved`
- `successCount`, `measuredSuccessCount`, 토큰 차원별 측정 개수, `costMeasuredCount`
- `costCoverage`: 0–1 비율. 모든 관찰값에 실측 비용이 있는 것이 아니면 부분 커버리지(< 1)
- `exactCorrelationCount`, `exactCorrelationCoverage`: 에이전트 실행 또는 상관관계 식별자를
  포함한 관찰값. 성과 조인이 아니라 런타임 연결 가능성을 보고하며, agent-version만으로는 정확한 일치가 아님

<a id="tokeneconomicsanomaly"></a>

### TokenEconomicsAnomaly: 토큰 경제성 이상

- `anomalyId`: 결정론적 해시
- `dimension`: `input-tokens | output-tokens | total-tokens | cost`
- `severity`: `low | medium | high | critical`
- `baselineMedian`, `observedMedian`, `deviationMads`(선택 사항, 분산이 0인 기준선에서는 생략)
- `evidenceIds`: 기준선 및 관찰 증거 참조
- `explanation`: 사람이 읽을 수 있는 설명

<a id="design-constraints-for-token-economics"></a>

## 토큰 경제성 설계 제약

- 비용은 실측 RuntimeObservation.costUsd 필드에서만 가져온다. 토큰 수나 모델 가격표로 절대 추정하지 않는다.
- 부분 비용 커버리지(costCoverage < 1)는 항상 사용자에게 표시해야 하며 전체 자산군으로 외삽하지 않는다.
- `costPerSuccessUsd`는 실패한 호출을 포함한 비용 측정 모집단의 총 실측 비용을 같은 모집단의 성공한 호출 수로 나눈 값이다. 해당 모집단의 성공 횟수가 0이면 생략한다.
- 이상 감지는 드리프트 분석 엔진과 동일한 MAD 기반 임계값(behavior-engine의 MADS_THRESHOLDS, PCT_THRESHOLDS)을 재사용한다.
- 통화 변환, ROI, 추정 절감액, 비용 회피 계산을 수행하지 않는다.
- 실환경 Foundry 모드 API 응답에는 `source: 'mock-synthetic'`이 절대 나타나서는 안 된다.
