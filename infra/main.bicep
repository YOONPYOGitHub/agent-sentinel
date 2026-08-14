targetScope = 'resourceGroup'

@description('Azure region for all Agent Sentinel resources.')
param location string = resourceGroup().location

@description('Microsoft Foundry account name.')
param accountName string = 'ais-agent-sentinel-260814'

@description('Microsoft Foundry project name.')
param projectName string = 'agent-sentinel-pjt'

@description('Azure OpenAI deployment name.')
param modelDeploymentName string = 'gpt-5.4'

resource foundryAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: accountName
  location: location
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    allowProjectManagement: true
    customSubDomainName: accountName
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      ipRules: []
      virtualNetworkRules: []
    }
  }
}

resource foundryProject 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: foundryAccount
  name: projectName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    displayName: projectName
    description: 'Agent Sentinel isolated development project'
  }
}

resource modelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: foundryAccount
  name: modelDeploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: 250
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-5.4'
      version: '2026-03-05'
    }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
  }
}

output foundryProjectEndpoint string = foundryProject.properties.endpoints['AI Foundry API']
output modelDeployment string = modelDeployment.name
