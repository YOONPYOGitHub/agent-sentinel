targetScope = 'resourceGroup'

@description('Azure region for all Agent Sentinel resources.')
param location string = resourceGroup().location

@description('Microsoft Foundry account name.')
param accountName string = 'ais-agent-sentinel-260814'

@description('Microsoft Foundry project name.')
param projectName string = 'agent-sentinel-pjt'

var deploymentDefinitions = [
  { name: 'gpt-5.6-terra', modelName: 'gpt-5.6-terra', version: '2026-07-09', capacity: 10, upgradeOption: 'NoAutoUpgrade' }
]

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: accountName
  location: location
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    allowProjectManagement: true
    customSubDomainName: accountName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    networkAcls: { defaultAction: 'Allow', ipRules: [], virtualNetworkRules: [] }
  }
}

resource foundryProject 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: foundryAccount
  name: projectName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: { displayName: projectName, description: 'Agent Sentinel isolated development project' }
}

@batchSize(1)
resource modelDeployments 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = [for deployment in deploymentDefinitions: {
  parent: foundryAccount
  name: deployment.name
  sku: { name: 'GlobalStandard', capacity: deployment.capacity }
  properties: {
    model: { format: 'OpenAI', name: deployment.modelName, version: deployment.version }
    versionUpgradeOption: deployment.upgradeOption
  }
}]

output foundryProjectEndpoint string = foundryProject.properties.endpoints['AI Foundry API']
output modelDeployments array = [for deployment in deploymentDefinitions: deployment.name]
