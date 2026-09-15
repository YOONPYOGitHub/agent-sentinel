<a id="agent-sentinel-domain-context"></a>

# Agent Sentinel 도메인 맥락

<a id="product-boundary"></a>

## 제품 경계

Agent Sentinel은 여러 플랫폼에 걸친 AI 에이전트 운영 및 보안 제어 평면이다.
Microsoft와 타사 시스템의 권위 있는 데이터를 활용하며, 각 시스템의 기본 관리 기능을 재구현하지 않는다.

<a id="product-pillars"></a>

## 제품의 핵심 축

- **발견:** 에이전트 플랫폼 전반의 인벤토리와 소유권.
- **거버넌스:** 정책, 예외, 승인, 컴플라이언스 증거.
- **보호:** 노출, 검증, 인시던트, 대응.
- **관찰:** 신뢰성, 품질, 활동, 지연 시간, 비용.
- **최적화:** 증거 기반 권고와 성과 검증.
- **수명주기:** 릴리스, 승격, 드리프트, 롤백, 폐기.

<a id="shared-language"></a>

## 공통 용어

- **에이전트 자산군:** 테넌트 내 모든 에이전트와 그 버전, ID, 기능, 소유자, 환경, 의존성.
- **증거 그래프:** 주장에 항상 출처, 신뢰도, 최신성, 관찰 시각을 명시하는, 타입이 지정된 자산과 관계.
- **공격 경로:** 신뢰할 수 없는 출발점에서 민감한 데이터 자산이나 영향이 큰 작업에 이르는 증거 기반의 연속 경로.
- **영향 반경:** 선택한 노드나 침해된 경로에서 도달할 수 있는 자산, 데이터, 작업, 사용자, 하위 에이전트.
- **검증:** 이론적 발견 사항을 검증됨 또는 재현되지 않음으로 바꾸는, 범위가 제한된 비파괴 테스트.
- **개선 조치:** 노출을 줄이며 롤백 방침이 정해진, 인가되고 감사 가능하며 멱등적인 작업.
- **Trust Catalog(신뢰 카탈로그):** 출처, 권한, 검증, 노출, 사용량, 수명주기 증거를 갖추고 거버넌스가 적용되는 에이전트, MCP 서버, 도구, 모델, 커넥터.

<a id="invariants"></a>

## 불변 조건

- 증거가 없으면 신뢰도가 낮아진다. 안전하다는 뜻은 결코 아니다.
- 증거 없는 발견 사항이나 관계는 존재하지 않는다.
- 인가와 승인 맥락 없이 영향이 큰 작업을 실행하지 않는다.
- 테넌트와 환경 경계는 UI 아래 계층에서도 적용한다.
- LLM 출력은 증거를 요약할 수 있지만 보안상의 사실을 확정하지는 않는다.

<a id="azure-ai-foundry-connector"></a>

## Azure AI Foundry 커넥터

`@agent-sentinel/foundry-connector` 워크스페이스는 Foundry v1 API에서 선언된 에이전트 및 함수 도구 구성을 발견한다. 이 증거에는 **선언된 구성**이라는 레이블을 붙이며, 관찰된 런타임 동작으로 제시하지 않는다. `@agent-sentinel/scenarios` 워크스페이스는 합성 검증 에이전트 6개를 정의하고, `@agent-sentinel/scripts`는 프로비저닝과 실환경 검증을 담당한다.

환경 변수:

- `AGENT_SENTINEL_CONNECTOR=mock|foundry` (기본값: `mock`)
- `FOUNDRY_PROJECT_ENDPOINT`
- `FOUNDRY_TENANT_ID`
- `FOUNDRY_ENVIRONMENT`

```bash
cd ~/project/agent-sentinel
FOUNDRY_PROJECT_ENDPOINT=https://ais-agent-sentinel-260814.services.ai.azure.com/api/projects/agent-sentinel-pjt tsx scripts/provision-agents.ts
FOUNDRY_PROJECT_ENDPOINT=https://ais-agent-sentinel-260814.services.ai.azure.com/api/projects/agent-sentinel-pjt tsx scripts/validate-live.ts
# 삭제 작업이므로 실행 전에 검토한다. 매니페스트에 있는 에이전트 이름만 삭제한다.
FOUNDRY_PROJECT_ENDPOINT=https://ais-agent-sentinel-260814.services.ai.azure.com/api/projects/agent-sentinel-pjt tsx scripts/cleanup-agents.ts
```

실환경 검증은 민감 정보를 제거하고 Git 추적에서 제외한 `scripts/live-validation-report.json`을 작성한다.

<a id="custom-manifest-adapter"></a>

## 사용자 지정 매니페스트 어댑터

`@agent-sentinel/manifest-connector` 워크스페이스는 자사 커넥터가 다루지 않는 에이전트를 기술한
운영자 제공 매니페스트를 수집한다. 이 소스는 **비권위적**이며, 커버리지 공백을 숨기지 않고
명확히 드러내기 위해 존재한다.

용어:

- **매니페스트 봉투:** 운영자가 제공하는, 버전이 지정되고 엄격하게 검증되는 문서.
  `@agent-sentinel/connector-sdk`에서 한 번만 정의한다.
- **어댑터 주장:** 매니페스트에서 유래한 증거 레코드. 항상
  `sourceOfTruth: false` 및 `isNonAuthoritative: true`이다.
- **선언된 구성과 관찰된 런타임의 구분:** 매니페스트가 `runtime_observed` 증거를 선언하고
  _동시에_ 어댑터가 `evidenceDepth: 'deep'`과 함께 `supportsRuntimeTelemetry`를 선언한 경우를
  제외하면 매니페스트 증거는 선언된 구성으로 취급한다. 그렇지 않으면 해당 주장을 선언된 구성으로 하향 분류한다.

위의 공통 불변 조건에 더해 어댑터에 적용되는 불변 조건:

- 매니페스트는 자사 커넥터보다 우선하지 않는다. 선언된 주장의 신뢰도 상한은 0.7이며 기본값은 0.4이다.
- 어댑터는 네트워크 I/O를 수행하지 않는다. 읽기 전에 원격 URL과 상대 경로를 거부하며 로컬 절대 경로만 허용한다.
- 어댑터는 작업을 수행할 수 없다. `execute()`가 없으며 `execute` 작업 수준은 로드 시 거부한다.
- 테넌트와 환경은 서버가 제어하는 자산군 경계와 일치해야 하며, UI 아래 계층과 영속성 계층에서 각각 강제한다.
- API 수집에는 JWT Administrator의 `configure` 권한과 배포 쓰기 게이트가 모두 필요하다.
  인증되지 않은 수집 엔드포인트는 없다.
- 변경 불가능한 콘텐츠 해시 버전을 별도로 저장하며, jobs는 매니페스트별 최신 버전만 비권위적 증거로 합성한다.

```bash
pnpm manifest:validate -- /absolute/path/to/manifest.json
```

<a id="behavior-baseline-and-drift-analysis-engine"></a>

## 행동 기준선 및 드리프트 분석 엔진

`@agent-sentinel/behavior-engine` 워크스페이스는 에이전트별 런타임 행동 기준선과 드리프트 발견 사항을
위한 결정론적 통계 엔진을 구현한다. `@agent-sentinel/domain`에만 의존하며 네트워크 I/O를 수행하지 않는다.

<a id="what-is-implemented"></a>

### 구현된 내용

- **강건 통계:** 지연 시간, 토큰, 실측 비용 분포에 중앙값과 MAD(중앙값 절대 편차)를 사용한다.
  이상치에 강하며 평균/표준편차는 사용하지 않는다.
- **비율 드리프트:** 오류율의 절대 변화량을 비교하고 4단계 심각도를 적용한다.
  성공률은 정확히 보완 관계이므로 중복해서 다루지 않는다.
- **도구 순서 드리프트:** 추가·제거·재정렬된 도구 호출의 집합과 순서 패턴을 분석하고
  설명 가능한 심각도를 제공한다.
- **불확실할 때 차단하는 데이터 품질 처리:** 오래된 윈도, 부족한 표본(< 10),
  잘못된 타임스탬프, 높은 중복 비율, 클록 스큐 위반은 모두 `status: 'invalid'` 또는
  `status: 'insufficient-data'`를 반환하며, 아무 알림 없이 정상 상태로 대체하지 않는다.
- **비용 부재 = 알 수 없음:** `costUsd`는 결코 추정하지 않는다. 측정값이 없으면 비용 차원을 생략하며,
  측정값이 있으면 동일한 강건 임계값으로 분석한다.
- **타입이 지정된 증거 참조:** `DriftAnalysisResult.baselineEvidenceId`와
  `observedEvidenceId`는 증거 레코드에 대한 변경 불가능한 문자열 참조이다.

<a id="mode-separation"></a>

### 모드 분리

| 결과 필드           | 모의 모드                    | 실환경 모드(OTel 구성됨)                             |
| ------------------- | ---------------------------- | ---------------------------------------------------- |
| `source`            | `'mock-synthetic'`           | `'azure-monitor-otel'`                               |
| `status`            | `'ready'`(또는 데이터 문제)  | 엔진 결과 또는 실패 시 타입이 지정된 알 수 없음 상태 |
| `unavailableReason` | 데이터 문제가 있을 때만 설정 | 원격 분석이 없거나 실패했거나 유효하지 않을 때 설정  |
| 드리프트 표시 여부  | 표시함(합성 데이터)          | 실측 윈도가 검증을 통과한 경우에만 표시              |

실환경 모드 API 응답에는 `source: 'mock-synthetic'`이 **절대** 포함되지 않는다.
사용할 수 없는 실환경 결과를 합성 결과로 대체하지 않는다.

<a id="live-runtime-adapter"></a>

### 실환경 런타임 어댑터

`@agent-sentinel/azure-monitor-otel-connector` 워크스페이스는 범위가 제한된 읽기 전용
Azure Monitor Logs 쿼리를 수행하고, 필요한 필드로 투영된 OTel `AppRequests` 행을
`ObservationWindow` 객체로 엄격하게 매핑한다. 워크스페이스·테넌트·환경 구성이 주입된 경우에만
활성화된다. 구성이 없거나 공급자/계약 실패가 발생하면 타입이 지정된 알 수 없음 상태를 유지한다.
`@agent-sentinel/mock-connector`의 고정 픽스처는 모의 모드에서만 읽는다.

불변 조건:

- 드리프트 분석에는 LLM이 관여하지 않는다. 심각도와 신뢰도는 측정값과
  `packages/behavior-engine/src/thresholds.ts`에 정의된 임계값에 대한 결정론적 함수이다.
- 계산 한도를 명시한다. 윈도당 관찰값 ≤ 10,000개, 분석 결과당 차원 ≤ 10개,
  관찰값당 도구 이름 ≤ 50개이다.
- 엔진은 읽기 전용이다. 수집 엔드포인트는 없다.
