<a id="security-and-authentication"></a>

# 보안 및 인증

<a id="current-posture"></a>
<a id="auth-states"></a>

## 현재 보안 상태

API JWT 검증기, 4개 역할의 RBAC, SPA MSAL 통합, 리디렉션 브리지,
토큰 기반 실제 환경 검증기는 저장소 코드에 구현되어 테스트되었습니다.
이 구현 상태가 배포 상태를 의미하지는 않습니다.

증거로 확인된 마지막 대체 배포는 `AUTH_MODE=disabled`와
`AGENT_SENTINEL_WRITE_ENABLED=false`를 사용합니다. 대체 API 및 SPA 앱 등록과 service principal은
생성되어 있지만, 관리자 동의·사용자 역할 할당·실제 로그인 활성화는 미완료입니다.
현재 배포와 저장소에만 있는 변경은 [현재 상태](current-status.md)를 기준으로 구분합니다.
과거의 읽기 전용 직원 JWT 검증과 이전 테넌트 등록은 대체 환경의 인증을 입증하지 않습니다.

활성 공개 엣지는 Azure Front Door입니다. 현재 WAF 정책에는 관리형 규칙이 있지만
`BlockApiMutationPreAuth` 사용자 지정 규칙은 증거로 확인되지 않았습니다.
이 규칙은 중지된 HTTP 전용 Application Gateway에 있으며 Front Door 트래픽을
**보호하지 않습니다**. 따라서 현재의 안전한 읽기 전용 상태는 API 쓰기 스위치를 false로
유지하는 데 의존합니다. 활성 Front Door 변경 차단 규칙을 검토하고 실제로 배치하여
JWT와 함께 검증하기 전까지 쓰기 활성화는 금지됩니다.

저장소에는 이제 기본적으로 비활성화된 Front Door 계약이
`infra/auth/frontdoor-authenticated-mutation-guard.contract.json`에 있습니다.
이 계약은 공개 변경 요청의 정확한 경로/메서드 쌍을 열거하며,
`Authorization` 헤더가 없거나 세 부분으로 구성된 Bearer 토큰 형태가 아닌 요청을 차단합니다.
`Allow` 규칙이나 `/api/*` 와일드카드를 만들지 않습니다.
토큰 형태 검사는 엣지 보호 장치일 뿐입니다.
JWT 서명, tenant, audience, scope, role, 쓰기 스위치 적용의 최종 권한은 API에 있습니다.

<a id="roles"></a>

## 역할

| 역할          | 정확한 앱 역할 값             | 기능 권한 경계                                |
| ------------- | ----------------------------- | --------------------------------------------- |
| Viewer        | `AgentSentinel.Viewer`        | 인벤토리, 증거, 보안 태세, 커넥터 상태 읽기   |
| Analyst       | `AgentSentinel.Analyst`       | Viewer 권한에 검증, 자문, 시정 조치 제안 추가 |
| Approver      | `AgentSentinel.Approver`      | Analyst 권한에 승인 결정 추가                 |
| Administrator | `AgentSentinel.Administrator` | Approver 권한에 시정 조치 실행 및 구성 추가   |

접두사가 붙은 정확한 app role 값만 허용합니다. 읽기 delegated scope는 Viewer를,
쓰기 delegated scope는 최대 Analyst를 부여합니다.
scope가 Approver 또는 Administrator를 암묵적으로 부여하지는 않습니다.
API는 서명, 정확한 tenant, audience, issuer, RS256, scope, role을 검증합니다.
민감 정보를 제거한 principal만 노출합니다.

<a id="runtime-configuration-contract"></a>

## 런타임 구성 계약

필수 값이 하나라도 없거나 유효하지 않으면 JWT 시작은 fail-closed 방식으로 차단됩니다.
실제 식별자는 커밋된 소스가 아니라 배포 매개변수 또는 승인된 구성에 둡니다.

| 설정                                | JWT 모드 요구사항                                                         |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `AUTH_TENANT_ID`                    | 단일 테넌트 디렉터리 UUID                                                 |
| `AUTH_AUDIENCE`                     | 정확한 `api://` 또는 HTTPS 애플리케이션 ID URI                            |
| `AUTH_ISSUER`                       | 선택적 정확한 HTTPS issuer. 비어 있으면 tenant별 Entra v2 issuer에서 도출 |
| `AUTH_JWKS_URI`                     | 선택적 정확한 HTTPS JWKS URI. 비어 있으면 tenant별 v2 discovery에서 도출  |
| `AUTH_READ_SCOPES`                  | 비어 있지 않은 정확한 `scp` claim 값                                      |
| `AUTH_WRITE_SCOPES`                 | 비어 있지 않고 겹치지 않는 정확한 `scp` claim 값                          |
| `AUTH_SPA_CLIENT_ID`                | SPA 애플리케이션 UUID                                                     |
| `AUTH_SPA_SCOPES`                   | 구성된 fully qualified API scope. 비어 있으면 읽기만 요청                 |
| `AUTH_SPA_REDIRECT_URI`             | 등록된 정확한 HTTPS URI 또는 로컬 개발용 `http://localhost`               |
| `AUTH_SPA_POST_LOGOUT_REDIRECT_URI` | 동일 출처의 정확한 로그아웃 후 URI                                        |

API는 이 공개 SPA 값을 `/api/auth/config`에 게시합니다.
SPA는 리디렉션 출처가 애플리케이션을 제공하는 출처와 다른 구성을 거부합니다.
자동 토큰 갱신 오류를 익명 요청으로 바꾸지 않습니다.

<a id="redirect-host-decision"></a>

## 리디렉션 호스트 결정

활성 Azure Front Door HTTPS 출처는 SPA와 API를 모두 라우팅하며,
대체 환경의 리디렉션 및 동일 출처 로그아웃에 사용할 출처입니다.
Application Gateway 엔드포인트는 여전히 HTTP 전용이며 인증 출처로 허용되지 않습니다.
리디렉션 등록과 JWT 활성화는 함께 검증해야 합니다.
라우트가 정상이라는 사실만으로 인증이 성립하지 않습니다.

<a id="staged-activation"></a>

## 단계적 활성화

각 단계는 별도로 승인받아야 하는 변경입니다. 불일치가 있으면 중지하고 롤백합니다.

런타임 활성화 전에 대체 등록을 생성합니다.
`infra/auth/replacement-entra-registration-bootstrap.template.json`을 저장소 밖으로 복사하고,
자리 표시자를 승인된 비밀이 아닌 값으로 바꾼 다음 계획을 생성합니다.

```bash
pnpm auth:registration-bootstrap -- \
  --input /secure/local/path/entra-registration-input.json \
  --output entra-registration-plan.json
```

이 계획은 범위가 제한된 Graph 검색을 수행하고, 정확한 이름의 후보가 모호하거나
SPA 항목이 과거 또는 잘못된 출처를 사용하면 안전하게 차단합니다.
API 앱 및 service principal, delegated Read/Write scope, 4개 role, SPA 앱 및 service principal,
정확한 리디렉션/로그아웃 URL, SPA Read 접근에 대한 결정적 요청 구조를 포함합니다.
비밀, 인증서, 동의 부여, 그룹, 역할 할당은 생성하지 않습니다.
적용에는 검토된 계획 산출물, 정확한 테넌트 확인,
`APPROVE_ENTRA_REGISTRATION_BOOTSTRAP`, 보호된 `entra-registration-bootstrap` 환경이 필요합니다.
롤백은 해당 계획의 operation ID로 생성된 디렉터리 개체만 삭제합니다.

그런 다음 `infra/auth/replacement-auth-activation.template.json`을 저장소 밖으로 복사하고
오프라인 런타임 계획을 실행합니다.

```bash
pnpm auth:preflight -- --input /secure/local/path/auth-activation.json \
  --output auth-activation-plan.json
```

승인된 등록/런타임 변경 후
`infra/auth/replacement-active-edge-preflight.template.json`을 기반으로
범위가 제한된 활성 엣지 검사를 실행합니다.

```bash
pnpm auth:edge-preflight -- --input /secure/local/path/active-edge-input.json \
  --output active-edge-preflight.json
```

활성 엣지 보고서는 안전한 읽기 전용 정책 하나를 명시적으로 선택합니다.
정확한 계약 다이제스트와 규칙을 가진 명확하게 연결된 단일 Front Door Prevention 정책,
또는 쓰기 활성화를 허용하지 않는 `writeEnabled=false`입니다.
보안 정책/WAF 정책이 없거나 여러 개이거나, 다이제스트 드리프트, 중복 규칙,
API `Allow` 규칙, 비활성 JWT, true인 쓰기 스위치가 있으면 쓰기 단계 준비 판정은 항상 차단됩니다.

1. **읽기 전용 활성화 — 대체 배포에서는 미완료 상태입니다.**
   대체 환경의 정확한 HTTPS 리디렉션/로그아웃 URI를 등록하고,
   쓰기를 false로 유지하면서 실패 시 차단하는 JWT 설정을 주입한 후,
   익명 `401`, Viewer `403`, `/api/auth/me`, 로그인, 로그아웃을 입증합니다.
2. **역할 검증 완료.** Analyst, Approver, Administrator에 최소 권한 테스트 주체/그룹을 할당하고
   문서화된 모든 기능 권한 경계를 검증합니다. 광범위한 그룹을 기본으로 할당하지 않습니다.
3. **활성 엣지의 익명 요청 보호 장치 생성.** 쓰기 스위치를 변경하지 않고 정확한 계약 다이제스트,
   Bicep what-if, `frontDoorAuthenticatedMutationGuardEnabled=true` 매개변수를 검토합니다.
   인증 활성화와 별도로 배포한 후, 단일 정책과 모든 정확한 규칙을 다시 검색합니다.
4. **범위가 제한된 쓰기 검증.** JWT와 검토된 Front Door 계약이 모두 통과한 후에만
   승인된 private endpoint를 사용해 되돌릴 수 있는 쓰기를 한 번 수행합니다.
   이후의 Front Door 예외에는 별도 승인이 필요하며 익명 API 거부를 유지해야 합니다.
   WAF는 API 권한 부여를 대체하지 않습니다.
5. **공개 쓰기 별도 활성화.** 이후 검토된 배포에서 `AGENT_SENTINEL_WRITE_ENABLED`만 변경할 수 있습니다.
   이번 저장소 변경은 해당 스위치를 활성화하거나 배포하지 않습니다.

사용자 지정 매니페스트 수집 엔드포인트는 JWT 모드, Administrator의 `configure` 기능 권한,
`AGENT_SENTINEL_WRITE_ENABLED=true`로 독립적으로 통제됩니다.
매니페스트의 테넌트/환경은 서버 자산 범위 구성에서 가져오며 요청 필드나 토큰 클레임에서 가져오지 않습니다.
토큰 테넌트는 호출자를 인증하며 Azure 자산 범위의 테넌트와 달라도 유효할 수 있습니다.

<a id="repeatable-live-validation"></a>

## 반복 가능한 실제 환경 검증

검증기는 토큰을 획득하거나 영구 저장하거나 출력하지 않습니다.
수명이 짧은 토큰과 테스트할 엔드포인트를 프로세스 환경으로 제공합니다.
읽기 단계에서는 익명 `401`, 역할 부족 `403`, `/api/auth/me`,
4개 역할 모두의 모든 기능 권한을 확인합니다.

```bash
AUTH_VALIDATION_BASE_URL=https://<approved-host> \
AUTH_VALIDATION_VIEWER_TOKEN=<short-lived-token> \
AUTH_VALIDATION_ANALYST_TOKEN=<short-lived-token> \
AUTH_VALIDATION_APPROVER_TOKEN=<short-lived-token> \
AUTH_VALIDATION_ADMINISTRATOR_TOKEN=<short-lived-token> \
AUTH_VALIDATION_EXPECTED_REDIRECT_ORIGIN=https://<approved-host> \
AUTH_VALIDATION_EXPECTED_API_SHA=<40-hex-sha> \
AUTH_VALIDATION_EXPECTED_API_IMAGE_DIGEST=sha256:<64-hex-digest> \
AUTH_VALIDATION_EXPECTED_WEB_SHA=<40-hex-sha> \
AUTH_VALIDATION_EXPECTED_WEB_IMAGE_DIGEST=sha256:<64-hex-digest> \
pnpm auth:validate-live
```

예상 web/API/jobs SHA 및 다이제스트 변수는 선택 사항이며 각각 독립적으로 선택할 수 있습니다.
제공된 경우 `/api/status`가 해당 값과 일치해야 합니다.
`AUTH_VALIDATION_EXPECTED_REDIRECT_ORIGIN`이 있으면 검증기는 토큰을 포함한 검사를 보내기 전에
`/api/auth/config`에 정확히 `<origin>/auth-redirect.html`과 `<origin>/`가 있는지 확인합니다.
JSON 응답의 기본 한도는 256 KiB이며,
`AUTH_VALIDATION_MAX_RESPONSE_BYTES`는 1024부터 1048576까지 설정할 수 있습니다.

승인된 쓰기 단계에서는 `AUTH_VALIDATION_PHASE=write`,
`AUTH_VALIDATION_WRITE_METHOD`, `AUTH_VALIDATION_WRITE_PATH`,
선택적 JSON `AUTH_VALIDATION_WRITE_BODY`, 정확한 2xx `AUTH_VALIDATION_WRITE_EXPECTED_STATUS`를
추가로 설정합니다. 승인된 테스트 계획에서 범위가 제한되고 되돌릴 수 있는 대상을 선택합니다.
스크립트는 의도적으로 변경 엔드포인트나 리소스 식별자를 추측하지 않습니다.

<a id="activation-checklist"></a>

## 활성화 점검 목록

- [ ] 승인된 부트스트랩 계획을 통해 대체 API 및 SPA 앱 등록 생성
- [ ] 대체 API Read/Write 범위 및 정확한 앱 역할 4개 생성
- [x] 명시적 유형과 실패 시 차단 동작을 갖춘 API, SPA, 등록, 배포, 엣지 사전 검사, 검증 구성을 로컬에서 준비
- [ ] 대체 HTTPS 리디렉션 및 로그아웃 출처 승인과 증거 확보
- [ ] 대체 리디렉션 및 로그아웃 URI 등록
- [ ] 대체 읽기 전용 위임 권한 검토 및 검증 주체의 사용 가능 여부 확인
- [ ] 4개 역할 모두에 테스트 주체/그룹 할당
- [ ] 검토된 이미지 다이제스트와 쓰기 비활성 상태로 `AUTH_MODE=jwt` 배포
- [ ] 대체 환경 직원 로그인, 로그아웃, 익명 `401`, Viewer `403`, `/api/auth/me` 검증
- [ ] 실제 토큰으로 Analyst, Approver, Administrator 및 4개 역할 모두의 경계 검증
- [ ] 프라이빗 인증 쓰기 스모크 테스트 통과
- [ ] 정확한 Front Door 계약 다이제스트 및 Bicep what-if 승인
- [ ] 기본 비활성 Front Door 익명 변경 차단 장치 배포 및 재검색
- [ ] 별도 쓰기 스위치 승인 전에 공개 익명 요청 거부 재검증

OneRAI 또는 사내 서비스 온보딩은 독립적으로 진행할 수 있으며 로컬 인증 개발을 차단하지 않습니다.
또한 ID, 동의, 역할 할당, 배포 또는 WAF 승인을 대체하지 않습니다.

<a id="emergency-rollback"></a>

## 긴급 롤백

1. 먼저 `AGENT_SENTINEL_WRITE_ENABLED=false`를 설정하고 `/api/status`를 검증합니다.
   쓰기 상태를 알 수 없는 동안 Front Door 익명 요청 보호 장치를 제거하거나 완화하지 않습니다.
2. 검토된 Front Door Prevention 모드 계약과 다이제스트를 복원합니다.
   중지된 Application Gateway 규칙에 의존하지 않습니다.
3. 마지막으로 정상 동작이 확인된 Container Apps 리비전과 불변 이미지 다이제스트를 복원합니다.
4. 쓰기를 false로 유지하는 동안에만 `AUTH_MODE=disabled`로 돌아갑니다.
   활성화되고 검토된 Front Door 변경 차단 규칙 없이는 공개 쓰기 활성화를 허용하지 않습니다.
5. 승인된 ID 절차를 통해 잘못된 역할 할당 또는 동의 부여를 제거합니다.
6. 상태 코드와 상관관계 ID만 기록합니다. 토큰, 개인 클레임, 비밀은 복사하지 않습니다.
