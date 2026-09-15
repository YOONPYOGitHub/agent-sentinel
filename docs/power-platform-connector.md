<a id="power-platform-resourcequery-connector"></a>

# Power Platform ResourceQuery 커넥터

**구현 상태:** `feature/production-readiness-r1`에서 완료되었습니다.
실제 배포에서는 비활성 상태이며 활성화하지 않았습니다.
Copilot Studio 리소스 스키마는 전체적으로 미리 보기이며, 현재 Microsoft는
ResourceQuery 인벤토리를 위한 지원되는 무인 권한 부여 경로를 문서화하지 않습니다.

<a id="evidence-boundary"></a>

## 증거의 경계

읽기 전용 `@agent-sentinel/power-platform-connector`는 공식 Power Platform API를 통해 Copilot Studio 및 Microsoft 365 Copilot Agent Builder 에이전트의 인벤토리를 수집합니다.

- `POST https://api.powerplatform.com/resourcequery/resources/query?api-version=2024-10-01`
- 토큰 범위 `https://api.powerplatform.com/.default`
- `type == 'microsoft.copilotstudio/agents'`와 설정된
  `properties.environmentId` 경계를 사용하는 고정 `PowerPlatformResources` 쿼리

호출자는 KQL, 절, 호스트, 경로, 쿼리 매개변수를 제공할 수 없습니다. 커넥터는 한도가 적용된 핵심 인벤토리 필드만 사용합니다. 웹 페이지를 스크래핑하거나 비공개 API를 호출하지 않습니다. 미리 보기의 커넥터, 채널, 인증 상세 정보는 권위 있는 발견 사항으로 취급하지 않습니다.

각 레코드는 권위 있는 에이전트 노드 하나와 신뢰도 1의 실시간 증거 레코드 하나가 됩니다. ResourceQuery가 반환한 ID 식별자는 메타데이터로만 남습니다. 커넥터는 도구, 신뢰, 권한 부여 내역, 런타임 동작, 상관관계 또는 `RUNS_AS` 간선을 추론하지 않습니다.

<a id="authorization"></a>

## 권한 부여

현재 지원되는 인벤토리 계약은 위임된 Power Platform API 권한
`ResourceQuery.Resources.Read`와 지원되는 Microsoft Entra 역할을 사용합니다.
에이전트 전용 인벤토리에서는 나열된 역할 중 **AI Reader**가 최소 권한 역할입니다.

Power Platform RBAC는 미리 보기이며, 현재 기본 제공 역할은 테넌트 범위입니다.
Microsoft는 이 역할이 Power Platform 인벤토리 액세스에 지원되지 않는다고
명시합니다. 따라서 **Power Platform Reader는 이 커넥터의 ResourceQuery
인벤토리 호출 권한을 부여하지 않습니다**. 요청 본문의 환경 필터는 반환되는
레코드를 제한하지만 권한 부여 경계는 아닙니다.

공식 [인벤토리 액세스 요구 사항](https://learn.microsoft.com/power-platform/admin/power-platform-inventory#access-requirements),
[권한 참조](https://learn.microsoft.com/power-platform/admin/programmability-permission-reference),
[Power Platform RBAC 제한 사항](https://learn.microsoft.com/power-platform/admin/security/role-based-access-control)을 참조하세요.
이 저장소는 Power Platform 역할 할당을 생성하지 않으며, 과도한 권한을 부여하는
레거시 `New-PowerAppManagementApp` 등록을 우회 방법으로 사용해서는 안 됩니다.

<a id="configuration"></a>

## 설정

기본값은 `POWER_PLATFORM_CONNECTOR_ENABLED=false`입니다. 활성화할 때는 `POWER_PLATFORM_SOURCES_JSON` 또는 두 레거시 기본값을 모두 설정하세요.

```json
[
  {
    "id": "studio-production",
    "name": "Studio production",
    "tenantId": "00000000-0000-4000-8000-000000000000",
    "environment": "environment-id",
    "credential": {
      "mode": "federated-app",
      "clientId": "00000000-0000-4000-8000-000000000000",
      "managedIdentityClientId": "00000000-0000-4000-8000-000000000000"
    }
  }
]
```

소스 ID는 Foundry 프로젝트 ID와 독립적입니다. `credential`은 선택 사항이며 기본값은 비밀 없는 `DefaultAzureCredential`입니다. `federated-app`은 관리 ID 토큰 교환 어설션을 사용합니다. 고유한 테넌트/환경 소스를 최대 50개 허용합니다.

| 설정                                                      |                                                 기본값 |
| --------------------------------------------------------- | -----------------------------------------------------: |
| `POWER_PLATFORM_API_BASE_URL`                             | `https://api.powerplatform.com` (유일하게 허용되는 값) |
| `POWER_PLATFORM_TENANT_ID` / `POWER_PLATFORM_ENVIRONMENT` |                                레거시 기본 소스 미설정 |
| `POWER_PLATFORM_PAGE_SIZE`                                |                                                    100 |
| `POWER_PLATFORM_MAX_PAGES`                                |                                                     20 |
| `POWER_PLATFORM_MAX_ITEMS`                                |                                                   5000 |
| `POWER_PLATFORM_REQUEST_TIMEOUT_MS`                       |                                                  15000 |
| `POWER_PLATFORM_MAX_RETRIES`                              |                                                      2 |
| `POWER_PLATFORM_MAX_RETRY_AFTER_MS`                       |                                                  30000 |
| `POWER_PLATFORM_MAX_RESPONSE_BYTES`                       |                                                2000000 |

<a id="failure-and-composition-behavior"></a>

## 실패 및 합성 동작

`429`, `500`, `502`, `503`, `504`만 재시도할 수 있으며, 한도 내의 유효한 `Retry-After`가 있을 때만 가능합니다. 시간 제한, 응답 바이트, 페이지, 항목, 페이지 크기, 연속 조회 토큰에 한도가 적용됩니다. ResourceQuery의 `resultTruncated=0`은 한도 내의 새로운 건너뛰기 토큰이 있을 때만 계속 진행하며, `resultTruncated=1`은 쿼리를 완료합니다. 소스 상태 ID는 `power-platform:<source-id>`를 사용하며 역할은 `discovery`이고 사유는 민감 정보를 제거한 값입니다.

합성 순서는 Foundry, Entra, Power Platform입니다. 이는 Power Platform ID 메타데이터가 의도하지 않은 Entra 상관관계를 만드는 것을 방지합니다. 성공한 소스 스냅샷은 기본 관리 영역 경계 아래에서 커넥터, 소스 이름, 테넌트, 환경, 환경 ID, 리소스 유형, 공급자 객체 출처를 보존합니다. 활성화된 소스가 하나라도 실패하면 상태는 부분 완료가 됩니다. 작업은 사용 가능한 스냅샷을 반환하지만 저장과 조정은 거부합니다.

<a id="activation-checklist"></a>

## 활성화 점검 목록

1. Microsoft가 프로덕션에서 지원되는 앱 전용 인벤토리 권한 부여를 문서화할 때까지
   기다립니다.
2. 지원되는 권한 부여가 의도한 테넌트 및 환경 경계를 강제할 수 있는지 확인합니다.
   쿼리 필터만으로는 충분하지 않습니다.
3. 의도한 모든 소스 경계와 비밀 없는 자격 증명을 설정합니다.
4. 소스 리소스를 변경하지 않고 연결 및 한도가 있는 인벤토리 검증을 실행합니다.
5. 소스별 상태와 출처를 검토합니다.
6. 별도로 검토된 Container Apps 설정 변경을 통해 활성화합니다.

위임된 운영자 검증은 `ResourceQuery.Resources.Read` 및 AI Reader와 함께
레코드 1개, 고정 유형, 고정 환경 쿼리를 사용할 수 있지만,
무인 Agent Sentinel 런타임에 권한이 있음을 입증하지는 않습니다.
실제 활성화는 이루어지지 않았습니다.
