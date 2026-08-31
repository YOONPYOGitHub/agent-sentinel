param accountName string
param projectName string
param location string

resource aiAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: accountName
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' existing = {
  parent: aiAccount
  name: projectName
}

resource embedding 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: aiAccount
  name: 'text-embedding-3-large'
  sku: {
    name: 'GlobalStandard'
    capacity: 100
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'text-embedding-3-large'
      version: '1'
    }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
  }
}

resource advisoryModel 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: aiAccount
  name: 'gpt-5.6-terra'
  sku: {
    name: 'GlobalStandard'
    capacity: 10
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-5.6-terra'
      version: '2026-07-09'
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
  dependsOn: [embedding]
}

output aiAccountId string = aiAccount.id
output projectId string = project.id
output deploymentName string = embedding.name
output advisoryDeploymentName string = advisoryModel.name
output openAiEndpoint string = 'https://${accountName}.openai.azure.com'
