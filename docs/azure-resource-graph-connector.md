<a id="azure-resource-graph-connector"></a>

# Azure Resource Graph 커넥터

Azure Resource Graph 커넥터는 어떤 리소스도 AI 에이전트로 분류하지 않으면서,
한도가 적용된 Azure 클라우드 리소스 인벤토리를 Agent Sentinel에 제공합니다.

<a id="evidence-boundary"></a>

## 증거의 경계

커넥터는 문서화된 GA 엔드포인트를 호출합니다.

```text
POST https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01
```

고정된 Kusto 쿼리를 사용하며 다음만 보관합니다.

- ARM 리소스 ID
- 이름과 리소스 유형
- Azure 지역
- 구독 ID와 리소스 그룹
- 한도가 적용된 `kind`, SKU 이름, 관리 ID 유형 문자열

커넥터는 태그, 임의의 리소스 속성, 키, 엔드포인트, 연결 문자열,
설정 페이로드, 공급자 오류 본문을 요청하거나 보관하지 않습니다.

각 레코드는 `control` 노드 하나와 `Evidence` 객체 하나가 되며 그래프 간선은
생기지 않습니다. 리소스의 직접적인 존재만으로 다음을 입증할 수는 없습니다.

- AI 에이전트 분류
- 배포 또는 런타임 활동
- ID 상관관계
- 소유권
- 상태, 신뢰, 보안 또는 규정 준수

<a id="fixed-resource-types"></a>

## 고정된 리소스 유형

쿼리는 Azure AI 및 이를 직접 지원하는 리소스 계열로 제한됩니다.

- Azure Container Apps 및 관리형 환경
- Azure AI Services 계정, 프로젝트, 배포
- Azure Machine Learning 작업 영역
- 사용자 할당 관리 ID
- Application Insights 및 Log Analytics
- Azure AI Search
- Cosmos DB
- Service Bus
- Key Vault
- Azure Container Registry

다른 리소스 유형을 추가하는 것은 런타임 설정이 아니라 코드 검토를 거치는
계약 변경입니다.

<a id="authorization"></a>

## 권한 부여

Azure Resource Graph는 자격 증명으로 읽을 수 있는 리소스만 반환합니다.
모든 소스에 정확한 구독 ID를 설정하세요.

- M365 E5는 필요하지 않습니다.
- 기존 리소스 범위의 Azure 역할로는 권한이 허용된 일부 범위만 보일 수 있습니다.
- 구독 또는 리소스 그룹에 `Reader`를 할당하면 인벤토리 범위가 넓어지지만,
  이는 보안/RBAC 확대이므로 별도 승인이 필요합니다.
- 쿼리 성공은 해당 자격 증명에 허용된 범위에 접근할 수 있음을 입증할 뿐,
  구독 전체를 포괄한다는 증거는 아닙니다.
- 테넌트 간 소스는 다른 커넥터와 동일하게 비밀 없는 관리 ID 페더레이션 패턴을
  사용하며, 승인된 대상 테넌트 애플리케이션/RBAC 경계가 필요합니다.

저장소에 포함된 IaC는 Reader 할당을 생성하지 않습니다.

<a id="configuration"></a>

## 설정

커넥터는 기본적으로 비활성화되어 있습니다.

```text
AZURE_RESOURCE_GRAPH_CONNECTOR_ENABLED=false
AZURE_RESOURCE_GRAPH_SOURCES_JSON=
```

명시적인 소스 JSON 없이 플랫폼 템플릿을 통해 활성화하면 배포 구독과
애플리케이션 UAMI에 대한 단일 소스가 생성됩니다. 명시적 다중 소스 설정은
최대 50개의 소스 정의와 소스당 100개의 구독 ID를 지원합니다.
증거 중복을 방지하기 위해 구독은 하나의 소스에만 포함될 수 있습니다.

안전 한도:

```text
AZURE_RESOURCE_GRAPH_PAGE_SIZE=200
AZURE_RESOURCE_GRAPH_MAX_PAGES=20
AZURE_RESOURCE_GRAPH_MAX_ITEMS=5000
AZURE_RESOURCE_GRAPH_REQUEST_TIMEOUT_MS=15000
AZURE_RESOURCE_GRAPH_MAX_RETRIES=2
AZURE_RESOURCE_GRAPH_MAX_RETRY_AFTER_MS=30000
AZURE_RESOURCE_GRAPH_MAX_RESPONSE_BYTES=2000000
```

<a id="fail-closed-behavior"></a>

## 실패 시 차단 동작

- 액세스 토큰의 테넌트는 설정된 소스 테넌트와 일치해야 합니다.
- 모든 ARM ID는 투영된 구독, 리소스 그룹, 공급자, 리소스 유형 필드와
  일치해야 합니다.
- 반환된 모든 구독은 명시적으로 설정되어 있어야 합니다.
- 페이지 수, 요청 페이지 크기, 총개수, `totalRecords`, 건너뛰기 토큰의 진행,
  응답 바이트, 재시도, 재시도 지연에 한도가 적용됩니다.
- 공급자가 알린 잘림, 총수 변경, 반복 토큰, 중복 리소스 ID, 잘못된 응답 구조는
  해당 소스를 실패 처리합니다.
- 선택적 Resource Graph 소스 하나가 실패하면 커넥터 상태가 저하되지만,
  권위 있는 Foundry 스냅샷을 대체하거나 차단하지는 않습니다.
- 공급자 오류는 안정적인 사유 코드로 축약되며 응답 본문은 폐기됩니다.

<a id="validation-evidence"></a>

## 검증 증거

2026-08-29 기준:

- 고정 쿼리는 권한이 있는 사용자 자격 증명으로 허용된 리소스 유형 13종에 걸친
  실제 리소스 64개를 반환했습니다. 정규화 결과는 제어 노드 64개,
  증거 객체 64개, 간선 0개였습니다.
- 배포된 애플리케이션 UAMI는 기존 역할로 `ready`를 보고했습니다.
- 작업은 UAMI로 볼 수 있는 리소스 5개를 제어 노드 5개와 증거 객체 5개로
  저장했으며 간선은 0개였습니다.

64개와 5개의 차이는 권한에 따른 조회 범위의 경계이지, 증거 누락이나 정상 상태의
증거가 아닙니다. 더 넓은 범위의 Reader 역할은 추가하지 않았습니다.
