<a id="microsoft-purview-sensitivity-label-connector"></a>

# Microsoft Purview 민감도 레이블 커넥터

**상태:** 구현 완료, 읽기 전용, 멀티테넌트 지원, 기본적으로 비활성화.
실제 테넌트, Graph 권한, 앱 역할 할당, 토큰, 비밀, 레이블 또는 그 밖의
Microsoft 365/Azure 리소스를 생성하거나 변경하지 않습니다.

<a id="verified-official-contract"></a>

## 검증된 공식 계약

**2026-08-28**에 Microsoft Learn을 기준으로 계약을 검토했습니다.

- [sensitivityLabels 목록 조회](https://learn.microsoft.com/graph/api/tenantdatasecurityandgovernance-list-sensitivitylabels?view=graph-rest-1.0)는
  테넌트 카탈로그 조회를 다음과 같이 문서화합니다.
  `GET https://graph.microsoft.com/v1.0/security/dataSecurityAndGovernance/sensitivityLabels`.
  이 API는 Global 서비스에서만 사용할 수 있으며 US Government L4/L5나
  중국에서는 사용할 수 없습니다.
- 최소 애플리케이션 권한은 테넌트 관리자 동의가 필요한 `SensitivityLabel.Read`입니다.
  공식 권한 참조에는 애플리케이션 역할 ID
  `3b8e7aad-f6e3-4299-83f8-6fc6a5777f0b`가 명시되어 있습니다.
  클라이언트는 `https://graph.microsoft.com/.default`만 요청합니다.
- [sensitivityLabel 리소스](https://learn.microsoft.com/graph/api/resources/security-sensitivitylabel?view=graph-rest-1.0)는
  `id`, `displayName`, `name`, `color`, `sensitivity`, `priority`,
  `applicableTo`, `isEnabled`를 문서화합니다. 한도가 적용된 이 카탈로그 필드만
  보관합니다. `priority`는 문서화된 정렬 값이며 `isEnabled`는 활성/비활성 상태로
  표현합니다.
- [Microsoft Graph 페이지 매김](https://learn.microsoft.com/graph/paging)은
  `@odata.nextLink`가 없어질 때까지 따라가도록 요구합니다.
  커넥터는 HTTPS 원본과 정확한 v1.0 목록 경로가 바뀌지 않을 때만 이를 허용합니다.

이 커넥터는 단일 레이블/상세 경로, beta, 활동 탐색기, 사용량, 콘텐츠,
레이블 적용, 권한 계산, 다운로드, 파일 스캔 또는 쓰기 API를 호출하지 않습니다.
호출자가 제어하는 OData를 제공하지 않습니다. 공급자가 생성한 연속 조회 쿼리 값은
경계를 검증한 뒤에만 변경 없이 재사용합니다.

<a id="configuration"></a>

## 설정

기본값은 `PURVIEW_CONNECTOR_ENABLED=false`입니다. 활성화할 때는
`PURVIEW_SOURCES_JSON` 또는 레거시 `PURVIEW_TENANT_ID`와
`PURVIEW_ENVIRONMENT` 쌍을 설정하세요.

```json
[
  {
    "id": "governance-a",
    "name": "Governance tenant A",
    "tenantId": "00000000-0000-0000-0000-000000000000",
    "environment": "production-governance",
    "credential": {
      "mode": "federated-app",
      "clientId": "00000000-0000-0000-0000-000000000000",
      "managedIdentityClientId": "00000000-0000-0000-0000-000000000000"
    }
  }
]
```

GUID는 자리 표시자입니다. 소스 ID와 테넌트가 고유한 소스 1–50개를 허용합니다.
Azure GUID 검증은 의도적으로 RFC 버전으로 제한된 UUID 검증 대신
전체 GUID 형식을 허용합니다. `environment`는 로컬 출처 레이블이며
Microsoft Graph로 전송되지 않습니다.

| 환경 변수                    | 기본값                        |
| ---------------------------- | ----------------------------- |
| `PURVIEW_SOURCES_JSON`       | 미설정                        |
| `PURVIEW_TENANT_ID`          | 미설정                        |
| `PURVIEW_ENVIRONMENT`        | 미설정                        |
| `PURVIEW_GRAPH_BASE_URL`     | `https://graph.microsoft.com` |
| `PURVIEW_MAX_PAGES`          | 20                            |
| `PURVIEW_MAX_ITEMS`          | 합계 5000                     |
| `PURVIEW_REQUEST_TIMEOUT_MS` | 15000                         |
| `PURVIEW_MAX_RETRIES`        | 2                             |
| `PURVIEW_MAX_RETRY_AFTER_MS` | 30000                         |
| `PURVIEW_MAX_RESPONSE_BYTES` | 응답당 2000000                |

Graph 기본 주소는 자격 증명을 포함하지 않는 정확한 Global 원본으로 고정됩니다.
소스는 순차적으로 수집합니다. 페이지, 항목, 바이트, 시간 또는 연속 조회 한도에
도달하면 잘린 스냅샷을 완전한 것으로 반환하지 않고 해당 소스를 실패 처리합니다.
429, 500, 502, 503, 504만 재시도할 수 있으며 한도 내의 유효한
`Retry-After`가 있을 때만 가능합니다. 토큰은 `tid`가 설정된 테넌트와 정확히
일치하는 JWT여야 합니다. 불투명 토큰과 다른 테넌트 토큰은 실패 시 차단합니다.

`credential.mode=default`는 소스 테넌트에 바인딩된 `DefaultAzureCredential`을
사용합니다. `federated-app`은 `ClientAssertionCredential`을 통해 사용자 할당
관리 ID 어설션을 교환합니다. 소스 JSON에 포함된 클라이언트 비밀과 인증서는 거부합니다.

<a id="privacy-and-evidence-semantics"></a>

## 개인정보 보호와 증거의 의미

민감도 레이블 정의는 테넌트 거버넌스 메타데이터이지만, 이름에서 분류 용어가
드러날 수 있습니다. 추가 Graph 필드는 바이트 한도 내에서 허용하되 매핑 전에
제거합니다. 설명, 도구 설명, 권한, 보호 설정, 보안 주체, 레이블이 지정된
파일/콘텐츠, 사용자, 활동, 사용량은 저장하지 않습니다.

관찰한 각 레이블은 소스 네임스페이스를 사용하는 결정적 `control` 노드 하나와
증거 레코드 하나를 생성합니다. 에이전트별 상관 키가 없으므로 커넥터는
에이전트 노드, 관계, 간선 또는 이름 기반 조인을 생성하지 않습니다.
신뢰도 `1`은 테넌트 카탈로그가 레이블 정의를 직접 반환했다는 의미일 뿐입니다.
레이블이 사용 중이거나, 콘텐츠가 보호되거나, 에이전트가 접근하거나,
신뢰/규정 준수 요구 사항을 충족한다는 뜻이 아닙니다.

<a id="failure-and-activation-behavior"></a>

## 실패 및 활성화 동작

안정적인 상태 사유는 `authentication`, `authorization`, `not-available`,
`bounds`, `timeout`, `malformed-response`, `network`,
`request-failed:<status>`입니다. HTTP 403은 `authorization-required`로,
404는 사용 불가로 매핑합니다. 공급자 오류 설명은 로그에 기록하거나 보관하지 않습니다.

합성 순서는 Foundry → Entra → Power Platform → Agent 365 → Defender
for Cloud Apps → Purview입니다. 비활성 모드는 Defender/기본 커넥터를 그대로
반환합니다. 진단을 위해 성공한 추가 결과를 반환할 수 있지만, 활성화된 권위 있는
Purview 소스가 하나라도 실패하면 상태를 부분 완료로 표시합니다.
따라서 작업은 해당 불완전한 실행의 스냅샷 저장과 발견 사항 조정을 거부합니다.
모의 데이터 대체 경로나 Purview 쓰기 경로는 없습니다.

활성화하려면 각 소스에 대한 별도 승인과 테넌트 관리자의
`SensitivityLabel.Read` 애플리케이션 동의가 필요합니다.
IaC는 기본적으로 비활성이고 비어 있는 설정만 노출하며, 의도적으로 Graph 앱
역할 할당을 생성하지 않습니다. 이 커넥터는 활동/사용량 증거를 수집하지 않으므로
해당 증거는 활성화의 전제 조건이 아닙니다.
