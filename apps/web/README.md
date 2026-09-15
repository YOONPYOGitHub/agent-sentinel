<a id="agent-sentinel-web"></a>

# Agent Sentinel 웹

웹 콘솔은 자산 집합(estate) 데이터 화면을 마운트하기 전에 `/api/estates`에서
인증된 자산 집합 접근 권한을 불러옵니다. 유효하게 저장된 자산 집합 ID,
유효한 서버 기본값, 첫 번째 허가된 자산 집합 순서로 선택합니다.
브라우저는 `agent-sentinel.estate-id`에 의미를 해석하지 않는 ID만 저장합니다.

자산 집합 범위의 모든 요청은 공통 `apiFetch`를 사용합니다. 호출자 헤더와 기존
전달자 토큰 동작을 유지하면서 `x-agent-sentinel-estate-id`를 삽입합니다.
자산 집합을 전환하면 이전 범위의 요청을 중단하고 자산 집합 의존 상태를 다시 마운트해
드리프트, 경제성, 비즈니스 가치, 거버넌스, 노출, 데모 데이터가 자산 집합 경계를 넘지 못하게 합니다.
기본값이 아닌 자산 집합에 활성화되지 않은 API는 서버 측 차단이 최종 기준입니다.
이러한 차단 때문에 자산 집합 데이터를 불러오지 못하더라도 선택기는 계속 사용할 수 있어
운영자가 활성화된 자산 집합으로 돌아갈 수 있습니다.

자산 집합 탐색은 기존 인증 게이트 이후에 마운트됩니다. 전용 `auth-redirect.html`
MSAL(Microsoft 인증 라이브러리) 브리지는 별도의 Vite 빌드 진입점으로 유지되며
자산 집합 선택은 인증 리디렉션 상태를 대체하거나 영속화하지 않습니다.

<a id="development"></a>

## 개발

현재 두 가지 공식 플러그인을 사용할 수 있습니다.

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react)는 [Oxc](https://oxc.rs)를 사용합니다.
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc)는 [SWC](https://swc.rs/)를 사용합니다.

## React Compiler

React Compiler는 개발·빌드 성능에 영향을 주므로 이 템플릿에서 활성화하지 않았습니다. 추가하려면 [설치 문서](https://react.dev/learn/react-compiler/installation)를 참고하십시오.

<a id="expanding-the-eslint-configuration"></a>

## ESLint 설정 확장

프로덕션 애플리케이션을 개발한다면 타입을 인식하는 린트 규칙을 활성화하도록 설정을 갱신하는 것이 좋습니다.

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // 기타 설정...

      // tseslint.configs.recommended를 제거하고 다음으로 대체
      tseslint.configs.recommendedTypeChecked,
      // 더 엄격한 규칙이 필요하면 다음을 대신 사용
      tseslint.configs.strictTypeChecked,
      // 스타일 규칙이 필요하면 다음을 선택적으로 추가
      tseslint.configs.stylisticTypeChecked,

      // 기타 설정...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // 기타 옵션...
    },
  },
])
```

React 전용 린트 규칙을 사용하려면 [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x)와 [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom)을 설치할 수도 있습니다.

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // 기타 설정...
      // React 린트 규칙 활성화
      reactX.configs['recommended-typescript'],
      // React DOM 린트 규칙 활성화
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // 기타 옵션...
    },
  },
])
```
