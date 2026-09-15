<a id="agent-sentinel-runtime-instrumentation"></a>

# Agent Sentinel 런타임 계측

이 패키지는 Azure Monitor 커넥터가 소비하는, 버전이 지정된 단일
OpenTelemetry 요청 스팬을 생성합니다. 트레이서 공급자, 샘플러, 리소스,
프로세서, 내보내기 도구는 초기화하지 않습니다.

```ts
const result = await instrumentAgentInvocation(
  tracer,
  configuration,
  { agentRunId, correlationId },
  async () => {
    const response = await client.responses.create(request)
    return {
      value: response,
      telemetry: telemetryFromOpenAIResponses(response),
    }
  },
)
```

스트리밍 API에서는 콜백 안에서 공급자의 최종 응답을 기다리세요.
`agent.invoke` 스팬은 해당 콜백이 성공 또는 실패로 완료될 때까지 열린 상태를
유지합니다. `recordTelemetry`는 오류 전에 공급자가 보고한 최종 사용량을
보존할 수 있습니다.

`agentInvocationResourceAttributes(configuration)`으로 런타임의 OTel 리소스를
초기화하세요. `service.name`은 커넥터 소스의 `applicationRoleName`과 같아야
하며, 정확히 소문자로 변환된 Application Insights ARM 리소스 ID도 커넥터
소스와 일치해야 합니다. 완전한 호출 증거가 필요하면 항상 수집하는 샘플러를 사용하세요.

공급자가 측정한 토큰 사용량만 허용합니다. 비용에는 명시적인 공급자 또는 청구
권한 주체와 `USD`가 필요하며, 없는 값은 생략합니다.
API는 프롬프트, 응답, 도구 인수/결과, 헤더, 자격 증명, 이메일, 예외를 기록하거나
임의의 스팬 속성을 지정하는 인터페이스를 제공하지 않습니다.

`telemetryFromOpenAIResponses`는 `usage.input_tokens`, `usage.output_tokens`,
함수 호출 이름만 읽습니다. OpenAI Agents 및 Azure AI Agents 어댑터는
SDK 결과 형식이 버전마다 달라 의도적으로 좁게 정규화된 연동 접점만 허용합니다.
공급자의 최종 사용량과 이미 정제된 도구 이름만 해당 접점에 매핑하세요.
