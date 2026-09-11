using '../platform.bicep'

param location = 'koreacentral'
param suffix = 'm098047'
param webImageDigest = readEnvironmentVariable('WEB_IMAGE_DIGEST')
param apiImageDigest = readEnvironmentVariable('API_IMAGE_DIGEST')
param jobsImageDigest = readEnvironmentVariable('JOBS_IMAGE_DIGEST')
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
param entraConnectorEnabled = true
param entraConnectorTenantId = 'ef7d55d6-c61d-4085-9064-4e83adf15ee3'
param entraConnectorEnvironment = 'replacement-validation'
param powerPlatformConnectorEnabled = false
param agent365ConnectorEnabled = true
param agent365ManagedIdentityClientId = '59dbea72-1e91-403a-89cf-e02cdb8da350'
param agent365SourcesJson = '[{"id":"primary","name":"Primary Microsoft Agent 365 tenant","tenantId":"ef7d55d6-c61d-4085-9064-4e83adf15ee3","environment":"replacement-validation","limits":{"maxPages":20,"maxItems":5000,"requestTimeoutMs":15000,"maxRetries":2,"maxRetryAfterMs":30000,"maxResponseBytes":2000000}}]'
param defenderCloudAppsConnectorEnabled = true
param defenderCloudAppsSourcesJson = '[{"id":"primary","name":"Primary Microsoft Defender for Cloud Apps tenant","tenantId":"ef7d55d6-c61d-4085-9064-4e83adf15ee3","environment":"replacement-validation","portalHostname":"mngenvmcap098047.us2.portal.cloudappsecurity.com","credential":{"mode":"default","managedIdentityClientId":"59dbea72-1e91-403a-89cf-e02cdb8da350"}}]'
param purviewConnectorEnabled = true
param purviewTenantId = 'ef7d55d6-c61d-4085-9064-4e83adf15ee3'
param purviewEnvironment = 'replacement-validation'
param azureResourceGraphConnectorEnabled = true
param teamsDistributionConnectorEnabled = true
param teamsDistributionTenantId = 'ef7d55d6-c61d-4085-9064-4e83adf15ee3'
param teamsDistributionEnvironment = 'replacement-validation'
param azureMonitorConnectorEnabled = true

// Create the replacement-tenant API and SPA registrations after the Front Door
// origin exists. Keep authentication and every write path closed until validated.
param authMode = 'disabled'
