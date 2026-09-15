<a id="agent-sentinel-development-instructions"></a>

# Agent Sentinel 개발 지침

운영 사실은 `456d01f2`에서 **2026-09-14**에 마지막으로 대조·정리했습니다.

변경 전에 `agent-sentinel-product-spec.md`, `docs/maintainer-handoff.md`,
`docs/current-status.md`를 읽으십시오.

<a id="working-branch"></a>

## 작업 브랜치

- 활성 통합 브랜치는 `feature/production-readiness-r1`입니다.
- `main`은 통합 브랜치보다 뒤처져 있습니다. 작업에서 `main`의 동기화 완료를 명시하지
  않았다면 `main`을 기준으로 구현하지 않습니다.
- 각 작업은 주제가 명확한 브랜치와 풀 리퀘스트로 유지합니다. 서로 무관한
  작업 묶음을 합치지 않습니다.

<a id="product-invariants"></a>

## 제품 불변 원칙

- 핵심 순환 흐름은 커넥터 구성, 권위 있는 에이전트 발견, 계층 간 증거 상관 분석,
  결정론적 분석 계산, 증거 기반 발견 사항의 거버넌스입니다.
- 실제 서비스 준비도에는 실제 공급자 응답이 필요합니다. 모의·합성 데이터로 실제
  서비스 통과를 입증해서는 안 됩니다.
- 합성 안전성 탐침은 합성임을 명시한 경우에만 허용되며 파괴적 도구를 호출하거나
  실제 비밀정보를 포함해서는 안 됩니다.
- 누락·희소·미승인·오래된·미귀속 증거는 `unknown`, `insufficient-data`,
  `authorization-required`, `degraded`로 남습니다. 정상 상태로 바꾸지 않습니다.
- 모든 경계에서 테넌트, 자산 집합(estate), 환경, 원본, 공급자 개체 ID, 관측 기간,
  증거 출처 정보를 보존합니다.
- 정확한 식별자로만 신원과 에이전트를 상관 분석합니다. 표시 이름으로 일치시키지 않습니다.
- 인증되고 승인되며 되돌릴 수 있는 쓰기 게이트가 작업에 명시적으로 포함되지 않는 한
  실제 쓰기는 비활성화 상태로 유지합니다.
- 프라이빗 네트워킹, Azure Container Registry(ACR) 제한, 웹 애플리케이션 방화벽(WAF),
  역할 기반 접근 제어(RBAC), 검증, 페이지 처리 한도, 재시도 한도, 시간 초과 동작을 약화하지 않습니다.

<a id="repository-conventions"></a>

## 저장소 규칙

- Node.js 22와 고정된 `pnpm@10.15.1`을 사용합니다.
- TypeScript pnpm/Turborepo 모노레포입니다.
- Zod 스키마와 기존 저장소, Fastify, React, Cosmos ETag, 감사, 커넥터 구성 결합
  패턴을 재사용합니다.
- 타입 안전성을 유지합니다. `any`, 광범위한 예외 포착, 조용한 대체 동작,
  성공처럼 보이는 기본값을 사용하지 않습니다.
- 동작 변경에 테스트를 추가하고 직접 관련된 문서를 갱신합니다.
- 생성된 실제 서비스 증거, 자격 증명, 토큰, 비공개 데이터를 커밋하지 않습니다.
- Azure, Microsoft 365, Entra, OneRAI, DARSy 등 외부 시스템을 변경하지 않습니다.
  클라우드 작업과 실제 데이터 검증은 검토 후 통합 담당자가 수행합니다.

<a id="validation"></a>

## 검증

반복 작업 중에는 범위가 좁은 패키지 검사를 실행하고 완료 전에 다음을 실행합니다.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

웹 작업 흐름이나 라우팅을 변경하면 `pnpm test:e2e`를 실행합니다. 기존 저장소 전체
Prettier 서식 차이는 별도로 추적하므로 작업에서 변경한 파일만 서식을 정리합니다.

구현한 내용, 실행한 테스트, 남은 미확인 사항, 실제 대체 테넌트 검증이
아직 필요한 주장을 정확히 보고합니다.
