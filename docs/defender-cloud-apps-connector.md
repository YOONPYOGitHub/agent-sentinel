<a id="microsoft-defender-for-cloud-apps-connector"></a>

# Microsoft Defender for Cloud Apps 커넥터

**상태:** 구현 완료, 읽기 전용, 다중 소스 지원. 대체 환경의 기본 소스는 API/작업에서
실제로 가동 중이며, 다른 환경은 기본적으로 비활성화되어 있습니다.
커넥터 IaC는 테넌트, 권한, 역할, 토큰, 비밀, 라이선스 또는 그 밖의
Microsoft 365/Azure 리소스를 생성하지 않습니다.

<a id="verified-official-contract"></a>

## 검증된 공식 계약

**2026-08-28**에 Microsoft Learn을 기준으로 계약을 검토했습니다.

- [Defender for Cloud Apps REST API 개요](https://learn.microsoft.com/en-us/defender-cloud-apps/api-introduction)는
  테넌트 API URL을 `https://<tenant>.<region>.portal.cloudappsecurity.com/api`로,
  기본 및 최대 목록 크기를 100으로, 요청 제한을 테넌트당 분당 30회로 명시합니다.
  정확한 API URL은 Microsoft Defender 포털의 **Settings > Cloud Apps >
  System > About**에서 확인하세요. 테넌트 이름으로 추정하지 마세요.
- [애플리케이션 컨텍스트 액세스](https://learn.microsoft.com/en-us/defender-cloud-apps/api-authentication-application)는
  지원되는 무인 OAuth 흐름입니다. 리소스 애플리케이션 ID는
  `05a65629-4c1b-48c1-a78b-804c4abdd4af`이고, 문서화된 v2 클라이언트 자격 증명
  범위는 `05a65629-4c1b-48c1-a78b-804c4abdd4af/.default`입니다
  (`api://` 접두사 없음). 활동과 경고를 위한 최소 읽기 애플리케이션 권한은
  테넌트 관리자가 부여하는 `Investigation.Read`입니다.
- 공식 목록 계약은 `GET /api/v1/alerts/`와 `GET /api/v1/activities/`입니다.
  [경고 목록 조회](https://learn.microsoft.com/en-us/defender-cloud-apps/api-alerts-list)와
  [활동 목록 조회](https://learn.microsoft.com/en-us/defender-cloud-apps/api-activities-list)를 참조하세요.
  요청은 커넥터가 생성한 URL 인코딩 매개변수 `date.gte`, `sortDirection=desc`,
  `sortField=date`, `skip`, `limit`만 사용합니다. `hasNext=true`이면 반환된
  레코드 수만큼 `skip`을 늘리고, `false`이면 해당 목록을 종료합니다.
- 보관하는 경고 필드는 문서화된
  [경고 속성](https://learn.microsoft.com/en-us/defender-cloud-apps/api-alerts)의
  `_id`, `timestamp`, `severityValue`, `statusValue`, `resolutionStatusValue`,
  `stories`, `intent`와 공식 목록 응답에 표시된 안전한 서비스/정책 ID 및
  정책 유형입니다. 활동 보관 범위는 공식
  [활동 필터](https://learn.microsoft.com/en-us/defender-cloud-apps/api-activities)에
  명시된 비개인 ID/시간/작업/서비스/정책 필드로 제한됩니다.
- Microsoft의 최신 [대규모 활동 스캔 지침](https://learn.microsoft.com/en-us/defender-cloud-apps/api-activities-investigate-script)은
  POST 스캔 모드와 `nextQueryFilters`를 사용합니다. 이 첫 구현 단계는
  의도적으로 한도가 있는 GET 목록만 구현하며 공급자가 생성한 연속 조회 필터는
  허용하지 않습니다.

레거시 MDCA API 토큰은 사용 중단되었으며 **허용되지 않습니다**.
커넥터는 Bearer OAuth 애플리케이션 컨텍스트만 사용합니다.

<a id="configuration"></a>

## 설정

기본값은 `DEFENDER_CLOUD_APPS_CONNECTOR_ENABLED=false`입니다. 활성화할 때는
`DEFENDER_CLOUD_APPS_SOURCES_JSON`을 설정하거나 레거시 기본값을 모두 설정하세요.
레거시 기본값은 테넌트 ID, 로컬 환경 레이블, 그리고 API 기본 URL 또는 포털 호스트 이름입니다.

```json
[
  {
    "id": "security-a",
    "name": "Security tenant A",
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "environment": "production-security",
    "portalHostname": "tenant.region.portal.cloudappsecurity.com",
    "credential": {
      "mode": "federated-app",
      "clientId": "00000000-0000-0000-0000-000000000000",
      "managedIdentityClientId": "00000000-0000-0000-0000-000000000000"
    }
  }
]
```

예제 값은 자리 표시자입니다. 테넌트에 표시된 정확한 포털을 사용하세요.
정제기는 `portal.cloudappsecurity.com` 아래에서 문서화된 두 레이블의
테넌트 및 지역 형식과 일치하는 HTTPS 루트만 허용합니다. 자격 증명, 명시적 포트,
경로, 쿼리 문자열, 프래그먼트, 전역 포털, 다른 접미사, 중복된 테넌트/포털
경계는 거부합니다. `environment`는 로컬 집계 레이블일 뿐이며 MDCA로 전송되지 않습니다.

| 환경 변수                                | 기본값           |
| ---------------------------------------- | ---------------- |
| `DEFENDER_CLOUD_APPS_SOURCES_JSON`       | 미설정           |
| `DEFENDER_CLOUD_APPS_TENANT_ID`          | 미설정           |
| `DEFENDER_CLOUD_APPS_ENVIRONMENT`        | 미설정           |
| `DEFENDER_CLOUD_APPS_API_BASE_URL`       | 미설정           |
| `DEFENDER_CLOUD_APPS_PORTAL_HOSTNAME`    | 미설정           |
| `DEFENDER_CLOUD_APPS_LOOKBACK_HOURS`     | 24               |
| `DEFENDER_CLOUD_APPS_PAGE_SIZE`          | 100              |
| `DEFENDER_CLOUD_APPS_MAX_PAGES`          | 리소스 계열당 20 |
| `DEFENDER_CLOUD_APPS_MAX_ITEMS`          | 4000             |
| `DEFENDER_CLOUD_APPS_REQUEST_TIMEOUT_MS` | 15000            |
| `DEFENDER_CLOUD_APPS_MAX_RETRIES`        | 2                |
| `DEFENDER_CLOUD_APPS_MAX_RETRY_AFTER_MS` | 30000            |
| `DEFENDER_CLOUD_APPS_MAX_RESPONSE_BYTES` | 2000000          |

고유한 테넌트 1–50개를 허용합니다. 소스와 경고/활동은 순차적으로 읽습니다.
페이지 수는 한 소스의 두 목록을 합산하며, 항목 수는 두 목록과 모든 소스를
합산합니다. 설정된 최댓값에서 `hasNext`가 있으면 `bounds`로 실패합니다.
완전한 스냅샷을 알리지 않고 잘라내지 않습니다. 요청 제한 상태 429만 재시도하며,
한도 내의 유효한 `Retry-After`가 있을 때만 재시도합니다.

`credential.mode=default`는 소스 테넌트에 바인딩된 `DefaultAzureCredential`을
사용합니다. `federated-app`은 비밀 없는 관리 ID 어설션 패턴을 재사용합니다.
클라이언트 비밀이나 레거시 토큰 필드는 허용하지 않습니다.

<a id="privacy-and-evidence-semantics"></a>

## 개인정보 보호와 증거의 의미

공급자 레코드가 도메인 스냅샷에 도달하기 전에 추가 필드를 제거하고
한도가 적용된 허용 목록만 보관합니다. 커넥터는 공급자 본문, 경고 제목/설명/증거,
활동 설명/원시 감사 데이터, 사용자 이름, UPN/이메일, IP, 위치, 장치/세션 ID,
파일 이름/URL, 엔터티 레이블을 저장하거나 로그에 기록하지 않습니다.

보관된 각 레코드는 증거 레코드 하나가 있는 독립적인 `control` 노드가 됩니다.
ID는 소스 네임스페이스를 사용하고 SHA-256에서 결정적으로 파생됩니다.
간선도 에이전트 노드 연결도 없습니다. MDCA는 지원되는 에이전트별 상관 키를
제공하지 않으므로 이름, 사용자, IP, 앱 표시 이름을 조인에 사용하지 않습니다.
신뢰도 `1`은 MDCA가 해당 레코드를 직접 반환했다는 의미일 뿐이며,
요약에는 이 증거가 특정 에이전트에 귀속되지 않았음을 명시합니다.
신뢰, 런타임, 상태 또는 개선 조치 결과를 추론하지 않습니다.

<a id="failure-and-activation-behavior"></a>

## 실패 및 활성화 동작

안정적인 상태 사유는 `authentication`, `authorization`, 지원되는 계약으로
식별할 수 있는 경우의 `license-required`, `not-available`, `bounds`,
`timeout`, `malformed-response`, `network`, `request-failed:<status>`입니다.
현재 목록 계약에는 신뢰할 수 있는 라이선스 전용 오류 본문이 문서화되어 있지
않으므로, 비공개 오류 설명을 검사하지 않고 403은 authorization-required로,
404는 사용 불가로 매핑합니다. 인증, 권한 부여, 신뢰성 있게 식별한 라이선스
요구 사항은 `authorization-required`로 매핑합니다.

합성 순서는 Foundry → Entra → Power Platform → Agent 365 → MDCA입니다.
비활성 모드는 기본 커넥터를 그대로 반환합니다. 활성화된 권위 있는 MDCA 소스 중
하나라도 실패하면 스냅샷을 부분 완료로 표시합니다. 작업은 진단을 위해 성공한
기본/기타 추가 결과를 반환하지만, 스냅샷 저장과 발견 사항 조정은 거부합니다.
커넥터는 기존 기본 실행 동작에 위임하며 MDCA 쓰기 경로를 추가하지 않습니다.

활성화에는 라이선스/API 가용성, 정확한 테넌트 포털 URL, 대상 테넌트 애플리케이션
동의, 기존 비밀 없는 자격 증명에 대한 별도 승인이 필요합니다.
한도가 있는 연결 테스트와 개인정보 보호 검토를 통과하기 전에는 게이트를 활성화하지 마세요.

대체 테넌트 활성화는 **2026-09-01**에 완료되었습니다.

- Defender XDR은 `Provisioned`를 보고합니다.
- 정확한 API URL을 **Settings > Cloud Apps > System > About**에서 읽었습니다.
- 커넥터 UAMI에는 기존 Purview 레이블 읽기 권한 외에 승인된
  Microsoft Cloud App Security `Investigation.Read` 역할만 있습니다.
- API와 작업은 `defender-cloud-apps:primary`를 `ready`로 보고합니다.
- 현재 24시간 목록에는 경고와 활동이 모두 0개입니다. 이는 유효한 빈 결과이며,
  Defender 제어/증거 노드를 추가하지 않습니다.
- Security Administrator와 Privileged Role Administrator는 한정된 설정 작업 직후
  비활성화되었습니다. 활성 디렉터리 역할은 Global Reader뿐입니다.
