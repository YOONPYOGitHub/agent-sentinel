<a id="microsoft-agent-365-package-catalog-connector"></a>

# Microsoft Agent 365 패키지 카탈로그 커넥터

`@agent-sentinel/agent365-connector` 패키지는 공식
Microsoft Graph v1.0 Agent 365 Package Management API를 사용하는 읽기 전용
멀티테넌트 인벤토리 커넥터이며, 기본적으로 비활성화되어 있습니다. API와 작업은 모두
활성화된 배포 출처의 커넥터 소스 레코드를 정확한 관리 영역(estate)에 맞춰 해석합니다.
배포 JSON은 변경할 수 없는 호환성 소스로 유지됩니다.
사용자 출처의 Agent 365 레코드는 상태와 준비 상태를 검토할 수 있도록 계속 표시되지만,
생성, 변경, 활성화, 비활성화, 삭제하거나 가동할 수 없습니다.
관리 영역 범위의 팩터리는 빈 런타임을 포함해 정확히 해석된 런타임을 항상 전달하므로,
환경 설정이 요청한 관리 영역 밖의 소스를 다시 활성화할 수 없습니다.
환경 설정만 사용하는 대체 경로는 관리 영역 범위가 아닌 진입점에서만 사용할 수 있으며,
동일한 자격 증명 정책을 따릅니다.

<a id="verified-ga-contract-2026-08-28"></a>

## 검증된 GA 계약 (2026-08-28)

공식 Microsoft Learn 참조:

- [Package Management API 개요](https://learn.microsoft.com/microsoft-365/copilot/extensibility/api/admin-settings/package/overview)
- [Copilot 패키지 목록 조회](https://learn.microsoft.com/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackages-list)
- [Copilot 패키지 상세 정보 조회](https://learn.microsoft.com/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-get)
- [`copilotPackage` 리소스](https://learn.microsoft.com/microsoft-365/copilot/extensibility/api/admin-settings/package/resources/copilotpackage)
- [`copilotPackageDetail` 리소스](https://learn.microsoft.com/microsoft-365/copilot/extensibility/api/admin-settings/package/resources/copilotpackagedetail)

커넥터가 호출하는 엔드포인트는 다음뿐입니다.

```http
GET https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages
Authorization: Bearer <application token for https://graph.microsoft.com/.default>
```

목록은 `copilotPackage` 컬렉션과 표준 `@odata.nextLink`를 반환합니다. 문서에 명시된 목록 필드는 `id`, `displayName`, `type`, `shortDescription`, `isBlocked`, `supportedHosts`, `lastModifiedDateTime`, `publisher`, `availableTo`, `deployedTo`, `elementTypes`, `platform`, `version`, `manifestVersion`, `manifestId`, `appId`, `assetId`입니다. 스트림 값인 `zipFile`은 요청하거나 저장하지 않습니다.

Learn의 목록 계약에는 `$filter`가 문서화되어 있지만 `$select`는 없습니다. 따라서 이 구현은 지원되지 않는 `$select` 동작을 가정하지 않고 첫 요청에 쿼리를 보내지 않습니다. 동일한 Graph 원본과 정확한 v1.0 목록 경로를 사용하는 공급자 발급 연속 페이지 URL만 허용합니다. 호출자가 제공하는 URL, 필터, OData 식은 허용하지 않습니다.

상세 정보 읽기는 핵심 인벤토리에 필요하지 않으므로 명시적으로 비활성화되어 있습니다. 커넥터는 `/beta`, 패키지 쓰기 작업, 비공개 엔드포인트 또는 관리 센터 엔드포인트를 호출하지 않습니다. `allowedUsersAndGroups`, `acquireUsersAndGroups`, 요소 정의, 패키지 파일을 읽거나 보관하지 않습니다.

<a id="authorization-and-current-evidence"></a>

## 권한 부여와 현재 증거

활성화된 각 소스에는 다음이 필요합니다.

1. 테넌트의 Microsoft Agent 365 라이선스.
2. 테넌트 관리자 동의를 받은 Microsoft Graph **애플리케이션** 권한 `CopilotPackages.Read.All`.
3. 배포 출처와, Git 외부의 승인된 배포 설정으로 제공되는 기존 사용자 할당 관리 ID의 정확한 승인된 클라이언트 ID.

참조 배포에는 필요한 Agent 365 라이선스가 있고, 승인된 커넥터 관리 ID에는 `CopilotPackages.Read.All`이 있습니다. 배포된 소스는 `ready + complete` 상태입니다. 패키지 308개에서 에이전트 패키지 노드 302개, 확장 패키지 노드 6개, 소스에 연결된 실시간 증거 레코드 308개가 생성되었습니다. 이는 제한된 범위의 소스 스냅샷만 입증하며, 패키지 총수는 실행 중인 에이전트 총수가 아닙니다.

획득한 모든 Graph 액세스 토큰은 설정된 소스 테넌트와 정확히 일치하는 `tid` 클레임을 포함해야 합니다. 홈 테넌트의 관리 ID 토큰을 외부 테넌트의 결과로 잘못 표시할 수 없습니다.

이 API는 Global 서비스에 대해서만 문서화되어 있습니다. 이 저장소의 IaC는 Graph 앱 역할을 부여하거나 라이선스를 생성하거나 테넌트를 변경하지 않습니다. `403`은 `authorization-required`입니다. 인식된 `LicenseRequired` 응답은 동일한 조치 가능한 준비 상태를 사용하면서, 민감 정보를 제거한 더 구체적인 사유 코드를 유지합니다. 목록 엔드포인트의 `404`는 계속 사용 불가로 처리됩니다.

<a id="configuration"></a>

## 설정

```dotenv
AGENT365_CONNECTOR_ENABLED=false
AGENT365_SOURCES_JSON=
AGENT365_TENANT_ID=
AGENT365_ENVIRONMENT=
AGENT365_MANAGED_IDENTITY_CLIENT_ID=00000000-0000-0000-0000-000000000000
AGENT365_GRAPH_BASE_URL=https://graph.microsoft.com
AGENT365_MAX_PAGES=20
AGENT365_MAX_ITEMS=5000 # aggregate cap across all configured sources
AGENT365_REQUEST_TIMEOUT_MS=15000
AGENT365_MAX_RETRIES=2
AGENT365_MAX_RETRY_AFTER_MS=30000
AGENT365_MAX_RESPONSE_BYTES=2000000
AGENT365_MAX_CONCURRENCY=2
AGENT365_MAX_DURATION_MS=60000
```

`AGENT365_MAX_RETRY_AFTER_MS`의 엄격한 최댓값은 `60000`입니다.
배포 환경 파싱, 커넥터 소스 스키마 검증, 런타임 해석에서 동일한 한도를
적용하므로 저장된 값으로 Agent 365 Graph의 재시도 범위를 확대할 수 없습니다.
배포 프로젝션은 저장소 기반 런타임 해석을 위해
`AGENT365_MAX_CONCURRENCY` (1–10)와
`AGENT365_MAX_DURATION_MS` (100–300000)도 보존하며, 운영자 값을 기본값으로
대체하지 않습니다. 웹에서는 Agent 365 소스 상태를 계속 표시하지만,
생성, 편집, 활성화, 비활성화, 삭제 컨트롤은 제공하지 않습니다.

`AGENT365_SOURCES_JSON`은 테넌트 ID가 고유한 배포 소스 객체 1–50개를
허용합니다. API/작업은 각 배포 소스를 설정된
`AGENT_SENTINEL_TENANT_ID`와 `AGENT_SENTINEL_ENVIRONMENT`의 포트폴리오
관리 영역 아래에 투영하면서, Graph 인증, 상태, 증거 출처를 위해 공급자의
테넌트와 환경을 유지합니다. 따라서 공급자 데이터를 관리 영역 내부 데이터로
재표시하지 않고도 명시적인 테넌트 간 인벤토리를 사용할 수 있습니다.
카탈로그는 테넌트 전체 범위이므로, 서로 다른 로컬 환경 레이블을 사용해
같은 테넌트를 두 번 설정할 수 없습니다.

```json
[
  {
    "id": "tenant-a",
    "name": "Tenant A Agent 365",
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "environment": "production"
  }
]
```

API/작업 배포 설정은 `AGENT365_MANAGED_IDENTITY_CLIENT_ID`를 제공합니다.
자격 증명 메타데이터가 없는 JSON 소스는 이 전용 값에 바인딩됩니다.
활성화 시에는 정확히 승인된 클라이언트 ID를 사용하는 배포 출처의
`managed-identity` 자격 증명만 허용합니다. 사용자 출처, 기본/주변 환경 자격 증명,
임의의 관리 ID, 페더레이션 앱, Key Vault, 비밀, 위임 모드는 비활성 상태로
남거나 거부됩니다. `AZURE_CLIENT_ID`는 Agent 365의 대체 값으로 사용되지 않습니다.
유효하지 않은 기존 저장 레코드는 `deployment-origin-required`,
`managed-identity-required`, `managed-identity-client-id-not-approved` 같은
유형화된 사유와 함께 계속 표시되며, 자동으로 마이그레이션되지 않습니다.
이전 재시도 계약에 따라 저장된 `maxRetryAfterMs > 60000` 소스도
`migration-required`로 비활성 상태를 반환하며, 운영자가 명시적으로 값을
낮출 때까지 저장 값을 유지합니다. 런타임은 알리지 않고 값을 제한하거나
소스를 활성화하지 않습니다.
레거시 스칼라 설정에는 `AGENT365_TENANT_ID`, `AGENT365_ENVIRONMENT`,
`AGENT365_MANAGED_IDENTITY_CLIENT_ID`가 필요하며, JSON이 없으면
`primary` 소스를 생성합니다. `AGENT365_GRAPH_BASE_URL`은 정확히
`https://graph.microsoft.com`만 허용합니다(선택적인 끝 슬래시는 정규화됨).
자격 증명, 포트, 경로, 쿼리 문자열, 프래그먼트, 다른 클라우드는 거부됩니다.

저장된 소스는 한도가 있고 앞으로 진행하는 페이지 매김으로 읽습니다.
배포 소스는 동일한 저장소 계약을 통해 덧씌워지며 변경 불가 상태를 유지합니다.
네임스페이스가 적용된 구성 플레인 ID는 원래 설정된 소스 ID와의 변경 불가
런타임 바인딩을 유지하므로, 배포 소스를 공유 저장소에 투영해도 기존 패키지 ID,
상태 ID, 출처는 바뀌지 않습니다.
사용자 출처의 모든 Agent 365 소스는 테넌트의 고유 여부와 무관하게 비활성 상태입니다.
API는 저장소 쓰기나 감사 기록 생성 전에 이러한 소스의 변경을 거부합니다.

<a id="evidence-and-composition"></a>

## 증거와 합성

합성 순서는 Foundry → 선택적 Entra → 선택적 Power Platform → 선택적 Agent 365입니다. Agent 365 소스 ID는 독립적이며 표시 이름으로 Entra와 연관 짓지 않습니다.

문서화된 에이전트 신호(`supportedHosts`의 `Copilot` 또는
`elementTypes`의 `bot`, `declarativeAgent`, `customEngineAgent`)가 있는 패키지는
에이전트 노드가 됩니다. `M365` 또는 `SharePoint`에서 호스팅되는 선언형 에이전트
패키지는 `m365-declarative-agent` 또는 `sharepoint-declarative-agent` 분류를
추가로 받습니다. 다른 패키지는 가상의 에이전트가 아니라 사실에 맞게 표시된
확장 패키지 제어 노드가 됩니다. 분류가 여러 개여도 패키지 하나는 노드 하나를
생성합니다. 매핑은 검증된 패키지 메타데이터와 정확한 관리 영역/소스 테넌트/환경/패키지
출처만 보존합니다. 간선을 생성하지 않으며 런타임 동작, 신뢰, 도구, ID,
권한 부여 내역, 보안 주체, 유효 액세스를 추론하지 않습니다.

새로 수집한 각 레코드는 패키지 카탈로그를 직접 관찰한 것이므로 신뢰도는 `1`,
최신성은 `live`입니다. 읽기 모델 프로젝션은 정확히 연결된 소스의 현재 상태가
`ready`이면서 `complete`일 때만 `live`를 유지합니다.
새로 고침이 실패, 부분 완료, 빈 결과, 취소, 소스 변경, 만료 또는 그 밖의 사용 불가
상태이면 마지막 완전한 패키지 레코드는 과거 증거로 계속 표시되지만,
유형화된 `stale` 또는 `unknown` 소스 상태가 노출되고 최신성이 `stale`로 설정되며,
권위 있는 그래프 탐색에는 사용할 수 없습니다. ID는 소스 네임스페이스를 사용하고
SHA-256에서 결정적으로 파생됩니다. 기본적으로 최대 두 소스가 동시에 실행되며,
전체 실행 시간과 소스별 페이지, 항목, 응답 바이트, 재시도, 요청 시간 제한에
한도가 적용됩니다.
`AGENT365_MAX_RESPONSE_BYTES`는 개별 응답뿐 아니라 한 작업의 모든 Agent 365
소스와 페이지에 걸쳐 동시성에 안전한 단일 총량 한도로도 적용됩니다.
총량은 `Content-Length`가 아니라 측정된 본문 바이트를 사용하며, 한도가 소진되면
대기 중인 소스는 종료됩니다. 호출자 취소는 토큰 획득, HTTP 요청, 응답 본문 읽기,
재시도 대기까지 전달됩니다. 2xx가 아닌 응답 본문을 읽는 동안의 시간 초과/취소는
권한 부여 실패로 재분류하지 않습니다.

소스 상태에는 정확한 소스 ID, 카탈로그 엔드포인트 출처, 페이지 및 레코드 수,
유형화된 `complete`, `empty`, `failed`, `cancelled` 상태를 기록합니다.
성공한 빈 카탈로그는 완전한 검색으로 간주하지 않고 `empty`/성능 저하 상태로
유지합니다. 활성화된 소스 중 하나라도 완전하지 않으면 기본 스냅샷과 성공적으로
추가된 항목을 보존하면서 상태를 부분 완료로 표시합니다. 작업은 부분적인
권위 스냅샷의 저장/조정을 거부합니다. 비활성 모드는 기본 커넥터 객체를
그대로 반환합니다.

저장된 상태의 조정은 측정값이 오래되었을 때 먼저 활성화된 모든 커넥터 소스를
만료시킵니다. 그다음 Agent 365 소스 집합 지문 변경을 `agent365:` 소스에만
적용하므로, Agent 365 불일치 때문에 만료된 비-Agent365 소스가 준비 상태로
남을 수 없습니다.

대체 환경 매개변수 파일에는 검토되었지만 배포되지 않은 후보가 들어 있습니다.
이 후보는 `AGENT365_MANAGED_IDENTITY_CLIENT_ID`를 API/작업에만 주입하며,
승인된 커넥터 관리 ID와 이미 동의된 `CopilotPackages.Read.All` 애플리케이션
권한만 사용합니다. 비밀, 위임 권한, 라이선스 할당, 역할 할당, 클라우드 변경을
추가하지 않습니다. 배포와 소스에 연결된 저장 스냅샷 검증은 여전히 통합 담당자의
수동 단계입니다.
