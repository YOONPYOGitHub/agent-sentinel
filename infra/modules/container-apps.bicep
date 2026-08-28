param location string
param envName string
param tags object
param subnetId string
param lawWorkspaceId string
@secure()
param lawWorkspaceKey string
param uamiId string
param uamiClientId string
param acrLoginServer string
param cosmosEndpoint string
param pgHost string
param searchEndpoint string
param sbFqdn string
param appInsightsConnectionString string


@description('Data mode for the API and web layers (mock reads deterministic fixture; live reads from Cosmos).')
@allowed(['mock','live'])
param agentSentinelDataMode string = 'mock'

@description('Global write switch. Keep false until JWT authorization and the private write smoke test pass.')
param agentSentinelWriteEnabled bool = false

@description('Azure AI Foundry project endpoint (empty when data mode is mock).')
param foundryProjectEndpoint string = ''

@description('Azure OpenAI account endpoint used by the advisory narrative service.')
param advisoryEndpoint string = ''

@description('Azure OpenAI deployment used by the advisory narrative service.')
param advisoryModelDeployment string = 'gpt-5.6-terra'

@description('Advisory provider mode. Azure mode must not be enabled until JWT authentication protects generation endpoints.')
@allowed(['mock', 'azure'])
param advisoryMode string = 'mock'
@description('Authentication mode for the API layer. Keep disabled until Entra app registration and WAF approval are complete.')
@allowed(['disabled', 'mock', 'jwt'])
param authMode string = 'disabled'

@description('Entra tenant ID for JWT validation. Required when authMode is jwt. Do not set to a real value here.')
param authTenantId string = ''

@description('API audience / application ID URI. Required when authMode is jwt.')
param authAudience string = ''

@description('Expected Entra v2 token issuer. Empty derives the tenant-specific Microsoft identity platform issuer.')
param authIssuer string = ''

@description('Entra JWKS endpoint. Empty derives the tenant-specific Microsoft identity platform discovery endpoint.')
param authJwksUri string = ''

@description('SPA client ID (public config, no secret). Required when authMode is jwt.')
param authSpaClientId string = ''

@description('Comma-separated fully qualified API scopes requested by the SPA. Empty requests the configured read scope.')
param authSpaScopes string = ''

@description('Exact registered SPA redirect URI. Required when authMode is jwt.')
param authSpaRedirectUri string = ''

@description('Exact post-logout redirect URI on the same origin. Required when authMode is jwt.')
param authSpaPostLogoutRedirectUri string = ''

@description('Comma-separated delegated scopes that grant read access.')
param authReadScopes string = 'AgentSentinel.Read'

@description('Comma-separated delegated scopes that grant Analyst capabilities.')
param authWriteScopes string = 'AgentSentinel.Write'

@description('Foundry AAD tenant id (empty when data mode is mock).')
param foundryTenantId string = ''

@description('Foundry environment label (empty when data mode is mock).')
param foundryEnvironment string = 'validation'

@description('Optional JSON array of multiple Foundry tenant/project source definitions.')
param foundrySourcesJson string = ''

@description('Stable aggregate estate tenant. Empty preserves the legacy Foundry tenant boundary.')
param agentSentinelTenantId string = ''

@description('Stable aggregate estate environment.')
param agentSentinelEnvironment string = ''

@description('Enable optional Microsoft Entra identity enrichment. Disabled by default.')
param entraConnectorEnabled bool = false
param entraConnectorTenantId string = ''
param entraSourcesJson string = ''
param entraConnectorEnvironment string = ''
param entraConnectorGraphBaseUrl string = 'https://graph.microsoft.com'
param entraConnectorOwnersEnabled bool = false
param entraConnectorAppRolesEnabled bool = false
param entraConnectorAgentIdentityPreview bool = false
param entraConnectorMaxPages string = '20'
param entraConnectorMaxItems string = '1000'
param entraConnectorRequestTimeoutMs string = '15000'
param entraConnectorMaxRetries string = '2'
param entraConnectorMaxRetryAfterMs string = '30000'

param powerPlatformConnectorEnabled bool = false
param powerPlatformSourcesJson string = ''
param powerPlatformTenantId string = ''
param powerPlatformEnvironment string = ''
param powerPlatformApiBaseUrl string = 'https://api.powerplatform.com'
param powerPlatformPageSize string = '100'
param powerPlatformMaxPages string = '20'
param powerPlatformMaxItems string = '5000'
param powerPlatformRequestTimeoutMs string = '15000'
param powerPlatformMaxRetries string = '2'
param powerPlatformMaxRetryAfterMs string = '30000'
param powerPlatformMaxResponseBytes string = '2000000'

param agent365ConnectorEnabled bool = false
param agent365SourcesJson string = ''
param agent365TenantId string = ''
param agent365Environment string = ''
param agent365GraphBaseUrl string = 'https://graph.microsoft.com'
param agent365MaxPages string = '20'
param agent365MaxItems string = '5000'
param agent365RequestTimeoutMs string = '15000'
param agent365MaxRetries string = '2'
param agent365MaxRetryAfterMs string = '30000'
param agent365MaxResponseBytes string = '2000000'

param defenderCloudAppsConnectorEnabled bool = false
param defenderCloudAppsSourcesJson string = ''
param defenderCloudAppsTenantId string = ''
param defenderCloudAppsEnvironment string = ''
param defenderCloudAppsApiBaseUrl string = ''
param defenderCloudAppsPortalHostname string = ''
param defenderCloudAppsLookbackHours string = '24'
param defenderCloudAppsPageSize string = '100'
param defenderCloudAppsMaxPages string = '20'
param defenderCloudAppsMaxItems string = '4000'
param defenderCloudAppsRequestTimeoutMs string = '15000'
param defenderCloudAppsMaxRetries string = '2'
param defenderCloudAppsMaxRetryAfterMs string = '30000'
param defenderCloudAppsMaxResponseBytes string = '2000000'

param purviewConnectorEnabled bool = false
param purviewSourcesJson string = ''
param purviewTenantId string = ''
param purviewEnvironment string = ''
param purviewGraphBaseUrl string = 'https://graph.microsoft.com'
param purviewMaxPages string = '20'
param purviewMaxItems string = '5000'
param purviewRequestTimeoutMs string = '15000'
param purviewMaxRetries string = '2'
param purviewMaxRetryAfterMs string = '30000'
param purviewMaxResponseBytes string = '2000000'

param azureMonitorConnectorEnabled bool = false
param azureMonitorSourcesJson string = ''

@description('Cosmos database id backing exposure findings and snapshots.')
param cosmosDatabase string = 'agent-sentinel-db'

@description('Ingestion worker discovery interval in milliseconds.')
param discoveryIntervalMs string = '300000'

@description('Required immutable image tag (git SHA). Mutable tags such as latest are not permitted.')
param imageTag string

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: envName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: lawWorkspaceId
        sharedKey: lawWorkspaceKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: subnetId
      internal: true
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

var suffix = last(split(envName, '-'))

// Network boundary enforcement:
//   web  ? external: true, allowInsecure: true ? HTTP/80 reachable from VNet (App Gateway backend).
//          allowInsecure permits App Gateway ? ACA HTTP traffic within the private VNet only.
//          The public internet cannot reach ACA directly; App Gateway is the sole ingress path.
//   api  ? external: false ? reachable only within the ACA environment (nginx proxy from web).
//   jobs ? ingressEnabled: false ? no ingress; Service Bus-triggered only.
var appDefinitions = [
  { slug: 'api',  containerName: 'agent-sentinel-api',  ingressEnabled: true,  externalIngress: false, allowInsecure: false, port: 3001, minReplicas: 1 }
  { slug: 'web',  containerName: 'agent-sentinel-web',  ingressEnabled: true,  externalIngress: true,  allowInsecure: true,  port: 80,   minReplicas: 1 }
  { slug: 'jobs', containerName: 'agent-sentinel-jobs', ingressEnabled: false, externalIngress: false, allowInsecure: false, port: 0,    minReplicas: 0 }
]

var env = [
  { name: 'COSMOS_ENDPOINT',                       value: cosmosEndpoint }
  { name: 'PG_HOST',                               value: pgHost }
  { name: 'SEARCH_ENDPOINT',                       value: searchEndpoint }
  { name: 'SB_FQDN',                               value: sbFqdn }
  { name: 'SERVICE_BUS_FQDN',                      value: sbFqdn }
  { name: 'AGENT_SENTINEL_WRITE_ENABLED',          value: string(agentSentinelWriteEnabled) }
  { name: 'AGENT_SENTINEL_DATA_MODE',             value: agentSentinelDataMode }
  { name: 'FOUNDRY_PROJECT_ENDPOINT',             value: foundryProjectEndpoint }
  { name: 'AGENT_SENTINEL_ADVISORY_ENDPOINT',     value: advisoryEndpoint }
  { name: 'AGENT_SENTINEL_ADVISORY_MODEL',        value: advisoryModelDeployment }
  { name: 'AGENT_SENTINEL_ADVISORY_MODE',         value: advisoryMode }
  { name: 'FOUNDRY_TENANT_ID',                    value: foundryTenantId }
  { name: 'AZURE_TENANT_ID',                      value: foundryTenantId }
  { name: 'FOUNDRY_ENVIRONMENT',                  value: foundryEnvironment }
  { name: 'FOUNDRY_SOURCES_JSON',                 value: foundrySourcesJson }
  { name: 'AGENT_SENTINEL_ENVIRONMENT',           value: empty(agentSentinelEnvironment) ? foundryEnvironment : agentSentinelEnvironment }
  { name: 'ENTRA_CONNECTOR_ENABLED',              value: string(entraConnectorEnabled) }
  { name: 'ENTRA_CONNECTOR_TENANT_ID',            value: entraConnectorTenantId }
  { name: 'ENTRA_SOURCES_JSON',                   value: entraSourcesJson }
  { name: 'ENTRA_CONNECTOR_ENVIRONMENT',          value: entraConnectorEnvironment }
  { name: 'ENTRA_CONNECTOR_GRAPH_BASE_URL',       value: entraConnectorGraphBaseUrl }
  { name: 'ENTRA_CONNECTOR_OWNERS_ENABLED',        value: string(entraConnectorOwnersEnabled) }
  { name: 'ENTRA_CONNECTOR_APP_ROLES_ENABLED',     value: string(entraConnectorAppRolesEnabled) }
  { name: 'ENTRA_CONNECTOR_AGENT_IDENTITY_PREVIEW', value: string(entraConnectorAgentIdentityPreview) }
  { name: 'ENTRA_CONNECTOR_MAX_PAGES',             value: entraConnectorMaxPages }
  { name: 'ENTRA_CONNECTOR_MAX_ITEMS',             value: entraConnectorMaxItems }
  { name: 'ENTRA_CONNECTOR_REQUEST_TIMEOUT_MS',    value: entraConnectorRequestTimeoutMs }
  { name: 'ENTRA_CONNECTOR_MAX_RETRIES',           value: entraConnectorMaxRetries }
  { name: 'ENTRA_CONNECTOR_MAX_RETRY_AFTER_MS',    value: entraConnectorMaxRetryAfterMs }
  { name: 'POWER_PLATFORM_CONNECTOR_ENABLED',       value: string(powerPlatformConnectorEnabled) }
  { name: 'POWER_PLATFORM_SOURCES_JSON',            value: powerPlatformSourcesJson }
  { name: 'POWER_PLATFORM_TENANT_ID',               value: powerPlatformTenantId }
  { name: 'POWER_PLATFORM_ENVIRONMENT',             value: powerPlatformEnvironment }
  { name: 'POWER_PLATFORM_API_BASE_URL',            value: powerPlatformApiBaseUrl }
  { name: 'POWER_PLATFORM_PAGE_SIZE',               value: powerPlatformPageSize }
  { name: 'POWER_PLATFORM_MAX_PAGES',               value: powerPlatformMaxPages }
  { name: 'POWER_PLATFORM_MAX_ITEMS',               value: powerPlatformMaxItems }
  { name: 'POWER_PLATFORM_REQUEST_TIMEOUT_MS',      value: powerPlatformRequestTimeoutMs }
  { name: 'POWER_PLATFORM_MAX_RETRIES',             value: powerPlatformMaxRetries }
  { name: 'POWER_PLATFORM_MAX_RETRY_AFTER_MS',      value: powerPlatformMaxRetryAfterMs }
  { name: 'POWER_PLATFORM_MAX_RESPONSE_BYTES',      value: powerPlatformMaxResponseBytes }
  { name: 'AGENT365_CONNECTOR_ENABLED',             value: string(agent365ConnectorEnabled) }
  { name: 'AGENT365_SOURCES_JSON',                 value: agent365ConnectorEnabled ? agent365SourcesJson : '' }
  { name: 'AGENT365_TENANT_ID',                   value: agent365ConnectorEnabled ? agent365TenantId : '' }
  { name: 'AGENT365_ENVIRONMENT',                 value: agent365ConnectorEnabled ? agent365Environment : '' }
  { name: 'AGENT365_GRAPH_BASE_URL',                value: agent365GraphBaseUrl }
  { name: 'AGENT365_MAX_PAGES',                     value: agent365MaxPages }
  { name: 'AGENT365_MAX_ITEMS',                     value: agent365MaxItems }
  { name: 'AGENT365_REQUEST_TIMEOUT_MS',            value: agent365RequestTimeoutMs }
  { name: 'AGENT365_MAX_RETRIES',                   value: agent365MaxRetries }
  { name: 'AGENT365_MAX_RETRY_AFTER_MS',            value: agent365MaxRetryAfterMs }
  { name: 'AGENT365_MAX_RESPONSE_BYTES',            value: agent365MaxResponseBytes }
  { name: 'DEFENDER_CLOUD_APPS_CONNECTOR_ENABLED',  value: string(defenderCloudAppsConnectorEnabled) }
  { name: 'DEFENDER_CLOUD_APPS_SOURCES_JSON',       value: defenderCloudAppsConnectorEnabled ? defenderCloudAppsSourcesJson : '' }
  { name: 'DEFENDER_CLOUD_APPS_TENANT_ID',          value: defenderCloudAppsConnectorEnabled ? defenderCloudAppsTenantId : '' }
  { name: 'DEFENDER_CLOUD_APPS_ENVIRONMENT',        value: defenderCloudAppsConnectorEnabled ? defenderCloudAppsEnvironment : '' }
  { name: 'DEFENDER_CLOUD_APPS_API_BASE_URL',       value: defenderCloudAppsConnectorEnabled ? defenderCloudAppsApiBaseUrl : '' }
  { name: 'DEFENDER_CLOUD_APPS_PORTAL_HOSTNAME',    value: defenderCloudAppsConnectorEnabled ? defenderCloudAppsPortalHostname : '' }
  { name: 'DEFENDER_CLOUD_APPS_LOOKBACK_HOURS',     value: defenderCloudAppsLookbackHours }
  { name: 'DEFENDER_CLOUD_APPS_PAGE_SIZE',          value: defenderCloudAppsPageSize }
  { name: 'DEFENDER_CLOUD_APPS_MAX_PAGES',          value: defenderCloudAppsMaxPages }
  { name: 'DEFENDER_CLOUD_APPS_MAX_ITEMS',          value: defenderCloudAppsMaxItems }
  { name: 'DEFENDER_CLOUD_APPS_REQUEST_TIMEOUT_MS', value: defenderCloudAppsRequestTimeoutMs }
  { name: 'DEFENDER_CLOUD_APPS_MAX_RETRIES',        value: defenderCloudAppsMaxRetries }
  { name: 'DEFENDER_CLOUD_APPS_MAX_RETRY_AFTER_MS', value: defenderCloudAppsMaxRetryAfterMs }
  { name: 'DEFENDER_CLOUD_APPS_MAX_RESPONSE_BYTES', value: defenderCloudAppsMaxResponseBytes }
  { name: 'PURVIEW_CONNECTOR_ENABLED',              value: string(purviewConnectorEnabled) }
  { name: 'PURVIEW_SOURCES_JSON',                   value: purviewConnectorEnabled ? purviewSourcesJson : '' }
  { name: 'PURVIEW_TENANT_ID',                      value: purviewConnectorEnabled ? purviewTenantId : '' }
  { name: 'PURVIEW_ENVIRONMENT',                    value: purviewConnectorEnabled ? purviewEnvironment : '' }
  { name: 'PURVIEW_GRAPH_BASE_URL',                 value: purviewGraphBaseUrl }
  { name: 'PURVIEW_MAX_PAGES',                      value: purviewMaxPages }
  { name: 'PURVIEW_MAX_ITEMS',                      value: purviewMaxItems }
  { name: 'PURVIEW_REQUEST_TIMEOUT_MS',             value: purviewRequestTimeoutMs }
  { name: 'PURVIEW_MAX_RETRIES',                    value: purviewMaxRetries }
  { name: 'PURVIEW_MAX_RETRY_AFTER_MS',             value: purviewMaxRetryAfterMs }
  { name: 'PURVIEW_MAX_RESPONSE_BYTES',             value: purviewMaxResponseBytes }
  { name: 'AZURE_MONITOR_SOURCES_JSON',            value: azureMonitorConnectorEnabled ? azureMonitorSourcesJson : '' }
  { name: 'AZURE_MONITOR_WORKSPACE_ID',            value: azureMonitorConnectorEnabled && empty(azureMonitorSourcesJson) ? lawWorkspaceId : '' }
  { name: 'AZURE_MONITOR_TENANT_ID',               value: azureMonitorConnectorEnabled && empty(azureMonitorSourcesJson) ? foundryTenantId : '' }
  { name: 'AZURE_MONITOR_ENVIRONMENT',             value: azureMonitorConnectorEnabled && empty(azureMonitorSourcesJson) ? foundryEnvironment : '' }
  { name: 'AGENT_SENTINEL_TENANT_ID',             value: empty(agentSentinelTenantId) ? foundryTenantId : agentSentinelTenantId }
  { name: 'COSMOS_DATABASE',                      value: cosmosDatabase }
  { name: 'COSMOS_GOVERNANCE_CONTAINER',          value: 'governance-cases' }
  { name: 'COSMOS_MANIFEST_INGESTIONS_CONTAINER', value: 'manifest-ingestions' }
  { name: 'DISCOVERY_INTERVAL_MS',                value: discoveryIntervalMs }
  { name: 'AGENT_SENTINEL_CONNECTOR',             value: agentSentinelDataMode == 'live' ? 'foundry' : 'mock' }
  { name: 'AZURE_CLIENT_ID',                       value: uamiClientId }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
  { name: 'AUTH_MODE',                             value: authMode }
  { name: 'AUTH_TENANT_ID',                        value: authTenantId }
  { name: 'AUTH_AUDIENCE',                         value: authAudience }
  { name: 'AUTH_ISSUER',                           value: authIssuer }
  { name: 'AUTH_JWKS_URI',                         value: authJwksUri }
  { name: 'AUTH_SPA_CLIENT_ID',                    value: authSpaClientId }
  { name: 'AUTH_SPA_SCOPES',                       value: authSpaScopes }
  { name: 'AUTH_SPA_REDIRECT_URI',                 value: authSpaRedirectUri }
  { name: 'AUTH_SPA_POST_LOGOUT_REDIRECT_URI',     value: authSpaPostLogoutRedirectUri }
  { name: 'AUTH_READ_SCOPES',                      value: authReadScopes }
  { name: 'AUTH_WRITE_SCOPES',                     value: authWriteScopes }
]

resource apps 'Microsoft.App/containerApps@2024-03-01' = [for app in appDefinitions: {
  name: format('{0}-as-{1}', app.slug, suffix)
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uamiId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          server: acrLoginServer
          identity: uamiId
        }
      ]
      ingress: app.ingressEnabled ? {
        external: app.externalIngress
        targetPort: app.port
        transport: 'auto'
        allowInsecure: app.allowInsecure
      } : null
    }
    template: {
      containers: [
        {
          name: app.containerName
          image: format('{0}/{1}:{2}', acrLoginServer, app.containerName, imageTag)
          env: env
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: app.minReplicas
        maxReplicas: 2
      }
    }
  }
}]

output environmentId string = environment.id
output acaEnvId string = environment.id
// apps[0] = api (internal ingress; FQDN is only resolvable within ACA environment)
// apps[1] = web (external within VNet; App Gateway backend target)
output apiFqdn string = apps[0].properties.configuration.ingress.fqdn
output webFqdn string = apps[1].properties.configuration.ingress.fqdn
output envDefaultDomain string = environment.properties.defaultDomain
output envStaticIp string = environment.properties.staticIp
