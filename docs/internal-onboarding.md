<a id="corporate-onboarding"></a>

# 사내 온보딩

Agent Sentinel의 사내 온보딩 런북입니다.
이 문서는 개인 연락처, 테넌트 식별자, Service Tree 식별자,
앱 등록 식별자를 저장하지 않고 반복 가능한 절차를 기록합니다.

<a id="why-service-tree-is-required"></a>

## Service Tree가 필요한 이유

Service Tree는 서비스에 대한 책임 있는 Microsoft 소유 관계를 확립합니다.
청구 수단이 아니며 애플리케이션을 배포하거나 외부에 노출하지 않습니다.
사내 Microsoft Entra 앱 등록에는 ID 자산의 소유자, 수명 주기, 지원 경로를
확보하기 위해 해당 Service Tree 레코드가 필요합니다.

<a id="registration-decision"></a>

## 등록 결정

서비스를 생성하기 전에:

1. 소유 조직과 제품 범위가 Agent Sentinel에 맞는 기존 서비스를 검색합니다.
2. 책임 소유자가 Agent Sentinel이 해당 서비스에 속한다고 확인한 경우에만 재사용합니다.
3. 편리하다는 이유로 관련 없는 조직이 소유한 해커톤 또는 랩 서비스를 재사용하지 않습니다.
4. 적합한 서비스가 없으면 확인된 소유 계층 아래에 새 서비스를 생성합니다.

Agent Sentinel의 경우 관련 없는 해커톤 및 랩 레코드를 검토한 뒤 사용하지 않기로 했습니다.
확인된 `MCAPS > GES Asia > Korea` 계층 아래에 새 서비스를 생성했습니다.

<a id="registered-metadata"></a>

## 등록된 메타데이터

| 필드                      | 값               |
| ------------------------- | ---------------- |
| Service name              | `Agent Sentinel` |
| Short name                | `AgentSentinel`  |
| Service type              | Online Service   |
| Service subtype           | Azure            |
| Cloud                     | Public           |
| Microsoft-owned           | Yes              |
| External-facing           | No               |
| Lifecycle                 | In Development   |
| Next stage                | Private Preview  |
| Estimated next-stage date | 2026-09-30       |

이 서비스에는 개발 및 프로그램 관리를 담당하는 프로젝트 소유자,
업무 연속성을 위한 두 번째 관리자, 비공개 팀 별칭이 있습니다.
정확한 ID와 생성된 식별자는 Git이 아니라 승인된 사내 시스템에서 관리합니다.

<a id="feature-alias"></a>

## 기능 별칭

개인 주소 대신 전용 Microsoft 365 그룹을 사용합니다.

- 비공개 구성원
- 내부 전용 민감도 레이블
- 외부 발신자 비활성화
- 소유자 최소 2명
- 프로젝트 구성원에게 최소 권한 부여
- Service Tree에는 `@microsoft.com` 접미사 없이 별칭 입력

확인된 비공개 그룹은 다음과 같습니다.

- Display name: `Agent Sentinel Hackathon`
- Primary SMTP address: 비공개 온보딩 기록에만 보관

이 그룹을 IcM 서비스 이메일과 기본 Triage, Incident Manager,
Executive Incident Manager 팀 이메일 필드에 사용합니다.
구성원 및 소유권의 기준은 Microsoft 365 디렉터리이며,
구성원 목록을 Git에 복사하지 않습니다.

<a id="compliance-and-icm-onboarding-status"></a>

## 규정 준수 및 IcM 온보딩 상태

TrIP Digital Asset 온보딩 메타데이터는 2026-08-26에 Compliance Coach에서 작성 완료했습니다.
제출된 분류는 Agent Sentinel을 Microsoft 내부 직원용으로 개발 중인
기밀 웹 기반 사용자 지정 서비스 및 웹 API로 기록합니다.
Microsoft 업무 데이터, 직원 운영 디렉터리 데이터, 접근 제어 데이터를 처리합니다.
고객 데이터, 모델 학습 데이터, 규제 대상 민감 데이터는 처리 대상으로 선언하지 않았습니다.

S360은 현재 SLA 기한 내에 있는 Service Tree 관리 작업 두 건을 보고하며,
두 작업의 기한은 모두 2026-09-20입니다.

- IcM 온콜 팀과 테넌트를 Service Tree 서비스에 연결합니다.
- IcM 연결 후 Security 긴급 브로드캐스트 설정을 구성합니다.

IcM 온보딩에는 다음과 같은 반복 가능한 구성을 사용합니다.

- Service Tree 서비스: `Agent Sentinel`
- Service category: `MCAPS`
- CEN override: `No configuration`
- Service and team email: 위에서 확인한 비공개 그룹
- Default teams: Triage, Incident Manager, Executive Incident Manager
- Team membership: 활성 IcM 연락 담당자 최소 2명
- Default rotation: 태평양 시간 월요일 오전 10시에 시작하는 주간 순환

업무 연속성을 위한 두 연락 담당자는 여기에 나열하지 않고 IcM과 Service Tree에서 관리합니다.
각 담당자는 자신의 IcM 프로필에 있는 필수 전화번호 필드를 직접 관리해야 합니다.
해당 전화번호를 채팅, 이메일, Git 또는 프로젝트 문서로 수집하거나 기록하지 마세요.

<a id="permission-and-approval-process"></a>

## 권한 및 승인 절차

올바른 계층이 보이지만 선택할 수 없는 경우:

1. 다른 계층 아래에 등록하지 않습니다.
2. 확인된 Service Group 관리자에게 등록 권한 또는 올바른 배치를 요청합니다.
3. 서비스 목적, 요청 계층, 소유권 모델, 기존 레코드 생성 여부를 포함합니다.
4. 소유자가 대상 계층을 확인한 후에만 재개합니다.
5. 개인 서신이나 티켓 식별자를 제외하고 [현재 상태](current-status.md)에 완료를 기록합니다.

Agent Sentinel은 이 절차를 완료했으며 현재 Service Tree 레코드가 존재합니다.

<a id="api-app-registration-checklist"></a>

## API 앱 등록 점검 목록

별도의 단일 테넌트 API 앱을 생성합니다.

- Agent Sentinel Service Tree 레코드에 연결합니다.
- 브라우저 리디렉션 URI는 구성하지 않습니다.
- delegated scope `AgentSentinel.Read`와 `AgentSentinel.Write`를 노출합니다.
- `Viewer`, `Analyst`, `Approver`, `Administrator` app role을 정의합니다.
- role 및 scope 식별자는 배포 secret store에 보관합니다.
- API에 필요한 권한만 부여합니다.

<a id="spa-app-registration-checklist"></a>

## SPA 앱 등록 점검 목록

별도의 단일 테넌트 SPA 앱을 생성합니다.

- 동일한 Service Tree 레코드에 연결합니다.
- Front Door HTTPS 콜백 및 로그아웃 URI를 등록합니다.
- Agent Sentinel API에 대한 위임 권한을 추가합니다.
- 브라우저 애플리케이션에 클라이언트 비밀을 추가하지 않습니다.
- 요청 권한을 검토한 후에만 테넌트 동의를 부여합니다.

<a id="activation-and-rollback"></a>

## 활성화 및 롤백

대체 배포는 현재 `AUTH_MODE=disabled`와
`AGENT_SENTINEL_WRITE_ENABLED=false`를 사용합니다. JWT 인증은 활성화되지 않았으며,
WAF의 인증 전 변경 차단은 유지되어 있습니다.

향후 승인된 JWT 활성화 절차:

1. JWT 인증 배포에 대한 승인을 받습니다.
2. 승인된 배포 경로를 통해 tenant, API audience, client, scope, role 설정을 보존합니다.
3. `AGENT_SENTINEL_WRITE_ENABLED=false`와 WAF 인증 전 변경 차단을 유지하면서
   `AUTH_MODE=jwt`를 설정합니다.
4. 쓰기 상태를 변경하지 않고 로그인과 네 역할 모두를 검증합니다.
5. 익명 요청이 `401`, 권한이 부족한 역할이 `403`을 반환하고 쓰기가 비활성 상태로 유지되는지 확인합니다.
6. 향후 쓰기 활성화 또는 WAF 적용 범위 축소는 별도로 승인받아야 하는 변경으로 취급합니다.

롤백:

1. 이전 Container Apps 리비전을 복원하거나,
   `writeEnabled=false`인 경우에만 `AUTH_MODE=disabled`를 설정합니다.
2. 인증 전 변경을 차단하는 WAF 규칙을 복원합니다.
3. 실패한 활성화를 위해 추가한 권한 부여 또는 역할 할당을 취소합니다.
4. 토큰이나 전체 클레임을 복사하지 않고 관측된 실패를 기록합니다.

운영 세부 사항은 [보안 및 인증](security-authentication.md)과
[런북](runbooks.md)을 참조하세요.

<a id="work-that-does-not-depend-on-service-tree"></a>

## Service Tree에 의존하지 않는 작업

거버넌스 작업 큐, 수명 주기 증거, 런타임 원격 분석 커넥터,
행동 드리프트, 토큰 경제성, 범용 어댑터, 시프트 레프트 검사,
비즈니스 가치 증거 작업은 독립적으로 진행할 수 있습니다.
Service Tree는 사내 ID 등록의 선행 조건이었으며 제품 개발의 선행 조건은 아니었습니다.

<a id="data-prohibited-in-git"></a>

## Git에 저장하면 안 되는 데이터

다음을 커밋하지 마세요.

- 개인 이메일 주소 또는 서신
- 개인 전화번호 또는 IcM 연락처 세부 정보
- Service Tree, 테넌트, 구독 또는 앱 등록 식별자
- 액세스 토큰, 비밀, 인증서 또는 전체 토큰 클레임
- 사내 디렉터리 세부 정보가 포함된 스크린샷
- 승인 티켓 식별자

생성된 식별자는 승인된 배포 구성 또는 사내 시스템에 저장합니다.
개인용이 아닌 비공개 그룹 주소가 이 런북에서 요구하는 고정 운영 별칭인 경우에는 기록할 수 있습니다.
개인 ID, 구성원 정보, 연락 수단은 승인된 사내 시스템에서 관리합니다.
