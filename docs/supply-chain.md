<a id="supply-chain-deployment-policy"></a>

# 공급망 배포 정책

## Azure Container Registry

배포 환경에는 Azure Container Registry Premium을 사용합니다.

<a id="immutable-image-references"></a>

## 불변 이미지 참조

추적성을 위해 모든 컨테이너 이미지에 해당 이미지를 만든 전체 Git 커밋 SHA를 태그로 지정하지만,
태그는 배포 식별자가 아닙니다. 필수 Bicep 매개변수인
`webImageDigest`, `apiImageDigest`, `jobsImageDigest`에는 기본값이 없습니다.
Bicep은 `<private-acr>/<repository>@sha256:<digest>` 형식으로
컴포넌트별 프라이빗 ACR 참조를 구성합니다.
`latest`를 포함해 변경 가능하거나 태그 기반인 배포 참조는 금지합니다.

플랫폼을 배포하기 전에 해당 SHA의 모든 애플리케이션 이미지를 빌드하고 게시합니다.
릴리스 기록과 함께 빌드 출처를 보존합니다.
롤백에는 이전에 검증한 다이제스트와 연결된 전체 SHA 태그를 선택해야 하며,
이미지에 태그를 다시 지정해서는 안 됩니다.

각 릴리스 기록에는 검증된 버전 관리형
[민감 정보를 제거한 릴리스 증거 매니페스트](release-evidence.md)를 포함해야 합니다.
예상 이미지 태그는 매니페스트의 전체 커밋 SHA입니다.
실제 배포 태그와 정규 다이제스트는 명시적으로 제공되고 민감 정보가 제거된 배포 관측에서 가져와야 합니다.
오프라인 생성기는 ACR이나 Container Apps를 쿼리하지 않습니다.
코드 버전과 배포된 이미지 버전은 별개의 사실이며 하나의 상태로 합쳐서는 안 됩니다.

<a id="retention-guidance"></a>

## 보존 지침

태그가 없는 매니페스트에 대한 Azure Container Registry 보존 정책을 구성하되,
다이제스트로 참조되는 매니페스트와 그 출처를 나타내는 전체 SHA 태그는
조직의 롤백 및 감사 기간 동안 보존합니다.
정리 필터가 활성 Container App 리비전이나 승인된 롤백 릴리스에서 사용하는 이미지를 삭제해서는 안 됩니다.
실행 중인 리비전이 여전히 보존된 매니페스트를 참조하는지,
보존 기간이 운영 및 규정 준수 요구사항을 충족하는지 주기적으로 확인합니다.

<a id="private-build-path"></a>

## 프라이빗 빌드 경로

이미지는 선택한 Agent Sentinel VNet 내부에서 자체 호스팅 GitHub Actions runner를 사용해 빌드해야 합니다.
Microsoft 호스팅 runner는 `publicNetworkAccess`가 `Disabled`인 대상 ACR에 접근할 수 없습니다.
대체 환경 검증에 승인된 경로는 레지스트리의 private endpoint와 private DNS 링크를 통해
`vnet-as-m098047/build`에서 `acrm098047`로 연결하는 경로입니다.

<a id="build-workflow"></a>

### 빌드 워크플로

워크플로 `.github/workflows/ci-build-deploy.yml`은
`[self-hosted, linux, x64, <PRIVATE_RUNNER_LABEL>]`에서 실행되며,
마지막 레이블은 검증된 저장소 변수입니다. 이 워크플로는 다음을 수행합니다.

1. 정확한 전체 40자리 16진수 커밋 SHA 하나를 검증하고 모든 job에서 해당 SHA를 체크아웃합니다.
2. Azure 구독, 리소스 그룹, ACR, runner UAMI 클라이언트 ID, runner 레이블의 저장소 변수를 검증합니다.
3. GitHub 대상 환경과 저장소에 포함된 `.bicepparam` 경로에 허용 목록을 적용하고
   경로 순회를 거부하며, 대체 환경 검증에는 `acrm098047`를 요구합니다.
4. 선택한 runner UAMI로 Azure에 로그인하고 구성된 구독을 명시적으로 선택합니다.
   반환된 첫 번째 구독을 임의로 선택하지 않습니다.
5. managed identity로 선택한 ACR에 로그인하고 확정된 전체 SHA로 컴포넌트 이미지를 빌드합니다.
6. API/jobs 이미지 가져오기 검사를 실행하고, private endpoint로 이미지를 푸시하며,
   푸시한 각 태그를 정규 SHA-256 다이제스트로 확인합니다. 현재 전체 워크플로는 web도 빌드하지만,
   web의 코드나 엣지 구성이 변경된 경우에만 web 롤아웃이 필수입니다.
7. 검증된 다이제스트를 허용 목록에 있는 플랫폼 what-if에 전달합니다.
8. `workflow_dispatch`에서 `deployPlatform=true`, `none`이 아닌 대상,
   선택한 GitHub 환경의 필수 검토자가 모두 갖춰진 경우에만 배포를 허용합니다.
9. Container App마다 활성 리비전 하나를 요구하며, 다이제스트 기반 이미지 참조를
   확인된 ACR 다이제스트와 대조하여 검증합니다.

저장소의 기본값(`targetEnvironment=none`, `parameterFile=none`,
`deployPlatform=false`)으로는 배포할 수 없습니다. 전체 플랫폼 배포는
단계적 해커톤 롤아웃과 별개이며 API/jobs 통과 기준을 우회하는 데 사용해서는 안 됩니다.

<a id="approval-gated-hackathon-rollout"></a>

### 승인이 필요한 해커톤 롤아웃

1. 변경 범위를 한정한 `connector-sources` what-if를 승인하고,
   해당 기존 계정/데이터베이스의 하위 컨테이너만 생성합니다.
2. ACR 범위의 `AcrPush` 할당을 포함한 대상 runner 기반 인프라 what-if를 승인합니다.
   유효기간 1시간의 토큰으로 runner를 프로비전하고 부팅합니다.
3. 정확한 릴리스 SHA, 저장소 변수, 대상 매개변수 파일, runner 레이블을 검증합니다.
4. API와 jobs를 빌드/푸시하고 둘 다 정규 다이제스트로 확인합니다.
   검토된 web 변경에 필요한 경우에만 web을 빌드/푸시합니다.
5. 롤아웃 전에 현재 API/jobs/web 다이제스트를 기록합니다.
   보호된 환경의 승인을 받아 API부터 새 다이제스트로 업데이트하고,
   상태, 커넥터 상태, 인증, 익명 변경 요청 검사를 실행합니다.
6. API가 통과한 후에만 jobs를 업데이트하고 활성 다이제스트와 범위가 제한된 수집 주기 한 번을 검증합니다.
   web은 명시적으로 승인된 경우에만 마지막에 업데이트합니다.
7. 실패 시 jobs를 건드리기 전에 이전 API 다이제스트를 복원합니다.
   jobs를 변경했다면 다음으로 이전 jobs 다이제스트를 복원하고, web은 변경한 경우에만 복원합니다.
   복원할 때마다 활성 리비전과 스모크 테스트를 검증합니다. 이미지 태그를 다시 지정하지 않습니다.

이는 필수 실행 순서이며, 배포·이미지 푸시·역할 할당·runner 등록이
실제로 수행되었다는 의미가 아닙니다.

<a id="no-long-lived-secrets"></a>

### 장기 비밀 사용 금지

CI 기반 인프라는 선택한 ACR에 대해서만 runner UAMI에 `AcrPush`를 부여합니다.
추가 what-if 또는 배포 권한에는 별도의 최소 권한 승인이 필요합니다.
runner 등록 토큰은 `gh api`로 새로 발급받아(TTL 1시간)
Azure 관리 평면(TLS)을 통해 VM에 전달합니다.
디스크에 쓰거나 Key Vault, GitHub 변수, 매개변수 파일, 소스 제어에 저장하지 않습니다.
대상 매개변수 파일의 SSH 키 자료는 `ADMIN_SSH_PUBLIC_KEY`에서만 읽으며 반드시 공개 키여야 합니다.
