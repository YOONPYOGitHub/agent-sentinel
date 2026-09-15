<a id="agent-sentinel--deployment-guide"></a>

# Agent Sentinel 배포 가이드

<a id="prerequisites"></a>

## 사전 요구사항

- Bicep 확장이 설치된 Azure CLI >= 2.65
- 현재 대상은 `koreacentral`의 `rg-agent-sentinel-m098047`; 실행 전에 승인된 테넌트·구독을 확인
- 읽기 조사, 이미지 푸시, Container Apps 업데이트, 역할 할당에 필요한 권한을 각각 최소 범위로 승인
- Contributor나 RBAC Administrator를 일괄 전제하지 않음. Azure RBAC는 Microsoft Graph 관리자 동의를 대체하지 않음

<a id="current-deployment-safety"></a>

## 현재 배포 안전성

2026-09-15 기준 배포는 `https://agent-sentinel-dadmh3cee9edbwha.b01.azurefd.net`이며
web/API/jobs의 SHA는 모두 `7c1336bc7985ea7e383c335d631b7c705fffb97c`입니다.

| 컴포넌트 | 리비전                        | 다이제스트                                                                |
| -------- | ----------------------------- | ------------------------------------------------------------------------- |
| web      | `web-as-m098047--p07c1336bc`  | `sha256:7dca740d6d7161fc57a14a0cc79a8488e25a12cf2c0ea37f8cd677188c13e267` |
| API      | `api-as-m098047--p07c1336bc`  | `sha256:b43991c120161b73737d492847bd2c3e8dbb6fe33408e4ac49fac6fa01de13a7` |
| jobs     | `jobs-as-m098047--p07c1336bc` | `sha256:7918fa5fc0f207e11cc7b22c0a340cb40926369265c622085bab27bddf132ecc` |

현재 RG에는 `fd-as-m098047`와 `appgw-as-m098047`가 있으며 VM은 없습니다.
`acrm098047`는 `publicNetworkAccess=Disabled`, `defaultAction=Deny`, IP 허용 규칙 0개입니다.
저장소 기준 `1129bbe8727ab9cb7a2e49a1f417a8e042d9ad94`의 Foundry instance identity,
외부 runtime SDK·패키징, pilot 도구와 readiness 수정은 아직 배포되지 않았습니다.
인증 기반 코드와 release-review v2의 존재도 인증 활성화나 승인 완료를 뜻하지 않습니다.

이전 배포의 참고 기록은 web SHA `372944b2e70f11050d20ca0596a5bfe1cb11e5db` / 다이제스트 `sha256:ba52df80df821e67f2b8936a6f1c96bc6af881753c7187e70d0b033e66a8d1f4`, API 리비전 `api-as-m098047--p168bc0baa` / SHA `68bc0baaa346111c3f36aef07c9d7f4a7eba33ea` / 다이제스트 `sha256:aa6f191623b27ebeaaca47614bae7d582579ce251a3f62de23f09263fb7af4c9`, jobs SHA `c26fe400d6f91bed897155e49d2f8e7b18b94f95` / 다이제스트 `sha256:1438fd84ea10af0fd438609989875d8232ce43ff716e1d0d57be313476014648`입니다. 현재 관측 또는 자동 롤백 승인이 아닙니다.
저장소에 포함된 전체 `platform.bicep`의 목표 상태는 실제 리소스 그룹과 차이가 있습니다.
과거 전체 what-if는 관련 없는 수정 54건을 제안했습니다. 이번 문서 정합성 작업의 새 관측값이 아닙니다.
이 드리프트를 해소하고 별도로 검토하기 전까지 **전체 Bicep 배포를 실행하지 마세요**.
다음 인증 단계에서는 검토를 거친, 변경 범위를 한정한 Container Apps 리비전/이미지/구성 업데이트만 사용합니다.

<a id="replacement-tenant-portability"></a>

## 대체 테넌트 이식성

기존 개발 환경은 과거의 애플리케이션, 커넥터, Teams, Foundry 리소스 이름을
`infra/environments/dev.parameters.bicepparam`에 의도적으로 고정합니다.
이 재정의는 증분 배포가 현재 접미사 도입 전에 명명된 ID를 교체하지 못하도록 합니다.

대체 테넌트에는 별도 환경 매개변수 파일을 만들고 다음을 수행합니다.

1. 새롭고 고유한 `suffix`를 설정합니다.
2. 정확히 같은 이름으로 이미 존재하는 리소스를 채택하는 경우가 아니라면,
   개발 파일의 `applicationIdentityName`, `connectorIdentityName`,
   `teamsIdentityName`, `foundryAccountName`을 복사하지 않습니다.
   값이 비어 있으면 `suffix`에서 새 이름을 도출합니다.
3. 테넌트별 인증 및 커넥터 소스 식별자를 설정합니다.
   라이선스나 동의가 필요한 각 커넥터는 대체 테넌트에서 문서화된 사전 요구사항을 검증할 때까지 비활성화합니다.
4. 불변 web 이미지 하나를 빌드합니다. web Container App은 런타임에
   `API_UPSTREAM=api-as-<suffix>`를 주입하므로 API Container App 이름이 달라도 이미지를 다시 빌드할 필요가 없습니다.
5. 프라이빗 빌드 runner가 필요하면 동일한 접미사로 `infra/ci-foundation.bicep`을 배포합니다.
   runner의 ID 이름은 해당 접미사에서 도출합니다.
6. 새 리소스 그룹에 대해 전체 what-if를 실행하고 생성 전에 모든 역할 할당을 검토합니다.
   현재 개발 리소스 그룹의 미해결 드리프트에 따른 금지는 비어 있는 대체 리소스 그룹에는 적용되지 않습니다.

이는 기존 위치에서의 테넌트 마이그레이션이 아니라 IaC로 새로 재생성하는 작업입니다.
기존 테넌트의 테넌트 ID, 주체 ID, 페더레이션 자격 증명, Graph 동의 또는 라이선스 상태를 복사하지 않습니다.

현재 기준 환경은 저장소에 포함된 비밀이 아닌 매개변수 파일로 표현됩니다.
`mngenvmcap098047-*` 파일은 해당 환경의 예제이며 이식 가능한 기본값이 아닙니다.

- `infra/environments/mngenvmcap098047-foundry.parameters.bicepparam`은
  테넌트 로컬 Foundry 계정과 프로젝트를 먼저 생성합니다.
- `infra/environments/mngenvmcap098047.parameters.bicepparam`은
  새 접미사와 테넌트 경계로 플랫폼을 정의합니다. 쓰기와 인증은 비활성 상태를 유지하며,
  명시적으로 활성화된 읽기 커넥터에는 아래에 설명된 별도 권한과 검증이 필요합니다.
- `infra/environments/mngenvmcap098047-connector-sources.parameters.bicepparam`은
  기존 `cosmos-as-m098047` / `agent-sentinel-db` 계층의 `connector-sources`만 대상으로 합니다.
- `infra/environments/mngenvmcap098047-ci-foundation.parameters.bicepparam`은
  기존 `vnet-as-m098047/build` 서브넷과 `acrm098047`를 대상으로 합니다.
  SSH 공개 키는 소스 제어가 아니라 `ADMIN_SSH_PUBLIC_KEY`로 제공합니다.
  이 파일은 목표 구성일 뿐이며 현재 RG에 runner가 프로비전되었다는 증거가 아닙니다.

<a id="reference-environment-follow-up-sequence"></a>

## 기준 환경 후속 작업 순서

커넥터 소스 컨테이너와 Agent 365 카탈로그 읽기 런타임은 기준 환경에 이미 배포되어 있습니다.
남은 ID, 원격 분석, 이미지, 쓰기 변경에는 여전히 명시된 단계에서 운영자 승인이 필요합니다.

1. **기존 `connector-sources` 경계 검증.** 기준 컨테이너는 프로비전되어 배포 관리형 소스에서 사용 중입니다.
   향후 변경 전에는 범위를 한정한 템플릿을 오프라인으로 컴파일하고,
   의도한 컨테이너 계약만 변경하는 리소스 그룹 what-if를 검토합니다.
   새 테넌트는 자체 격리 컨테이너를 생성하고 `/estateId`, 인덱싱, ETag, 자산 범위 동작을 검증합니다.
2. **대상 runner 승인 및 프로비전.** `mngenvmcap098047-ci-foundation.parameters.bicepparam`으로
   `infra/ci-foundation.bicep` what-if를 검토하기 전에 대상 계정, 구독, 리소스 그룹,
   `vnet-as-m098047/build`, `acrm098047`를 확인합니다.
   managed identity, `AcrPush` 할당, NSG, NIC, VM에는 모두 명시적인 인프라 및 보안 승인이 필요합니다.
   호출 시 SSH _공개_ 키만 제공합니다.
3. **runner 승인 및 부팅.** 새로 발급한 유효기간 1시간의 GitHub 등록 토큰과
   대상 전용 레이블 `agent-sentinel-private-m098047`를 사용합니다.
   [runner 준비 절차](runbooks.md#replacement-tenant-runner-readiness-not-executed)의
   환경 변수 전달 제약을 검증하기 전에는 등록 명령을 실행하지 않습니다.
   runner가 온라인인지 확인한 후 [공급망](supply-chain.md)에 문서화된 저장소 변수를 구성합니다.
   토큰을 GitHub 변수, 매개변수 파일, 셸 기록 또는 저장소 파일에 저장하지 않습니다.
4. **정확한 릴리스 SHA 검증.** 전체 40자리 16진수 커밋 SHA,
   `targetEnvironment=replacement-validation`, 허용 목록의 대체 매개변수 파일,
   `deployPlatform=false`로 프라이빗 워크플로를 실행 요청합니다.
   검증, 오프라인 Bicep 빌드, 이미지 가져오기 검사, 정규 ACR 다이제스트를 검토합니다.
   기본 대상 `none`과 배포 값 `false`로는 배포할 수 없습니다.
5. **API/jobs 빌드 및 게시, web은 선택 사항.** API와 jobs는 필수 해커톤 산출물입니다.
   web은 코드나 엣지 구성이 변경된 경우에만 게시합니다.
   게시되는 모든 태그는 정확한 전체 SHA이며, 모든 롤아웃에는 태그가 아니라 확인된 다이제스트를 사용합니다.
6. **API 배포 및 검증 후 jobs 배포.** 보호된 GitHub 환경의 검토자가 정확한 SHA, 다이제스트,
   대상 리소스 그룹, 매개변수 파일, what-if를 승인한 후 API 리비전을 먼저 업데이트합니다.
   jobs를 업데이트하기 전에 단일 활성 리비전, 다이제스트 일치, 상태, 커넥터 상태,
   익명 변경 요청 차단을 검증합니다. jobs 리비전과 범위가 제한된 수집 주기 한 번을 검증합니다.
   web은 승인되고 필요한 경우에만 마지막에 롤아웃합니다.
7. **어느 통과 기준이든 실패하면 롤백.** jobs를 변경하기 전에 이전에 기록한 API 다이제스트를 복원합니다.
   jobs를 변경했다면 다음으로 이전 jobs 다이제스트를 복원하고 web은 변경한 경우에만 복원합니다.
   동일한 활성 리비전 및 스모크 검사를 다시 실행하고 시도한 다이제스트와 복원한 다이제스트를 모두 기록합니다.
   이미지 태그를 다시 지정하지 않습니다.

기존 워크플로의 전체 플랫폼 배포 스위치는 전체 검토가 완료된 Bicep what-if를 위한
별도의 보호된 작업입니다. 위의 API 다음 jobs 순서인 단계적 해커톤 롤아웃을 우회하도록 승인하는 것이 아닙니다.

어느 배포든 과거 테넌트를 여전히 대상으로 하는 Azure CLI 컨텍스트에서 실행하지 않습니다.
먼저 정확한 테넌트, 구독, 계정을 확인합니다.
대상 구독은 배포 명령으로 선택하므로 플랫폼 매개변수 파일에는 의도적으로 구독 ID를 포함하지 않습니다.

현재 대체 API/SPA 등록과 service principal은 이미 존재하므로 재생성하지 않습니다.
새 테넌트에서만 기존 등록이 없음을 확인한 후 별도 승인으로 생성합니다.
`security-authentication.md`의 정확한 범위와 역할을 보존하고,
새 출처는 SPA에만 등록하며 `auth*` 매개변수로 새 ID를 주입합니다.
대체 등록 및 읽기 전용 로그인 검사가 통과할 때까지
`authMode = 'disabled'`와 `agentSentinelWriteEnabled = false`를 유지합니다.

Front Door 변경 차단은 별도의 단계적 배포입니다.
모듈 매개변수 `frontDoorAuthenticatedMutationGuardEnabled`의 기본값은 `false`입니다.
환경별 매개변수 파일에 미리 추가하지 않습니다.
쓰기를 false로 유지한 상태에서 JWT 읽기 검증이 성공하면
`infra/auth/frontdoor-authenticated-mutation-guard.contract.json`의 정확한 계약 다이제스트와
Front Door WAF 계약만 변경하는 Bicep what-if를 검토합니다.
매개변수를 활성화하면 별도의 불변 보호 정책을 생성하고,
해당 정책이 존재한 후에만 엔드포인트 보안 정책 연결을 변경합니다.
기본 관리형 규칙 정책은 롤백 대상으로 유지합니다.
별도의 `agentSentinelWriteEnabled=true` 승인을 요청하기 전에
쓰기 준비 엣지 사전 검사를 실행하고 익명 API 거부를 다시 검증합니다.

롤백은 먼저 `agentSentinelWriteEnabled=false`를 복원하고,
검토된 Front Door 계약과 다이제스트를 복원한 뒤,
마지막으로 정상 동작이 확인된 Container Apps 이미지 다이제스트를 복원해야 합니다.
쓰기 스위치 상태를 알 수 없는 동안 익명 요청 보호 장치를 완화하거나 제거하지 않습니다.

Foundry 에이전트는 워크로드 데이터이며 Bicep으로 생성되지 않습니다.
현재 프로젝트의 합성 에이전트 6개는 이미 존재합니다. 다음은 새 환경 또는
별도 승인된 재프로비전 절차의 참고 명령이며 현재 환경에서 반복 실행하지 않습니다.
모델 배포와 프로젝트 범위의 최소 권한을 검토한 후에만 실행합니다.

```bash
FOUNDRY_PROJECT_ENDPOINT='https://ais-agent-sentinel-m098047.services.ai.azure.com/api/projects/agent-sentinel-pjt' \
  pnpm foundry:provision
```

이 명령은 현재 저장소에서 관리하는 합성 정의 6개만 생성합니다.
이전 테넌트의 과거 버전 ID, 에이전트 ID 또는 참조되지 않는 실험 모델을 마이그레이션하지 않습니다.
대체 애플리케이션이 기능적으로 준비되었다고 판단하기 전에
jobs가 에이전트 6개의 스냅샷을 영구 저장하는지 확인합니다.

대체 환경은 리소스 범위 RBAC가 존재한 후 Azure Resource Graph와 Azure Monitor를 활성화합니다.
또한 별도의 managed identity 3개에 정확한 대체 테넌트 애플리케이션 권한을 할당한 후에만
범위가 제한된 Entra 서비스 주체, Purview 민감도 레이블, Teams 조직 카탈로그 읽기를 활성화합니다.
Defender for Cloud Apps는 Defender XDR 테넌트 프로비전, 정확한 About 페이지 API 검색,
별도로 승인된 애플리케이션 역할이 갖춰진 후에만 활성화합니다.
소유자, 앱 역할 보강, 미리 보기 Agent Identity API, Power Platform,
인증, 쓰기는 비활성 상태를 유지합니다. Agent 365 카탈로그 읽기는 현재 활성화되어 있습니다.
과거 앱 역할 할당이 새 managed identity로 이전되지는 않습니다.

**2026-09-01 14:23 KST**의 과거 대체 환경 검증은 당시 읽기 소스 7개 모두를
`ready`로 보고합니다. 해당 소스는 Foundry, Entra, Defender for Cloud Apps,
Purview, Azure Resource Graph, Teams 조직 카탈로그, Azure Monitor OTel입니다.
Defender와 Teams 읽기는 유효한 빈 결과입니다. 반환 레코드가 0개라는 사실은
에이전트 귀속, 설치, 배포, 신뢰 또는 더 넓은 커버리지를 입증하지 않습니다.
당시 Agent 365는 의도적으로 제외되었습니다. 이 결과를 현재의 OTel 준비 완료로 재사용하지 않습니다.
**2026-09-15** 기준 Agent 365는 패키지 308개(에이전트 패키지 노드 302개,
확장 패키지 통제 6개), Entra는 ID 344개를 보고합니다. Foundry 소스 1개·합성 에이전트 6개이며
`RUNS_AS=0`, OTel 적격 0·쿼리 0·실제 증거 0입니다. OTel 소스는 `degraded/not-queried`이고
전체 릴리스 준비 상태는 `partial`입니다.
Power Platform, 매니페스트 수집, 비즈니스 성과는 활성화 누락이 아닙니다.
각각 지원되지 않는 무인 권한 부여, 쓰기/인증 안전성 통과 조건,
권위 있는 소스 부재 때문에 계속 차단되어 있습니다.

<a id="infrastructure-deployment-reference-only-while-drift-is-unresolved"></a>

## 인프라 배포(드리프트 미해결 시 참고용으로만 사용)

아래 A~C단계의 `rg-agent-sentinel`, `dev.parameters.bicepparam` 및 `260814` 이름은
과거 개발 환경의 참고 전용 값입니다. 현재 RG에 적용하거나 접미사만 치환해 실행하지 않습니다.
목표 IaC와 실배포 상태는 별개이며, 전체 배포 금지는 유지됩니다.

<a id="phase-a--foundation-network-identity-observability-kv-acr"></a>

### A단계: 기반 인프라(네트워크, ID, 관측 가능성, KV, ACR)

저장소에 포함된 `.bicepparam` 파일을 컴파일하거나 이 참고 명령을 실행하기 전에
`DEPLOYMENT_COMMIT_SHA`를 검증된 전체 40자 커밋으로,
`WEB_IMAGE_DIGEST`, `API_IMAGE_DIGEST`, `JOBS_IMAGE_DIGEST`를
프라이빗 ACR에서 검증한 정규 다이제스트로 설정합니다.
이 값들은 배포 후 검증을 위해 민감 정보를 제거한 읽기 전용 `/api/status` 계약으로만 노출됩니다.

```bash
az deployment group create \
  --mode Incremental \
  --resource-group rg-agent-sentinel \
  --template-file infra/platform.bicep \
  --parameters infra/environments/dev.parameters.bicepparam \
  --parameters deploymentCommitSha="${DEPLOYMENT_COMMIT_SHA}" \
  --parameters webImageDigest="${WEB_IMAGE_DIGEST}" \
  --parameters apiImageDigest="${API_IMAGE_DIGEST}" \
  --parameters jobsImageDigest="${JOBS_IMAGE_DIGEST}" \
  --name "platform-$(date +%Y%m%d%H%M%S)"
```

<a id="phase-b--data-cosmos-postgresql-search-service-bus"></a>

### B단계: 데이터(Cosmos, PostgreSQL, Search, Service Bus)

동일한 명령을 사용합니다. Bicep은 Incremental 모드에서 멱등성을 갖습니다.

Cosmos는 배포된 `manifest-ingestions` 컨테이너의 `/tenantId` 파티셔닝과
`/manifestId` 및 `/envelope/producedAt`의 기존 고유 키를 유지합니다.
목표 상태에는 불변 소스 세대 필드를 고유 키에 포함하는 `manifest-ingestions-v2`도 선언되어 있습니다.
`manifestIngestionsContainerName`의 기본값은 레거시 컨테이너이며,
운영자가 v2를 프로비전하고 보존 레코드를 복사·검증하며 what-if를 검토하고
수동 전환을 승인하기 전까지 변경해서는 안 됩니다.

다중 프로젝트 Foundry 검색에는 `agentSentinelTenantId`와
`agentSentinelEnvironment`를 안정적인 집계 영구 저장 경계로 설정하고
`foundrySourcesJson`을 전달합니다. 현재 식별자를 보존하도록 기존 프로젝트의 소스 ID를
`primary`로 유지합니다. 테넌트 간 소스마다 대상 테넌트의 앱 등록에
워크로드 ID 페더레이션과 프로젝트 범위의 `Azure AI User`가 필요합니다.
Container Apps에는 클라이언트 비밀을 저장하지 않습니다.

ID와 테넌트/환경 경계가 `foundrySourcesJson`과 정확히 일치하는 항목으로
`entraSourcesJson`을 설정합니다. 테넌트 간 항목은 동일한 managed identity 페더레이션 패턴을 사용하며
대상 테넌트의 `Application.Read.All` 관리자 동의가 필요합니다.
모든 대상 소스에 권한을 부여하고 범위가 제한된 Graph 인벤토리 검사를 승인할 때까지
`entraConnectorEnabled=false`를 유지합니다.

Power Platform ResourceQuery 인벤토리는
`powerPlatformConnectorEnabled=false`로 별도로 비활성화됩니다.
독립적인 소스 ID를 가진 `powerPlatformSourcesJson` 또는 레거시
`powerPlatformTenantId`와 `powerPlatformEnvironment` 쌍을 구성합니다.
허용되는 기본 주소는 `https://api.powerplatform.com`뿐입니다.
페이징, 항목 수, 재시도, 시간 제한, 응답 바이트는 해당 `powerPlatform*` 매개변수로 제한됩니다.
Microsoft가 인벤토리에 대해 위임 `ResourceQuery.Resources.Read`와 지원되는 Entra 역할의 조합만
문서화하는 동안에는 이를 활성화하거나 IaC 역할 할당을 추가하지 않습니다.
Power Platform Reader를 포함한 미리 보기 Power Platform RBAC 역할은 인벤토리 접근에 명시적으로 지원되지 않으며,
환경 쿼리 필터는 권한 부여 경계가 아닙니다.
[Power Platform 커넥터](power-platform-connector.md)를 참조하세요.

Microsoft Agent 365 패키지 카탈로그 인벤토리는 `agent365ConnectorEnabled`로 독립적으로 제어합니다.
`agent365SourcesJson` 또는 레거시 `agent365TenantId`와 `agent365Environment` 쌍을 구성합니다.
허용되는 기본 주소는 `https://graph.microsoft.com`뿐이며, 모든 요청은
고정된 v1.0 목록 엔드포인트와 제한된 후속 페이지 링크를 사용합니다.
테넌트에 Microsoft Agent 365 라이선스와 테넌트 관리자의
`CopilotPackages.Read.All` **애플리케이션** 동의가 있기 전까지 활성화하지 않습니다.
Agent 365 소스는 배포 관리형 읽기 전용입니다. API로 생성한 레코드는 거부되며,
레거시 사용자 생성 레코드는 계속 표시되지만 비활성 상태로 유지됩니다.
API/jobs에는 전용 `AGENT365_MANAGED_IDENTITY_CLIENT_ID`를 전달합니다.
활성화에는 Git 외부에서 제공하는 기존 승인된 커넥터 UAMI 클라이언트 ID만 허용하며,
`AZURE_CLIENT_ID`, 페더레이션, Key Vault, 비밀, 위임 자격 증명,
임의의 managed identity는 허용하지 않습니다. 검토된 대체 환경 후보는 Graph 앱 역할을 부여하거나,
권한을 확대하거나, 라이선스를 할당하거나, 테넌트 리소스를 생성하지 않습니다.
배포 및 실제 영구 저장 스냅샷 검증은 수동으로 유지됩니다.
[Agent 365 커넥터](agent365-connector.md)를 참조하세요.

Microsoft Defender for Cloud Apps 증거는
`defenderCloudAppsConnectorEnabled=false`로 독립적으로 기본 비활성 상태를 유지합니다.
`defenderCloudAppsSourcesJson` 또는 레거시 테넌트/환경 및 정확한 테넌트 포털 URL 값을 구성합니다.
대체 환경은 정확한 About 페이지 호스트 이름과 커넥터 UAMI로 승인된 소스를 활성화합니다.
IaC는 권한, 앱 역할, 토큰, 비밀, 라이선스 또는 M365 리소스를 생성하지 않습니다.
`Investigation.Read` 애플리케이션 동의, 라이선스/API 가용성, 정확한 포털 URL,
비밀 없는 자격 증명을 별도로 승인하기 전까지 다른 소스를 활성화하지 않습니다.
[Defender for Cloud Apps 커넥터](defender-cloud-apps-connector.md)를 참조하세요.

Microsoft Purview 민감도 레이블 카탈로그 증거는 `purviewConnectorEnabled=false`로
독립적으로 비활성화됩니다. `purviewSourcesJson` 또는 레거시
`purviewTenantId`와 `purviewEnvironment` 쌍을 구성합니다.
Graph 기본 주소는 `https://graph.microsoft.com`으로 고정되며,
비활성 상태에서는 소스 식별자를 빈 값으로 주입합니다.
IaC는 Graph 앱 역할 할당, 권한, 비밀, 레이블 또는 M365 리소스를 생성하지 않습니다.
모든 소스에 대해 테넌트 관리자의 `SensitivityLabel.Read` 애플리케이션 동의와
비밀 없는 자격 증명을 별도로 승인한 후에만 활성화합니다.
[Purview 커넥터](purview-connector.md)를 참조하세요.

Microsoft Teams 테넌트 앱 카탈로그 증거는
`teamsDistributionConnectorEnabled=false`로 기본 비활성화됩니다.
`teamsDistributionSourcesJson` 또는 레거시 `teamsDistributionTenantId`와
`teamsDistributionEnvironment` 쌍을 구성합니다.
Graph 기본 주소는 `https://graph.microsoft.com`으로 고정되며,
비활성 상태에서는 소스 식별자를 빈 값으로 주입합니다.
IaC는 Graph 앱 역할 할당, 권한, 비밀, Teams 앱 또는 Microsoft 365 리소스를 생성하지 않습니다.
대체 기본 소스는 테넌트 관리자의 `AppCatalog.Read.All`과 비밀 없는 자격 증명이
승인된 후 API/jobs에서 활성화됩니다. **2026-09-01 14:23 KST** 결과는
`ready`이며 조직 카탈로그 항목 0개의 유효한 빈 결과입니다.
추가 소스도 동일한 승인 후에만 활성화합니다.
이는 조직 카탈로그 메타데이터만 읽으며 에이전트, 배포, 설치, 사이드로딩,
배포 유통, 신뢰 또는 커버리지를 입증하지 않습니다.
[Teams 배포 커넥터](teams-distribution-connector.md)를 참조하세요.

Foundry 소스 ID와 일치하는 항목으로 `azureMonitorSourcesJson`을 설정합니다.
각 항목에는 `id`, `name`, `workspaceId`, `providerResourceId`, `applicationRoleName`,
`sourceProjectId`, `tenantId`, `environment`와 선택적 페더레이션 자격 증명이 포함됩니다.
`requestName`은 `agent.invoke`로 고정됩니다. 레거시 입력도 workspace·Application Insights 리소스·
application role·테넌트·환경 5개와 Foundry 엔드포인트가 모두 필요합니다.
[개발 문서의 정확한 OTel 계약](development.md#azure-monitor-opentelemetry-runtime-connector)을 따릅니다.
새 소스는 읽기 전용 workspace 권한과 정확한 계측 계약을 검토한 후 활성화합니다.
현재 `azureMonitorConnectorEnabled=true`는 구성 주입 상태이지 적격 에이전트나 수락된 호출 증거가 있다는 뜻이 아닙니다.

ID 모듈은 별도의 읽기 전용 커넥터 managed identity와 Teams managed identity도 선언합니다.
Container Apps는 이를 API/jobs에만 연결합니다.
명시적 소스 JSON 없이 Purview를 활성화하면 배포가 커넥터 ID로 기본 테넌트 소스를 생성하며,
Teams는 별도 ID를 사용합니다.
Microsoft 365 애플리케이션 및 디렉터리 역할은 ARM/Bicep 할당이 아니라
커넥터 런북에 문서화된 테넌트 관리자 작업으로 유지됩니다.

<a id="phase-c--foundry-embedding"></a>

### C단계: Foundry 임베딩

text-embedding-3-large 배포를 추가합니다(AIServices를 변경하는 모듈은 이 모듈뿐입니다).

<a id="phase-d--container-apps--regional-diagnostic-gateway"></a>

### D단계: Container Apps 및 지역 진단 게이트웨이

다음은 `platform.bicep`의 목표 구성 설명입니다. 현재 세 Container Apps는 이미 배포되어 있으며,
이 단계는 재프로비전 또는 전체 플랫폼 배포 지시가 아닙니다.

- Container Apps(내부 ingress의 API, VNet 접근 가능 ingress의 web, ingress가 없는 jobs)
- 선택적 지역 진단 엣지인 Application Gateway WAF v2(현재 리소스 `appgw-as-m098047`).
  현재 중지되어 있으며 활성 Front Door 라우트를 보호하지 않음

<a id="phase-e--front-door-active"></a>

### E단계: Front Door(활성)

현재 `fd-as-m098047`는 기본 HTTPS 호스트 이름으로 web과 API를 모두 라우팅합니다.
과거 프로필 `fd-as-260814`는 현재 대상이 아닙니다.
[아키텍처: Azure Front Door 상태](architecture.md#azure-front-door-status)를 참조하세요.

<a id="container-image-build-and-push"></a>

## 컨테이너 이미지 빌드 및 푸시

각 대상 ACR은 private endpoint를 사용하고 `publicNetworkAccess: Disabled`로 설정됩니다.
빌드를 위해 공개 레지스트리 접근을 활성화하지 않습니다.
지속적인 CI의 설계 경로는 대상 프라이빗 자체 호스팅 runner와 `.github/workflows/ci-build-deploy.yml`입니다.
현재 RG에는 runner VM이 없으므로 사용 가능한 빌드 경로로 전제하지 않습니다.
별도 승인된 일회성 로컬 이미지 빌드는 CI와 다른 출처로 기록하고,
그 승인을 향후 빌드·ACR 방화벽 변경·배포 승인으로 확대하지 않습니다.
[공급망 정책](supply-chain.md#private-build-path)의 승인 및 출처 경계를 따릅니다.
리소스 그룹, 구독, ACR, runner managed identity 클라이언트 ID, 프라이빗 runner 레이블은
검증된 GitHub 저장소 변수에서 가져오며, 대상 환경과 매개변수 파일은
허용 목록에 있는 실행 요청 선택 항목입니다.
수동 실행 요청에는 정확한 40자리 16진수 커밋 SHA 하나가 필요합니다.
워크플로는 해당 커밋을 한 번 검증·확정하고 검증, 이미지 빌드, what-if 및
보호된 배포에 동일한 확정 SHA를 체크아웃하며,
실행 요청 입력을 셸 명령에 직접 삽입하지 않습니다.

추적성을 위해 이미지 3개 모두에 확정된 전체 커밋 SHA를 태그로 지정합니다.
각 푸시 후 워크플로는 `az acr repository show`로 태그를 조회하며,
정규 `sha256:<64 lowercase hex>` 다이제스트가 아닌 결과를 거부합니다.
보호된 what-if와 배포는 검증된 컴포넌트 다이제스트 3개를
`webImageDigest`, `apiImageDigest`, `jobsImageDigest`로 전달합니다.
Bicep은 해당 다이제스트만 프라이빗 ACR 로그인 서버 및 컴포넌트 저장소 이름과 결합하므로,
각 Container App 리비전은 태그 대신 불변
`<target-acr>.azurecr.io/<repository>@sha256:<digest>` 참조를 사용합니다.

배포 후 워크플로는 Container App마다 정확히 하나의 활성 리비전을 요구하며,
해당 리비전의 web, API 또는 jobs 이미지 참조를 검증된 해당 ACR 다이제스트와 비교합니다.
레지스트리 다이제스트만으로는 푸시한 항목만 입증할 수 있습니다.
활성 리비전 검사가 실제 배포 항목을 연결하고 검증합니다.
민감 정보를 제거한 관측이 전체 릴리스 SHA, 실행 중인 이미지 다이제스트 3개 모두,
소스, 관측 시간, 범위, 증거 참조까지
[릴리스 증거 매니페스트](release-evidence.md)에 제공한 후에만 실제 배포 증거를 기록합니다.

<a id="what-if-before-deployment"></a>

## 배포 전 what-if

승인된 변경 전에 정확한 대상의 what-if를 검토합니다. 다음은 읽기 검토용이며
전체 플랫폼 배포를 허용하지 않습니다. SHA와 세 다이제스트를 먼저 검증해야 합니다.

```bash
az deployment group what-if \
  --mode Incremental \
  --resource-group rg-agent-sentinel-m098047 \
  --template-file infra/platform.bicep \
  --parameters infra/environments/mngenvmcap098047.parameters.bicepparam
```

**what-if에 다음이 나타나면 중지합니다.**

- Foundry 리소스의 `Delete`
- 기존 서브넷의 `Delete`(추가만 예상됨)
- `fd-as-m098047`(현재 Front Door 프로필)의 `Delete`

<a id="front-door-smoke-test"></a>

## Front Door 스모크 테스트

배포 후 활성 Front Door 엔드포인트를 검증합니다.

```bash
# 테넌트별 호스트 이름을 고정하지 말고 생성된 엔드포인트를 조회
FD_HOST=$(az afd endpoint show -g rg-agent-sentinel-m098047 \
  --profile-name fd-as-m098047 \
  --endpoint-name agent-sentinel \
  --query hostName -o tsv)

# 루트(SPA) 테스트
curl -sI "https://${FD_HOST}/" | grep "HTTP/"
# 예상 결과: HTTP/2 200

# 상태 프로브 경로 테스트
curl -s "https://${FD_HOST}/health"
# 예상 결과: ok

# API 프록시 경로 테스트
curl -s "https://${FD_HOST}/api/connector/status"
# 예상 결과: API의 JSON 응답(네트워크 오류가 아님)

# 별도 승인된 부정 테스트만 실행. 현재 거부는 쓰기 스위치 때문이며 WAF/JWT 통과 증거가 아님
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST "https://${FD_HOST}/api/demo/reset"
# 예상 결과: 401 또는 403

# API에 외부에서 직접 접근할 수 없는지 확인
API_FQDN=$(az containerapp show -g rg-agent-sentinel-m098047 -n api-as-m098047 \
  --query 'properties.configuration.ingress.fqdn' -o tsv)
echo "API FQDN: ${API_FQDN}"
# external:false이면 FQDN에 .internal.이 포함되고 내부 IP로만 확인되어야 함
```

<a id="authentication-deployment-stages"></a>

## 인증 배포 단계

ID 활성화는 구성으로 제어합니다. 포털에서 Container Apps를 직접 편집하지 않습니다.
Bicep 기본값과 저장소의 개발 매개변수는 `authMode = 'disabled'`와
`agentSentinelWriteEnabled = false`로 실패 시 차단 상태를 유지합니다.
과거 이전 테넌트 배포는 JWT 값을 사용했지만 대체 배포는 여전히 인증이 비활성화되어 있고
대체 API/SPA 등록과 service principal은 생성되어 있습니다.
기존 등록을 재생성하지 말고 승인된 계획과 대조한 뒤 관리자 동의·역할 할당·JWT 활성화를 별도로 완료합니다.
현재 상태와 미배포 변경은 [현재 상태](current-status.md)를 참고합니다.
향후 활성화에는 다음 승인된 입력을 포함한 기존 등록 대조와 런타임 리비전 검토가 필요합니다.

- `authTenantId`, `authAudience`, 선택적 명시적 `authIssuer` / `authJwksUri`
- `authSpaClientId`, `authSpaScopes`, `authSpaRedirectUri`,
  `authSpaPostLogoutRedirectUri`
- 정확한 `authReadScopes` 및 `authWriteScopes`

먼저 `infra/auth/replacement-entra-registration-bootstrap.template.json`으로
민감 정보를 제거한 등록 입력을 만들고
`pnpm auth:registration-bootstrap -- --input <path> --output entra-registration-plan.json`을 실행합니다.
기본 계획은 정확한 이름의 후보를 검색하고 모호함과 과거 출처를 거부하며,
비밀, 동의 부여, 그룹 또는 할당을 포함하지 않습니다.
현재 등록은 재생성하지 않습니다. 필요한 변경만 산출물과 대조하며,
적용은 별도 승인과 정확한 테넌트 확인을 거친 후 보호된 워크플로에서만 가능합니다.

다음으로 `infra/auth/replacement-auth-activation.template.json`으로 런타임 입력을 만들고
`pnpm auth:preflight -- --input <path> --output auth-activation-plan.json`을 실행합니다.
환경별 복사본은 둘 다 커밋하지 않습니다.
저장소의 스키마는 추가 필드, localhost 프로덕션 출처, 쓰기 활성화,
변경 가능한 이미지, 비밀 형태의 키를 거부합니다.

`.github/workflows/auth-activation.yml`이 이 단계의 유일한 배포 경로입니다.
기본값은 오프라인 `plan`이며 기존 배포 워크플로의 프라이빗 runner 변수를 사용하고
`infra/platform.bicep`을 호출하지 않습니다.
`apply`에는 정확한 `APPROVE_READ_ONLY_AUTH_ACTIVATION` 실행 요청 입력과
보호된 `replacement-validation` GitHub 환경 승인이 모두 필요합니다.
이전 API/web 리비전, 이미지, 범위가 제한된 인증 환경 값을 캡처하고
web보다 API를 먼저 업데이트·검증하며, 실패하면 web 다음 API 순서로 복원합니다.
이 워크플로는 Entra 또는 WAF API를 호출하지 않습니다.

활성 Front Door 기본 HTTPS 호스트 이름이 사용할 출처이지만,
대체 등록과 현재 이미지 다이제스트는 확인되어 있습니다. 정확한 리디렉션/로그아웃의
활성 로그인 검증, 관리자 동의, 역할 할당, JWT 배포에는 여전히 승인과 최신 증거가 필요합니다.
현재 권한 시도는 Global Reader에서 `403`이었으며 PIM 적격성이나 역할 활성화를 확인한 것으로 취급하지 않습니다.
마지막 기록의 중지된 Application Gateway는 HTTP 전용이며,
과거 `BlockApiMutationPreAuth` 규칙은 현재 Front Door를 보호하지 않습니다.
활성 Front Door WAF에는 현재 증거로 확인된 변경 차단 규칙이 없으므로,
읽기 전용 안전성은 `AGENT_SENTINEL_WRITE_ENABLED=false`에 의존하고 쓰기 활성화는 금지됩니다.
사용자 지정 도메인은 별도의 보안 강화 작업입니다.

배포 순서:

1. 기존 Entra 등록을 계획과 대조합니다. 기본 워크플로와 풀 리퀘스트 워크플로는 계획만 수행합니다.
2. 변경이 필요한 경우에만 보호된 ID 승인 후 정확한 계획을 적용하고 다시 검색합니다.
   부트스트랩은 동의나 사용자/그룹 할당을 수행하지 않습니다. 권한 있는 관리자가
   별도로 최소 권한 동의와 격리된 테스트 주체 할당을 완료해야 하며 동의 우회는 허용하지 않습니다.
3. 정확한 불변 이미지 다이제스트로 런타임 인증 사전 검사를 생성·검토합니다.
4. 보호된 배포 승인을 받은 후 변경 범위를 한정한 인증 워크플로를 사용합니다.
   쓰기를 false로 유지하며 web보다 API를 먼저 업데이트합니다.
5. 활성 Front Door를 대상으로 `pnpm auth:edge-preflight -- --input <path> --output active-edge-preflight.json`을 실행합니다.
   Front Door 변경 차단 규칙이 없으면 `api-writes-disabled-no-write-activation`만 안전합니다.
6. 리비전마다 [보안 및 인증](security-authentication.md)의 읽기 단계를 실행합니다.
7. JWT가 활성화되고 정확한 Front Door 변경 차단 규칙을 별도로 검토·배포·재검색하기 전까지
   쓰기 단계 준비 절차에 진입하지 않습니다.

롤백 시 쓰기를 먼저 false로 복원하고, 활성화되고 검토된 Front Door 변경 차단이 존재하면
이를 복원한 후 마지막으로 정상 동작이 확인된 Container Apps 리비전을 복원합니다.
중지된 Application Gateway 규칙은 활성 엣지 롤백 제어 수단이 아닙니다.
[런북](runbooks.md)의 RB-011과 RB-012를 참조하세요.

<a id="never-deploy-if"></a>

## 배포 금지 조건

- what-if에 기존 AIServices 계정, 프로젝트 또는 모델 배포의 Delete/Modify가 표시됨
- what-if에 기존 서브넷의 Delete가 표시됨
- what-if에 `fd-as-m098047`의 Delete가 표시됨
- 배포 후 Front Door 원본 상태 또는 SPA/API 스모크 라우트가 하나라도 실패함
- what-if에 `aca-env-m098047`, `web-as-m098047`, `api-as-m098047` 또는 `jobs-as-m098047`의 Delete가 표시됨

<a id="tls--custom-domain-next-steps"></a>

## TLS / 사용자 지정 도메인 후속 단계

활성 Front Door 기본 호스트 이름은 이미 HTTPS를 제공하며 범위가 한정된 인증 출처로 사용할 대상입니다.
App Gateway 엔드포인트는 여전히 HTTP 전용입니다.
Front Door 사용자 지정 도메인 승인·DNS·인증서 구성은 별도 엣지 변경입니다.
다음 목록은 HTTP Application Gateway에 별도로 TLS를 추가하는 과거 설계 참고이며,
현재 Front Door 도메인 절차나 실행 승인이 아닙니다.

1. 도메인을 등록하거나 기존 도메인 사용
2. PFX/PEM 인증서를 생성하고 Key Vault에 저장
3. KV 비밀 접근용 `applicationGatewayUserAssignedIdentity` 추가
4. `application-gateway.bicep`에 KV 인증서를 참조하는 `sslCertificates` 섹션 추가
5. HTTPS 수신기(포트 443) 및 SSL 종료 추가
6. HTTP에서 HTTPS로의 리디렉션 규칙 추가
7. `appgw` 서브넷에서 포트 443 인바운드를 허용하도록 NSG 업데이트

그때까지 애플리케이션에는 Front Door HTTPS를 사용합니다.
HTTP App Gateway 엔드포인트는 범위가 제한된 진단에만 적합합니다.
