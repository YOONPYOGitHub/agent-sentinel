targetScope = 'resourceGroup'

@description('Resource name suffix used when accountName is empty.')
param suffix string = '260814'

@description('Existing Microsoft Foundry account name.')
param accountName string = ''

var effectiveAccountName = empty(accountName) ? 'ais-agent-sentinel-${suffix}' : accountName

@description('Advisory model deployment name.')
param deploymentName string = 'gpt-5.6-terra'

@description('Advisory model version pinned for repeatable deployment.')
param modelVersion string = '2026-07-09'

@description('GlobalStandard TPM capacity in thousands.')
@minValue(1)
param capacity int = 10

resource aiAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: effectiveAccountName
}

resource advisoryModel 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: aiAccount
  name: deploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: capacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-5.6-terra'
      version: modelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

output deploymentResourceId string = advisoryModel.id
output deploymentModel string = advisoryModel.properties.model.name
output deploymentVersion string = advisoryModel.properties.model.version
