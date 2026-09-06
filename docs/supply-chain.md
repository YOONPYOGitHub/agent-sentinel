# Supply-chain deployment policy

## Azure Container Registry

Use Azure Container Registry Premium for deployed environments.

## Immutable image tags

The `imageTag` Bicep parameter is required and has no `latest` default. Every container image must
be tagged with the Git commit SHA that produced it, and that same SHA must be supplied as
`imageTag` during deployment. Mutable tags, including `latest`, are prohibited.

Build and publish every application image for the SHA before deploying the platform. Retain build
provenance with the release record. Rollbacks must select a previously published SHA-tagged image;
do not retag an image.

Each release record must include a validated versioned
[sanitized release evidence manifest](release-evidence.md). The expected image
tag is the full manifest commit SHA. Live deployed tags and canonical digests
must come from an explicitly supplied sanitized deployment observation; the
offline generator never queries ACR or Container Apps. Code and deployed image
versions are separate facts and must not be collapsed into one status.

## Retention guidance

Configure an Azure Container Registry retention policy for untagged manifests while retaining
immutable SHA-tagged images for the organization's rollback and audit window. Purge filters must not
remove images used by active Container App revisions or approved rollback releases. Periodically
verify that running revisions still reference retained manifests and that the retention window
meets operational and compliance requirements.

## Private Build Path

Images must be built inside the Agent Sentinel VNet using the self-hosted GitHub Actions runner
(`vm-ci-runner-as`). Microsoft-hosted runners cannot reach `acr260814` because `publicNetworkAccess`
is `Disabled`. The private endpoint for ACR is registered in `privatelink.azurecr.io` private DNS
zone, which is linked to `vnet-as-260814`.

### Build workflow

The workflow `.github/workflows/ci-build-deploy.yml` runs on
`[self-hosted, linux, x64, agent-sentinel-private]`. It:

1. Checks out the repo using the built-in `GITHUB_TOKEN` (no PAT required).
2. Logs into Azure with `az login --identity --client-id` using the runner UAMI (`id-ci-runner-260814`).
3. Logs into ACR with `az acr login --name acr260814` (identity, no password).
4. Builds all three images with `docker build` using the resolved full 40-hex commit SHA.
5. Pushes to `acr260814.azurecr.io` via private endpoint.
6. Resolves each pushed tag with `az acr repository show` and requires a canonical SHA-256 digest.
7. Optionally runs `az deployment group what-if` and deploys `platform.bicep` with the same full SHA as `imageTag`.

### No long-lived secrets

The runner UAMI (`id-ci-runner-260814`) holds `AcrPush` only. The runner registration token is
obtained fresh via `gh api` (1-hour TTL) and passed to the VM over the Azure management plane
(TLS). It is never written to disk or stored in Key Vault or source control.
