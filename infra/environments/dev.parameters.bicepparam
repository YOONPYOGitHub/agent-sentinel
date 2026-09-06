using '../platform.bicep'
param location = 'koreacentral'
param suffix = '260814'
param applicationIdentityName = 'id-agent-sentinel-260814'
param connectorIdentityName = 'id-agent-sentinel-connectors-260829'
param teamsIdentityName = 'id-agent-sentinel-teams-260829'
param foundryAccountName = 'ais-agent-sentinel-260814'
param webImageDigest = readEnvironmentVariable('WEB_IMAGE_DIGEST')
param apiImageDigest = readEnvironmentVariable('API_IMAGE_DIGEST')
param jobsImageDigest = readEnvironmentVariable('JOBS_IMAGE_DIGEST')
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
param defenderCloudAppsConnectorEnabled = false
param purviewConnectorEnabled = false
param azureResourceGraphConnectorEnabled = false
param teamsDistributionConnectorEnabled = false
param authMode = 'disabled'
param foundryProjectEndpoint = 'https://ais-agent-sentinel-260814.services.ai.azure.com/api/projects/agent-sentinel-pjt'
param foundryTenantId = '4dfc2b10-8eb6-4454-a9ee-9f337141b596'
param foundryEnvironment = 'validation'
param cosmosDatabase = 'agent-sentinel-db'
param discoveryIntervalMs = '300000'
