# Supply-chain deployment policy

## Azure Container Registry

Use Azure Container Registry Premium for deployed environments.

## Immutable image references

Every container image is tagged with the full Git commit SHA that produced it
for traceability, but tags are not the deployment identity. The required
`webImageDigest`, `apiImageDigest`, and `jobsImageDigest` Bicep parameters have
no defaults. Bicep constructs component-specific private ACR references in the
form `<private-acr>/<repository>@sha256:<digest>`. Mutable or tag-qualified
deployment references, including `latest`, are prohibited.

Build and publish every application image for the SHA before deploying the
platform. Retain build provenance with the release record. Rollbacks must
select a previously verified digest and its associated full-SHA tag; do not
retag an image.

Each release record must include a validated versioned
[sanitized release evidence manifest](release-evidence.md). The expected image
tag is the full manifest commit SHA. Live deployed tags and canonical digests
must come from an explicitly supplied sanitized deployment observation; the
offline generator never queries ACR or Container Apps. Code and deployed image
versions are separate facts and must not be collapsed into one status.

## Retention guidance

Configure an Azure Container Registry retention policy for untagged manifests
while retaining digest-referenced manifests and their full-SHA provenance tags
for the organization's rollback and audit window. Purge filters must not remove
images used by active Container App revisions or approved rollback releases.
Periodically verify that running revisions still reference retained manifests
and that the retention window meets operational and compliance requirements.

## Private Build Path

Images must be built inside the selected Agent Sentinel VNet using its
self-hosted GitHub Actions runner. Microsoft-hosted runners cannot reach a target
ACR whose `publicNetworkAccess` is `Disabled`. For replacement validation, the
approved path is `vnet-as-m098047/build` to `acrm098047` over the registry's
private endpoint and private DNS link.

### Build workflow

The workflow `.github/workflows/ci-build-deploy.yml` runs on
`[self-hosted, linux, x64, <PRIVATE_RUNNER_LABEL>]`, where the final label is a
validated repository variable. It:

1. Validates one exact full 40-hex commit SHA and checks out that SHA in every job.
2. Validates repository variables for Azure subscription, resource group, ACR,
   runner UAMI client ID, and runner label.
3. Allowlists the GitHub target environment and checked-in `.bicepparam` path,
   rejects traversal, and requires `acrm098047` for replacement validation.
4. Logs into Azure with the selected runner UAMI and explicitly selects the
   configured subscription; it never selects the first subscription returned.
5. Logs into the selected ACR with managed identity and builds component images
   with the resolved full SHA.
6. Runs the API/jobs image import probes, pushes the images over the private
   endpoint, and resolves each pushed tag to a canonical SHA-256 digest. Web is
   built by the current full workflow but is only a rollout requirement when its
   code or edge configuration changed.
7. Passes verified digests to the allowlisted platform what-if.
8. Allows deployment only on `workflow_dispatch`, with `deployPlatform=true`, a
   non-`none` target, and required reviewers on the selected GitHub environment.
9. Requires one active revision per Container App and verifies its
   digest-qualified image reference against the resolved ACR digest.

The checked-in defaults (`targetEnvironment=none`, `parameterFile=none`, and
`deployPlatform=false`) cannot deploy. A full-platform deploy remains separate
from the staged hackathon rollout and must not be used to bypass API/jobs gates.

### Approval-gated hackathon rollout

1. Approve the surgical `connector-sources` what-if and create only that existing
   account/database child container.
2. Approve the target runner foundation what-if, including its ACR-scoped
   `AcrPush` assignment; provision and boot the runner with a one-hour token.
3. Validate the exact release SHA, repository variables, target parameter file,
   and runner label.
4. Build/push API and jobs, resolving both to canonical digests. Build/push web
   only when a reviewed web change requires it.
5. Record current API/jobs/web digests before rollout. With protected-environment
   approval, update API to its new digest first and run health, connector status,
   authentication, and anonymous-mutation checks.
6. Only after API passes, update jobs and verify its active digest plus one
   bounded ingestion cycle. Update web last only when explicitly approved.
7. On failure, restore the previous API digest before touching jobs. If jobs was
   changed, restore its prior digest next; restore web only if it changed. Verify
   active revisions and smoke tests after each restoration. Never retag an image.

This is a required execution order, not a statement that any deployment, image
push, role assignment, or runner registration has occurred.

### No long-lived secrets

The CI foundation grants the runner UAMI `AcrPush` only on the selected ACR. Any
additional what-if or deployment permission requires a separate least-privilege
approval. The runner registration token is obtained fresh via `gh api` (one-hour
TTL) and passed to the VM over the Azure management plane (TLS). It is never
written to disk or stored in Key Vault, GitHub variables, parameter files, or
source control. SSH key material in the target parameter file is read only from
`ADMIN_SSH_PUBLIC_KEY` and must be a public key.
