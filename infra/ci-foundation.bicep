targetScope = 'resourceGroup'

// ci-foundation.bicep
// Provisions the self-hosted GitHub Actions build runner infrastructure.
// Deploy AFTER platform.bicep (which creates the VNet and build subnet).
//
// Deployment:
//   az deployment group create \
//     -g rg-agent-sentinel \
//     -f infra/ci-foundation.bicep \
//     -p location=koreacentral
//
// After deploy: bootstrap the runner with scripts/bootstrap-runner.sh
// (see docs/runbooks.md > CI Runner section).

param location string = resourceGroup().location
param suffix string = '260814'
param tags object = {
  application: 'agent-sentinel'
  environment: 'dev'
  'managed-by': 'bicep'
  component: 'ci-foundation'
}

resource existingVnet 'Microsoft.Network/virtualNetworks@2024-01-01' existing = {
  name: 'vnet-as-${suffix}'
}

resource existingAcr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = {
  name: 'acr${suffix}'
}

// Build subnet is subnet index 5 (10.0.6.0/24), added to network.bicep alongside platform.bicep deploy.
var buildSubnetId = '${existingVnet.id}/subnets/build'

@description('SSH public key for azureuser on vm-ci-runner-as. VM is accessed via Run Command only. Generate with: ssh-keygen -t ed25519 -f ~/.ssh/id_ci_runner_as_ed25519 -N empty and pass -p adminSshPublicKey=<content>.')
param adminSshPublicKey string

module buildRunner './modules/build-runner.bicep' = {
  name: 'build-runner'
  params: {
    location: location
    tags: tags
    buildSubnetId: buildSubnetId
    acrId: existingAcr.id
    adminSshPublicKey: adminSshPublicKey
    runnerIdentityName: 'id-ci-runner-${suffix}'
  }
}

output vmName string = buildRunner.outputs.vmName
output vmId string = buildRunner.outputs.vmId
output runnerIdentityClientId string = buildRunner.outputs.runnerIdentityClientId
output runnerIdentityPrincipalId string = buildRunner.outputs.runnerIdentityPrincipalId
