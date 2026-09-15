<a id="external-runtime-instrumentation"></a>

# 외부 런타임 계측

재사용 가능한 `@agent-sentinel/runtime-instrumentation` 패키지는 Azure Monitor
OpenTelemetry 커넥터가 소비하는 실제 호출 증거를 위한 지원되는 생성자 계약입니다.
통합은 각 외부 에이전트 런타임에서 이루어져야 합니다.
현재 Agent Sentinel API와 작업은 증거를 읽고 투영합니다.
외부 에이전트를 대신해 요건을 충족하는 `agent.invoke` 호출 스팬을 생성해서는 안 됩니다.

<a id="runtime-contract"></a>

## 런타임 계약

외부 런타임에서 OpenTelemetry를 초기화한 다음 해당 `Tracer`를
`instrumentAgentInvocation`에 전달하세요. 헬퍼는 콜백마다 `agent.invoke`라는
이름의 `SERVER` 스팬을 정확히 하나 관리합니다(큐 소비자는 `CONSUMER`를 명시적으로
선택할 수 있음). 내보내기 도구, 샘플러, 프로세서, 트레이서 공급자의 초기화는
담당하지 않습니다.

공급자 리소스를 다음과 같이 설정하세요.

```ts
resourceFromAttributes(agentInvocationResourceAttributes(configuration))
```

`service.name`은 커넥터 소스의 `applicationRoleName`과 정확히 같아야 합니다.
런타임은 `providerResourceId`가 지정하는 정확한 Application Insights 구성 요소로
내보내야 합니다. 커넥터가 완전한 원시 증거(`ItemCount == 1`)를 보고해야 한다면
항상 수집하는 샘플러를 사용하세요.

콜백이 수명 경계입니다. 스트림에서는 콜백 안에서 종료 이벤트나 최종 응답을 기다리세요.

```ts
await instrumentAgentInvocation(tracer, configuration, input, async () => {
  const stream = await client.responses.stream(request)
  const response = await stream.finalResponse()
  return {
    value: response,
    telemetry: telemetryFromOpenAIResponses(response),
  }
})
```

헬퍼의 UUID를 사용하려면 `providerInvocationId`를 생략하세요.
호출자가 제공하는 값에는 엄격한 한도가 적용되며 커넥터 소스 내에서 고유해야 합니다.

OpenAI Responses 어댑터는 최종 토큰 사용량과 함수 호출 이름만 읽습니다.
OpenAI Agents와 Azure AI Agents는 SDK 결과 형식이 달라 좁게 정규화된 연동
접점을 제공합니다. 공급자가 보고한 최종 토큰 사용량과 검증된 도구 이름만
매핑하세요. 텍스트 길이로 사용량을 산출하거나 비용을 추정하지 마세요.
비용은 공급자나 청구 권한 주체가 USD 금액을 명시적으로 제공할 때만 생성합니다.

스키마는 의도적으로 프롬프트, 응답, 도구 인수/결과, 헤더, 자격 증명,
이메일 주소, 예외 메시지, 임의 속성을 수집할 방법을 제공하지 않습니다.
누락된 사용량과 비용은 누락된 상태로 유지합니다.

<a id="deployment-variables"></a>

## 배포 변수

각 외부 런타임은 자체 비밀 없는 설정을 이 값에 매핑해야 합니다.
이름은 권장 배포 바인딩입니다. 패키지는 타입이 지정된 객체를 받으며
프로세스 환경을 직접 읽지 않습니다.

| 변수                                                   | 필수 값                                            |
| ------------------------------------------------------ | -------------------------------------------------- |
| `AGENT_SENTINEL_APPLICATION_ROLE_NAME`                 | 정확한 커넥터 `applicationRoleName`/`service.name` |
| `AGENT_SENTINEL_PROVIDER_RESOURCE_ID`                  | 정확한 Application Insights ARM 리소스 ID          |
| `AGENT_SENTINEL_ESTATE_ID`                             | 관리 영역 바인딩                                   |
| `AGENT_SENTINEL_ESTATE_TENANT_ID`                      | 관리 영역 테넌트 바인딩                            |
| `AGENT_SENTINEL_ESTATE_ENVIRONMENT`                    | 관리 영역 환경 바인딩                              |
| `AGENT_SENTINEL_SOURCE_CONNECTOR_ID`                   | 정확한 커넥터 소스 ID                              |
| `AGENT_SENTINEL_SOURCE_TENANT_ID`                      | 소스 테넌트와 `agent.sentinel.tenant_id`           |
| `AGENT_SENTINEL_SOURCE_PROJECT_ID`                     | 정확한 소스 프로젝트 ID                            |
| `AGENT_SENTINEL_SOURCE_ENVIRONMENT`                    | 소스/배포 환경                                     |
| `AGENT_SENTINEL_PROVIDER_AGENT_ID`                     | 정확한 공급자 에이전트 ID                          |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` 또는 동등한 값 | 외부 런타임이 관리하는 내보내기 대상               |

커넥터 측의 작업 영역, 소스, 테넌트, 프로젝트, 환경, 공급자 리소스, 역할,
에이전트 바인딩은 이 값과 정확히 일치해야 합니다. 남은 배포 작업은 런타임별로
수행합니다. 패키지 추가, 리소스와 내보내기 도구 설정, 최종 호출 경계 래핑,
배포, 승인된 비합성 트래픽 생성, 샘플링되지 않은 원시 `AppRequests` 검증이 필요합니다.

정식 픽스처와 Draft 2020-12 JSON 스키마는
`@agent-sentinel/runtime-instrumentation/contract/agent-invocation-v1.*`에서 내보냅니다.
