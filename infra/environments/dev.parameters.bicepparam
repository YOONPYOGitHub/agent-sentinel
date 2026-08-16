using '../platform.bicep'
param location = 'koreacentral'
param suffix = '260814'
param imageTag = '7e530f5'
param acaEnvDomain = 'blackrock-0e55f941.koreacentral.azurecontainerapps.io'
param tags = {
  application: 'agent-sentinel'
  environment: 'dev'
  'managed-by': 'bicep'
  'data-classification': 'synthetic'
}
