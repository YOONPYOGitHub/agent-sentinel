<a id="agent-sentinel-documentation"></a>
# Agent Sentinel 문서

Agent Sentinel 제어 계층의 문서 색인입니다. `feature/production-readiness-r1`을 기준으로
**2026-09-14**에 마지막으로 검토했습니다.

제품의 가치와 실제 서비스·모의 환경의 경계는 [루트 README](../README.md)부터 읽으십시오. [유지관리자 인수인계](maintainer-handoff.md)는 운영 작업을 이어 가기 위한 단일 지침입니다.

<a id="recommended-reading-paths"></a>
## 권장 읽기 순서

- **평가자:** [루트 README](../README.md) → [제품 개요](product-overview.md) → [현재 상태](current-status.md) → [커넥터 가용성](connector-availability.md) → [릴리스 증거](release-evidence.md).
- **유지관리자 또는 코딩 에이전트:** [유지관리자 인수인계](maintainer-handoff.md) → [새 테넌트 초기 구성](new-tenant-bootstrap.md) → [도메인 맥락](CONTEXT.md) → [아키텍처](architecture.md) → [데이터 모델](data-model.md) → [개발](development.md) → [알려진 문제](known-issues.md).
- **운영자:** [현재 상태](current-status.md) → [새 테넌트 초기 구성](new-tenant-bootstrap.md) → [배포](deployment.md) → [운영 절차서](runbooks.md) → [보안 및 인증](security-authentication.md) → [공급망](supply-chain.md) → [재해 복구 설계](dr-design.md).
- **릴리스 검토자:** [유지관리자 인수인계](maintainer-handoff.md) → [현재 상태](current-status.md) → [릴리스 증거](release-evidence.md) → [커넥터 가용성](connector-availability.md) → [알려진 문제](known-issues.md).

<a id="product"></a>
## 제품

| 문서 | 필요한 정보 |
| --- | --- |
| [제품 개요](product-overview.md) | 사용자 유형, 작업 흐름, 카탈로그 화면, 제품 경계, 증거의 의미를 이해합니다. |
| [도메인 맥락](CONTEXT.md) | 모든 기능이 따라야 하는 공통 용어와 불변 원칙을 익힙니다. |
| [로드맵](roadmap.md) | 코드 준비도, 활성화 상태, 의존성, 완료 기준을 확인합니다. |
| [제품 명세](../agent-sentinel-product-spec.md) | 장기적으로 유지되는 제품 요구 사항과 범위를 검토합니다. |

<a id="engineering"></a>
## 엔지니어링

| 문서 | 필요한 정보 |
| --- | --- |
| [유지관리자 인수인계](maintainer-handoff.md) | 현재 저장소와 배포의 사실을 바탕으로 안전하게 작업을 이어 갑니다. |
| [아키텍처](architecture.md) | 런타임 토폴로지, 경계, 패키지 구성을 이해합니다. |
| [데이터 모델](data-model.md) | 도메인 계약, 저장 모델, 인덱스, 메시징 엔터티를 조회합니다. |
| [개발](development.md) | WSL을 설정하고 검사를 실행하며 저장소 규칙을 따릅니다. |
| [외부 런타임 계측](external-runtime-instrumentation.md) | Azure Monitor 커넥터가 수용하는 개인정보 보호형 호출 스팬을 생성합니다. |
| [새 테넌트 초기 구성](new-tenant-bootstrap.md) | 모의 환경 사용, 실제 서비스 읽기 접근, 운영자 접근, 승인, 소유권 이전을 구분합니다. |
| [Foundry 실제 서비스 에이전트](foundry-live-agents.md) | 합성 검증용 에이전트 6개와 운영자 전용 수명주기를 이해합니다. |
| [Foundry 신원 파일럿](foundry-identity-pilot.md) | 신원을 인식하는 격리된 합성 에이전트 하나를 미리 보고 검증하고 롤백합니다. |
| [Agent 365 커넥터](agent365-connector.md) | 배포 전용 패키지 카탈로그 계약과 한계를 검토합니다. |
| [Azure Resource Graph 커넥터](azure-resource-graph-connector.md) | 제한된 클라우드 리소스 인벤토리와 범위의 의미를 검토합니다. |
| [Entra 신원 커넥터](entra-identity-connector.md) | 정확한 식별자 기반 신원 상관 분석과 `RUNS_AS` 규칙을 검토합니다. |
| [Power Platform 커넥터](power-platform-connector.md) | 지원되지 않는 무인 권한 부여의 경계를 검토합니다. |
| [Defender 커넥터](defender-cloud-apps-connector.md) | 범위가 제한되고 개인정보를 최소화한 경고·활동 계약을 검토합니다. |
| [Purview 커넥터](purview-connector.md) | 민감도 레이블 카탈로그와 실제 사용을 관측하지 못하는 한계를 검토합니다. |
| [Teams 커넥터](teams-distribution-connector.md) | 조직 앱 카탈로그와 배포를 관측하지 못하는 한계를 검토합니다. |
| [사내 온보딩](internal-onboarding.md) | 사람이 책임지는 서비스 및 사내 신원 온보딩 절차를 따릅니다. |

<a id="operations-and-status"></a>
## 운영 및 상태

| 문서 | 필요한 정보 |
| --- | --- |
| [현재 상태](current-status.md) | 저장소, 배포, 커넥터, 차단 요인의 사실을 날짜와 함께 기록한 권위 있는 현황을 확인합니다. |
| [커넥터 가용성](connector-availability.md) | 구현, 공급자 접근, 배포, 증거 품질을 구분합니다. |
| [알려진 문제](known-issues.md) | 명시된 제약과 정확한 해소 조건을 확인합니다. |
| [배포](deployment.md) | 승인된 배포 경계와 필요한 부분만 변경하는 배포 경로를 검토합니다. |
| [운영 절차서](runbooks.md) | 명명된 운영 절차(RB-001부터)를 실행합니다. |
| [보안 및 인증](security-authentication.md) | 인증 상태, 역할, 활성 에지 요구 사항, 활성화 게이트를 검토합니다. |
| [공급망](supply-chain.md) | 프라이빗 빌드, 전체 SHA 태그, 다이제스트, 출처 정보를 이해합니다. |
| [릴리스 증거](release-evidence.md) | 민감정보를 제거한 릴리스 증거와 보안·접근성·OneRAI 모의 실행 검토 묶음을 오프라인으로 생성하고 검증합니다. |
| [재해 복구 설계](dr-design.md) | 복구 목표와 장애 조치 동작을 검토합니다. |

<a id="decisions-and-documentation-governance"></a>
## 의사결정 및 문서 거버넌스

| 문서 | 목적 |
| --- | --- |
| [아키텍처 결정 기록 0001](adr/0001-modular-monolith.md) | 모듈형 모놀리스 결정입니다. |
| [아키텍처 결정 기록 0002](adr/0002-evidence-first-deterministic-core.md) | 증거 우선 결정론적 코어 결정입니다. |
| [문서 수명주기](document-lifecycle.md) | 권위, 검토 날짜, 보관 및 삭제 규칙입니다. |

<a id="documentation-conventions"></a>
## 문서 표기 규칙

| 표기 | 의미 |
| --- | --- |
| **현재 구현됨** | 기준 브랜치에 구현되었고 저장소 증거로 뒷받침됩니다. |
| **실제 서비스에서 확인됨** | 날짜가 있고 민감정보를 제거한 증거를 통해 실제 배포 서비스에서 관측되었습니다. |
| **실제 서비스의 선언된 설정** | 실제 공급자 설정이며 관측된 런타임 동작이 아닙니다. |
| **합성** | 목적에 맞게 만든 검증 데이터이며 고객 또는 프로덕션 증거가 아닙니다. |
| **모의 환경 전용** | 저장소 내부의 결정론적 픽스처 또는 공급자입니다. |
| **계획됨** | 설계되었거나 작업 순서가 정해졌으나 구현되지 않았습니다. |
| **차단됨** | 명시된 외부 의존성 때문에 활성화나 검증이 불가능합니다. |

기여자 규칙:

- 저장소 명령이나 민감정보를 제거한 관측으로 재현할 수 없는 지표는 문서화하지 않습니다.
- 비밀정보, 자격 증명, 토큰, 개인 이메일 주소, 테넌트·구독 식별자, 사용자별 절대 경로를 포함하지 않습니다.
- 증거가 없으면 신뢰도가 낮아지며, 안전하다는 뜻이 되지는 않습니다.
- 별도 상태 문서나 인수인계 파일을 추가하기보다 기존 권위 있는 문서를 갱신합니다.
