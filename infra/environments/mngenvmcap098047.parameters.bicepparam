using '../platform.bicep'

param location = 'koreacentral'
param suffix = 'm098047'
param imageTag = '5d48113'
param tags = {
  application: 'agent-sentinel'
  environment: 'replacement-validation'
  'managed-by': 'bicep'
  'data-classification': 'synthetic'
}

param agentSentinelDataMode = 'live'
param agentSentinelWriteEnabled = false
param foundryProjectEndpoint = 'https://ais-agent-sentinel-m098047.services.ai.azure.com/api/projects/agent-sentinel-pjt'
param foundryTenantId = 'ef7d55d6-c61d-4085-9064-4e83adf15ee3'
param foundryEnvironment = 'replacement-validation'
param agentSentinelTenantId = 'ef7d55d6-c61d-4085-9064-4e83adf15ee3'
param agentSentinelEnvironment = 'replacement-validation'
param acaEnvDomain = 'kindflower-ef2d40f6.koreacentral.azurecontainerapps.io'

// Tenant consent, workload identity federation, and bounded probes are separate gates.
param entraConnectorEnabled = false
param powerPlatformConnectorEnabled = false
param agent365ConnectorEnabled = false
param defenderCloudAppsConnectorEnabled = false
param purviewConnectorEnabled = false
param azureResourceGraphConnectorEnabled = false
param teamsDistributionConnectorEnabled = false
param azureMonitorConnectorEnabled = false

// Create the replacement-tenant API and SPA registrations after the Front Door
// origin exists. Keep authentication and every write path closed until validated.
param authMode = 'disabled'
