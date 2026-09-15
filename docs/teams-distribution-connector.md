<a id="microsoft-teams-distribution-catalog-connector"></a>

# Microsoft Teams 배포 카탈로그 커넥터

상태: **구현 완료, 읽기 전용, 기본적으로 비활성화, 권한 부여 대기 중**.
이 구현은 실제 소스, 권한, 애플리케이션 역할, 자격 증명 또는 Microsoft 365
리소스를 생성하지 않습니다.

<a id="official-contract-verified-2026-08-29"></a>

## 2026-08-29에 검증된 공식 계약

커넥터는 지원되는 Microsoft Graph v1.0
[teamsApp 목록 조회](https://learn.microsoft.com/graph/api/appcatalogs-list-teamsapps?view=graph-rest-1.0)
API만 사용합니다.

```http
GET https://graph.microsoft.com/v1.0/appCatalogs/teamsApps
  ?$filter=distributionMethod eq 'organization'
  &$select=id,externalId,displayName,distributionMethod
```

- 애플리케이션 권한: 문서화된 최소 애플리케이션 권한인 **`AppCatalog.Read.All`**.
  테넌트 관리자 동의는 Agent Sentinel 외부에서 처리합니다.
- 토큰 리소스 범위: **`https://graph.microsoft.com/.default`**.
  토큰의 `tid`는 설정된 소스 테넌트와 정확히 일치해야 합니다.
- 지원되는 쿼리 옵션은 `$filter`, `$select`, `$expand`입니다.
  이 커넥터는 문서화된 조직 필터와 네 필드 선택을 고정합니다.
  호출자는 OData를 추가할 수 없으며 `$expand`는 의도적으로 사용하지 않습니다.
- 보관하는 `teamsApp` 속성은 `id`, `externalId`, `displayName`,
  `distributionMethod`입니다. `id`와 `externalId`는 RFC UUID 버전 또는
  변형 비트를 강제하지 않는 Azure GUID 형식을 사용합니다.
- 컬렉션 연속 조회는 공급자의 `@odata.nextLink`를 사용합니다.
  각 링크는 HTTPS, 정확히 동일한 Global Graph 원본, 정확한 v1.0 컬렉션 경로를
  사용해야 합니다.
- Microsoft는 이 API를 Global, US Government L4, US Government L5에 대해
  문서화하지만 21Vianet이 운영하는 중국에 대해서는 문서화하지 않습니다.
  이 첫 구현 단계는 의도적으로 `https://graph.microsoft.com`만 허용합니다.
  소버린 호스트에는 별도로 검토된 설정 계약이 필요합니다.
- API는 Teams 앱 관리 정책을 따르는 카탈로그 항목을 반환하며,
  게시 시점보다 24–48시간 늦을 수 있습니다. 관리자 관점의 인벤토리가 아닙니다.

`teamsAppDefinition` 관계에는 버전과 `publishingState`가 문서화되어 있지만,
이를 수집하려면 `$expand`가 필요합니다. 이 구현 단계에서는 확장하지 않으므로
두 필드를 제공한다고 주장하거나 보관하지 않습니다.

<a id="evidence-boundary"></a>

## 증거의 경계

각 조직 카탈로그 레코드는 `control` 노드 하나와 증거 레코드 하나가 됩니다.
신뢰도 `1`은 Graph가 해당 카탈로그 레코드를 직접 반환했다는 의미일 뿐입니다.
간선은 없습니다.

카탈로그에 존재한다는 사실은 해당 항목이 에이전트이거나, 배포, 설치,
사이드로드되었거나, 누군가에게 배포되었거나, 신뢰되거나, 권한을 부여받았거나,
접근 가능하거나, 도구와 연결되어 있음을 **입증하지 않습니다**.
커넥터는 앱 정의, 매니페스트, 아이콘, 패키지 파일, 사용자, 그룹, 팀, 채팅,
설치 정보를 읽지 않습니다. 따라서 설치나 배포 포괄 범위가 아니라
테넌트 앱 카탈로그 증거를 제공합니다.

<a id="configuration"></a>

## 설정

```dotenv
TEAMS_DISTRIBUTION_CONNECTOR_ENABLED=false
TEAMS_DISTRIBUTION_SOURCES_JSON=[{"id":"tenant-a","name":"Tenant A catalog","tenantId":"00000000-0000-0000-0000-000000000000","environment":"catalog","credential":{"mode":"federated-app","clientId":"00000000-0000-0000-0000-000000000000","managedIdentityClientId":"00000000-0000-0000-0000-000000000000"}}]
TEAMS_DISTRIBUTION_GRAPH_BASE_URL=https://graph.microsoft.com
TEAMS_DISTRIBUTION_MAX_PAGES=20
TEAMS_DISTRIBUTION_MAX_ITEMS=5000
TEAMS_DISTRIBUTION_REQUEST_TIMEOUT_MS=15000
TEAMS_DISTRIBUTION_MAX_RETRIES=2
TEAMS_DISTRIBUTION_MAX_RETRY_AFTER_MS=30000
TEAMS_DISTRIBUTION_MAX_RESPONSE_BYTES=2000000
```

최대 50개의 소스를 허용합니다. 소스 ID와 테넌트 ID는 고유해야 합니다.
자격 증명 모드는 `default`와 비밀 없는 `federated-app`이며,
클라이언트 비밀은 허용하지 않습니다. 레거시 단일 소스 설정은
`TEAMS_DISTRIBUTION_TENANT_ID`와 `TEAMS_DISTRIBUTION_ENVIRONMENT`를 사용합니다.

<a id="bounds-and-failure-behavior"></a>

## 한도와 실패 동작

페이지, 순차 소스 전체의 항목 합계, 응답 바이트, 시간 제한, 재시도,
`Retry-After`에 한도가 적용됩니다. HTTP 429, 500, 502, 503, 504만 재시도할
수 있으며, 허용 가능한 `Retry-After`가 있을 때만 가능합니다.
필요한 다음 페이지가 한도를 넘으면 잘라내지 않고 실패합니다.

HTTP 403은 `authorization-required`로, 404 및 기타 가용성 실패는
`unavailable`로 매핑합니다. 소스별 상태 ID는 `teams-distribution:<source-id>`이고
역할은 `enrichment`입니다. 성공한 소스는 증거를 제공할 수 있지만,
실패한 소스가 있으면 커넥터 상태는 부분 완료가 됩니다.
작업 수집 서비스는 의도적으로 부분 스냅샷을 저장하지 않습니다.

합성 순서는 Foundry → Entra → Power Platform → Agent 365 → Defender
for Cloud Apps → Purview → Teams 배포입니다.
비활성화하면 팩터리는 기본 커넥터를 그대로 반환합니다.
