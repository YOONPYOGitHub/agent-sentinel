<a id="microsoft-foundry-live-agents"></a>

# Microsoft Foundry 실제 에이전트 연동

Agent Sentinel은 Foundry 제어 플레인을 대체하지 않고 Microsoft Foundry에서
에이전트를 검색할 수 있습니다. 이 통합은 런타임에서 읽기 전용이며, 개선 조치
실행은 명시적으로 거부합니다. 프로비전과 정리는 운영자가 호출하는 별도 스크립트입니다.

<a id="prerequisites"></a>

## 사전 요구 사항

- Node.js 22 및 pnpm 10.15.1
- Azure CLI 로그인 또는 다른 `DefaultAzureCredential` 소스
- 인프라 출력 `foundryProjectEndpoint`에서 가져온 배포된 Foundry 프로젝트 엔드포인트
- 에이전트 프로비전 또는 정리를 실행하는 운영자에게 프로젝트 범위의
  `Foundry User` 액세스. Azure Resource Manager `Owner`만으로는
  Foundry 에이전트 데이터 플레인 액세스가 부여되지 않습니다.

`.env.example`의 값을 셸에 복사하세요. 자격 증명이나 API 키를 소스 파일에
넣지 마세요. 이 통합은 Microsoft Entra 토큰을 사용합니다.

```bash
export FOUNDRY_PROJECT_ENDPOINT='https://<account>.services.ai.azure.com/api/projects/<project>'
export AZURE_TENANT_ID='<tenant-id>'
export AGENT_SENTINEL_ENVIRONMENT='development'
```

<a id="scenario-manifest"></a>

## 시나리오 매니페스트

`@agent-sentinel/scenarios`가 엄격한 6개 에이전트 매니페스트를 관리합니다.
에이전트별 SHA-256 해시는 정규화되어 있고 안정적입니다.
프로비전된 에이전트는 메타데이터에 매니페스트 해시를, 설명에
`[managed-by:agent-sentinel]`과 전체 해시를 모두 포함하여 드리프트와 소유권을
명확히 합니다.

<a id="provision-and-cleanup"></a>

## 프로비전과 정리

다음 명령은 실제 변경을 수행하므로 권한이 있는 운영자만 실행해야 합니다.
빌드나 테스트의 일부가 아닙니다.

```bash
pnpm build
pnpm foundry:provision
pnpm foundry:cleanup          # dry-run; makes no changes
pnpm foundry:cleanup -- --apply
```

대상 프로젝트와 매니페스트가 참조하는 모든 모델 배포가 존재한 뒤에만
프로비전하세요. 대체 테넌트에는 새로운 에이전트 ID와 버전 ID가 부여됩니다.
과거 에이전트 ID나 이전 버전을 복사하지 마세요. 매니페스트는 현재의 합성 정의
6개만 다시 생성하며, 참조되지 않은 실험용 모델 배포는 필요하지 않습니다.

프로비전은 변경 불가 ID로 일치하는 에이전트를 확인합니다. 소유한 버전이 일치하면
변경하지 않습니다. 정의가 바뀌면 새 버전을 생성하며 기존 에이전트를 패치하지
않습니다. 정리는 기본적으로 시험 실행이며, 정확한 매니페스트 이름과 소유권
표식이 모두 필요합니다. 메타데이터나 이름 일치만으로 무관한 에이전트가 삭제
대상이 될 수는 없습니다.

프로비전 운영자 역할은 테넌트 내부 역할입니다. 대체 프로젝트의 운영자에게
할당하세요. 마이그레이션의 일부로 대체 테넌트 계정을 과거 테넌트에 추가하지 마세요.

<a id="api-selection-and-connector-health"></a>

## API 선택과 커넥터 상태

API는 기본적으로 모의 커넥터를 사용합니다. 레거시 단일 프로젝트 설정도
계속 지원됩니다.

```bash
export AGENT_SENTINEL_CONNECTOR=foundry
export FOUNDRY_PROJECT_ENDPOINT='...'
export FOUNDRY_TENANT_ID='...'
export FOUNDRY_ENVIRONMENT='production'
pnpm dev
```

모드가 유효하지 않거나 Foundry 설정이 없으면 자동 대체 대신 시작을 중단합니다.
`GET /api/connectors/status`는 선택한 모드, 기능, 권한, API 성숙도,
알려진 사각지대, 측정된 연결 결과를 반환합니다. 웹의 **Connectors** 페이지도
동일한 증거를 표시합니다.

커넥터는 Foundry 응답을 검증하고 동일 원본, 동일 컬렉션의 `nextLink` 및
본문/헤더 연속 조회 토큰을 안전하게 따라갑니다. 실제 검색에는 100페이지,
에이전트 10,000개, 응답당 4 MiB, 검색 실행 전체 16 MiB, 요청당 30초의
한도가 적용됩니다. 반복되는 연속 조회, 잘못된 페이지, 과도한 크기의 응답,
시간 초과, 중단은 안정적인 사유 코드와 함께 해당 소스를 실패 처리합니다.
실패 전에 누적된 에이전트는 승격하지 않습니다.
포트폴리오 집계는 최대 50개의 설정된 소스를 허용하고, 최대 4개 소스를 동시에
실행하며, 요청별 한도 외에 전체 단일 60초 기한을 적용합니다.
호출자 취소는 자격 증명 및 HTTP 작업으로 전파되며, 대기 중인 소스는 취소 후
시작하지 않습니다. 커넥터는 완료된 각 소스 객체를 증거와 관리 영역 에이전트에
매핑하며, Foundry가 반환하지 않은 도구, 관계, 소유자, 상태를 추론하지 않습니다.
안정 버전의 `instance_identity.principal_id`는 런타임 서비스 주체 객체 ID로,
`instance_identity.client_id`는 해당 애플리케이션 클라이언트 ID로 정규화됩니다.
인스턴스 상태, 청사진 ID 필드, `blueprint_reference.blueprint_id`는
소스별 설명 메타데이터로 남습니다. 누락된 런타임 인스턴스 ID를 청사진 또는
프로젝트 관리 ID로 대체하지 않습니다.

<a id="multiple-tenants-and-projects"></a>

### 여러 테넌트와 프로젝트

안정적인 집계 관리 영역 경계를 설정하고 JSON 소스 배열을 제공하세요.

```bash
export AGENT_SENTINEL_CONNECTOR=foundry
export AGENT_SENTINEL_TENANT_ID='<stable-estate-id>'
export AGENT_SENTINEL_ENVIRONMENT='portfolio'
export FOUNDRY_ENVIRONMENT='portfolio'
export FOUNDRY_SOURCES_JSON='[
  {
    "id": "primary",
    "name": "Current Foundry project",
    "projectEndpoint": "https://<account-a>.services.ai.azure.com/api/projects/<project-a>",
    "tenantId": "<tenant-a>",
    "environment": "production"
  },
  {
    "id": "tenant-b-project",
    "name": "Tenant B validation",
    "projectEndpoint": "https://<account-b>.services.ai.azure.com/api/projects/<project-b>",
    "tenantId": "<tenant-b>",
    "environment": "validation",
    "credential": {
      "mode": "federated-app",
      "clientId": "<app-client-id-in-tenant-b>",
      "managedIdentityClientId": "<optional-source-uami-client-id>"
    }
  }
]'
```

기존 프로젝트의 노드와 발견 사항 식별자를 보존하려면 소스 ID `primary`를
사용하세요. 추가 소스는 소스 ID로 네임스페이스를 지정합니다. 모든 노드는
`sourceConnectorId`, 소스 테넌트, 프로젝트, 환경을 기록합니다.
커넥터 상태에는 집계 관리 영역의 테넌트/환경과 정확한 소스 커넥터,
소스 테넌트/환경, 공급자, 프로젝트 객체 ID를 기록합니다.
유형화된 데이터 상태도 유지합니다. 비어 있지 않은 완료 소스는 `complete`,
권한이 있지만 에이전트를 반환하지 않은 소스는 `empty`, 레코드를 받은 후 페이지
매김 한도에 도달하면 `partial`, 공급자 실패는 `failed`, 호출자 또는 전체
기한에 의한 취소는 `cancelled`입니다. 빈 소스, 부분 완료, 실패, 취소 소스는
완전한 실제 검색을 확립하지 못합니다.

동일 테넌트 소스는 기본 관리 ID/개발자 자격 증명을 사용할 수 있습니다.
테넌트 간 소스는 비밀 없는 워크로드 ID 페더레이션을 사용합니다.
대상 테넌트에 앱을 만들고, Agent Sentinel 관리 ID 어설션을 신뢰하는
페더레이션 ID 자격 증명을 설정하고, 대상 프로젝트에서 해당 앱에 `Azure AI User`를
부여하세요. 권한이 없는 소스는 사용 불가를 보고합니다. 설정된 검색 소스 중
하나라도 실패하면 커넥터는 모든 소스의 상태를 갱신하고
`FoundryPortfolioIncompleteError`로 거부합니다. 부분 집계 스냅샷은 외부로
반환되지 않으며, 작업은 최신의 영구 저장된 완전한 스냅샷을 보존하고,
커넥터는 이전 검색 세대의 메모리 내 증거를 무효화합니다.
유효하지만 빈 소스에도 동일한 실패 시 차단 동작이 적용됩니다.
빈 공급자 응답은 상태에 `empty`로 보존하며 실제 인벤토리로 재표시하지 않습니다.

<a id="live-validation"></a>

## 실제 검증

실제 검증은 의도적으로 명시적 선택이 필요하며 CI에서 실행하지 않습니다.

```bash
pnpm build
pnpm foundry:validate
```

실행기는 현재의 변경 불가 에이전트 6개를 모두 ID로 조회하고 Responses API를 통해
무해한 동작, 에이전트별 동작, 프롬프트 주입, 유해 콘텐츠 프로브를 실행합니다.
서비스 콘텐츠 필터는 에이전트 수준의 거부와 별도로 보고합니다.
로컬 함수 호출은 합성 출력만 받으며 외부 작업은 수행하지 않습니다.
`scripts/live-validation-report.json`을 작성합니다.
에이전트 누락, 빈 응답, 안전하지 않은 결과, 불완전한 실행은 실패로 처리합니다.

<a id="limitations-and-troubleshooting"></a>

## 제한 사항과 문제 해결

- 에이전트 CRUD는 프로젝트 `v1`을 사용합니다. 실제 호출은 현재 SDK에서 유도한
  통신 형식 가정을 루트 `agent_reference`가 있는
  `POST /openai/responses?api-version=v1`로 분리합니다.
  서비스가 이 형식을 거부하면 다시 확인해야 합니다.
- 런타임 추적, 도구 권한 부여, 비용에는 별도의 권위 있는 텔레메트리 커넥터가
  필요하며, 사각지대로 보고합니다.
- HTTP/RBAC 실패는 저하된 상태로 보고하며 모의 성공으로 대체하지 않습니다.
- `403`이면 프로젝트 범위 역할을 검토해야 합니다. 잘못된 응답은 API 계약
  드리프트를 나타내며 스키마 검증에 실패합니다.
- 시나리오 에이전트 6개가 더 이상 필요하지 않으면 프로젝트 리소스가 남지 않도록
  항상 정리를 실행하세요.
