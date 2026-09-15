<a id="versioned-sanitized-release-evidence"></a>

# 버전 관리형 민감 정보 제거 릴리스 증거

릴리스 증거는 빌드, 테스트, 예상, 배포, 관측 항목을 버전 관리하고 기계적으로 검증하는 요약입니다.
원시 로그 묶음이 아닙니다. 저장소 매니페스트 버전 `1.0.0`은
[`release-evidence/v1/schema.json`](../release-evidence/v1/schema.json)과
`scripts/release-evidence-schema.ts`의 더 엄격한 필드 간 검사로 정의됩니다.

정확한 SHA에 대한 검토 번들 버전 `2.0.0`은 해당 매니페스트에
보안, 접근성, OneRAI, 위협/통제, 커넥터, 실제 환경 검증,
운영 릴리스 준비 상태, 배포, 차단 요인, 사람의 결정에 대한 통과 기준을 결합합니다.
기계 처리용 필드 `demoReadiness`와 `demo-readiness`는 v2 호환성을 위해 유지됩니다.
계약은 [`input.schema.json`](../release-evidence/v2/input.schema.json)과
[`bundle.schema.json`](../release-evidence/v2/bundle.schema.json)입니다.

생성기는 의도적으로 오프라인으로 설계되었습니다.
커밋 SHA와 미커밋 변경 상태를 읽기 위해 로컬 Git 명령만 호출합니다.
검증 명령, Azure, Microsoft 365, Foundry, OneRAI, 레지스트리 또는 다른 네트워크 서비스를 호출하지 않습니다.

<a id="commands"></a>

## 명령

저장소 전용 증거를 생성합니다. 제공되지 않은 검사, 배포, 실제 환경 검증,
커넥터, 구성, OneRAI 필드는 모두 명시적으로 `not-run`, `unknown` 또는 `planned` 상태를 유지합니다.

```bash
pnpm release-evidence:generate -- \
  --output release-evidence/generated/<full-sha>.json
```

명시적으로 제공된, 민감 정보를 제거한 관측을 추가합니다.

```bash
pnpm release-evidence:generate -- \
  --input <sanitized-input.json> \
  --output release-evidence/generated/<full-sha>.json
```

매니페스트를 검증하고 커밋된 JSON Schema가 동기화되어 있는지 확인합니다.

```bash
pnpm release-evidence:validate -- <manifest.json>
pnpm release-evidence:schema:check
```

선택적 생성 인수 `--timestamp <ISO-8601>`은 재현 가능한 저장소 예제를 위한 것입니다.
일반적인 릴리스 생성에는 현재 시간을 사용합니다.

<a id="exact-sha-release-review-bundle"></a>

### 정확한 SHA의 릴리스 검토 번들

엄격한 차단 상태 템플릿에서 시작해 허용 목록의 요약과 불투명 증거 참조만 바꾸고,
로컬 시험 실행을 수행합니다.

```bash
SHA="$(git rev-parse HEAD)"

pnpm release-review:schema:check
pnpm release-review:dry-run -- \
  --dry-run \
  --sha "$SHA" \
  --input release-evidence/v2/templates/sanitized-input.template.json \
  --output release-evidence/generated \
  --timestamp '2026-09-14T01:00:00.000Z'
pnpm release-review:validate -- \
  --sha "$SHA" \
  "release-evidence/generated/release-review-v2-$SHA.json"
```

선택적인 민감 정보 제거 접근성 증거는 `--accessibility <artifact.json>`과
명시된 `--accessibility-ref <id>`로 제공합니다.
산출물이 없으면 차단 상태를 유지합니다. 커밋된 통과/실패 픽스처는
지원되는 axe 형식을 보여 주는 테스트 데이터이며 릴리스 증명이 아닙니다.
각 화면에는 민감 정보를 제거한 식별자와 명시적인 `violations` 배열이 있어야 합니다.
`--accessibility-observed-at`은 누락된 산출물 타임스탬프를 채울 수 있지만,
산출물에 이미 있는 충돌하는 타임스탬프를 덮어쓸 수는 없습니다.
위반 행에는 규칙 ID, 영향, WCAG 태그와 빈 `nodes` 자리 표시자 또는
정수 `affectedNodes` 개수만 보존합니다.
`html`, `target`, `any`, `all`, `failureSummary` 같은 원시 DOM 필드는 보존하지 않고 거부합니다.

생성에는 `--dry-run`이 필요하며 체크아웃된 `HEAD`와 다른 SHA는 거부합니다.
결정적 `--timestamp` 입력(또는 `SOURCE_DATE_EPOCH`)도 필요합니다.
로컬 Git 상태와 지정한 로컬 JSON 파일만 읽고, 모드 `0600`의 JSON 및 Markdown을 씁니다.
배포, 승인, 검토자 연락, 양식 제출 또는 공급자 호출은 하지 않습니다.
SHA-256은 `canonicalHash`만 제외한 정규 번들 JSON 전체를 대상으로 합니다.

번들은 내장된 증거에서 품질, 커넥터, OneRAI, 준비 상태 통과 기준을 도출합니다.
통과 기준을 다시 쓰고 해시를 재계산하는 시도는 거부됩니다.
OneRAI 시나리오 행은 정렬하고 결정적 `onerai-sha256:<digest>` 참조를 부여합니다.
집합 성격의 검토 인벤토리와 참조는 해싱 전에 정규화합니다.
위협/통제 쌍은 버전 관리형 카탈로그로 고정되며,
서비스 거부 위험에 대응하는 제한된 리소스 처리도 포함합니다.

사람의 결정은 명시적인 `pending`, `approved` 또는 `rejected` 레코드입니다.
보안, 접근성, OneRAI는 해당 증거 통과 기준이 차단된 동안 승인할 수 없습니다.
릴리스 승인에는 추가로 결정을 제외한 모든 통과 기준과 전문가 결정 3개가 모두 필요합니다.
범주화된 미해결 차단 요인은 해당 품질, 보안, 접근성, OneRAI, 배포,
실제 환경 검증, 커넥터, 운영 릴리스 준비 상태 또는 사람의 결정 통과 기준을 차단하며,
선언된 차단 요인의 집계 기준도 차단합니다.
CLI는 승인을 생성하지 않습니다.

<a id="classifications-and-outcomes"></a>

## 분류 및 결과

증거를 포함하는 모든 레코드는 다음 분류 중 하나를 사용합니다.

| 분류        | 의미                                                                    |
| ----------- | ----------------------------------------------------------------------- |
| `live`      | 실제 공급자 또는 배포된 시스템 관측에서 민감 정보를 제거한 요약.        |
| `synthetic` | 범위가 제한된 합성 검사 또는 픽스처. 고객 또는 프로덕션 증거가 아님.    |
| `tested`    | 로컬 또는 CI 저장소 검사, 또는 테스트된 저장소 상태에서 직접 도출한 값. |
| `blocked`   | 명시된 사전 요구사항이 관측이나 작업을 차단함.                          |
| `planned`   | 제공된 관측이 없음. 성공의 증거가 아님.                                 |

검사 및 검증 결과는 `pass`, `fail`, `unknown`, `blocked` 또는 `not-run`입니다.
평가된 모든 실제 환경 검증의 통과 또는 실패에는 분류에 관계없이
null이 아닌 민감 정보 제거 소스, 관측 타임스탬프, 범위, 최소 하나의 증거 참조가 필요합니다.
OneRAI 증거도 `tested`로 분류되거나 결과가 `pass` 또는 `fail`이면 동일한 출처 정보가 필요합니다.
통과한 저장소 검사는 명시적인 최신성 구간 내에 있어야 하며
미커밋 변경이 있는 작업 트리를 증명할 수 없습니다.
통과한 실제 환경 검증은 정확한 배포 후보, 스냅샷, 평가된 발견 사항,
`connectorRefs`의 고유한 지원 커넥터 ID 1~20개도 식별해야 합니다.
정확히 참조된 해당 커넥터만 동일한 명시적 유형의 참조에 대해 준비 완료여야 하며,
시간 순서는 정확히
`deployment.observedAt < connector.observedAt <= validation.observedAt`이어야 합니다.
참조되지 않은 커넥터 증거는 관련 없는 검증에 영향을 주지 않고 자체 준비 상태를 유지합니다.
OneRAI 분류와 `syntheticOnly`는 정확히 일치해야 합니다.
`synthetic`에는 `true`, `live` 또는 `tested`에는 `false`,
`planned` 또는 `blocked`에는 `null`이 필요합니다.
출처가 누락되거나 오래되었거나 알 수 없는 경우 통과로 바뀌지 않습니다.

커넥터 준비 상태는 별도로 `ready`, `degraded`, `unavailable`, `disabled`,
`authorization-required`, `insufficient-data`, `unknown`, `blocked` 또는 `planned`로 유형화합니다.
커넥터 ID는 `foundry:primary` 같은 콜론 포함 ID를 비롯해
커넥터 상태 식별자 구문을 유지하며 다른 ID로 정규화하지 않습니다.
`ready`는 실제 출처 정보가 완전한 최신 실제 증거에만 유효합니다.
배포, 스냅샷, 발견 사항 참조는 통과한 실제 환경 검증이 `connectorRefs`에서
해당 커넥터를 선택한 경우에만 필요합니다.
`otel:<source>`처럼 참조되지 않은 준비 완료 커넥터는 해당 참조를 null 또는 빈 값으로 둘 수 있습니다.
버전 1은 최신성 구간을 24시간으로 고정하며 이를 `release.freshnessWindowHours`에 명시적으로 기록합니다.
`fresh`와 `stale`은 `release.generatedAt`을 기준으로 계산하며,
관측이 없으면 반드시 `unknown`을 유지해야 합니다.
통과한 OneRAI 증거도 동일한 24시간 구간을 넘으면 거부합니다.

<a id="manifest-contents"></a>

## 매니페스트 내용

버전 1은 다음을 포함합니다.

- 전체 Git 커밋 SHA, 작업 트리의 미커밋 변경 상태, 생성 타임스탬프, 명시적인 최신성 구간
- 예상 web/API/jobs 전체 SHA 이미지 태그 및 선택적 SHA-256 다이제스트
- 배포된 web/API/jobs 전체 SHA 이미지 태그, 실제 배포 증거에 필수인 다이제스트,
  불투명하고 유형이 지정된 배포 참조
- 허용 목록의 정규 구성에 대한 SHA-256. 키 이름만 보존
- 린트, 타입 검사, 단위 테스트, 빌드, E2E, Bicep 결과
- 명시적 유형의 배포, 스냅샷, 발견 사항, 지원 커넥터 참조를 포함한 범위가 제한된 실제 환경 검증 요약
- 전체 커넥터 준비 상태 및 최신성. 선택된 지원 커넥터는 검증의 명시적 유형 릴리스 참조에 연결
- 합성 및 사람의 검토 상태를 포함한 범위가 제한된 OneRAI 요약

실제 레코드는 민감 정보를 제거한 불투명 `estateRef`, `tenantRef`,
`environmentRef`, `sourceRef` 값과 제한된 증거 참조를 보존합니다.
이는 상관관계 연결용 식별자이며 원시 공급자 페이로드나 비공개 클라우드 식별자가 아닙니다.
한 매니페스트의 범위가 지정된 모든 레코드는 동일한 자산 범위, 테넌트, 환경 참조를 사용해야 합니다.
소스 참조는 레코드별로 유지됩니다.

<a id="sanitized-input"></a>

## 민감 정보를 제거한 입력

입력 개체는 엄격하게 처리하며 알 수 없는 속성은 거부합니다.
생성기 사용 편의를 위해 생략된 null 허용 출처 필드, 검사 명령/완료 필드,
증거 참조 배열에는 이 입력 경계에서 `null` 또는 `[]` 기본값을 적용합니다.
생성된 매니페스트와 외부에서 검증하는 매니페스트는 모든 필드를 명시적으로 포함해야 하며,
출력 스키마는 기본값을 적용하지 않습니다.
대표 구조는 다음과 같습니다. 반복된 `a` 값은 생성 중인 체크아웃된 릴리스의 정확한 전체 SHA를 나타냅니다.

```json
{
  "deployedImages": {
    "deploymentRef": "deployment-candidate-a",
    "classification": "live",
    "observedAt": "2026-09-04T00:00:00.000Z",
    "source": "sanitized-deployment-observation",
    "scope": {
      "estateRef": "replacement-estate",
      "tenantRef": "replacement-tenant",
      "environmentRef": "dev",
      "sourceRef": "container-apps"
    },
    "evidenceRefs": ["deployment-observation-2026-09-04"],
    "web": {
      "tag": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    "api": {
      "tag": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    },
    "jobs": {
      "tag": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "digest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    }
  },
  "safeConfiguration": {
    "AUTH_MODE": "disabled",
    "AGENT_SENTINEL_WRITE_ENABLED": false,
    "DATA_MODE": "live"
  },
  "checks": {
    "lint": {
      "classification": "tested",
      "outcome": "pass",
      "command": "pnpm lint",
      "completedAt": "2026-09-04T00:00:00.000Z",
      "summary": "Workspace lint completed."
    }
  },
  "liveValidations": [],
  "connectors": [],
  "oneRai": {
    "classification": "planned",
    "outcome": "not-run",
    "observedAt": null,
    "source": null,
    "scope": null,
    "evidenceRefs": [],
    "syntheticOnly": null,
    "automated": null,
    "cases": null,
    "defects": null,
    "humanReviewRequired": null,
    "summary": "No sanitized OneRAI summary was supplied."
  }
}
```

`expectedImages`에는 배포 출처 필드 없이 동일한 컴포넌트 개체 3개가 있습니다.
모든 태그는 정확한 소문자 40자리 16진수 릴리스 커밋 SHA입니다.
각 예상 컴포넌트에는 선택적으로 정규
`sha256:<64 lowercase hex characters>` 다이제스트를 제공할 수 있습니다.
실제 배포 컴포넌트에는 전체 릴리스 SHA 태그와 다이제스트가 모두 필요합니다.

<a id="safe-configuration-allow-list"></a>

### 안전한 구성 허용 목록

다음 키만 구성 해시에 포함할 수 있습니다.

```text
AGENT365_CONNECTOR_ENABLED
AGENT_SENTINEL_WRITE_ENABLED
AUTH_MODE
AZURE_MONITOR_OTEL_CONNECTOR_ENABLED
AZURE_RESOURCE_GRAPH_CONNECTOR_ENABLED
DATA_MODE
DEFENDER_CLOUD_APPS_CONNECTOR_ENABLED
ENTRA_CONNECTOR_ENABLED
FOUNDRY_CONNECTOR_ENABLED
MANIFEST_CONNECTOR_ENABLED
NODE_ENV
POWER_PLATFORM_CONNECTOR_ENABLED
PURVIEW_CONNECTOR_ENABLED
TEAMS_DISTRIBUTION_CONNECTOR_ENABLED
```

값은 정렬된 키 순서로 정규화하고 SHA-256으로 해싱합니다.
매니페스트는 알고리즘, 해시, 정렬된 키 이름을 보존하지만 값은 보존하지 않습니다.
`tested`로 분류된 구성에는 null이 아닌 해시와 허용 목록의 키 하나 이상이 필요합니다.
`planned`로 분류된 구성에는 null 해시와 빈 키 목록이 필요합니다.

<a id="rejected-content-and-contradictions"></a>

## 거부되는 내용과 모순

비밀, 자격 증명, 권한 부여, 제한 없는 환경, 비공개 페이로드, 프롬프트 또는 출력 관련 필드가
포함된 입력은 스키마 파싱 전에 거부합니다.
Bearer 자격 증명, JWT, GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` 및 `github_pat_` 토큰,
자유 텍스트 자격 증명 할당, 연결 문자열, 자격 증명 URL, 서명된 URL,
개인 키 같은 비밀 형태 문자열도 거부합니다.
오류 메시지는 길이가 제한된 필드 경로만 식별하며 값을 다시 출력하지 않습니다.

검토 번들은 추가로 이메일 주소, UUID 형태의 테넌트/구독 식별자,
`/subscriptions/...` 리소스 경로, `*.onmicrosoft.com` 도메인,
로컬 Unix/Windows 절대 경로와, 이메일·테넌트/구독 ID·원시/공급자/요청/응답 페이로드·
로컬 파일 경로를 나타내는 이름의 필드를 거부합니다.
이후 엄격한 스키마가 허용 목록 밖의 모든 속성을 거부합니다.
접근성 정규화는 도구, 관측 시간, 화면 ID, 제한된 규칙/심각도/WCAG 개수,
불투명 증거 참조만 보존하며 URL과 원시 노드 페이로드는 버립니다.

민감 정보를 제거한 생성기 입력과 완전한 매니페스트 모두 민감한 내용 검사 또는
스키마 검증 전에 중복 키를 거부하며 파싱합니다.
이는 모든 중첩 개체와, 디코딩하면 같은 키가 되는 이스케이프 표기에 독립적으로 적용됩니다.
따라서 뒤의 속성이 앞의 비밀 형태 값을 덮어써 숨길 수 없습니다.

검증기는 다음과 같은 모순도 거부합니다.

- 명령과 완료 타임스탬프가 없는 통과 검사
- 오래된 통과 검사 또는 미커밋 변경이 있는 작업 트리에 연결된 통과 검사
- 관측 시간, 소스, 민감 정보를 제거한 범위, 증거 참조가 없는 실제 증거 또는 평가된 실제 환경 검증 통과/실패
- 명시적 유형의 배포, 스냅샷, 발견 사항 참조가 없는 평가된 실제 환경 검증
- 동등한 출처 정보가 없는 테스트 또는 평가된 OneRAI 증거
- 해시 또는 키 목록과 모순되는 구성 분류
- 매니페스트 증거 간 자산 범위, 테넌트 또는 환경 참조 불일치
- 중복된 실제 환경 검증 ID, 커넥터 ID 또는 증거 참조
- `release.generatedAt`보다 늦은 타임스탬프
- 명시적인 24시간 구간과 모순되는 최신성 값
- 전체 릴리스 커밋 SHA와 같지 않은 예상 또는 배포 태그
- 정규 이미지 다이제스트 3개가 모두 갖춰지지 않은 실제 배포 증거
- 하나의 릴리스를 식별하지 않는 배포 컴포넌트 태그
- 대응하는 이미지 태그가 없는 다이제스트
- 서로 모순되는 예상 및 배포 다이제스트
- 최신 실제 데이터가 아닌데 준비 완료로 표시된 커넥터
- 실제 배포 후보가 없거나, 관측이 배포 시점 또는 그 이전이거나,
  배포 참조가 배포 후보와 일치하지 않는 통과한 실제 환경 검증
- 제한된 지원 `connectorRefs`가 없거나, 커넥터 참조가 매니페스트 커넥터 증거를 식별하지 못하거나,
  참조된 커넥터의 배포·스냅샷·발견 사항 참조가 누락되거나 불일치하거나,
  커넥터의 최신성·분류·준비 상태가 검증과 모순되는 통과한 실제 환경 검증
- 배포 시점 또는 그 이전, 혹은 해당 통과한 실제 환경 검증 이후에 관측된 참조 지원 커넥터 증거
- 통과와 짝지어진 차단 또는 계획 상태의 증거
- 정확히 일치하지 않는 OneRAI 분류와 `syntheticOnly` 값
- 완전한 소스, 관측 시간, 민감 정보를 제거한 범위, 증거 참조 출처가 없는 테스트 또는 평가된 OneRAI 증거
- 최신성 구간 24시간을 지난 통과 OneRAI 증거
- 평가된 사례 수보다 많은 결함 수

스키마 드리프트 검사는 정규 JSON을 파싱하고 비교하므로
속성 순서와 LF/CRLF 차이로 잘못된 드리프트를 보고하지 않으면서도 의미가 바뀌면 실패합니다.

커밋된 [`repository-only.json`](../release-evidence/v1/examples/repository-only.json)
예제에는 의도적으로 실제 환경 통과 또는 배포 주장을 포함하지 않았습니다.

<a id="artifact-handling"></a>

## 산출물 처리

생성된 증거, 실제 증거, 비공개 증거, 로컬 증거는 무시되는 경로 아래에 둡니다.

```text
release-evidence/generated/
release-evidence/live/
release-evidence/private/
release-evidence/**/*.local.json
```

버전 관리형 스키마와 의도적으로 민감 정보를 제거한 예제만 커밋합니다.
원시 검증 행, 프롬프트, 출력, 환경 덤프, 로그, 자격 증명, 토큰, 연결 문자열,
개인 데이터, 테넌트/구독 식별자 또는 비공개 공급자 페이로드는 커밋하지 않습니다.

통합 담당자는 생성기 외부에서 대체 테넌트 관측을 수집하고
이 계약에 맞게 민감 정보를 제거한 후 결과 매니페스트를 검증해야 합니다.
저장소 전용 CI는 도구의 동작을 입증하며 실제 환경 통과를 확립하지는 않습니다.

버전 관리형 v2 템플릿, 접근성 픽스처, 차단 예제는 의도적으로 비공개 정보를 포함하지 않으며
통과 상태가 아닙니다. 생성된 후보 번들은 `release-evidence/generated/` 아래에 두며,
구조 검증을 통과했다는 이유만으로 승인된 것이 아닙니다.
