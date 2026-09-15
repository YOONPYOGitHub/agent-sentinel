<a id="agent-sentinel--dr-design"></a>

# Agent Sentinel – 재해 복구 설계

<a id="recovery-objectives"></a>

## 복구 목표

- RTO(복구 시간 목표): 4시간
- RPO(복구 시점 목표): 1시간

## Cosmos DB

- 1시간마다 자동 백업, 8시간 보존(주기적 백업 모드)
- RTO를 줄이기 위해 다중 지역 읽기 추가 가능
- 세션 일관성을 통해 가장 가까운 복제본에서 읽기 가능

## PostgreSQL

- 가용성 영역 2의 대기 인스턴스를 사용하는 영역 중복 고가용성
- 자동 백업: 7일 보존, 지역 중복
- 지정 시간 복원 가능
- 장애 조치: AZ 장애 조치를 통해 자동 수행(120초 미만)

## Container Apps

- Consumption 워크로드 프로필: 자동으로 0까지 축소 및 수평 확장
- 프로덕션에서 api와 jobs에 여러 복제본 사용

## Service Bus Premium

- 기본 제공 영역 중복(Premium 계층)
- 실패한 메시지용 dead-letter queue
- 메시지 잠금 기간: 5분

## AI Search

- 복제본 1개의 S1 계층(개발용). 고가용성을 위해 복제본 추가
- 필요시 원본 데이터에서 인덱스 재구축

<a id="runbook-failover-steps"></a>

## 런북: 장애 조치 절차

1. PostgreSQL 자동 장애 조치 완료 확인
2. ACA 앱 상태 엔드포인트 확인
3. Cosmos DB 복제 지연 확인
4. Service Bus DLQ에서 미처리 메시지 확인
5. AI Search 인덱스 완전성 검증
