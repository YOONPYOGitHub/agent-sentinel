<a id="foundry-identity-aware-synthetic-pilot"></a>

# Foundry ID 인식 합성 파일럿

이 런북은 기존 에이전트와 나란히 검증할 에이전트 하나를 준비합니다.
기존 합성 에이전트 6개를 마이그레이션, 업데이트 또는 삭제하지 않습니다.
저장소에 포함된 명령은 기본적으로 계획만 수행합니다.
운영자가 명시적으로 `create` 또는 `cleanup`을 선택하고 `--apply`를 추가하며
정확한 확인 문자열을 제공하지 않는 한 Azure 또는 Microsoft Graph 요청을 하지 않습니다.

<a id="fixed-pilot-contract"></a>

## 고정된 파일럿 계약

| 항목                   | 값                                           |
| ---------------------- | -------------------------------------------- |
| 에이전트 이름          | `agent-sentinel-identity-pilot-readonly-v1`  |
| 표식                   | `[pilot:foundry-instance-identity-v1]`       |
| 파일럿 버전            | `1`                                          |
| 의미적 원본            | `customer-support-safe`                      |
| Foundry API            | 안정 버전 프로젝트 데이터 플레인 `v1`        |
| 생성 후 예상 관리 영역 | 변경되지 않은 기존 에이전트 6개와 파일럿 1개 |

이 저장소는 에이전트 SDK 대신 한도가 있는 자체 `FoundryHttpClient`를 사용합니다.
검색과 CRUD는 모두 안정 버전 Foundry 프로젝트 데이터 플레인 `v1`으로 고정됩니다.
이에 대응하는 현재 공식 Python SDK는 `azure-ai-projects` 2.6.1
(2026-09-14 릴리스)입니다. 안정 버전의 `agents.create_version` 작업 역시
기본값으로 `api-version=v1`을 사용하며, 동일한 `definition`, `description`,
`metadata` 및 선택적인 `blueprint_reference` 필드를 허용합니다.

`customer-support-safe`는 기존 정의 중 의미적으로 복제하기에 가장 안전합니다.
읽기 전용 합성 함수 `knowledge_search` 하나만 있고, 쓰기 작업, 외부 전송,
직원이나 기타 민감한 영역의 조회가 없으며, 개인정보 공개, 외부 전송, 쓰기를
금지하는 명시적인 지침이 있습니다. 파일럿은 공급자 객체, 애플리케이션,
에이전트, 버전, 청사진 식별자를 복사하지 않습니다.

안정 버전 생성 요청은 다음과 같습니다.

```http
POST {FOUNDRY_PROJECT_ENDPOINT}/agents/agent-sentinel-identity-pilot-readonly-v1/versions?api-version=v1
Authorization: Bearer <token for https://ai.azure.com/.default>
Content-Type: application/json
```

`pnpm foundry:identity-pilot -- plan`이 출력하는 본문에는 고정 프롬프트 정의와
한도가 있는 메타데이터만 들어 있습니다. `blueprint_reference`와 모든 ID 식별자는
의도적으로 생략합니다. 현재 Foundry 에이전트 객체 모델에서는 새 에이전트를
만들면 서비스가 고유한 에이전트 ID와 청사진을 생성합니다.
프로젝트 관리 ID나 과거 공급자 ID를 제공하는 것은 금지됩니다.

<a id="repository-findings"></a>

## 저장소에서 확인한 사항

- `@agent-sentinel/scenarios`는 정확히 6개의 합성 에이전트를 정의합니다.
  `customer-support-safe`만이 도구 하나를 사용하는 비민감 읽기 전용 선택지입니다.
- `scripts/provision-agents.ts`는 6개 에이전트 전체 매니페스트를 순회하므로
  이 파일럿만 안전하게 생성할 수 없습니다.
- `scripts/cleanup-agents.ts`는 매니페스트 이름 6개를 모두 대상으로 하며,
  ID 파일럿 롤백 명령이 아닙니다.
- `scripts/foundry-http.ts`와 실제 커넥터는 안정 버전 `v1` API와
  `https://ai.azure.com/.default` 토큰 범위를 사용합니다.
- Foundry 검색은 이미 `instance_identity.principal_id`만 정확한 런타임 객체
  식별 근거로 매핑합니다. 청사진과 프로젝트 ID는 설명용으로 남으며
  `RUNS_AS`를 생성할 수 없습니다.
- 작업 서비스는 시작 시 한 번 검색하고, 기본적으로 5분마다 검색합니다.
- IaC는 별도의 커넥터 UAMI를 만들지만, 이에 대한 프로젝트 범위 Foundry 또는
  Microsoft Graph 권한을 부여하지 않습니다. 해당 권한은 명시적인 배포 전제 조건입니다.
- `ENTRA_RUNS_AS_BINDINGS_JSON`에는 정확한 Foundry-Entra 소스 경계가 이미
  포함되어 있어야 합니다. 이름 기반 또는 암묵적인 `primary` 바인딩은 허용하지 않습니다.

<a id="prerequisites-and-permissions"></a>

## 사전 요구 사항과 권한

승인 전에 운영자는 다음을 확인해야 합니다.

1. 대상이 의도한 프로젝트이고 안정 버전 `v1` 데이터 플레인을 사용할 수 있습니다.
2. 매니페스트 이름 6개가 현재 에이전트 관리 영역 전체이며, 각 에이전트에
   Agent Sentinel 소유권 표식이 있고 `instance_identity`는 null입니다.
3. 프로젝트 `properties.agentIdentityId`는 여전히 null이며, 기준 관찰값으로만
   기록하고 `RUNS_AS` 후보로 사용하지 않습니다.
4. 고정된 파일럿 이름이 존재하지 않습니다.
5. `customer-support-safe`가 사용하는 설정된 모델 배포가 존재합니다.
6. 생성하는 보안 주체에게 프로젝트 범위의 **Foundry User**가 있습니다.
   Azure Resource Manager Owner만으로는 Foundry 데이터 플레인 CRUD에 충분하지 않습니다.
7. 프로젝트 관리 ID에는 플랫폼에서 요구하는 **Foundry User** 할당이 있습니다.
   이는 서비스 관리 청사진을 인증하며, `RUNS_AS` 끝점이 되지 않고
   파일럿의 다운스트림 권한을 받지 않습니다.
8. 안정 버전 Graph 인벤토리에 `Application.Read.All`이 있습니다.
   안정 버전 v1.0 하위 유형 검증에는 승인된 `AgentIdentity.Read.All`이 있고,
   위임된 비소유자에게는 지원되는 Agent ID Administrator 역할도 필요합니다.

이 기본 파일럿에서는 다운스트림 역할 할당을 예상하지도 허용하지도 않습니다.
함수 도구는 공급자 연결이 없는 스키마 전용 합성 콜백입니다.
나중에 실제 다운스트림 도구를 추가하면 별도의 변경으로 취급하고 최소 권한 역할을
`instance_identity.principal_id`에 할당해야 합니다.
프로젝트 관리 ID나 청사진에 할당해서는 안 됩니다.

<a id="preview-and-create-sequence"></a>

## 미리 확인 및 생성 순서

승인된 커밋의 깨끗한 체크아웃에서 실행하세요. 환경별 출력은 보호된 세션 파일이나
승인된 감사 시스템에만 저장하세요.

```bash
set -o pipefail
pnpm install --frozen-lockfile
pnpm build
pnpm foundry:identity-pilot -- plan

export FOUNDRY_PROJECT_ENDPOINT='https://<account>.services.ai.azure.com/api/projects/<project>'
export PILOT_EVIDENCE_DIR='<absolute-session-files-directory>'
pnpm foundry:identity-pilot -- create --apply \
  --confirm CREATE:agent-sentinel-identity-pilot-readonly-v1 \
  | tee "${PILOT_EVIDENCE_DIR}/foundry-identity-pilot-create.log"
```

생성 전 관리 영역이 런타임 ID가 null인 소유된 매니페스트 에이전트 정확히 6개가
아니면 생성 명령은 실패 시 차단합니다. 고정된 파일럿 이름만 생성하고
ID 정보가 준비될 때까지 기다린 뒤, 기존 지문 6개를 모두 비교하고 성공을 보고합니다.

null이 아니어야 하는 응답 필드:

- `instance_identity.principal_id`
- `instance_identity.client_id`
- `blueprint.principal_id`
- `blueprint.client_id`
- `blueprint_reference.type`은 `ManagedAgentIdentityBlueprint`와 같아야 함
- `blueprint_reference.blueprint_id`

명령의 JSON 출력을 보존하세요. 검증과 롤백에 필요한 파일럿의 변경 불가 ID,
ID 식별자, 청사진 ID가 포함되어 있습니다.

<a id="graph-and-ingestion-verification"></a>

## Graph 및 수집 검증

보존한 생성 증거에서 값을 설정하세요. 이름에서 추정하지 마세요.

```bash
export PILOT_AGENT_ID='<immutable-agent-id>'
export PILOT_PRINCIPAL_ID='<instance_identity.principal_id>'
export PILOT_CLIENT_ID='<instance_identity.client_id>'
export PILOT_BLUEPRINT_PRINCIPAL_ID='<blueprint.principal_id>'

az rest --method get \
  --resource https://ai.azure.com \
  --url "${FOUNDRY_PROJECT_ENDPOINT}/agents/agent-sentinel-identity-pilot-readonly-v1?api-version=v1"

az rest --method get \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/${PILOT_PRINCIPAL_ID}?\$select=id,appId,displayName,servicePrincipalType"

az rest --method get \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/${PILOT_PRINCIPAL_ID}/microsoft.graph.agentIdentity?\$select=id,appId,displayName,servicePrincipalType,agentIdentityBlueprintId"

az rest --method get \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/${PILOT_BLUEPRINT_PRINCIPAL_ID}?\$select=id,appId,displayName,servicePrincipalType"
```

다음 값이 정확히 같아야 합니다.

- Foundry `principal_id` = Graph `id`
- Foundry `client_id` = Graph `appId`
- 하위 유형 `@odata.type` = `#microsoft.graph.agentIdentity`
- 하위 유형 `servicePrincipalType` = `ServiceIdentity`
- 하위 유형 `agentIdentityBlueprintId` = Foundry `blueprint.client_id`
- 청사진 서비스 주체 `id` = Foundry `blueprint.principal_id`
- 청사진 서비스 주체 `appId` = Foundry `blueprint.client_id`

두 읽기 모두 Microsoft Graph v1.0을 사용합니다. 프로덕션 상관관계는 계속
안정 버전 서비스 주체 인벤토리와 정확한 객체 ID를 사용합니다.

작업 서비스는 시작 즉시 검색하고 이후 `DISCOVERY_INTERVAL_MS`마다
(기본 5분) 검색합니다. 생성 후 다음 예약 실행을 기다리거나 일반 배포 절차에
따라 작업 리비전만 다시 시작하세요. API/웹 애플리케이션을 다시 시작하지 말고,
6개 에이전트 프로비전 또는 정리 명령도 실행하지 마세요.

인증된 실제 읽기 모델을 조회하세요.

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer ${AGENT_SENTINEL_ACCESS_TOKEN}" \
  -H "x-agent-sentinel-estate-id: ${AGENT_SENTINEL_ESTATE_ID}" \
  "${AGENT_SENTINEL_API_ORIGIN}/api/demo/state" \
  > "${PILOT_EVIDENCE_DIR}/pilot-state.json"

jq --arg name agent-sentinel-identity-pilot-readonly-v1 \
  '[.snapshot.nodes[] | select(.kind=="agent" and .name==$name)] | length' \
  "${PILOT_EVIDENCE_DIR}/pilot-state.json"

jq '[.snapshot.edges[] | select(.relationship=="RUNS_AS")] | length' \
  "${PILOT_EVIDENCE_DIR}/pilot-state.json"

PILOT_NODE_ID="$(
  jq -r --arg name agent-sentinel-identity-pilot-readonly-v1 \
    '.snapshot.nodes[] | select(.kind=="agent" and .name==$name) | .id' \
    "${PILOT_EVIDENCE_DIR}/pilot-state.json"
)"
IDENTITY_NODE_ID="$(
  jq -r --arg id "${PILOT_PRINCIPAL_ID}" \
    '.snapshot.nodes[] |
     select(.kind=="identity" and
       ((.metadata.providerObjectId // "") | ascii_downcase)==($id | ascii_downcase)) |
     .id' "${PILOT_EVIDENCE_DIR}/pilot-state.json"
)"
jq --arg from "${PILOT_NODE_ID}" --arg to "${IDENTITY_NODE_ID}" \
  '[.snapshot.edges[] |
    select(.relationship=="RUNS_AS" and .from==$from and .to==$to)] | length' \
  "${PILOT_EVIDENCE_DIR}/pilot-state.json"
```

수용 조건은 다음과 같습니다.

- 권위 있는 Foundry 에이전트 7개와 원래의 변경 불가 ID 6개.
- 정확한 Foundry 보안 주체/클라이언트 메타데이터가 있는 파일럿 노드 1개.
- 파일럿 에이전트 노드에서 공급자 객체 ID가 `PILOT_PRINCIPAL_ID`와 같은
  Entra ID로 향하는 `RUNS_AS` 간선이 정확히 1개.
- 상관관계 진단이 정확한 객체 ID 일치 1개, 모호성 0개를 보고하고,
  기존 에이전트 6개는 공급자 ID 식별자 누락으로 명시적인 미일치 상태를 유지.
- 파일럿에 대한 새로운 `CAN_READ`, `CAN_EXFILTRATE_TO` 또는 기타
  다운스트림 권한 부여 간선이 없음.

<a id="rollback"></a>

## 롤백

먼저 생성 출력, Foundry GET, Graph 응답, 새로 고침 후 스냅샷을 보호된
감사 저장소에 보존하세요. 그런 다음 정확한 변경 불가 파일럿 ID로 삭제를 승인하세요.

```bash
pnpm foundry:identity-pilot -- cleanup --apply \
  --agent-id "${PILOT_AGENT_ID}" \
  --confirm "DELETE:agent-sentinel-identity-pilot-readonly-v1:${PILOT_AGENT_ID}" \
  | tee "${PILOT_EVIDENCE_DIR}/foundry-identity-pilot-cleanup.log"
```

정리는 기존 이름, 불일치 ID, 표식 누락, 파일럿 메타데이터 누락, 불완전한 ID를
모두 거부합니다. ID를 고정된 파일럿 이름 하나와 대조한 뒤,
해당 이름의 안정 버전 삭제 엔드포인트를 호출하고, 파일럿이 없어졌는지와
기존 지문 6개가 모두 변경되지 않았는지 확인합니다.

서비스가 생성한 에이전트 ID와 청사진의 수명 주기는 Foundry가 관리합니다.
이 런북에는 별도의 직접 Graph 삭제가 없습니다. 전파 후 하위 유형 읽기가
`404`를 반환하거나 디렉터리 객체가 삭제된 항목에만 존재하는지 확인하세요.
Foundry가 지원되는 고아 객체 정리 작업을 문서화하면, 객체 ID가 보존된 파일럿
증거에서 왔음을 입증한 뒤에만 사용하세요.
표시 이름으로 삭제하지 말고 프로젝트 ID를 삭제하지 마세요.

마지막으로 작업 검색 주기 한 번이 실행되게 하거나 직접 트리거하고,
에이전트 6개, 파일럿 `RUNS_AS` 간선 0개, 변경되지 않은 기존 ID를 요구하세요.
감사 증거는 삭제하지 말고 보관하세요.

<a id="risks"></a>

## 위험

- Entra ID와 삭제 전파는 최종 일관성을 따릅니다.
- `agentIdentity` 하위 유형 읽기는 Microsoft Graph v1.0에서 사용할 수 있지만
  별도의 `AgentIdentity.Read.All` 승인이 필요합니다.
- 로컬 검증이 ID 필드를 받기 전에 생성이 성공할 수 있습니다.
  통제된 정리를 위해 고정 이름과 공급자 응답을 보존하세요.
- 실제 도구 연결이나 역할 할당은 위험 경계를 바꾸며 이 파일럿의 범위를 벗어납니다.

<a id="official-references"></a>

## 공식 참조

- [Microsoft Foundry 에이전트 ID 개념](https://learn.microsoft.com/azure/foundry/agents/concepts/agent-identity)
- [새 Foundry 에이전트 객체 모델](https://learn.microsoft.com/azure/foundry/agents/how-to/migrate-agent-applications)
- [Foundry 역할 기반 액세스 제어(RBAC)](https://learn.microsoft.com/azure/foundry/concepts/rbac-foundry)
- [Microsoft Graph v1.0 agentIdentity 조회](https://learn.microsoft.com/graph/api/agentidentity-get?view=graph-rest-1.0)
- [Azure AI Projects Python SDK 릴리스 기록](https://github.com/Azure/azure-sdk-for-python/blob/main/sdk/ai/azure-ai-projects/CHANGELOG.md)
