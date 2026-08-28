using '../platform.bicep'
param location = 'koreacentral'
param suffix = '260814'
param imageTag = '5c521ff'
param acaEnvDomain = 'blackrock-0e55f941.koreacentral.azurecontainerapps.io'
param tags = {
  application: 'agent-sentinel'
  environment: 'dev'
  'managed-by': 'bicep'
  'data-classification': 'synthetic'
}
param agentSentinelDataMode = 'live'
// Safety gates remain explicit until the staged Entra activation runbook is approved.
param agentSentinelWriteEnabled = false
param entraConnectorEnabled = false
param powerPlatformConnectorEnabled = false
param agent365ConnectorEnabled = false
param authMode = 'disabled'
param foundryProjectEndpoint = 'https://ais-agent-sentinel-260814.services.ai.azure.com/api/projects/agent-sentinel-pjt'
param foundryTenantId = '4dfc2b10-8eb6-4454-a9ee-9f337141b596'
param foundryEnvironment = 'validation'
param cosmosDatabase = 'agent-sentinel-db'
param discoveryIntervalMs = '300000'
