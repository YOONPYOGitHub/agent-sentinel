<a id="agent-sentinel--runbooks"></a>

# Agent Sentinel 런북

2026-09-15 기준 현재 대상은 `rg-agent-sentinel-m098047`입니다.
읽기 조사와 변경 작업의 승인을 구분하고, 실행 전에 승인된 테넌트·구독·대상을 확인합니다.
이 문서 갱신은 실행 승인이 아닙니다. 과거 `260814`/`rg-agent-sentinel` 예제는
참고 전용이며 현재 대상에 그대로 실행하거나 접미사만 치환하지 않습니다.

현재 대상 명령의 공통 입력:

```bash
export RESOURCE_GROUP='rg-agent-sentinel-m098047'
export FRONT_DOOR_PROFILE='fd-as-m098047'
export FRONT_DOOR_HOST='agent-sentinel-dadmh3cee9edbwha.b01.azurefd.net'
# AZURE_SUBSCRIPTION_ID는 승인된 현재 구독을 별도로 확인하여 설정
```

기존 RB 번호와 외부 앵커는 유지합니다. 중복 RB-013은
[인증 출처 절차](#rb-013-https-origin-and-app-registration)와
[릴리스 준비 상태 절차](#rb-013-bounded-post-deployment-release-readiness-verification)로 구분합니다.

<a id="rb-001-check-service-health"></a>

## RB-001: 서비스 상태 확인

```bash
# 현재 공개 엣지와 읽기 전용 상태
curl -fsSI "https://${FRONT_DOOR_HOST}/"
curl -fsS "https://${FRONT_DOOR_HOST}/api/health"
curl -fsS "https://${FRONT_DOOR_HOST}/api/status"

# 지역 진단용 App Gateway. 중지 상태에서는 공개 서비스 상태의 기준으로 사용하지 않음
az network application-gateway show-backend-health \
  --name appgw-as-m098047 \
  --resource-group "${RESOURCE_GROUP}" \
  --query 'backendAddressPool[].backendHttpSettingsCollection[].servers[].{address:address,health:health}' \
  -o table

# ACA 앱 상태
az containerapp show --name web-as-m098047 --resource-group "${RESOURCE_GROUP}" \
  --query 'properties.runningStatus'
az containerapp show --name api-as-m098047 --resource-group "${RESOURCE_GROUP}" \
  --query '{status:properties.runningStatus,external:properties.configuration.ingress.external}'
```

<a id="rb-002-process-dead-letter-queue"></a>

## RB-002: dead-letter queue 처리

```bash
# DLQ 메시지 조회
: "${SERVICE_BUS_NAMESPACE:?승인된 현재 namespace 이름 필요}"
az servicebus queue show --name findings-validation \
  --namespace-name "${SERVICE_BUS_NAMESPACE}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query 'countDetails.deadLetterMessageCount'
```

<a id="rb-003-rotate-secrets"></a>

## RB-003: 비밀 교체

Azure 커넥터는 기본적으로 managed identity/AAD를 사용하므로 모든 인증을
Key Vault 비밀 교체로 처리하지 않습니다. `kv-as-260814`는 과거 참고 이름입니다.
현재 대상에 실제 Key Vault 참조가 있을 때만 아래 절차를 적용합니다.

1. 승인된 vault·비밀·소비 리비전·이전 버전을 확인하고 새 버전을 생성합니다.
2. 소비 애플리케이션의 참조 방식과 새로 고침/재시작 요구사항을 확인합니다.
   저장소는 일괄적인 10분 이내 반영을 보장하지 않습니다.
3. 새 버전의 실제 사용과 앱 상태를 검증하고 실패하면 승인된 이전 참조로 복원합니다.

<a id="rb-004-scale-aca-apps"></a>

## RB-004: ACA 앱 크기 조정

별도 승인된 용량 변경에서만 실행합니다. 목표 IaC의 API 최소 1·최대 2와 다른
변경은 비용·부하·설정 드리프트를 검토합니다.

```bash
: "${APPROVED_MIN_REPLICAS:?승인된 최소 복제본 수 필요}"
: "${APPROVED_MAX_REPLICAS:?승인된 최대 복제본 수 필요}"
az containerapp update \
  --name api-as-m098047 \
  --resource-group "${RESOURCE_GROUP}" \
  --min-replicas "${APPROVED_MIN_REPLICAS}" \
  --max-replicas "${APPROVED_MAX_REPLICAS}"
```

<a id="rb-005-emergency-rollback"></a>

## RB-005: 긴급 롤백

```bash
# 실제 리비전과 이미지 확인. "previous"를 리비전 이름으로 가정하지 않음
az containerapp revision list --name web-as-m098047 --resource-group "${RESOURCE_GROUP}" \
  --query '[].{name:name,active:properties.active,images:properties.template.containers[].image}' -o json
```

목표 설정은 `activeRevisionsMode=Single`입니다. 트래픽 가중치만 바꾸지 말고
이전 정상 다이제스트와 관련 구성을 승인된 리비전 복구 절차로 복원합니다.
먼저 API 쓰기를 false로 유지하고, [RB-011](#rb-011-active-edge-mutation-safety)과
[배포 가이드](deployment.md#reference-environment-follow-up-sequence)의 순서 및 검증을 따릅니다.

<a id="rb-006-re-index-ai-search"></a>

## RB-006: AI Search 재인덱싱

검색 인덱스가 손상되었거나 재구축이 필요한 경우:

1. 승인된 Search 서비스와 실제 인덱스 이름, 복구 원본 및 기존 인덱스 보존 방법을 확인합니다.
   과거 `search-as-260814`/`findings-index` 예제는 현재 실행 명령이 아닙니다.
2. `packages/search/src/ingestion.ts`의 인덱스 수집 기능과 호출 주체를 별도로 확인합니다.
   현재 jobs의 `snapshot-ingestion`은 스냅샷·노출 재수집이며 Search 재구축을 자동 호출하지 않습니다.
3. 삭제 전에 검토된 별도 재구축 절차와 완전성 검증을 준비합니다.
   이 저장소에 문서화된 실행용 Search 재인덱싱 CLI는 없으므로 임의의 `az search index delete`를 사용하지 않습니다.

<a id="rb-007-app-gateway-waf-tuning"></a>

## RB-007: App Gateway WAF 조정

다음 `260814` 명령은 과거 지역 진단 정책의 참고 예제입니다.
현재 Front Door WAF 절차가 아니며 보안 승인 없이 Detection 전환을 실행하지 않습니다.
현재 정책의 정확한 연결·이름을 새로 확인하고 [RB-011](#rb-011-active-edge-mutation-safety)을 우선합니다.

```bash
# WAF 정책 세부 정보 조회
az network application-gateway waf-policy show \
  --name waf-appgw-as-260814 \
  --resource-group rg-agent-sentinel

# WAF를 Detection 모드로 전환(오탐 조사용)
az network application-gateway waf-policy policy-setting update \
  --policy-name waf-appgw-as-260814 \
  --resource-group rg-agent-sentinel \
  --mode Detection

# 완료 후 Prevention 모드로 복귀
az network application-gateway waf-policy policy-setting update \
  --policy-name waf-appgw-as-260814 \
  --resource-group rg-agent-sentinel \
  --mode Prevention
```

<a id="rb-008-verify-network-boundaries"></a>

## RB-008: 네트워크 경계 검증

```bash
# API가 내부 전용인지 확인(external: false)
az containerapp show -g "${RESOURCE_GROUP}" -n api-as-m098047 \
  --query 'properties.configuration.ingress.{external:external,fqdn:fqdn}' -o json
# 예상 결과: external=false, fqdn에 .internal. 포함

# web에 VNet에서 접근 가능한지 확인(external: true, 내부 ACA 환경 내)
az containerapp show -g "${RESOURCE_GROUP}" -n web-as-m098047 \
  --query 'properties.configuration.ingress.{external:external,fqdn:fqdn}' -o json
# 예상 결과: external=true

# jobs에 ingress가 없는지 확인
az containerapp show -g "${RESOURCE_GROUP}" -n jobs-as-m098047 \
  --query 'properties.configuration.ingress' -o json
# 예상 결과: null
```

<a id="rb-009-front-door-investigation"></a>

## RB-009: Front Door 조사

**과거 문제:** `fd-as-260814` 원본에 `deploymentStatus: NotStarted`가 표시되었습니다.
현재 장애라고 재기록하지 않습니다. 아래는 현재 `fd-as-m098047`의 승인된 읽기 조사 절차입니다.

```bash
# Private Link 연결 상태 확인
az cdn profile list -g "${RESOURCE_GROUP}" --query '[].name' -o tsv

# Front Door 원본 상태 확인
: "${AZURE_SUBSCRIPTION_ID:?승인된 현재 구독 ID 필요}"
az rest --method GET \
  --url "https://management.azure.com/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Cdn/profiles/${FRONT_DOOR_PROFILE}/originGroups?api-version=2024-02-01"

# ACA 환경 Private Link 연결 확인
az network private-endpoint-connection list \
  --resource-group "${RESOURCE_GROUP}" \
  --name aca-env-m098047 \
  --type Microsoft.App/managedEnvironments
```

**현재 라우팅:** Azure Front Door가 활성 공개 엣지입니다.
Application Gateway는 중지되어 있으며 진단용 대체 경로로만 유지됩니다.
해당 WAF 정책은 Front Door 트래픽을 보호하지 않습니다.

<a id="rb-010-custom-domain--tls-setup-planned"></a>

## RB-010: 사용자 지정 도메인 및 TLS 설정(계획됨)

아래는 과거 Application Gateway TLS 설계의 참고 전용 예제입니다.
현재 Front Door 도메인 구성 절차가 아니며 전체 `platform.bicep` 배포는 금지되어 있습니다.
새 인증서·권한·수신기 변경은 별도 검토와 범위가 제한된 배포 절차가 준비된 후에만 수행합니다.

```bash
# 1. Key Vault로 인증서 가져오기
az keyvault certificate import --vault-name kv-as-260814 \
  --name appgw-tls --file cert.pfx --password <pwd>

# 2. App Gateway ID에 Key Vault 접근 권한 부여
# (kv-as-260814에 "Key Vault Secrets User" 역할을 가진 UAMI 추가)

# 3. application-gateway.bicep 업데이트:
#    - KV 인증서를 참조하는 sslCertificates 추가
#    - HTTPS 수신기 추가(포트 443)
#    - HTTP->HTTPS 리디렉션 규칙 추가
#    - 443 인바운드를 허용하도록 NSG 업데이트

# 4. 배포
az deployment group create --mode Incremental \
  --resource-group rg-agent-sentinel \
  --template-file infra/platform.bicep \
  --parameters infra/environments/dev.parameters.bicepparam
```

<a id="rb-011-active-edge-mutation-safety"></a>

## RB-011: 활성 엣지 변경 요청 안전성

`BlockApiMutationPreAuth`는 과거 Application Gateway 정책의 기록이며
현재 활성 `fd-as-m098047`에 배포된 사용자 지정 변경 차단 규칙이 아닙니다.
이 비활성 규칙을 공개 Front Door 트래픽 보호의 근거로 인용하지 않습니다.
`pnpm auth:edge-preflight -- --input <path> --output active-edge-preflight.json`으로 정확한 HTTPS 엔드포인트, 리디렉션 라우트,
공개 인증 구성, API 쓰기 스위치, Front Door 보안 정책 연결, WAF 모드, 사용자 지정 규칙을 검사합니다.

허용되는 읽기 전용 활성화 정책은 두 가지입니다.

1. `front-door-mutation-rule`: 연결된 Front Door 보안 정책과 WAF 정책이 각각 정확히 하나이고
   Prevention 모드이며, 불변 계약 다이제스트가 일치하고,
   `infra/auth/frontdoor-authenticated-mutation-guard.contract.json`의 모든 정확한 경로/메서드 규칙이
   `Authorization` 헤더가 없거나 Bearer 토큰 형태가 잘못된 요청을 차단합니다.
2. `api-writes-disabled-no-write-activation`: 활성 API가 `writeEnabled=false`를 보고합니다.
   Front Door 변경 차단 규칙이 없는 동안에는 쓰기 활성화를 허용하지 않습니다.

계약에는 API `Allow` 규칙이나 광범위한 `/api/*` 일치 조건이 없습니다.
정책 누락 또는 모호함, 규칙 중복 또는 드리프트, 다이제스트 불일치,
API `Allow` 규칙이 하나라도 있으면 쓰기 단계 준비 판정은 안전하게 차단됩니다.
WAF는 Entra 토큰을 인증할 수 없으며 API JWT와 역할 권한 부여가 권위 있는 기준으로 유지됩니다.

활성화 순서는 쓰기를 false로 유지한 JWT 읽기 검증, 쓰기를 계속 false로 유지한 별도 승인 WAF 배포,
정확한 엣지 재검색, 별도의 쓰기 스위치 승인입니다.
롤백 순서는 쓰기 false, 검토된 WAF 연결 복원(승인된 보호 정책 또는 기본 정책),
마지막 정상 Container Apps 리비전 복원입니다.

<a id="rb-012-registration-bootstrap-auth-activation-and-live-validation"></a>

## RB-012: 등록 부트스트랩, 인증 활성화 및 실제 환경 검증

대체 API/SPA 등록과 service principal은 이미 존재하며 중복 생성하지 않습니다.
이전 테넌트의 등록을 재사용하지 말고 현재 개체를 승인된 계획에 대조합니다.
저장소 코드나 이전 배포 증거로 활성화를 추론하지 않습니다.

1. `infra/auth/replacement-entra-registration-bootstrap.template.json`을 저장소 밖으로 복사하고
   승인된 비밀이 아닌 값만 채운 후 다음을 실행합니다.
   `pnpm auth:registration-bootstrap -- --input <path> --output entra-registration-plan.json`.
2. 결정적 Graph 요청 구조와 롤백 operation ID를 검토합니다.
   정확한 이름 후보가 모호하거나, 예상하지 않은 범위/역할/접근이 있거나,
   과거 리디렉션/로그아웃 출처가 하나라도 있으면 중지합니다.
3. 필요한 등록 변경에만 `.github/workflows/entra-registration-bootstrap.yml`을 사용합니다.
   풀 리퀘스트와 기본 실행 요청은 계획만 수행합니다.
   적용에는 정확한 테넌트 허용 목록, OIDC/위임 관리자 컨텍스트, 계획 산출물,
   `APPROVE_ENTRA_REGISTRATION_BOOTSTRAP`, 보호된 환경 승인이 필요합니다.
4. 부트스트랩은 클라이언트 비밀이나 인증서를 생성하지 않고 동의, 그룹 구성원 자격,
   앱 역할 할당을 부여하지 않습니다. 최소 권한 동의와 격리된 테스트 주체 할당은
   승인된 ID 절차를 통해 별도로 수행합니다. 현재 이 단계는 미완료이며
   마지막 Global Reader 시도는 `403`입니다. PIM 적격성·활성화를 가정하거나
   등록 재생성으로 관리자 동의를 우회하지 않습니다.
5. `infra/auth/replacement-auth-activation.template.json`을 저장소 밖으로 복사하고
   정확한 클라이언트 ID와 불변 이미지 다이제스트를 채운 후
   `pnpm auth:preflight -- --input <path> --output auth-activation-plan.json`을 실행합니다.
6. `.github/workflows/auth-activation.yml`을 계획 모드로 실행합니다.
   적용에는 별도의 보호된 승인이 필요하며 `AGENT_SENTINEL_WRITE_ENABLED=false`를 유지해야 합니다.
7. `infra/auth/replacement-active-edge-preflight.template.json`으로
   `pnpm auth:edge-preflight -- --input <path> --output active-edge-preflight.json`을 실행한 후 `/api/auth/config`,
   로그인/로그아웃, 익명 `401`, Viewer `403`, `/api/auth/me`를 확인합니다.
8. 수명이 짧은 역할 토큰을 프로세스 환경 변수로만 제공하고 `pnpm auth:validate-live`를 실행합니다.
   승인 후에만 격리된 Analyst, Approver, Administrator 주체를 할당하고 4개 기능 권한 경계를 모두 검증합니다.
9. RB-011이 JWT 및 검토된 활성 Front Door의 정확한 계약 다이제스트와 규칙을 보고하기 전까지
   `AUTH_VALIDATION_PHASE=write`를 실행하지 않습니다.
   명시적으로 승인된, 범위가 제한되고 되돌릴 수 있는 변경 대상만 사용합니다.

검증기는 사용자 토큰을 획득하거나 영구 저장하거나 출력하지 않습니다.
토큰 값을 셸 기록, Git, 로그, 스크린샷 또는 보고서에 넣지 않습니다.
통과/실패 상태와 상관관계 ID만 기록합니다.

<a id="rb-013-https-origin-and-app-registration"></a>
<a id="rb-013-https-출처-및-앱-등록"></a>

## RB-013: HTTPS 출처 및 앱 등록(인증 절차)

활성 Front Door HTTPS 라우트가 유일하게 사용할 인증 출처입니다.
중지된 Application Gateway는 여전히 HTTP 전용이며 인증 출처로 사용하거나
활성 WAF 보호의 근거로 인용해서는 안 됩니다.

인증을 활성화할 때마다 범위가 제한된 읽기 전용 활성 엣지 사전 검사를 실행하고 다음을 검증합니다.

- 엔드포인트가 활성화되고 호스트 이름이 승인된 출처와 일치함
- `/auth-redirect.html`, `/api/auth/config`, `/api/status`에 제한이 적용되고 접근 가능함
- `/api/auth/config`에 정확한 테넌트, 리디렉션, 로그아웃 값이 포함됨
- `/api/status`가 `writeEnabled=false`를 보고함
- Front Door 보안 정책 연결, WAF 모드, 변경 차단 규칙 결과가 기록됨

Front Door 변경 차단 규칙이 없으면 유일하게 유효한 결과는
`api-writes-disabled-no-write-activation`입니다.
어느 항목이든 이전보다 악화되면 활성화를 중지하고 마지막 정상 리비전을 복원합니다.
추가 출처를 등록하지 말고 별도로 승인된 교차 출처 설계에 필요한 경우에만 CORS를 추가합니다.

<a id="rb-013b-live-entra-and-otel-read-permissions"></a>

## RB-013B: 실제 Entra 및 OTel 읽기 권한

이는 독립적인 읽기 전용 소스 권한입니다. 승인 후에만 적용합니다.

Entra 안정 버전 인벤토리에는 테넌트 로컬 Microsoft Graph 서비스 주체와
`Application.Read.All` 애플리케이션 역할을 동적으로 확인합니다.
기존 할당을 먼저 확인하고 누락된 경우에만 승인된 Entra 소스의 정확한 UAMI에 할당합니다.
현재 Entra 읽기는 이미 동작 중이며, 이 절차는 API/SPA 사용자 동의와 별개입니다.
안정 버전 v1.0 단계에서는 `AgentIdentity.Read.All`이나 쓰기 역할을 요청하지 않습니다.

```bash
: "${ENTRA_UAMI_NAME:?승인된 현재 Entra 소스 UAMI 이름 필요}"
UAMI_PRINCIPAL_ID=$(az identity show -g "${RESOURCE_GROUP}" \
  -n "${ENTRA_UAMI_NAME}" --query principalId -o tsv)
GRAPH_SP_ID=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 \
  --query id -o tsv)
APPLICATION_READ_ALL_ID=$(az ad sp show \
  --id 00000003-0000-0000-c000-000000000000 \
  --query "appRoles[?value=='Application.Read.All'].id | [0]" -o tsv)
BODY=$(jq -n \
  --arg principalId "$UAMI_PRINCIPAL_ID" \
  --arg resourceId "$GRAPH_SP_ID" \
  --arg appRoleId "$APPLICATION_READ_ALL_ID" \
  '{principalId:$principalId,resourceId:$resourceId,appRoleId:$appRoleId}')
az rest --method POST \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/${UAMI_PRINCIPAL_ID}/appRoleAssignments" \
  --headers Content-Type=application/json \
  --body "$BODY"
```

OTel 쿼리에는 `infra/modules/identity.bicep`이 구성된 workspace 범위에서만
기본 제공 `Log Analytics Reader`를 할당합니다. 공유 키 읽기는 제외합니다.
현재 OTel 구성 활성화와 적격 에이전트/실제 호출 증거는 별개입니다.
합성 AppRequests는 계약 검증일 뿐 실제 런타임 준비 완료가 아닙니다.
[개발 문서](development.md#azure-monitor-opentelemetry-runtime-connector)의 필수 소스 필드와 정확한 계약을 따릅니다.

Container Apps 관리형 환경은 플랫폼 콘솔 로그를 전달하기 위해 보안 workspace 키를 별도로 사용합니다.
이 제어 평면 로그 대상은 애플리케이션 환경 변수로 노출되지 않으며 OTel 쿼리 커넥터가 사용하지 않습니다.
커넥터 읽기는 위의 UAMI 역할로만 인증합니다.

<a id="rb-013a-surgical-connector-sources-readiness-not-executed"></a>
<a id="rb-013a-변경-범위를-한정한-connector-sources-준비-절차미실행"></a>

## RB-013A: 변경 범위를 한정한 connector-sources 준비 절차(현재 프로비전 완료)

현재 `connector-sources`는 프로비전되어 배포 관리형 소스에 사용 중입니다.
기존 `not-executed` 앵커는 호환성만 위해 유지합니다.
아래 생성 명령은 새 환경이나 별도 승인된 복구에만 적용하며 현재 컨테이너를 재생성하지 않습니다.

기존 대상 계정이 `cosmos-as-m098047`이고 기존 SQL 데이터베이스가
`agent-sentinel-db`일 때만 `infra/connector-sources.bicep`을 사용합니다.
진입점은 두 상위 리소스를 `existing`으로 선언하고 하위 `connector-sources`만 생성합니다.

```bash
export TARGET_RG='rg-agent-sentinel-m098047'

# 오프라인 구조 컴파일.
az bicep build --file infra/connector-sources.bicep --stdout >/dev/null
az bicep build-params \
  --file infra/environments/mngenvmcap098047-connector-sources.parameters.bicepparam \
  --stdout >/dev/null

# 현재 경계 검토. 변경은 승인된 해당 컨테이너 계약에만 한정되어야 함.
az deployment group what-if \
  --resource-group "${TARGET_RG}" \
  --template-file infra/connector-sources.bicep \
  --parameters infra/environments/mngenvmcap098047-connector-sources.parameters.bicepparam \
  --result-format FullResourcePayloads

# 새 환경/복구에서 명시적 생성 승인을 받은 경우에만 실행. 현재 대상의 반복 생성 금지.
az deployment group create \
  --resource-group "${TARGET_RG}" \
  --template-file infra/connector-sources.bicep \
  --parameters infra/environments/mngenvmcap098047-connector-sources.parameters.bicepparam \
  --mode Incremental
```

`/estateId`, 저장소에 포함된 포함/제외 경로, 저장소의 복합 인덱스 2개만 승인합니다.
what-if에 계정/데이터베이스 쓰기, 처리량 변경, 다른 컨테이너, private endpoint,
ID 또는 역할 할당이 포함되면 중지합니다.
명령 예제 자체는 배포 완료 증거가 아닙니다. 현재 완료 사실은 별도의 기준 관측에서 가져옵니다.

<a id="rb-014-private-ci-build-runner"></a>

## RB-014: 프라이빗 CI 빌드 runner

<a id="architecture"></a>

### 아키텍처

다음 구성 표와 아웃바운드 표는 과거 `260814` 개발 runner의 참고 기록입니다.
당시 설계의 자체 호스팅 GitHub Actions runner(`vm-ci-runner-as`, Standard_D2s_v3)는
`vnet-as-260814`의 `build` 서브넷(10.0.6.0/24)을 사용했습니다.
공용 IP가 없으며 Azure Run Command(관리 평면)로만 접근합니다.
전용 `nat-build-as` NAT Gateway는 VM을 인터넷 인바운드 트래픽에 노출하지 않으면서
안정적인 아웃바운드 연결을 제공합니다.
runner 레이블: `self-hosted,linux,x64,agent-sentinel-private`.

| 컴포넌트    | 이름                  | 참고 사항                                          |
| ----------- | --------------------- | -------------------------------------------------- |
| VM          | `vm-ci-runner-as`     | 공용 IP 없음, Ubuntu 24.04 LTS                     |
| UAMI        | `id-ci-runner-260814` | acr260814에 대해서만 AcrPush                       |
| NSG         | `nsg-build-as`        | 모든 인바운드 거부, 아웃바운드 제한                |
| 서브넷      | `build` 10.0.6.0/24   | vnet-as-260814 내부                                |
| NAT Gateway | `nat-build-as`        | GitHub 및 패키지 레지스트리용 아웃바운드 전용 연결 |

<a id="required-outbound-domains-port-443-unless-noted"></a>

### 필수 아웃바운드 도메인(별도 표기가 없으면 포트 443)

| 도메인                             | 용도                                     |
| ---------------------------------- | ---------------------------------------- |
| `api.github.com`                   | runner 등록 및 job 폴링                  |
| `*.actions.githubusercontent.com`  | job 산출물 및 캐시                       |
| `github.com`                       | HTTPS를 통한 git clone                   |
| `objects.githubusercontent.com`    | 대용량 git 개체/LFS                      |
| `*.blob.core.windows.net`          | runner 진단 업로드, Azure Storage        |
| `mcr.microsoft.com`                | Microsoft Container Registry 기본 이미지 |
| `registry.npmjs.org`               | pnpm 패키지 다운로드                     |
| `registry-1.docker.io`             | Docker Hub 기본 이미지                   |
| `auth.docker.io`                   | Docker Hub 인증                          |
| `production.cloudflare.docker.com` | Docker CDN                               |
| `management.azure.com`             | Bicep what-if 및 배포용 ARM              |
| `login.microsoftonline.com`        | managed identity / Entra 토큰            |
| `acr260814.azurecr.io`             | VNet private endpoint 경유(인터넷 없음)  |
| OS 미러(포트 80)                   | `archive.ubuntu.com`, CRL 엔드포인트     |

<a id="replacement-tenant-runner-readiness-not-executed"></a>

### 대체 테넌트 runner 준비 절차(미실행)

2026-09-15 기준 `rg-agent-sentinel-m098047`의 VM 수는 0이며 runner는 미프로비전입니다.
일회성 승인 로컬 이미지 빌드는 CI runner의 존재·등록·가동 증거가 아닙니다.
현재 ACR은 공개 접근 Disabled, 기본 Deny, IP 허용 규칙 0개를 유지합니다.

대상 기반 인프라 매개변수 파일은
`infra/environments/mngenvmcap098047-ci-foundation.parameters.bicepparam`입니다.
접미사 `m098047`를 사용하면 `ci-foundation.bicep`은 기존
`vnet-as-m098047/build` 서브넷, 기존 `acrm098047`, 새 `id-ci-runner-m098047`를 식별합니다.
파일에는 구독 ID, 클라이언트 ID, 토큰, 비밀 또는 SSH 키 자료가 없으며
VM 크기는 `Standard_D2as_v5`입니다. 과거 구성 표를 현재 배포로 해석하지 않습니다.

필수 승인 순서:

1. 운영자가 활성 Azure 테넌트/구독을 확인하고
   `TARGET_RG`를 승인된 대체 리소스 그룹으로 설정합니다.
2. 네트워크 및 레지스트리 소유자가 해당 리소스 그룹에
   `vnet-as-m098047/build`와 `acrm098047`가 이미 존재하는지 확인합니다.
3. 보안 담당자가 what-if를 검토합니다. 예상 생성 항목은 runner UAMI,
   `acrm098047`로만 범위가 제한된 `AcrPush` 할당, runner NSG/NIC, VM입니다.
   VNet, ACR, 애플리케이션 ID 또는 더 넓은 역할 범위가 변경되면 중지합니다.
4. 운영자는 컴파일 및 배포용으로만 승인된 SSH 공개 키를 제공합니다.
   이를 커밋하거나 매개변수 파일에 넣지 않습니다.
5. 저장소 관리자가 레이블 `agent-sentinel-private-m098047`의 runner 등록을 승인하고,
   보호된 `replacement-validation` GitHub 환경에 필수 검토자를 구성합니다.
6. 템플릿의 ACR 범위 `AcrPush` 할당을 넘어서는 모든 Azure 권한
   (리소스 그룹 what-if 또는 배포 권한 포함)은 별도의 최소 권한 역할 검토 대상입니다.
   이 런북에서 해당 권한을 추론하거나 자동 할당하지 않습니다.

```bash
export TARGET_RG='rg-agent-sentinel-m098047'
export ADMIN_SSH_PUBLIC_KEY="$(cat '<approved-public-key>.pub')"

# 먼저 오프라인으로 컴파일.
az bicep build-params \
  --file infra/environments/mngenvmcap098047-ci-foundation.parameters.bicepparam \
  --stdout >/dev/null

# 검토 전용. what-if는 리소스를 생성하지 않음.
az deployment group what-if \
  --resource-group "${TARGET_RG}" \
  --template-file infra/ci-foundation.bicep \
  --parameters infra/environments/mngenvmcap098047-ci-foundation.parameters.bicepparam \
  --result-format FullResourcePayloads

# 승인 1~4를 기록한 후에만 create 실행.
az deployment group create \
  --resource-group "${TARGET_RG}" \
  --template-file infra/ci-foundation.bicep \
  --parameters infra/environments/mngenvmcap098047-ci-foundation.parameters.bicepparam \
  --mode Incremental
```

VM이 존재한 후 저장소 관리자가 유효기간 1시간의 새 등록 토큰과 현재 지원되는 runner 버전을 검토합니다.
`scripts/bootstrap-runner.sh`는 `GH_RUNNER_TOKEN`, `GH_RUNNER_LABELS`, `RUNNER_VERSION`을
환경 변수로 읽으며 이름 있는 명령행 인수를 파싱하지 않습니다.
따라서 `az vm run-command invoke --parameters KEY=VALUE`가 이 환경을 구성한다고 가정하지 않습니다.
승인된 VM 실행 컨텍스트에서 토큰을 영구 저장하지 않고 해당 환경을 전달하는 방식이 검증될 때까지
등록 실행은 차단합니다. 과거 `2.319.1` 예제를 현재 지원 버전의 증거로 재사용하지 않습니다.

워크플로 실행 요청을 활성화하기 전에 runner가 정확한 대상 레이블로 온라인 상태인지 확인합니다.
이 섹션은 준비 지침만 기록하며 runner 또는 역할 할당이 존재한다는 증거가 아닙니다.

<a id="historical-development-runner-provisioning"></a>

### 과거 개발 runner 프로비전

아래는 역사적 참고 전용 예제입니다. 현재 대상·필수 매개변수·환경 변수 전달을 충족하는
실행 지침이 아니며 그대로 재실행하지 않습니다.

```bash
# 1. build 서브넷 배포(platform.bicep 배포로 이미 생성되지 않은 경우):
az network vnet subnet create \
  -g rg-agent-sentinel --vnet-name vnet-as-260814 \
  --name build --address-prefixes 10.0.6.0/24

# 2. CI 기반 인프라 배포(UAMI + NSG + VM):
az deployment group create \
  -g rg-agent-sentinel \
  -f infra/ci-foundation.bicep \
  -p location=koreacentral

# 3. 수명이 짧은 runner 토큰 발급(TTL 1시간, 저장 금지):
TOKEN=$(~/.local/bin/gh api -X POST \
  /repos/YOONPYOGitHub/agent-sentinel/actions/runners/registration-token \
  --jq .token)

# 4. Run Command로 VM에서 runner 부트스트랩(TLS로 토큰 전달, 영구 저장하지 않음):
az vm run-command invoke \
  -g rg-agent-sentinel \
  --name vm-ci-runner-as \
  --command-id RunShellScript \
  --scripts @scripts/bootstrap-runner.sh \
  --parameters "GH_RUNNER_TOKEN=${TOKEN}" "RUNNER_VERSION=2.319.1"
```

<a id="azure-login-in-workflows"></a>

### 워크플로의 Azure 로그인

워크플로는 `az login --identity --client-id <RUNNER_UAMI_CLIENT_ID>`를 사용합니다.
OIDC 페더레이션이나 저장된 비밀은 필요하지 않습니다.
runner는 Azure 내부에 있으며 IMDS가 토큰을 직접 제공합니다.

```yaml
- name: Login to Azure (managed identity)
  run: az login --identity --client-id "${{ env.RUNNER_UAMI_CLIENT_ID }}"
- name: Login to ACR (identity - no password)
  run: az acr login --name "${{ env.ACR_NAME }}"
```

<a id="runner-rotation--re-registration"></a>

### runner 교체 / 재등록

다음은 과거 개발 runner의 참고 명령입니다. 현재 RG에는 교체할 runner가 없으며,
새 runner의 이름·레이블·버전·안전한 환경 전달 방식을 검증한 뒤 별도 승인 절차를 준비합니다.

```bash
# remove-token 발급(registration-token과 다른 엔드포인트):
REMOVE_TOKEN=$(~/.local/bin/gh api -X POST \
  /repos/YOONPYOGitHub/agent-sentinel/actions/runners/remove-token \
  --jq .token)

az vm run-command invoke \
  -g rg-agent-sentinel \
  --name vm-ci-runner-as \
  --command-id RunShellScript \
  --scripts @scripts/remove-runner.sh \
  --parameters "GH_RUNNER_TOKEN=${REMOVE_TOKEN}"

# 새 토큰으로 재등록:
NEW_TOKEN=$(~/.local/bin/gh api -X POST \
  /repos/YOONPYOGitHub/agent-sentinel/actions/runners/registration-token \
  --jq .token)

az vm run-command invoke \
  -g rg-agent-sentinel \
  --name vm-ci-runner-as \
  --command-id RunShellScript \
  --scripts @scripts/bootstrap-runner.sh \
  --parameters "GH_RUNNER_TOKEN=${NEW_TOKEN}" "RUNNER_VERSION=2.319.1"
```

<a id="github-environment-protection"></a>

### GitHub 환경 보호

워크플로 실행 요청은 `replacement-validation`을 허용 목록에 두며,
배포 job은 선택한 GitHub 환경에 바인딩됩니다.
`deployPlatform=true`를 설정하기 전에
Settings > Environments > replacement-validation에서 Required reviewers를 구성합니다.
같은 승인 단계에서 다음 저장소 변수도 검토해야 합니다.
`AZURE_RESOURCE_GROUP`, `AZURE_SUBSCRIPTION_ID`, `ACR_NAME` (`acrm098047`),
`RUNNER_UAMI_CLIENT_ID`, `PRIVATE_RUNNER_LABEL` (`agent-sentinel-private-m098047`),
`API_CONTAINER_APP_NAME`, `WEB_CONTAINER_APP_NAME`.
워크플로는 누락되거나 유효하지 않은 이름, 불일치하는 대상 ACR,
승인되지 않은 매개변수 경로, 경로 순회를 거부합니다.
입력 기본값은 `targetEnvironment=none`, `parameterFile=none`,
`deployPlatform=false`입니다.

<a id="vm-decommission"></a>

### VM 폐기

다음은 과거 개발 runner 폐기 순서의 참고 기록입니다. 현재 RG에서 실행하지 않습니다.
향후 폐기는 실제 runner와 종속 리소스 ID를 대조하고 각 삭제를 별도 승인해야 합니다.

1. remove-runner.sh 스크립트로 GitHub에서 제거합니다(위 절차 참조).
2. `az vm delete -g rg-agent-sentinel --name vm-ci-runner-as --yes`
3. `az network nic delete -g rg-agent-sentinel --name nic-ci-runner-as`
4. `az identity delete -g rg-agent-sentinel --name id-ci-runner-260814`
5. `az network nsg delete -g rg-agent-sentinel --name nsg-build-as`

<a id="rb-020-exposure-ingestion"></a>

## RB-020: 노출 수집

jobs worker(`apps/jobs`)는 노출 수집 루프를 실행합니다.

1. 시작: 즉시 실행한 후 `DISCOVERY_INTERVAL_MS`밀리초마다 실행합니다(기본값 300000).
2. 주기별 단계:
   - 커넥터 검색(`AGENT_SENTINEL_CONNECTOR=mock|foundry`).
   - 스냅샷 저장(실제 데이터 모드에서는 Cosmos, 모의 모드에서는 메모리 내 저장).
   - `evaluateAllExposurePolicies`로 AS-POL-001/002/003 실행.
   - 발견 사항 업서트(Cosmos는 `firstSeen` 보존).
   - 현재 스냅샷에 없는 발견 사항을 `resolved`로 처리.
3. 선택적 Service Bus 구독자(`snapshot-ingestion`)는 `withIdempotency`로 임시 실행을 시작할 수 있습니다.
4. 주요 환경 변수: `AGENT_SENTINEL_CONNECTOR`, `AGENT_SENTINEL_ESTATE_ID`, `AGENT_SENTINEL_TENANT_ID`,
   `AGENT_SENTINEL_ENVIRONMENT`, `DISCOVERY_INTERVAL_MS`, `COSMOS_ENDPOINT`,
   `COSMOS_DATABASE`(우선) 또는 `COSMOS_DATABASE_ID`, `FOUNDRY_PROJECT_ENDPOINT`,
   `FOUNDRY_TENANT_ID`, `FOUNDRY_ENVIRONMENT`, `SERVICE_BUS_FQDN`. 다중 소스는 별도 소스 JSON을 검증합니다.
5. Cosmos/Service Bus는 `DefaultAzureCredential`을 사용합니다.
   커넥터는 소스별 승인된 managed identity/페더레이션을 사용할 수 있으며 공유 키로 대체하지 않습니다.

API/jobs는 인벤토리 수집과 기존 증거 쿼리를 수행하며 검색된 에이전트를 호출하지 않습니다.
SDK 패키징이나 자체 exporter 초기화로 실제 `agent.invoke`를 생성하지 않습니다.

<a id="rb-013-bounded-post-deployment-release-readiness-verification"></a>
<a id="rb-013-범위가-제한된-배포-후-릴리스-준비-상태-검증"></a>

## RB-013: 범위가 제한된 배포 후 릴리스 준비 상태 검증(읽기 검증 절차)

승인된 배포 후에만 실행합니다. 문서화된 `GET` 요청만 수행하며,
배포, 구성 변경, 트래픽 생성 또는 Azure 제어 평면 API 쿼리는 수행하지 않습니다.

```bash
# 현재 AUTH_MODE=disabled에서는 토큰 인수를 사용하지 않음
pnpm release-readiness:verify -- \
  --url "https://${FRONT_DOOR_HOST}" \
  --timeout-ms 15000 \
  --max-response-bytes 4194304 \
  --expected-web-sha "${COMMIT_SHA}" \
  --expected-api-sha "${COMMIT_SHA}" \
  --expected-jobs-sha "${COMMIT_SHA}" \
  --expected-web-digest "${WEB_IMAGE_DIGEST}" \
  --expected-api-digest "${API_IMAGE_DIGEST}" \
  --expected-jobs-digest "${JOBS_IMAGE_DIGEST}" \
  --output "${PWD}/release-readiness.json"
```

인증이 활성화된 승인 환경에서만 수명이 짧은 읽기 토큰을 프로세스 환경에 안전하게 주입하고
`--token-env AGENT_SENTINEL_ACCESS_TOKEN`을 추가합니다. 토큰을 셸 기록에 직접 입력하지 않습니다.
예상 SHA/다이제스트는 후보의 정확한 값으로 설정하며 현재 배포와 다른 저장소 HEAD를
일치한다고 처리하지 않습니다. `--output`의 절대 경로는 pnpm의 `scripts` 작업 디렉터리와 혼동을 방지합니다.
토큰은 지정한 환경 변수에서 읽으며 JSON이나 콘솔 출력에 포함하지 않습니다.
검증기는 모든 응답에 제한을 적용하고 제공된 요청별 시간 제한 내에서 읽기 요청 7개를 병렬로 실행합니다.

다음은 형식 설명용 예제이며 현재 실행 결과나 릴리스 통과 증거가 아닙니다.

```text
release readiness: READY | Agent365 ready | RUNS_AS 4 | OTel 3/12 | version ready
```

2026-09-15 기준 실제 상태는 `partial`, Entra ID 344개, `RUNS_AS=0`,
OTel 적격 0·쿼리 0·실제 증거 0입니다. 콘솔의 OTel 비율은
`liveInvocationCount/acceptedRecordCount`이며 적격/쿼리 수와 다른 지표입니다.

JSON 결과에는 `overall`, 범주별 준비 상태 증거, 불변 버전 비교, 범위가 제한된 요청 결과가 포함됩니다.
패키지 이름, 공급자 ID, 액세스 토큰, 소스 페이로드는 의도적으로 생략합니다.
종료 코드는 `0` 준비 완료, `3` 부분 완료, `1` 차단/사용 불가/오류, `2` 잘못된 인수입니다.

해석:

- `ready`: 정확한 `agent365:primary`가 최신이며 준비 완료, 완전함, 비어 있지 않음, 출처 바인딩 조건을 충족합니다. 배포 소스 바인딩이 유효하고 정확한 `RUNS_AS` 증거가 존재하며, 수락된 실제 OTel 증거에 추적/스팬 및 토큰/비용 출처가 포함되고, 제공된 불변 버전이 일치합니다.
- `partial`: 증거가 불완전하지만 모순되지는 않습니다. 정확한 진단에서 모든 권위 있는 에이전트의 공급자 ID 누락을 설명하는 경우에만 `RUNS_AS` 0개를 부분 완료로 취급합니다. OTel 0개인 경우 승인된 대표 애플리케이션 트래픽이 필요하며 실제 환경 준비 완료로 간주하지 않습니다.
- `blocked`: 오래되었거나, 비어 있거나, 알 수 없거나, 합성이거나, 불일치하거나, 모호하거나, 안전하지 않은 증거 때문에 운영 준비 완료 결과를 낼 수 없습니다.
- `unavailable`: 필수 엔드포인트 또는 문서화된 응답 계약을 관측할 수 없었습니다.

웹 UI는 **Release readiness**(`/release-readiness`)에서 동일한 범주를 제공합니다.
현재 API 상태와 커넥터 소스 계약을 사용하며 모의 성공 대체 경로가 없습니다.
준비 완료 결과는 릴리스 검토에 필요한 운영 증거이며 릴리스 승인을 의미하지 않습니다.
`pnpm demo:verify`와 `/demo-readiness`는 호환성 별칭으로 유지됩니다.
