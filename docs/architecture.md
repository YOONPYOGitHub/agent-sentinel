<a id="agent-sentinel--architecture"></a>

# Agent Sentinel 아키텍처

<a id="overview"></a>

## 개요

Agent Sentinel은 기업 환경에서 AI 에이전트의 노출을 발견하고 매핑하며 개선 조치를 수행하는 플랫폼이다. 완전히 비공개인 내부 VNet 환경의 Azure Container Apps에서 실행되는 React SPA(web), Fastify REST API(api), 백그라운드 작업 워커(jobs)로 구성된다.

<a id="public-endpoint"></a>

## 공개 엔드포인트

**현재 활성 공개 에지: Azure Front Door Premium** (`fd-as-260814`)

Front Door는 HTTPS 엔드포인트와 WAF 경계를 제공한다. Private Link 원본은 VNet에서 접근 가능한
web Container App이다. API는 환경 내부로만 제한되며 web nginx 프록시를 통해서만 접근한다.
Application Gateway는 지역 HTTP 진단 에지이며 필요하지 않을 때 중지할 수 있다.

```text
인터넷 (HTTPS)
    |
Azure Front Door Premium + WAF
    |
내부 ACA 환경으로 연결되는 Private Link
    |
web-as-260814 (nginx + React SPA)
    |
    +-- /api/* --> api-as-260814 (ACA 서비스 검색, 공개 인그레스 없음)

jobs-as-260814는 인그레스가 없으며 프라이빗 플랫폼 서비스를 사용한다.
```

<a id="network-boundary-enforcement"></a>

## 네트워크 경계 강제

| 리소스       | 인그레스 유형     | 접근 가능한 위치               | 비고                              |
| -------------- | ---------------- | ----------------------------- | ---------------------------------- |
| web-as-260814  | external:true    | Front Door Private Link, VNet | ACA 환경 내부 포트 80 |
| api-as-260814  | external:false   | ACA 환경 내부만                  | nginx 프록시를 통해서만 접근 가능     |
| jobs-as-260814 | 없음             | 접근 불가                 | SB(Service Bus) 트리거 작업만 실행             |
| Cosmos DB      | 프라이빗 엔드포인트       | VNet private-endpoints 서브넷 | 공개 접근 없음                   |
| PostgreSQL     | 위임된 서브넷 | VNet database 서브넷          | 공개 접근 없음                   |
| AI Search      | 프라이빗 엔드포인트       | VNet private-endpoints 서브넷 | 공개 접근 없음                   |
| Service Bus    | 프라이빗 엔드포인트       | VNet private-endpoints 서브넷 | 공개 접근 없음                   |
| Key Vault      | 프라이빗 엔드포인트       | VNet private-endpoints 서브넷 | 공개 접근 없음                   |
| ACR            | 프라이빗 엔드포인트       | VNet private-endpoints 서브넷 | publicNetworkAccess: Disabled      |

<a id="vnet-subnets-1000016"></a>

## VNet 서브넷(10.0.0.0/16)

| 서브넷            | CIDR        | 용도                          |
| ----------------- | ----------- | -------------------------------- |
| apps              | 10.0.0.0/23 | ACA 환경(위임됨)      |
| private-endpoints | 10.0.2.0/24 | PaaS용 프라이빗 엔드포인트       |
| database          | 10.0.3.0/24 | PostgreSQL Flexible Server       |
| integration       | 10.0.4.0/24 | 향후 통합을 위해 예약됨 |
| appgw             | 10.0.5.0/24 | Application Gateway WAF v2       |

<a id="azure-front-door-status"></a>

## Azure Front Door 상태

**주 프로필 `fd-as-260814`가 현재 활성 HTTPS 에지이다.**

Front Door는 VNet에서 접근 가능한 web Container App을 대상으로 Private Link 원본 하나와
`/*` 경로 하나를 사용한다. Nginx는 SPA를 제공하고 ACA 서비스 검색을 통해 `/api/*`를
환경 내부 전용 API로 프록시한다.

Front Door가 API Container App을 직접 대상으로 삼아서는 안 된다. 내부 ACA 인그레스는
같은 ACA 환경의 다른 앱에서만 접근할 수 있다. API 복제본이 정상이어도 직접 연결한
Private Link 원본은 `404 Unavailable`을 반환한다.

<a id="nginx-reverse-proxy-web-as-260814"></a>

## Nginx 역방향 프록시(web-as-260814)

web 컨테이너에서 실행되는 nginx는 다음을 수행한다.

1. `/api/` 및 `/health`를 제외한 모든 경로에서 React SPA를 제공한다.
2. `/api/*`를 `http://api-as-260814`로 역방향 프록시한다(동일 ACA 환경 내 서비스 검색).
3. 에지 상태 프로브를 위해 `/health`를 HTTP 200으로 노출한다.

API 컨테이너에는 공개 인터넷이나 VNet에서 직접 접근할 수 없다.
지원 경로는 `Front Door -> web nginx -> API`이다.
App Gateway는 범위가 제한된 지역 진단 에지로만 사용할 수 있다.

<a id="packages"></a>

## 패키지

- **@agent-sentinel/domain** — Zod 스키마, 도메인 타입, 리포지토리 인터페이스
- **@agent-sentinel/persistence** — Cosmos DB 및 PostgreSQL 리포지토리 구현
- **@agent-sentinel/search** — AI Search 인덱스 스키마, 수집, RAG 검색
- **@agent-sentinel/messaging** — Service Bus 이벤트 계약, 멱등성 기본 요소
- **@agent-sentinel/graph-engine** — 공격 경로 계산
- **@agent-sentinel/policy-engine** — 정책 평가
- **@agent-sentinel/connector-sdk** — 커넥터 기본 추상화와 버전이 지정된 매니페스트 봉투 계약
- **@agent-sentinel/scenarios** — 시나리오 픽스처
- **@agent-sentinel/manifest-connector** — 읽기 전용 사용자 지정 매니페스트 검증, 정규화, 비권위적 자산군 합성
- **@agent-sentinel/azure-monitor-otel-connector** — 범위가 제한된 OTel `AppRequests` 행을 정확한 테넌트, Foundry 프로젝트, 공급자 에이전트, 환경으로 필터링한 뒤 시간 범위가 정해진 `ObservationWindow` 객체를 만드는 읽기 전용 Azure Monitor Logs 쿼리 어댑터. 윈도를 나누기 전에 관찰 ID를 기준으로 전체 응답을 정규화한다. 정확한 스냅샷 생성 시점, 자산군, 소스 프로젝트, 워크스페이스, 공급자 에이전트, 추적, 스팬, 런타임 상관관계, 버전, 일치한 도구의 출처를 보존하며, 완전하고 최신이며 샘플링되지 않았고 명시적으로 비합성인 그룹만 실환경 분석에 제공한다. 수집이나 Azure 리소스 변경을 수행하지 않으며 `AppMetrics`나 픽스처로 대체하지 않는다.
- **@agent-sentinel/behavior-engine** — 결정론적 행동 기준선, 드리프트, 실측값 전용 토큰 경제성 엔진(중앙값/MAD 통계, 도구 순서 드리프트, 정합성을 확인한 커버리지, 증거와 연결된 비용 이상). `@agent-sentinel/domain`에 의존한다. 네트워크 I/O, 가격 조회, LLM을 사용하지 않는다.
- **@agent-sentinel/ui** — KPI, 상태, 최신성, 데이터 상태를 표현하는 공통 Agent Sentinel 디자인 토큰과 타입이 지정된 React 기본 요소. Storybook은 접근성 검사를 포함한 현실적인 상태를 격리해서 제공한다.
- **@agent-sentinel/tools** — 오프라인 개발자 CLI(매니페스트 검증)

<a id="custom-manifest-adapter"></a>

## 사용자 지정 매니페스트 어댑터

사용자 지정 매니페스트 어댑터는 자사 커넥터가 다루지 않는 에이전트 인벤토리를 수집한다.
의도적으로 시스템에서 가장 낮은 권한을 갖는 커넥터로 설계되었다.

```
운영자 매니페스트 (인증된 API, 인라인 객체 또는 로컬 절대 경로 파일)
  -> file-loader        경로 안전성, 크기 한도, 일반 파일 검사; 네트워크 및 URL 사용 안 함
  -> validator          스키마 버전, 엄격한 Zod 검증, 작업 수준, 테넌트, 환경
  -> normalizer         EstateSnapshot + SourceProvenance (sourceOfTruth: false)
  -> manifest-ingestions 불변 Cosmos 버전, 해시 기반 멱등성
  -> jobs               매니페스트별 최신 버전 + Foundry 스냅샷 합성
  -> 기존 그래프/정책 파이프라인
```

구조적으로 보장하는 경계:

- **인증된 인그레스만 허용.** `POST /api/manifests/ingestions`에는 JWT 모드, Administrator의 `configure` 권한, 배포 쓰기 게이트가 필요하다. 인증되지 않은 수집 경로는 없다.
- **외부 송신 없음.** `://`를 포함하거나 `//`로 시작하는 경로는 I/O 전에 거부하므로, 어댑터가 SSRF 요청을 수행하도록 유도할 수 없다.
- **작업 실행 없음.** `ManifestConnector`는 발견과 증거 기능만 구현한다. `execute()`가 없으며 `supportsActions: 'execute'`를 선언한 매니페스트는 거부한다.
- **권위 없음.** 출처 정보는 `sourceOfTruth: false`와 `isNonAuthoritative: true`로 고정한다. 선언된 주장의 신뢰도 상한은 0.7(기본값 0.4)이며, 매니페스트가 심층 런타임 원격 분석을 선언한 경우에만 높아진다.
- **증거 ID 분리.** 수락 시 생성되는 기준선 증거용으로 `declared::<entity-id>`를 예약하며, 운영자 증거가 이 네임스페이스와 충돌하면 타입이 지정된 검증 문제를 반환한다.
- **자산군 범위 제한.** 봉투와 모든 엔터티의 환경은 서버가 제어하는 자산군 테넌트/환경 값과 일치해야 한다. 인증 토큰의 테넌트는 호출자 ID를 확립하며 Azure 자산군 테넌트와 다를 수 있다.
- **가용성 격리.** 매니페스트 리포지토리나 합성 실패는 선택적 소스만 저하시킨다. jobs는 권위 있는 Foundry 스냅샷을 계속 영속화한다.

<a id="connector-health-measurements"></a>

## 커넥터 상태 측정

jobs는 스냅샷을 의도적으로 승격하지 않은 부분 실행을 포함하여, 완료된 각 발견 작업이 생성한
커넥터 상태 보고서를 영속화한다. 각 측정값은 자산군 ID, 데이터 테넌트, 환경, 커넥터 ID를 키로
저장하고 조회한다. Cosmos는 기존 테넌트 파티션 아래 snapshots 컨테이너에 타임스탬프가 있는
불변 측정값을 저장하고, 정규화된 범위·시간 튜플의 SHA-256 해시로 문서 ID를 도출한다.
인메모리 어댑터도 로컬 실행과 테스트에서 동일한 경계 계약을 따른다.
쓰기는 원자적 생성 의미 체계를 사용한다. 정확히 같은 자산군/테넌트/환경/커넥터/타임스탬프
튜플에서는 첫 측정값이 우선하고, 바이트 단위로 같은 재시도는 멱등적으로 처리한다.
다른 내용의 재시도는 상태나 진단을 변경하지 않고 타입이 지정된 충돌을 발생시킨다.
해시가 충돌하면 멱등 재시도로 간주하지 않고 전체 튜플과 대조해 검증한다.

실환경 모드에서 `GET /api/connectors`는 인가된 요청 자산군과 활성 커넥터에 대해
영속화된 최신 측정값을 읽는다. 요청 처리 경로에서 공급자를 프로브하지 않으며 프로세스 로컬
상태나 합성 상태로 대체하지 않는다. 측정값이 없으면 사용 불가 상태를 유지한다.
런타임 원격 분석 상태는 정확한 자산군·테넌트·환경·소스 범위로 독립적으로 영속화된 측정값이
생길 때까지 생략한다. 프로세스 로컬 런타임 커넥터 상태는 실환경 응답에 절대 포함하지 않는다.
기본값이 아닌 자산군에서는 기본 자산군 프로젝트 엔드포인트와 범위가 지정되지 않은 비즈니스 성과 상태도 생략한다.

<a id="security"></a>

## 보안

- 모든 서비스 간 통신은 Managed Identity(UAMI, 사용자 할당 관리 ID)를 사용한다.
- 로컬 인증 정보/연결 문자열을 코드에 저장하지 않는다.
- 저장된 비밀에는 Key Vault(Premium)를 사용한다.
- 모든 PaaS 서비스에 프라이빗 엔드포인트를 사용한다.
- ACA에는 VNet 통합을 사용한다(내부 환경).
- **API Container App은 내부 전용 인그레스를 사용한다.** 인터넷이나 VNet에서 직접 접근할 수 없다.
- 공개 진입점에 방지 모드의 WAF v2(OWASP 3.2 + Bot Manager)를 사용한다.

<a id="token-economics-analysis"></a>

## 토큰 경제성 분석

토큰 경제성 분석 엔진(`@agent-sentinel/behavior-engine`)은 드리프트 분석 엔진과 동일한 MAD 기반 통계 기반 구조를 재사용한다.

<a id="evidence-boundaries"></a>

### 증거 경계

| 경계                     | 상태                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 토큰 경제성 엔진       | 구현됨. 결정론적 MAD 기반 분석, 중복 제거, 커버리지 추적.                                  |
| 모의 합성 픽스처      | 에이전트 3개(hr-policy-agent, code-review-copilot, sales-research-agent)의 정상/이상/비용 없음 시나리오. |
| GET /api/token-economics/... | 구현됨. mock은 합성 결과를 반환하고 foundry는 connector-not-connected를 반환한다.                                     |
| OTel 런타임 쿼리 커넥터 | 구현됨. 완전한 Azure Monitor 구성과 제한된 Logs 쿼리 권한이 있을 때만 활성화된다.       |
| 비용 매핑                 | 실측 `agent.sentinel.cost.usd`에 대해 구현됨. 값이 없으면 알 수 없음으로 유지하며 절대 추정하지 않는다.           |
| 실환경 효율성 스코어카드    | 구성된 공급자가 유효하고 충분한 커버리지를 갖춘 실측 윈도를 반환할 때만 사용할 수 있다.                  |

<a id="mode-boundaries"></a>

### 모드 경계

- **모의 모드:** `[SYNTHETIC]` 레이블이 붙은 결정론적 합성 보고서를 반환한다. 에이전트 3개의 실측 비용, 이상, 비용 누락 예시를 포함한다.
- **구성되지 않은 Foundry 모드:** 타입이 지정된 `connector-not-connected`를 반환한다. 공급자 실패나 잘못된 행은 타입이 지정된 `unavailable`/`invalid`를 반환한다. 어느 경로도 합성 데이터로 대체하지 않는다.
- **알 수 없는 에이전트:** 성공 데이터를 만들어 내지 않고 `insufficient-data`를 반환한다.

<a id="next-steps"></a>

## 다음 단계

1. **Entra ID 증거 활성화:** 커넥터를 활성화하기 전에 테넌트 관리자 동의와 범위가 제한된 v1.0 인벤토리 검증을 완료한다.
2. **인프라 드리프트 정합성 확인:** 전체 Bicep what-if에는 관련 없는 변경이 포함되어 있으므로, 실환경 상태와 대조하여 검토하기 전에는 적용해서는 안 된다.
3. **사용자 지정 도메인 강화:** 필요할 때 승인된 사용자 지정 도메인/TLS 정책을 추가한다. 현재의 범위가 제한된 인증 검증에는 활성 Front Door 기본 HTTPS 원본으로 충분하다.
