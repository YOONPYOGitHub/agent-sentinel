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

## Retention guidance

Configure an Azure Container Registry retention policy for untagged manifests while retaining
immutable SHA-tagged images for the organization's rollback and audit window. Purge filters must not
remove images used by active Container App revisions or approved rollback releases. Periodically
verify that running revisions still reference retained manifests and that the retention window
meets operational and compliance requirements.
