<a id="development"></a>

# 개발

<a id="canonical-environment"></a>

## 기준 개발 환경

개발은 승인된 브랜치를 체크아웃한 WSL Linux 파일시스템의 저장소 또는 worktree에서 수행합니다.
GitHub를 공동 작업의 기준으로 사용합니다. OneDrive로 동기화되는 복제본에서는
종속성을 설치하거나 개발하지 마세요.

요구사항:

- Node.js 22 이상(`package.json`의 `engines`); 이번 문서 대조 환경은 22.23.2
- pnpm 10.15.1(`packageManager`에 고정)
- 인프라 검증용 Azure CLI 및 Bicep

WSL의 Node/pnpm 경로를 먼저 확인합니다. Windows 실행 파일이나 다른 Node 버전이
PATH에서 먼저 선택되지 않아야 합니다. 의존성이 캐시된 환경에서만 오프라인 설치가 가능합니다.

```bash
node --version
pnpm --version
pnpm install --offline --frozen-lockfile
```

<a id="common-commands"></a>

## 자주 사용하는 명령

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

단일 앱 빌드에도 workspace 의존성의 `dist`가 필요합니다.
깨끗한 체크아웃에서는 `pnpm build`로 의존성 순서를 처리하거나
`pnpm -r --filter @agent-sentinel/web... build`로 web과 그 의존성을 함께 빌드합니다.
이 명령 목록은 실행 지침이며 현재 후보 전체의 통과 기록이 아닙니다.

실제 Foundry 검증은 명시적으로 의도한 경우에만 실행합니다.

```bash
pnpm foundry:validate
```

이 검증은 합성 Azure 리소스를 사용하며 CI에는 절대 포함되지 않습니다.

<a id="custom-manifest-adapter"></a>

## 사용자 지정 매니페스트 어댑터

`connectors/manifest` (`@agent-sentinel/manifest-connector`)는
운영자가 제공한 매니페스트를 `EstateSnapshot`으로 변환합니다. 엔벌로프 계약 자체는
`packages/connector-sdk/src/manifest.ts`에 두어 SDK가 단일 기준으로 유지되도록 합니다.
커넥터는 스키마를 중복 정의하지 않고 다시 내보냅니다.

```bash
pnpm --filter @agent-sentinel/manifest-connector test
pnpm manifest:validate -- /absolute/path/to/manifest.json \
  --tenant contoso-ai-lab \
  --environment production
pnpm manifest:scan /absolute/path/to/manifest.json \
  --tenant contoso-ai-lab \
  --environment production
```

검증기 CLI(`tools/validate-manifest.ts`)는 오프라인으로 동작합니다.
예상 테넌트 바인딩이 필수이며, 환경 바인딩은 선택적으로 검증합니다.
커넥터와 동일한 엄격한 검증을 수행하고, 정규화된 엔터티 수와
수집의 멱등성에 사용하는 결정적 SHA-256 매니페스트 해시를 출력합니다.
구체적인 예제는 `connectors/manifest/examples/sample-manifest.json`에 있습니다.

스캐너 CLI도 오프라인으로 동작합니다. 동일한 엄격한 수락 및 정규화 경로를 거친 후,
런타임 검색 이후에 사용하는 것과 동일한 결정적 정책 엔진 진입점을 사용합니다.
CI를 위해 기본 출력은 JSON입니다. 작성자용 설명은 `--format text`를,
더 엄격한 통과 기준은 `--fail-on warn`을 추가합니다. 종료 코드는
`0` 수락, `1` 정책 통과 기준 실패, `2` 잘못된 입력, `3` 예상치 못한 실패입니다.

매니페스트 증거에는 `sourceConnectorId`, `sourceTenantId`, `sourceObjectId`,
`sourceEnvironment`를 가진 선택적 `sourceBinding`을 포함할 수 있습니다.
실제 데이터 읽기 모델은 권위 있는 에이전트 또는 도구와 네 필드가 모두 정확히 일치하는 경우만 사용하며,
매니페스트의 `subjectId`는 공급자의 `sourceObjectId`와 같아야 합니다.
노드를 병합하거나 관계를 추론하지 않습니다.
`runtime_observed` 증거의 주장은 합성이 아닌 Azure Monitor 증거로만 검증합니다.
누락, 모호함, 사용 불가, 쿼리는 성공했지만 관측되지 않음 상태를 명시적으로 유지합니다.
관측이 없다는 사실을 모순으로 보고하지 않습니다. 런타임 검증은 환경별 최신 매니페스트 소스
500개로 제한합니다. 이 한도를 넘으면 저장소 장애인 것처럼 처리하지 않고
`source-limit-exceeded`를 보고합니다. 선언된 구성의 대조 결과는
권위 있는 개체의 정확한 일치와 인용된 증거만 보고합니다.
자유 형식 매니페스트 주장을 비교하거나 보증하지 않습니다.

엔벌로프를 변경할 때:

- `manifest.ts`, `connectors/manifest/schemas/manifest.schema.json`, 예제를
  함께 업데이트합니다. 테스트는 주요 제약조건에 대해 Zod 스키마와
  수동으로 관리하는 JSON Schema의 일치 여부를 검증합니다.
- 호환성을 깨는 변경에는 `MANIFEST_SCHEMA_VERSION`을 올리고
  `SUPPORTED_MANIFEST_VERSIONS`를 확장합니다. 지원하지 않는 버전은 강제 변환하지 말고 반드시 거부해야 합니다.
- 어댑터를 읽기 전용으로 유지합니다. `ManifestConnector`에는 의도적으로
  `execute()`가 없으며, `execute` 작업 깊이는 로드 시 거부됩니다.

<a id="azure-monitor-opentelemetry-runtime-connector"></a>

## Azure Monitor OpenTelemetry 런타임 커넥터

`@agent-sentinel/azure-monitor-otel-connector`는 쿼리 전용입니다.
고정된 Azure Monitor Logs 엔드포인트와 `AppRequests` 테이블에 범위가 제한된 쿼리와
제한된 후속 페이지 요청을 보내고, 반환된 행을 기준 및 관측 `ObservationWindow` 개체에 엄격하게 매핑합니다.
리소스를 만들거나, 원격 분석을 수집하거나, 로컬 데이터로 대체하지 않습니다.

실제 데이터 활성화에는 `AGENT_SENTINEL_DATA_MODE=live`와 검증된 소스 하나 이상이 필요합니다.
`AZURE_MONITOR_SOURCES_JSON`으로 소스를 구성하거나 다음 레거시 단일 소스 변수를 사용합니다.

- `AZURE_MONITOR_WORKSPACE_ID`
- `AZURE_MONITOR_PROVIDER_RESOURCE_ID`(정확한 Application Insights ARM 리소스 ID)
- `AZURE_MONITOR_APPLICATION_ROLE_NAME`(외부 런타임의 정확한 `service.name`)
- `AZURE_MONITOR_TENANT_ID`(권위 있는 소스 테넌트 바인딩)
- `AZURE_MONITOR_ENVIRONMENT`
- `FOUNDRY_PROJECT_ENDPOINT`(마지막 경로 세그먼트가 정확한 소스 프로젝트 ID를 제공함)

각 `AZURE_MONITOR_SOURCES_JSON` 항목에는 `id`, `name`, `workspaceId`,
`providerResourceId`, `applicationRoleName`, `tenantId`, `environment`와
권위 있는 Foundry 메타데이터에 일치하는 `sourceProjectId`가 필요합니다.
`requestName`은 생략하면 `agent.invoke`이며 다른 값은 허용하지 않습니다.
Foundry 구성은 앞뒤 공백을 제거한 최대 200자 프로젝트 ID 스키마를
커넥터 소스 API/도메인 엔드포인트 입력, 레거시 환경 입력, JSON 포트폴리오 파싱,
커넥터 생성에 동일하게 적용합니다. 엔드포인트의 마지막 세그먼트가 너무 길면
영구 저장, 자격 증명 처리 또는 공급자 요청을 시작하기 전에 거부합니다.

런타임은 Azure Monitor 커넥터 활성화 여부를 나타내는 별도 환경 변수를 읽지 않습니다.
`azureMonitorConnectorEnabled` Bicep 매개변수는 배포 구성의 주입 여부를 제어하며,
런타임 활성화 여부는 데이터 모드와 검증된 소스 구성에서 결정됩니다.

배포 소스 투영은 런타임과 동일한 활성화 판정을 사용합니다.
실제 데이터 모드에서는 검증된 JSON 소스 또는 완전한 레거시 튜플을 투영하고,
모의 모드에서는 Azure Monitor 구성을 파싱하거나 투영하지 않습니다.
투영된 레코드는 읽기 전용 및 `not-tested` 상태를 유지하며, 투영은 준비 완료의 증거가 아닙니다.
실제 데이터 모드에서 위 `AZURE_MONITOR_*` 필수 필드 5개 중 하나라도 구성하면
5개 모두와 별도의 `FOUNDRY_PROJECT_ENDPOINT`가 필요합니다.
불완전한 튜플은 비활성 커넥터가 아니라 구성 오류입니다.
필수 필드 5개를 모두 비워 두면 커넥터는 비활성 상태를 유지합니다.
비어 있지 않은 소스 JSON이 레거시 튜플보다 우선합니다.

선택적 제한값은 `AZURE_MONITOR_BASELINE_WINDOW_HOURS`(기본값 168),
`AZURE_MONITOR_OBSERVED_WINDOW_HOURS`(기본값 24),
`AZURE_MONITOR_MAXIMUM_FRESHNESS_HOURS`(기본값 168),
`AZURE_MONITOR_REQUEST_TIMEOUT_MS`(기본값 15000),
`AZURE_MONITOR_MAX_RESPONSE_BYTES`(기본값 4194304)입니다. 기본 인증은
`DefaultAzureCredential`이며 JSON 소스는 명시적 managed identity 또는 승인된
`federated-app` 자격 증명도 지원합니다. 대상 workspace에는 Azure Monitor Logs 쿼리 data action
(`Microsoft.OperationalInsights/workspaces/query/read`, 일반적으로 Log Analytics Reader를 통해 부여)만
허용합니다. 공유 키는 허용하지 않습니다.
시간 구간과 관측의 최신성은 신뢰할 수 있는 공급자의 `queriedAt` 타임스탬프와
`maximumFreshnessHours`를 기준으로 다시 계산합니다. 커넥터가 제공하는
`available` 상태나 오래된 데이터에 대한 주의사항은 권위 있는 기준이 아닙니다.
최신성 최대값이 없으면 품질을 미검증으로 낮추며, 구성된 최대값을 벗어난 타임스탬프는
오래된 상태를 유지합니다. 따라서 종료 시점이 168시간 최신성 한도 이내인
기본 168시간 기준 구간은 유효합니다.

행동 및 토큰 경제성 라우트는 런타임 커넥터를 호출하기 전에 스냅샷 해석기가
정확하고 권위 있는 원격 분석 요청을 반환하도록 요구합니다.
적격성 검사는 해석되지 않았거나 권위 수준이 혼합된 인용,
`isNonAuthoritative=true`, 합성/테스트 표식, `synthetic_validation` 증거,
정확한 선언 구성의 누락, 자산 범위·소스·환경·공급자 에이전트의 불일치를 거부합니다.
ID 이름, 소유자, 기본 ID, 테넌트 인벤토리, `RUNS_AS` 간선으로 런타임 적격성을 성립시킬 수는 없습니다.

계측된 요청 스팬은 다음 OTel/사용자 지정 속성을 포함하여 `AppRequests`에 도달해야 합니다.

리소스의 `service.name`은 커넥터의 `applicationRoleName`과 같아야 하고,
스팬 이름은 `agent.invoke`, 스팬 종류는 `SERVER`여야 합니다
(큐 소비자에 한해서만 `CONSUMER` 허용).
[외부 런타임 계측](external-runtime-instrumentation.md)을 참조하세요.

| 속성                                    | 매핑                                                           |
| --------------------------------------- | -------------------------------------------------------------- |
| `agent.sentinel.tenant_id`              | 필수 소스 테넌트 바인딩                                        |
| `gen_ai.agent.id`                       | 필수 공급자 에이전트 바인딩                                    |
| `deployment.environment.name`           | 필수 소스 환경 바인딩                                          |
| `agent.sentinel.source_project_id`      | 필수 정확한 소스 프로젝트 바인딩                               |
| `agent.sentinel.contract_version`       | 필수 리터럴 `1`                                                |
| `agent.sentinel.record_type`            | 필수 리터럴 `agent_invocation`                                 |
| `agent.sentinel.source_connector_id`    | 필수 정확한 커넥터 소스 바인딩                                 |
| `agent.sentinel.estate_id`              | 필수 자산 범위 바인딩                                          |
| `agent.sentinel.estate_tenant_id`       | 필수 자산 범위 테넌트 바인딩                                   |
| `agent.sentinel.estate_environment`     | 필수 자산 범위 환경 바인딩                                     |
| `agent.sentinel.source_tenant_id`       | 필수 정확한 소스 테넌트 바인딩                                 |
| `agent.sentinel.source_environment`     | 필수 정확한 소스 환경 바인딩                                   |
| `agent.sentinel.provider_agent_id`      | 필수 정확한 공급자 에이전트 바인딩                             |
| `agent.sentinel.provider_resource_id`   | 필수 정확한 소문자 Application Insights ARM 리소스 ID          |
| `agent.sentinel.provider_invocation_id` | 필수 고유 호출/관측 ID                                         |
| `agent.sentinel.outcome`                | 네이티브 스팬 상태와 일치하는 최종 `success` 또는 `error` 필수 |
| `agent.sentinel.synthetic`              | 명시적 분류 필수. 실제 증거는 `false`여야 함                   |
| `gen_ai.agent.run.id`                   | 선택적 정확한 에이전트 실행 식별자                             |
| `agent.sentinel.run_id`                 | 선택적 대체용 정확한 에이전트 실행 식별자                      |
| `agent.sentinel.correlation_id`         | 선택적 정확한 correlation ID(없으면 operation ID로 대체)       |
| `gen_ai.agent.version`                  | 선택적 포괄 에이전트 버전 맥락. 정확한 실행으로 집계하지 않음  |
| `gen_ai.usage.input_tokens`             | 선택적 공급자 입력 토큰 실측값. 없으면 알 수 없음 상태 유지    |
| `gen_ai.usage.output_tokens`            | 선택적 공급자 출력 토큰 실측값. 없으면 알 수 없음 상태 유지    |
| `agent.sentinel.cost.usd`               | 선택적 권위 있는 USD 비용 실측값. 추정값은 사용하지 않음       |
| `agent.sentinel.tool_call_names`        | 선택적 검증된 도구 이름의 크기가 제한된 JSON 문자열 배열       |
| `error.type`                            | 선택적 민감 정보를 제거한 오류 코드/유형                       |

`pnpm --filter @agent-sentinel/scripts validate-live`는 범위가 제한된 합성 검증 스팬을 내보냅니다.
민감 정보를 제거한 정확한 Foundry 프로젝트 ID가 소스 바인딩을 지원하지만,
`agent.sentinel.synthetic=true`가 권위 있는 분류 기준으로 유지되며,
이 스팬을 실제 런타임 증거로 설명해서는 안 됩니다.

Azure Monitor 행에는 32자리 소문자 16진수 추적 ID, 16자리 소문자 16진수 스팬 ID,
`ItemCount == 1`도 포함되어야 합니다. 각 행은 호출, 지연 시간, 오류, 입력 토큰,
출력 토큰, 비용 주장으로 변환한 뒤 오프라인 계약 테스트와 동일한 대표성 정규화기를 거칩니다.
누락되거나 샘플링되었거나 오래되었거나 합성이거나 충돌하거나 불일치하는 주장은
`unknown`, `insufficient-data` 또는 품질 저하 상태로 유지됩니다.
커넥터는 이를 `AppMetrics`, 픽스처 또는 추정값으로 대체하지 않습니다.

크기가 제한된 전체 응답은 기준/관측 구간으로 나누기 전에 관측 ID별로 정규화합니다.
하나의 관측 ID가 구간 사이에서 서로 충돌하는 내용으로 재사용되면
충돌하는 모든 행을 제거하고 영향을 받은 각 구간의 품질을
`conflicting-duplicate`로 낮춥니다.

Jobs와 실제 데이터 읽기 모델은 검증된 원격 분석 시간 구간을 이미 검색된 에이전트 노드에 매핑합니다.
두 경로 모두 투영 전에 반환된 자산 범위, 스냅샷, 테넌트, 환경, 소스 프로젝트,
workspace, 공급자 에이전트 및 중첩 관측의 출처를 정확한 요청과 대조하여 검증합니다.
Jobs는 검증된 투영만 영구 저장하고, 선택적 런타임 증거가 거부되면 권위 있는 검색 스냅샷을 유지합니다.
API는 수명이 짧은 요청 투영 전에 동일한 검증을 수행합니다.
도구 호출 이름이 기존 나가는 도구 관계 하나와 정확히 일치할 때만 도구 및 `CAN_CALL` 간선 증거를 추가합니다.
일치하지 않거나 모호한 이름은 커버리지 공백으로 보고하며 그래프 개체를 생성하지 않습니다.
합성 검증 스팬은 별도 유형으로 분류하며 행동 기준 및 토큰 경제성 분석에서 제외합니다.
Token Economics는 측정된 관측 중 에이전트 실행 또는 상관관계 식별자가 있는 비율을
런타임 상관관계 ID 가용성으로 보고합니다. 이는 연결 가능성을 나타내며,
결과가 실제로 조인되었다는 증거가 아닙니다.
에이전트 버전 맥락은 보존하지만 하나의 버전이 관련 없는 여러 실행과 결과에 걸칠 수 있으므로
정확한 실행 식별로 집계하지 않습니다.

어느 경로든 원격 분석을 쿼리하기 전에, 검색된 에이전트와 인용된 선언 구성 증거 레코드 하나가
모두 권위 있는 자료여야 하며 스냅샷의 자산 범위, 커넥터 소스, 소스 테넌트, 소스 프로젝트,
소스 환경 및 공급자 에이전트 ID와 정확히 일치해야 합니다.
이름, 소유자, 기본 ID, 테넌트 인벤토리 소속, 비권위적 매니페스트 메타데이터로
런타임 적격성이나 `RUNS_AS` 관계를 성립시킬 수는 없습니다.

영구 저장된 런타임 호출 증거는 길이가 제한된 에이전트 실행 ID, 상관관계 ID, 에이전트 버전과,
선언된 도구 간선 하나에 정확히 일치한 도구 호출 이름의 원래 순서를 유지합니다.
이 필드들은 불변 증거 충돌 검사에 사용되며 `/api/demo/state`를 통해 변경 없이 반환됩니다.

저장소에 포함된 Azure Monitor 응답 픽스처는 로컬 전용이며 계약 테스트로 검증합니다.

```bash
pnpm --filter @agent-sentinel/azure-monitor-otel-connector test
```

SDK 의존 경로는 API/jobs → `@agent-sentinel/azure-monitor-otel-connector` →
`@agent-sentinel/runtime-instrumentation`입니다. 커넥터는 SDK의 호출 계약 상수를 가져옵니다.
현재 API/jobs Containerfile은 SDK를 의존성보다 먼저 빌드하고 런타임 이미지에
`dist`, `package.json`, `contract`를 복사합니다. 이 패키징 변경은 `7c1336bc` 배포 이후의 저장소 변경입니다.

API/jobs의 `telemetry.ts`는 `APPLICATIONINSIGHTS_CONNECTION_STRING`이 있을 때
Azure Monitor exporter를 초기화할 뿐, 검색된 Foundry 에이전트를 호출하거나
`agent.invoke` 증거를 자동 생성하지 않습니다. API의 선택적 Azure OpenAI 자문 모델 호출도
검색된 에이전트의 실행 증거와 다릅니다. 외부 실행 애플리케이션의 명시적 SDK 채택과
정확한 호출 바인딩이 별도로 필요합니다. 2026-09-15 기준 적격 에이전트 0,
쿼리 대상 0, 실제 런타임 증거 0이며, SDK 존재·이미지 빌드·일반 HTTP 로그는 이를 대체하지 않습니다.

<a id="shared-ui-and-storybook"></a>

## 공통 UI와 Storybook

`@agent-sentinel/ui`는 디자인 토큰과 재사용 가능한 운영 기본 요소를 관리합니다.
독립적인 컴포넌트 작업에는 Storybook을 시작합니다.

```bash
pnpm storybook
```

정적 카탈로그를 빌드하고 컴포넌트 계약 테스트를 실행합니다.

```bash
pnpm storybook:build
pnpm --filter @agent-sentinel/ui test
```

Storybook은 스토리에 프로덕션 Fluent 어두운 테마를 적용합니다.
접근성 애드온은 `error` 모드로 실행되어 위반이 있으면 지원되는 Storybook 테스트 흐름이 실패합니다.
스토리는 합성 운영 상태만 사용하며 API를 호출하지 않습니다.

구성이 없거나, 자격 증명이 실패하거나, 공급자가 쿼리를 거부하거나,
어떤 행이든 테넌트/에이전트/환경/시간 바인딩을 위반하면 API는
명시적 유형의 알 수 없음 상태를 반환합니다. 실제 데이터 모드에서는 모의 픽스처를 읽지 않습니다.

<a id="contribution-practice"></a>

## 기여 원칙

- 기능 브랜치에서 작업합니다.
- 결정적 정책과 그래프 동작을 모델 접근과 독립적으로 유지합니다.
- 동작 변경에는 테스트를 추가합니다.
- 실제, 합성, 모의, 계획됨, 알 수 없음의 경계를 명시적으로 유지합니다.
- 실제 커넥터가 실패했을 때 모의 성공으로 대체하지 않습니다.
- 전체 커밋 빌드 태그와 검증된 다이제스트 기반 배포 참조를 사용합니다.

2026-09-15 기준 `rg-agent-sentinel-m098047`에는 VM이 없으며 프라이빗 CI runner는 미프로비전입니다.
VM 시작만으로 해결할 수 없습니다. IaC의 runner managed identity 권한은 ACR 범위의
`AcrPush`이며, 프로비전·등록·what-if·배포에는 각각 별도 승인이 필요합니다.
승인된 일회성 로컬 이미지 빌드와 이 CI 경로를 구분합니다.
[공급망 정책](supply-chain.md#private-build-path)을 참조하세요.
