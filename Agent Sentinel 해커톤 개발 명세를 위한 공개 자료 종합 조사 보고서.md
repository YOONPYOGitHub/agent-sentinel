충분한 자료를 수집했습니다. 이제 전체 결과를 종합하여 보고합니다.

---

# Agent Sentinel 해커톤 개발 명세를 위한 공개 자료 종합 조사 보고서

**조사 기준일**: 2026-08-14  
**조사 범위**: Microsoft 공식 Docs, Microsoft Security Blog, ServiceNow, Palo Alto Networks, Wiz 공식 자료 (공개 URL 명시)

---

## 1. 요약 (Executive Summary)

2026년 현재 Microsoft는 **Microsoft Agent 365**(2026-05-01 GA)를 중심으로 AI 에이전트의 인벤토리·거버넌스·보안·모니터링을 통합하는 "제어 평면(Control Plane)"을 완성 단계로 진입시켰다. Entra Agent ID(에이전트 전용 ID 프레임워크), Defender for Cloud Apps(실시간 위협 차단), Purview DSPM(데이터 보안 자세 관리), Azure AI Foundry Control Plane(Azure 네이티브 에이전트 운영)이 레이어를 형성한다. 경쟁사(ServiceNow AI Control Tower, Palo Alto AI Access Security, Wiz AI-SPM)는 각각 CMDB 통합·멀티벤더 지원, 네트워크 레이어 통제, 클라우드 인프라 수준 공격 경로 분석에 특화되어 있다. **Agent Sentinel의 차별화 공간은 명확히 존재한다**: (a) 에이전트 단위 통합 컴플라이언스 점수화, (b) 크로스플랫폼 행동 베이스라인과 드리프트 감지, (c) 자동화된 거버넌스 워크플로(승인 게이트 포함), (d) 에이전트-대-에이전트 신뢰 체인의 보안 시각화가 현재 제품군에서 가장 얕게 다뤄지는 영역이다.

---

## 2. Microsoft 현재 제품군 기능 매핑

### 2-1. Microsoft Agent 365

**공식 출처**: `learn.microsoft.com/en-us/microsoft-agent-365/overview` | `microsoft.com/security/blog/2026/05/01/...`  
**상태**: GA (2026-05-01, Commercial 세그먼트)  
**라이선스**: Microsoft 365 E7 포함; E5/A5/Business Premium에 애드온 가능

**세 가지 핵심 기둥**:

| 기둥 | 세부 기능 | 상태 |
|------|----------|------|
| **Observe (관찰)** | Agent Registry (중앙 인벤토리), Agent Map (시각화), Single Agent Map (Preview), Shadow AI 페이지, 사용량/세션/예외율/Assisted Hours 지표 | GA (Single Agent Map은 Preview) |
| **Govern (거버넌스)** | 에이전트 생명주기 관리(설치/차단/삭제/소유자 재지정), Connected Platforms 동기화(AWS Bedrock·Google Vertex AI·Salesforce Agentforce·Databricks Genie·Anthropic·Oracle), 에이전트 제출·검토·게시 워크플로 | GA; Connected Platforms(Bedrock/Vertex AI)는 Public Preview |
| **Secure (보안)** | Entra 기반 ID 제어, Purview 데이터 보호, Defender 위협 탐지, Global Secure Access 네트워크 제어(Copilot Studio 에이전트·엔드포인트 로컬 에이전트) | GA; 일부 기능 Preview |

**Agent Registry 주요 항목**:
- 에이전트 유형: Microsoft agents, External partner-built, Published by org, Shared by creator
- 필터: Status, Publisher Type, Channel(Copilot/Teams/Outlook/M365 apps/SharePoint), Platform, Data source
- 대시보드: Total agents, Agents at risk, Agents without owners, Unmanaged agents
- CSV/Excel 내보내기 지원

**Agent Map 클러스터** (`learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-map`):
- M365 Copilot Agent Builder, Copilot Studio, Azure AI Foundry, Amazon Bedrock, Google Vertex AI, Microsoft 1st party, External Partners 분류 시각화
- Usage 필터: Active users Top 100, Inactive, Total sessions, Exception rate, Assisted hours
- ⚠️ **제약**: Usage/Observability 필터는 **4,000명 미만 테넌트**에서만 지원됨

**Connected Platforms 지원** (`learn.microsoft.com/en-us/microsoft-agent-365/admin/connected-platforms`):

| 플랫폼 | 인증 방식 | 주요 권한 |
|--------|----------|----------|
| Amazon Bedrock | IAM Access Key/Secret | bedrock:ListAgents, GetAgent + bedrock-agentcore 권한 목록 |
| Google Vertex AI | Service Account JSON | aiplatform.reasoningEngines.list/get/delete |
| Salesforce Agentforce | OAuth2 Client Credentials Flow | chatbot_api, sfap_api, api, refresh_token |
| Databricks Genie | - | - |
| Anthropic Claude Managed Agents | - | - |
| Oracle Generative AI Agents | - | - |

**Shadow AI / 로컬 에이전트 관리**: Defender + Intune을 통해 Windows 디바이스에서 실행 중인 에이전트(OpenClaw, GitHub Copilot CLI, Claude Code 등) 발견·차단. Shadow AI 페이지는 Agent 365 Admin Center에 통합됨.

---

### 2-2. Microsoft Entra Agent ID

**공식 출처**: `learn.microsoft.com/en-us/entra/agent-id/what-is-microsoft-entra-agent-id` | `learn.microsoft.com/en-us/entra/workload-id/workload-identities-overview`  
**상태**: GA (모든 Microsoft Entra 고객 이용 가능)

**핵심 구조**:

```
Agent Identity Blueprint (템플릿, 부모)
    └── Agent Identity (인스턴스, 자식) × N
            └── Agent's User Account (1:1 선택적 페어링, 메일박스·캘린더·Teams 접근)
```

**주요 기능**:

| 기능 | 설명 | 문서 링크 |
|------|------|----------|
| **에이전트 인증** | OAuth 2.0, OIDC, MCP, A2A 프로토콜 지원; 위임 접근(OBO) + 자율 접근(클라이언트 자격증명) | `entra/agent-id/agent-oauth-protocols` |
| **Conditional Access for Agents** | 에이전트에 위치·위험 기반 조건부 접근 정책 적용 | `entra/identity/conditional-access/agent-id` |
| **Identity Protection for Agents** | 유출된 자격증명·비정상 로그인 위험 감지 | `entra/id-protection/concept-risky-agents` |
| **Identity Governance for Agents** | 에이전트 접근 검토, 권한 부여 수명주기 관리 | `entra/id-governance/agent-id-governance-overview` |
| **Network Controls** | Global Secure Access를 통한 네트워크 레벨 제어 | `entra/global-secure-access/concept-secure-web-ai-gateway-agents` |
| **서드파티 에이전트 통합** | AWS Bedrock, n8n 등 – Microsoft Entra ID Auth SDK(sidecar) 또는 Workload Identity Federation 방식 | `entra/agent-id/configure-third-party-agents` |
| **Sign-in/Audit Logs** | Entra 관리 센터에서 에이전트 활동 로그 조회 | `entra/agent-id/sign-in-audit-logs-agents` |

**에이전트 스프롤 문제 대응**: 블루프린트-인스턴스 계층 구조로 대규모 에이전트 집합에 중앙화된 보안 정책 적용. 소유자가 없는 에이전트(orphaned)를 식별하고 고아 자격증명 차단 가능.

---

### 2-3. Microsoft Defender for Cloud Apps / Defender XDR – AI 에이전트 보안

**공식 출처**: `learn.microsoft.com/en-us/defender-cloud-apps/real-time-agent-protection-during-runtime`  
**상태**: 실시간 보호 – Agent 365 GA; Copilot Studio Preview; Foundry Preview

**실시간 보호 작동 방식**:

```
에이전트 루프 중 활동 검사
    ↓
Default Rule (Audit) → BehaviorInfo 테이블에 기록
    ↓
Custom Rule (Block) → 실행 전 차단 + BehaviorInfo 기록
```

**탐지 유형(Detection Types)**:
- Secret exfiltration (비밀 데이터 유출)
- Malicious content propagation (악성 콘텐츠 전파)
- Evasion techniques (회피 기법)
- Unsafe email domain (안전하지 않은 이메일 도메인)

**에이전트 유형별 보호 범위**:

| 에이전트 유형 | 보호 범위 | 의존성 |
|-------------|----------|--------|
| Agent 365 tool invocations | Tool 호출 전 평가 | Work IQ MCP 통합 필요 |
| Copilot Studio agents | Tool 호출 평가 | Copilot Studio 커넥터 설정 필요 (Preview) |
| Foundry agents | 사용자 요청·에이전트 응답·Tool 호출·Tool 응답 | Preview |
| Local AI agents | 엔드포인트 런타임 보호 | Defender for Endpoint 활성 모드 |

**Prompt Evidence Collection**: 프롬프트 스니펫을 알림 증거로 포함(기본 활성화); 민감 데이터 및 비밀은 자동 편집.

**로컬 에이전트 Context Mapping** (2026년 6월 Preview 발표): 디바이스·MCP 서버·ID·클라우드 리소스 관계 맵 제공 → 블래스트 반경 평가.

---

### 2-4. Microsoft Purview – AI 에이전트 데이터 보안 및 컴플라이언스

**공식 출처**: `learn.microsoft.com/en-us/purview/ai-microsoft-purview` | `learn.microsoft.com/en-us/purview/ai-agent-365` | `learn.microsoft.com/en-us/purview/data-security-posture-management-learn-about`  
**상태**: DSPM(신 버전) GA; DSPM for AI (classic)는 신 버전으로 전환 권장

**에이전트별 지원 매트릭스** (`learn.microsoft.com/en-us/purview/ai-agents`):

| AI 앱/에이전트 | 정보 보호 | 컴플라이언스 관리 |
|--------------|---------|----------------|
| Microsoft 365 Copilot agents | ✓ | ✓ |
| Copilot Studio agents | ✓ (데이터분류·감도레이블·DLP·IRM) | ✓ |
| Microsoft Foundry agents | ✓ (데이터분류·감도레이블·DLP·IRM) | ✓ |
| Entra-registered agents | ✓ | ✓ |
| Microsoft Agent 365 | ✓ (DSPM AI observability 포함) | ✓ |
| ChatGPT Enterprise agents | ✓ (데이터분류·IRM만) | ✗ |
| Anthropic Claude Enterprise | ✗ | ✗ |

**Agent 365 전용 기능** (DSPM 신버전):
- **AI observability 페이지**: 활성 에이전트 인스턴스 가시성, 잠재 리스크 파악 및 교정
- **Audit**: 에이전트-대-인간, 인간-대-에이전트, 에이전트-대-도구, **에이전트-대-에이전트** 모든 상호작용 감사
- Agent 365 활동 전용 감사 로그 카테고리 존재

**DSPM 신버전 데이터 보안 목표 기반 워크플로**:
- "M365 Copilot 과공유 방지", "민감 데이터 유출 방지" 등 목표 단위 가이드
- 자동 교정(공유 링크 제거, DLP 정책 적용, 권한 취소)을 AI 에이전트가 수행 → 관리자 승인 후 실행 (모든 작업 감사됨)

---

### 2-5. Copilot Control System (M365 관리 센터 통합 컨트롤)

**공식 출처**: `learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-365-overview` | `learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-actions`  
**참고**: "Copilot Control System"은 마케팅 용어로 M365 관리 센터 내 Copilot/에이전트 관리 기능의 집합을 지칭함.

**M365 관리 센터 에이전트 워크로드 기능**:
- **Overview**: 30일 에이전트 활동 스냅샷, 리스크·거버넌스 갭, 보류 중 승인 요청 처리
- **Registry**: 전체 에이전트 목록, CSV 내보내기
- **Map**: 플랫폼별 클러스터 시각화
- **Connected Platforms**: 외부 플랫폼 연결·동기화 관리
- **Shadow AI**: 비관리 로컬·SaaS 에이전트 발견 (Frontier 프로그램)
- **에이전트 생명주기 액션**: Install, Uninstall, Block/Unblock, Delete, Start/Stop (Foundry 전용), Assign owner, Publish to store, Reject submission

---

### 2-6. Copilot Studio 관리 기능

**공식 출처**: `learn.microsoft.com/en-us/microsoft-copilot-studio/admin-share-bots`  
**위치**: Power Platform 관리 센터 + Copilot Studio 포털

**주요 관리 기능**:
- 에이전트 공유(조직 전체, 보안 그룹, 개인)
- Analytics Viewer 역할 (수정 권한 없이 분석 열람)
- Entra 조건부 인증 설정 (Microsoft Entra ID Provider)
- 서드파티 연결(Databricks Genie 등) 시 서비스 주체·환경 레벨 연결 권장

---

### 2-7. Azure AI Foundry Observability / Evaluation

**공식 출처**: `learn.microsoft.com/en-us/azure/ai-foundry/concepts/evaluation-approach-gen-ai` | `learn.microsoft.com/en-us/azure/ai-foundry/observability/how-to/how-to-monitor-agents-dashboard` | `learn.microsoft.com/en-us/azure/ai-foundry/control-plane/overview`  
**SDK**: `azure-ai-projects>=2.0.0` (Python), Azure.AI.Projects (.NET)

**Agent Monitoring Dashboard 메트릭**:

| 메트릭 | 설명 | 임계값 기준 |
|-------|------|-----------|
| Token usage | 기간 내 토큰 수 | 높으면 프롬프트 최적화 권고 |
| Latency | 에이전트 실행 응답 시간 | >10초 → 조사 권고 |
| Run success rate | 성공 실행 비율 | <95% → 조사 권고 |
| Evaluation metrics | 평가자 점수 | 평가자별 기준 상이 |
| Red teaming results | 예약 레드팀 스캔 결과 | 실패 → 보안 위험 |

**내장 평가자(Built-in Evaluators)**:
- 일반 품질: Coherence, Fluency
- RAG 전용: Groundedness, Relevance
- 안전·보안: Hate/Unfairness, Violence, Protected Materials
- **에이전트 전용**: Tool Call Accuracy, Task Completion
- 커스텀 평가자: 도메인 특화 요구사항에 맞게 구축 가능

**Foundry Control Plane** (`learn.microsoft.com/en-us/azure/ai-foundry/control-plane/overview`):  
상태: **Preview**

| 기능 | 설명 |
|------|------|
| Fleet 인벤토리 | Foundry agents, Azure SRE Agent, Logic Apps agent loops, 커스텀 에이전트 |
| 크로스 프로젝트 가시성 | 구독 내 모든 프로젝트 에이전트 통합 관리 |
| 준수 가드레일 | 엔터프라이즈 전체 안전·컴플라이언스·품질 정책 정의, 대규모 일괄 교정 |
| 보안 통합 | Defender·Purview 알림 Control Plane 대시보드에서 직접 조회 |
| 비용 추적 | 토큰 사용량·비용 이상 감지 |
| 레드팀 에이전트 | 자동 취약점 탐지 |
| 클러스터 분석 | 오류 근본 원인 자동 분석 |

**지원 플랫폼**: Foundry agents, Azure SRE Agent, Azure Logic Apps agent loops, 커스텀 에이전트 (수동 등록 가능)  
**미지원**: Classic agents, Azure OpenAI Assistants

---

### 2-8. Azure Monitor + OpenTelemetry

**공식 출처**: `learn.microsoft.com/en-us/azure/azure-monitor/app/opentelemetry-enable`  
**상태**: Azure Monitor OpenTelemetry Distro GA (.NET, Node.js, Python, Java)

- AI Foundry는 OpenTelemetry 표준 + Azure Monitor Application Insights 통합으로 분산 추적 제공
- 지원 프레임워크: LangChain, LangGraph, OpenAI Agents SDK, Microsoft Agent Framework
- Application Insights 데이터 보존 및 과금은 해당 리소스 설정 따름

---

### 2-9. Azure AI Content Safety

**공식 출처**: `learn.microsoft.com/en-us/azure/ai-services/content-safety/overview`

| 기능 | 상태 |
|------|------|
| Prompt Shields (지일브레이크 감지) | **GA** |
| Protected material text detection | **GA** |
| Analyze text/image APIs (해악 카테고리) | **GA** |
| Task Adherence API (에이전트 도구 사용 이탈 감지) | **GA** |
| Groundedness detection | **Preview** |
| Custom categories (standard/rapid) | **Preview** |

---

## 3. API/SDK/Preview/GA 상태 종합표 (2026-08-14 기준)

| 컴포넌트 | GA/Preview | 비고 |
|---------|-----------|------|
| Microsoft Agent 365 | **GA** (2026-05-01) | Commercial 세그먼트 |
| Entra Agent ID | **GA** | 모든 Entra 고객 |
| Entra Agent Identity Platform SDK (.NET/sidecar) | **GA** | - |
| Agent 365 Registry | **GA** | - |
| Agent Map | **GA** | - |
| Single Agent Map | **Preview** | - |
| Connected Platforms (Bedrock/Vertex AI) | **Public Preview** | 2026-05 발표 |
| Connected Platforms (Salesforce/Databricks/Anthropic/Oracle) | **GA** | 공식 문서 기재 |
| Shadow AI 페이지 + 로컬 에이전트 발견 | **Public Preview** | 2026-06 |
| Windows 365 for Agents | **Public Preview** | 미국 한정 |
| Agent 365 네트워크 제어 (Global Secure Access) | **GA** | 2026-05-01 발표 |
| Defender 실시간 보호 – Agent 365 | **GA** | - |
| Defender 실시간 보호 – Copilot Studio | **Preview** | - |
| Defender 실시간 보호 – Foundry | **Preview** | - |
| Defender 로컬 에이전트 런타임 보호 | **Preview** | 2026-06 |
| Defender 컨텍스트 매핑 (로컬 에이전트) | **Preview** | 2026-06 |
| Purview DSPM (신버전) | **GA** | DSPM for AI classic 대체 |
| Purview AI observability (DSPM Agent 365) | **GA** | - |
| Azure AI Foundry Evaluation SDK | **GA** | azure-ai-projects>=2.0.0 |
| Foundry Control Plane | **Preview** | - |
| Foundry Agent Monitoring Dashboard | **Preview** | - |
| Foundry 연속 평가 | **Preview** | - |
| Foundry 레드팀 스캔 | **Preview** | - |
| Foundry 알림 | **Preview** | - |
| Azure AI Content Safety Prompt Shields | **GA** | - |
| Azure AI Content Safety Task Adherence | **GA** | - |
| Azure AI Content Safety Groundedness | **Preview** | - |
| Azure Monitor OpenTelemetry Distro | **GA** | .NET/Node.js/Python/Java |
| Entra Conditional Access for Agents | **GA** | - |
| Entra Identity Protection for Agents | **GA** | - |

---

## 4. 경쟁·유사 제품 분석

### 4-1. ServiceNow AI Control Tower

**공식 출처**: `servicenow.com/products/ai-control-tower.html`  
**상태**: GA (가격 문의 필요)

**핵심 기능**:
- **자동 발견**: 에이전트, 모델, MCP 서버, 데이터셋을 엔터프라이즈 전체에서 자동 인벤토리 (1st party/3rd party, Shadow AI 포함)
- **CMDB 통합**: AI 자산을 CMDB Configuration Item으로 등록, 비즈니스 서비스와 관계 매핑
- **컴플라이언스 콘텐츠 팩**: NIST AI RMF, EU AI Act, 캘리포니아 AI 투명성법 **기본 제공**
- **AI 가치/ROI 추적**: AI 에이전트별 비용 대비 효과 정량화, 도입률·실현 가치 대시보드
- **자동화된 거버넌스 워크플로**: 자동 시정 조치, 컴플라이언스 게이트 강제
- **다중 역할**: CAIO(AI 전략·ROI), CIO/CTO(투자 현황), 리스크 리더(감사 대응) 각각에 특화된 뷰

**Microsoft 대비 차별점**: CMDB 기반 비즈니스 서비스 연계, 명시적 규제 컴플라이언스 콘텐츠 팩, ROI 계산, ServiceNow IT 워크플로와의 깊은 통합.

---

### 4-2. Palo Alto Networks AI Access Security

**공식 출처**: `paloaltonetworks.com/network-security/ai-access-security`  
**상태**: GA (Palo Alto SASE 포트폴리오 일부)

**핵심 기능**:
- **4,000+ GenAI 앱 카탈로그**: Shadow AI 발견 특화
- **80+ GenAI 특화 속성, 300+ ML 데이터 분류기**: 세밀한 앱 위험 분류
- 정책 기반 접근 제어(Sanctioned/Tolerated/Unsanctioned 분류)
- 인라인 DLP: 텍스트·파일 기반 민감 데이터 GenAI 앱으로의 전송 차단
- 악성 URL·멀웨어 포함 GenAI 응답 차단
- 사용자 코칭(비준수 행동 시 실시간 알림)
- Strata Copilot: 트래픽 기반 AI 정책 권고

**Microsoft 대비 차별점**: 네트워크 레이어에서 제3자 GenAI 앱 접근을 통제하는 SASE/ZTNA 접근법. Microsoft 에이전트 생태계 외부의 GenAI 사용까지 커버. 

---

### 4-3. Wiz AI-SPM (AI Security Posture Management)

**공식 출처**: `wiz.io/blog/ai-security-posture-management` (발표 글 기준)

**핵심 기능**:
- **AI-BOM (AI Bill of Materials)**: 에이전트리스로 AWS SageMaker, GCP Vertex AI, Amazon Bedrock, Azure Cognitive 등 클라우드 AI 서비스 전체 인벤토리
- **AI 설정 오류 감지**: SageMaker 암호화 미설정, Vertex AI Workbench 공개 IP 노출 등 기본 규칙 제공
- **DSPM → AI 확장**: AI 학습 데이터 민감도 분석, 공격 경로 상의 데이터 위험 식별
- **AI 공격 경로 분석**: 취약점·ID·인터넷 노출·데이터·설정 오류를 Wiz Security Graph로 연결 (예: Vertex AI Workbench → GCE 인스턴스 → 민감 데이터 접근 경로)
- **AI 보안 대시보드**: 우선순위화된 AI 보안 이슈 큐

**Microsoft 대비 차별점**: 클라우드 인프라 레이어의 에이전트리스 가시성. AI 공급망 공격(학습 데이터 오염, 모델 취약점)까지 커버. Wiz Security Graph의 복합 공격 경로가 강점.

---

### 4-4. Cisco AI Defense (참고)

공식 Cisco AI Defense 제품 페이지에는 접근이 제한되었으나, 공개 블로그·뉴스 기반으로: AI 애플리케이션 개발 및 사용에서의 보안 위협 탐지(프롬프트 인젝션, 모델 탈취), 네트워크 레이어 정책 시행에 특화.

---

### 4-5. Protect AI (참고)

공식 페이지 접근 제한으로 공식 자료 확인 불가. 공개 GitHub 기반 도구(`guardian`, `rebuff` 등)는 AI/ML 파이프라인 보안 스캐닝에 특화된 것으로 알려져 있으나, 현 보고서에서 세부 명세 단정을 보류함.

---

## 5. Microsoft 현재 제품과의 중복 기능 및 분명한 공백

### 5-1. Agent Sentinel과 중복되는 기능

| Agent Sentinel 예상 기능 | Microsoft 기존 제공 제품 | 중복 정도 |
|------------------------|----------------------|---------|
| 에이전트 인벤토리/레지스트리 | Agent 365 Registry, Agent Map | **높음** (GA, CSV 내보내기, 멀티플랫폼 동기화 포함) |
| 에이전트 ID·접근 제어 | Entra Agent ID, Conditional Access | **높음** (GA, OAuth/OIDC/MCP/A2A 지원) |
| 실시간 위협 차단 | Defender for Cloud Apps 실시간 보호 | **중간** (GA이나 Copilot Studio·Foundry는 Preview, 커스텀 탐지 규칙 제한) |
| 데이터 보안·DLP | Purview DSPM, 감도 레이블, DLP | **높음** (GA) |
| 감사 로그 | Purview 통합 감사 로그, Entra Sign-in logs | **높음** (에이전트-대-에이전트 상호작용 포함) |
| 에이전트 품질 평가 | Foundry Evaluation SDK, 내장 평가자 | **높음** (GA, Tool Call Accuracy·Task Completion 포함) |
| 프롬프트 인젝션 탐지 | Azure AI Content Safety Prompt Shields | **높음** (GA) |
| 생명주기 관리(설치/차단/삭제) | M365 관리 센터 에이전트 액션 | **높음** (GA) |

### 5-2. 분명한 공백 (Agent Sentinel의 차별화 공간)

**공백 1: 에이전트 단위 통합 컴플라이언스 점수 (Agent Compliance Health Score)**
- 현황: Defender 위험, Entra 위험, Purview 데이터 위험, Foundry 품질 점수가 각각 별도 콘솔에 분산. M365 관리 센터의 "Agents at risk" 카드는 집계를 제공하지만 에이전트 단위 상세 점수화는 없음.
- 공백: **단일 에이전트에 대한 종합 보안·컴플라이언스·품질 스코어카드** (예: Security 70/100, Compliance 85/100, Quality 60/100) 부재. 점수 하락 원인 드릴다운 및 자동 교정 제안 미존재.

**공백 2: 크로스플랫폼 행동 베이스라인 + 드리프트 감지**
- 현황: Foundry 에이전트는 토큰 사용량·성공률·평가 점수를 모니터링. 그러나 "이 에이전트는 정상 상태에서 이 순서로 이 도구를 호출한다"는 **행동 베이스라인**을 자동 학습하고, 해당 패턴에서 이탈 시 알림을 주는 기능은 없음.
- 공백: Copilot Studio, Foundry, 서드파티 에이전트에 걸쳐 **통일된 행동 프로파일링 및 이상 감지 엔진** 부재.

**공백 3: 자동화된 거버넌스 워크플로 (Approval Gate + Remediation Pipeline)**
- 현황: Agent 365 DSPM은 "AI 에이전트가 자동 교정 수행 후 관리자 승인"을 지원하지만, 이는 데이터 공유 링크 제거 같은 데이터 중심 시나리오에 한정. 에이전트 거버넌스(소유자 지정, 정책 할당, 권한 검토 요청 자동화)에 대한 **end-to-end 워크플로 자동화**는 없음.
- 공백: "소유자 없는 에이전트 → 자동 오너십 지정 요청 → 30일 내 미응답 시 자동 차단" 같은 규칙 기반 거버넌스 파이프라인 부재. ServiceNow AI Control Tower가 이 영역에 특화.

**공백 4: 에이전트-대-에이전트 신뢰 체인 보안 시각화**
- 현황: Entra Agent ID는 A2A 프로토콜 인증 지원, Agent Map은 에이전트 간 관계 조회 가능(Preview). 그러나 오케스트레이터 에이전트 → 서브 에이전트 체인에서의 **신뢰 전파 경로, 권한 상속, 블래스트 반경**을 보안 관점으로 시각화하는 기능은 없음.
- 공백: "이 에이전트가 침해될 경우 영향을 받는 다운스트림 에이전트 목록, 접근 가능한 데이터, 실행 가능한 액션"을 그래프 형태로 제시하는 **Agent Blast Radius Analysis** 부재.

**공백 5: 비즈니스 가치/ROI 측정**
- 현황: Agent 365는 "Assisted Hours" 지표 제공. Foundry는 비용 추정 제공.
- 공백: 에이전트별 **비즈니스 임팩트 정량화**(절감 비용, 처리된 티켓 수, 사용자 만족도 연계 등) 부재. ServiceNow AI Control Tower는 이를 명시적으로 제공.

**공백 6: 비Microsoft 플랫폼 에이전트의 심층 거버넌스**
- 현황: Connected Platforms는 인벤토리 동기화와 기본 생명주기 액션(일부 Preview)을 제공.
- 공백: AWS Bedrock, Google Vertex AI 에이전트에 대한 **실시간 위협 보호, 행동 분석, 정책 강제**는 Microsoft 네이티브 에이전트 수준에 비해 현저히 얕음. 동기화된 에이전트에 Entra Conditional Access를 적용하는 것도 제한적.

**공백 7: 에이전트 설계 단계 보안 검증 (Shift-Left)**
- 현황: Foundry는 배포 전 평가·레드팀을 제공하지만 개발자 IDE 수준의 통합은 없음.
- 공백: 에이전트 개발 시점에 **권한 최소화 검증, 프롬프트 인젝션 취약점 정적 분석, 도구 호출 범위 검토**를 제공하는 Shift-Left 보안 도구 부재. (Protect AI의 도구 영역과 유사)

---

## 6. Agent Sentinel 구현 가능한 차별화 방향

### 방향 1: 에이전트 단위 통합 보안·컴플라이언스 스코어카드

**구현 아이디어**:
```
데이터 수집원: Microsoft Graph API (Agent 365), Defender XDR API (BehaviorInfo), 
               Purview Compliance API, Entra ID API, Foundry SDK
    ↓
집계 엔진: 각 소스에서 신호 수집 후 가중치 기반 점수 계산
    ↓
스코어카드: Security Score, Compliance Score, Quality Score, Risk Score (각 0~100)
    ↓
드릴다운: "Security 60 → 이유: 소유자 없음(−20), 과도한 권한(−15), 미해결 Defender 알림 3건(−5)"
    ↓
자동 교정 제안: "소유자 지정 → 권한 최소화 → 알림 확인" 순서의 워크플로 트리거
```

**API 기반**: Microsoft 365 관리 API (`/admin/serviceAnnouncement`), Microsoft Graph (`/security/alerts_v2`), Foundry SDK (`azure-ai-projects`), Purview Content Search API, Entra Graph API

**차별성**: Microsoft가 "Agents at risk" 카드(집계 수치)만 제공하는 반면, Sentinel은 에이전트 단위 구성 요소별 점수와 액션 가이드를 제공.

---

### 방향 2: 행동 베이스라인 + 이상 감지 엔진

**구현 아이디어**:
```
OpenTelemetry 트레이스 수집 (Foundry/LangChain/LangGraph 에이전트)
    ↓
정상 패턴 학습: 도구 호출 시퀀스, 응답 시간 분포, 토큰 사용 패턴 (7/14/30일 롤링 윈도)
    ↓
이상 감지: Z-score + 시계열 이상(Prophet/ARIMA) 또는 Isolation Forest 적용
    ↓
이상 유형 분류: 과도한 도구 호출, 비정상 데이터 접근, 응답 품질 급락, 비용 폭증
    ↓
알림: Adaptive Alert Threshold → Defender XDR 또는 Teams 채널
```

**차별성**: 현재 Foundry 알림은 정적 임계값 기반. Agent Sentinel은 에이전트별 동적 베이스라인.

---

### 방향 3: 자동화된 거버넌스 워크플로 엔진

**구현 아이디어**:
```
규칙 정의 UI:
  IF 에이전트.소유자 = null AND 에이전트.마지막활동 > 30일
  THEN 알림 전송(OWNER_CANDIDATES) → 14일 내 미응답 → 에이전트 차단 + 티켓 생성

규칙 실행:
  - 트리거: 주기적 평가 (예: 매일) 또는 이벤트 기반 (소유자 퇴직 감지)
  - 실행: Microsoft 365 에이전트 차단 API 호출
  - 감사: 모든 자동 액션 감사 로그 기록

승인 게이트:
  고위험 에이전트(Risk Score > 80)에 대한 자동 차단은 관리자 승인 필요
  Power Automate 또는 Logic Apps 통합
```

**차별성**: Agent 365는 수동 관리 액션 제공. Agent Sentinel은 규칙 기반 자동화 레이어 추가.

---

### 방향 4: 에이전트-대-에이전트 신뢰 체인 시각화 (Agent Blast Radius)

**구현 아이디어**:
```
데이터 수집: Entra Agent ID API (에이전트 관계, A2A 토큰 교환 로그)
             Foundry 트레이스 (오케스트레이터→서브에이전트 호출 체인)
             Defender BehaviorInfo (에이전트 간 상호작용)
    ↓
그래프 구축: Neo4j 또는 Azure Cosmos Gremlin API
  노드: 에이전트, 사용자, 도구, 데이터 소스
  엣지: 호출(call), 위임(delegate), 접근(access), 위험 전파(risk_propagates_to)
    ↓
시각화: D3.js 또는 Azure Monitor Workbook 커스텀 시각화
  침해 시나리오 시뮬레이션: "이 에이전트가 침해되면?"
    ↓
블래스트 반경 계산: 영향 받는 에이전트 수, 접근 가능한 데이터 감도 레벨, 실행 가능한 최고 권한 액션
```

**차별성**: Wiz Security Graph의 AI 에이전트 버전. Microsoft는 에이전트 관계 표시는 있으나 보안 관점의 블래스트 반경 분석은 없음.

---

### 방향 5: 비Microsoft 에이전트 심층 거버넌스 (Universal Agent Adapter)

**구현 아이디어**:
```
Universal Agent Adapter (오픈 소스 커넥터 레이어):
  - 인풋: 각 플랫폼 API (Bedrock Agents API, Vertex AI Reasoning Engine, 
                        Salesforce Agentforce API, 자체 REST API)
  - 아웃풋: Agent Sentinel 표준 스키마 (이름, ID, 소유자, 도구 목록, 권한 범위, 마지막 실행)
    ↓
정책 에이전트 (Policy Engine):
  - 표준 스키마 기반으로 통일된 거버넌스 정책 적용
  - Microsoft Entra Group에 비Microsoft 에이전트 자동 할당 → 조건부 접근 정책 연계 시도
    ↓
Gap 명시: Microsoft Agent 365 Connected Platforms보다 깊은 정책 강제 구현이 목표
  단, 서드파티 플랫폼 실시간 차단은 해당 플랫폼 API 지원 여부에 의존
```

---

## 7. 주요 근거 URL 정리

| 항목 | URL |
|------|-----|
| Microsoft Agent 365 개요 | `learn.microsoft.com/en-us/microsoft-agent-365/overview` |
| Agent 365 GA 공식 블로그 | `microsoft.com/security/blog/2026/05/01/microsoft-agent-365-now-generally-available-expands-capabilities-and-integrations/` |
| Entra Agent ID 공식 문서 | `learn.microsoft.com/en-us/entra/agent-id/what-is-microsoft-entra-agent-id` |
| Entra Agent Identity Platform | `learn.microsoft.com/en-us/entra/agent-id/what-is-agent-id-platform` |
| Entra Security for AI Overview | `learn.microsoft.com/en-us/entra/agent-id/security-for-ai-overview` |
| Entra Agent Identities 개념 | `learn.microsoft.com/en-us/entra/agent-id/what-are-agent-identities` |
| Agent 365 Registry | `learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-registry` |
| Agent Map | `learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-map` |
| Agent 365 Management Overview | `learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-365-overview` |
| Agent Actions | `learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-actions` |
| Connected Platforms | `learn.microsoft.com/en-us/microsoft-agent-365/admin/connected-platforms` |
| Defender 실시간 에이전트 보호 | `learn.microsoft.com/en-us/defender-cloud-apps/real-time-agent-protection-during-runtime` |
| Purview AI 에이전트 | `learn.microsoft.com/en-us/purview/ai-agents` |
| Purview Agent 365 | `learn.microsoft.com/en-us/purview/ai-agent-365` |
| Purview AI Microsoft 개요 | `learn.microsoft.com/en-us/purview/ai-microsoft-purview` |
| Purview DSPM 신버전 | `learn.microsoft.com/en-us/purview/data-security-posture-management-learn-about` |
| Azure AI Foundry 평가 접근법 | `learn.microsoft.com/en-us/azure/ai-foundry/concepts/evaluation-approach-gen-ai` |
| Foundry Agent 모니터링 대시보드 | `learn.microsoft.com/en-us/azure/ai-foundry/observability/how-to/how-to-monitor-agents-dashboard` |
| Foundry Control Plane | `learn.microsoft.com/en-us/azure/ai-foundry/control-plane/overview` |
| Foundry Control Plane 에이전트 관리 | `learn.microsoft.com/en-us/azure/ai-foundry/control-plane/how-to-manage-agents` |
| Foundry Agent Service 개요 | `learn.microsoft.com/en-us/azure/ai-foundry/agents/overview` |
| Azure AI Content Safety | `learn.microsoft.com/en-us/azure/ai-services/content-safety/overview` |
| Azure Monitor OpenTelemetry | `learn.microsoft.com/en-us/azure/azure-monitor/app/opentelemetry-enable` |
| Copilot Studio 에이전트 공유 | `learn.microsoft.com/en-us/microsoft-copilot-studio/admin-share-bots` |
| ServiceNow AI Control Tower | `servicenow.com/products/ai-control-tower.html` |
| Palo Alto AI Access Security | `paloaltonetworks.com/network-security/ai-access-security` |
| Wiz AI-SPM | `wiz.io/blog/ai-security-posture-management` |

---

## 8. 불확실성 및 조사 한계

1. **Copilot Control System 공식 명세**: "Copilot Control System"이라는 이름의 독립 문서 페이지가 존재하지 않는 것으로 확인됨. Microsoft 365 관리 센터 내 Copilot/에이전트 관리 기능들을 포괄하는 마케팅 용어로 판단되나, 공식 명세 문서가 있다면 추가 조사 필요.

2. **Protect AI 세부 기능**: 공식 페이지 접근 실패로 상세 기능 확인 불가. 공개 GitHub 도구(`guardian`, `rebuff`, `modelscan`)는 확인되나 본 보고서에서 구체적 명세 단정 보류.

3. **Cisco AI Defense**: 공식 제품 페이지 접근 불가. 2025년 초 발표 이후 포트폴리오 재편 여부 불명확.

4. **Microsoft 365 E7 SKU 세부 포함 내용**: 문서에서 "E7 = E5 + M365 Copilot + Agent 365 + Entra Suite" 언급되나, 이 SKU는 2026년 출시된 것으로 보임. 정확한 포함 내용 및 가격은 Microsoft Volume Licensing 계약에 따라 상이할 수 있음.

5. **Connected Platforms 동기화 깊이**: Salesforce Agentforce, Databricks Genie, Anthropic, Oracle의 경우 문서에 "GA"로 기재되어 있으나, 지원하는 관리 액션의 깊이(읽기 전용 동기화인지 아니면 차단·삭제 등 쓰기 액션도 지원하는지)는 플랫폼별로 다를 가능성이 높으며 각 플랫폼 개별 확인 필요.

6. **Foundry Control Plane의 비Microsoft 에이전트 지원**: 문서는 Foundry agents, Azure SRE Agent, Logic Apps, 커스텀 에이전트를 지원 플랫폼으로 열거. AWS Bedrock·Google Vertex AI 에이전트는 Control Plane에서 직접 관리되지 않고, Agent 365 Connected Platforms를 통해 별도 동기화되는 구조로 이해됨.

7. **에이전트 단위 컴플라이언스 점수**: 이 기능이 GA/Preview 로드맵에 포함되어 있는지 여부는 공개 자료로 확인 불가. Agent Sentinel의 핵심 차별화 포인트가 될 수 있는 영역.

---

*본 보고서는 2026-08-14 기준 Microsoft 공식 문서, Microsoft Security Blog, ServiceNow, Palo Alto Networks, Wiz의 공개 자료만을 근거로 작성되었습니다. 내부 로드맵, 비공개 Preview, 계약별 상이한 기능 범위는 반영되지 않았습니다.*