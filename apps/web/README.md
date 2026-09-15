<a id="agent-sentinel-web"></a>

# Agent Sentinel Web

React + Fluent UI + Vite 기반 운영 콘솔입니다. 실제 배포와 미배포 코드는
[현재 상태](../../docs/current-status.md)로 구분합니다. UI가 있다는 사실만으로
로그인·개인 사용 권한·runtime telemetry가 활성화됐다고 주장하지 않습니다.

웹 콘솔은 `/api/estates`에서 현재 인증 모드에 따라 서버가 허용한 estate를 불러옵니다.
유효하게 저장된 estate ID, 서버 기본값, 첫 번째 허용된 estate 순서로 선택합니다.
브라우저에는 `agent-sentinel.estate-id`만 저장합니다.
공통 `apiFetch`가 `x-agent-sentinel-estate-id`를 보내며, estate 전환 시 이전 요청을
중단하고 관련 상태를 다시 마운트합니다. 서버 측 estate·권한 검사가 최종 경계입니다.

<a id="development"></a>

## 개발

저장소 루트에서 Node `22.23.2`, pnpm `10.15.1`을 사용합니다. 신규 clone은
`pnpm install --frozen-lockfile`이 필요하며 이미 채워진 pnpm store가 있을 때만
`--offline`을 추가합니다.

```bash
pnpm install --frozen-lockfile
pnpm build
```

API와 Web은 각각 별도 터미널에서 실행합니다. 다음 설정은 Azure 접근 없는 로컬
mock 전용이며 배포 설정에 복사하지 않습니다.

```bash
AGENT_SENTINEL_DATA_MODE=mock AGENT_SENTINEL_CONNECTOR=mock AUTH_MODE=disabled pnpm --filter @agent-sentinel/api dev
```

```bash
pnpm --filter @agent-sentinel/web dev
```

- Web: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:3001`
- `vite.config.ts`가 `/api`를 로컬 API로 프록시합니다. 실제 공급자용 환경변수를 혼합하지 않습니다.
- 현재 구성은 `@vitejs/plugin-react`를 사용합니다. 새로운 SWC·ESLint 플러그인 설치는 요구하지 않습니다.

## 화면과 데이터 경계

| 경로                                 | 용도와 현재 제약                                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/agent-inventory`, `/agent-catalog` | 서버가 허용한 estate의 조직 스냅샷입니다. package 레코드는 개인 사용 권한·실행 증거가 아닙니다.                                                                                    |
| `/my-agents`                         | 별도 API `/api/employee/agent-catalog`를 사용하며 조직 inventory로 대체하지 않습니다. 인증 미구성 시 Catalog로 이동합니다. 실제 resolver가 없으면 로그인 후에도 unavailable입니다. |
| `/exposure`, `/lifecycle`            | 선언 기반 발견 사항과 현재 버전 증거입니다. 실제 공격·remediation 실행·릴리스 승인으로 해석하지 않습니다.                                                                          |
| `/release-readiness`                 | Lifecycle에서 진입하는 운영 증거 화면입니다. `/demo-readiness`는 호환 redirect입니다.                                                                                              |
| `/auth-redirect.html`                | MSAL 전용 Vite 진입점이며 일반 앱 화면·estate 선택과 분리됩니다.                                                                                                                   |

snapshot·connector 오류는 loading/error/insufficient 상태로 표시하며 실제 데이터
실패를 mock 성공으로 대체하지 않습니다.

## 검증과 빌드

루트에서 순차 실행합니다. 의존 패키지 `dist`가 없는 checkout은 먼저 `pnpm build`를
완료합니다.

```bash
pnpm --filter @agent-sentinel/web lint
pnpm --filter @agent-sentinel/web typecheck
pnpm --filter @agent-sentinel/web test
pnpm --filter @agent-sentinel/web build
pnpm test:e2e
```

`playwright.config.ts`는 로컬 포트 3001·5173을 사용합니다. 기존 서버가 있으면 어느
모드인지 확인하고 다른 사용자의 프로세스를 종료하거나 테스트를 배포 URL로 돌리지
않습니다. E2E·컴포넌트 통과는 사람의 Accessibility 승인과 다릅니다.
최신 전체 후보의 Web timeout 이력은 [검증 원장](../../docs/current-status.md#validation-baseline)에 남깁니다.

<a id="react-compiler"></a>

## React Compiler

현재 `vite.config.ts`에는 React Compiler 설정이 없습니다. 동결 후보의 실행에
필요하지 않으며 도입 여부는 별도 성능·호환성 검토 사항입니다.

<a id="expanding-the-eslint-configuration"></a>

## ESLint 설정 확장

루트 [`eslint.config.mjs`](../../eslint.config.mjs)의 `recommendedTypeChecked`와
`projectService`가 이미 적용됩니다. Web과 공통 UI에는 `react-hooks` 및
`react-refresh` 규칙도 적용됩니다. 이 파일을 기준으로 변경하며 일반 Vite
템플릿의 설정 예제를 새로 추가하거나 실제 설치되지 않은 플러그인을 필요한
의존성으로 안내하지 않습니다.
