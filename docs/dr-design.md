<a id="agent-sentinel--dr-design"></a>

# Agent Sentinel – 재해 복구 설계

아래는 저장소 IaC의 목표 구성과 복구 지침입니다. 2026-09-15 문서 대조에서는
실제 백업 정책·복구 시점·장애 조치 실험을 새로 검증하지 않았습니다.
현재 `rg-agent-sentinel-m098047`의 실배포가 목표 구성과 같다고 가정하지 않습니다.
과거 전체 Bicep 드리프트는 별도 검토 대상이며 복구를 이유로 전체 배포를 실행하지 않습니다.

<a id="recovery-objectives"></a>

## 복구 목표

- RTO(복구 시간 목표): 4시간
- RPO(복구 시점 목표): 1시간

두 값은 설계 목표이며 실측 달성값이나 승인된 서비스 보장이 아닙니다.

## Cosmos DB

- `infra/modules/cosmos.bicep`은 백업 간격·보존 기간·모드를 명시하지 않습니다.
  기존의 1시간 간격·8시간 보존 주장은 이 코드로 검증할 수 없습니다.
- 목표는 단일 지역, `isZoneRedundant=false`, `Session` 일관성입니다.
  다중 지역 읽기나 자동 지역 복구를 현재 구성으로 주장하지 않습니다.
- 복구 전에 실제 백업 정책·복원 가능 시점과 복원 대상 권한을 별도로 확인합니다.

## PostgreSQL

- `infra/modules/postgres.bicep` 목표는 PostgreSQL 16, 기본 영역 1,
  `ZoneRedundant` 고가용성, 대기 영역 2입니다.
- 코드에 선언된 백업은 7일 보존, 지역 중복 Enabled입니다. 실제 배포 값은 별도 검증 대상입니다.
- 지정 시간 복원 가능 범위와 장애 조치 시간을 실제 서비스에서 검증해야 합니다.
  120초 미만 완료나 이번 후보의 복구 성공을 입증한 기록은 없습니다.

## Container Apps

- 목표는 Consumption, `activeRevisionsMode=Single`, web/API 최소 1,
  jobs 최소 0, 세 앱 모두 최대 2입니다. 모든 앱이 0까지 축소되는 설정이 아닙니다.
- jobs의 주기 수집 루프는 프로세스 실행에 의존합니다. 이 IaC의 scale 설정에는
  별도 Service Bus scaler가 없으므로 큐 메시지만으로 0에서 복구된다고 보장하지 않습니다.
- 현재 실행 이미지 `7c1336bc`와 저장소의 이후 변경을 구분하고,
  승인된 이전 이미지 다이제스트·구성·쓰기 false를 복원한 뒤 활성 리비전을 검증합니다.

## Service Bus Premium

- `infra/modules/servicebus.bicep`은 Premium 용량 1을 선언하지만 영역 중복을 명시하지 않습니다.
  계층만으로 현재 가용성 영역 복구 구성을 입증하지 않습니다.
- 실패한 메시지용 dead-letter queue
- 메시지 잠금 기간: 5분

## AI Search

- 목표는 `standard` 계층, 복제본 1개·파티션 1개입니다. 고가용성 확대는 별도 승인 대상입니다.
- 원본 데이터와 승인된 수집 경로로 인덱스 재구축을 검증합니다.
  현재 jobs 스냅샷 재수집을 Search 재구축 완료로 취급하지 않습니다.

<a id="runbook-failover-steps"></a>

## 런북: 장애 조치 절차

1. 승인된 장애 범위와 현재 백업/HA 구성을 확인하고 PostgreSQL 복구 또는 장애 조치 결과를 검증합니다.
2. Front Door와 ACA 상태, 정확한 실행 다이제스트, 쓰기 false를 확인합니다.
3. Cosmos 복원 가능 시점과 데이터 완전성을 검증합니다. 단일 지역에서 존재하지 않는 복제본을 전제하지 않습니다.
4. Service Bus DLQ의 미처리 메시지와 jobs 실제 실행 상태를 확인합니다.
5. AI Search 인덱스 완전성을 검증하고 복구 시간·데이터 손실을 측정하여 RTO/RPO 목표와 비교합니다.
