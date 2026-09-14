targetScope = 'resourceGroup'
param location string = resourceGroup().location
param suffix string = '260814'
@description('Optional existing application UAMI name. Empty derives a portable name from suffix.')
param applicationIdentityName string = ''
@description('Optional existing shared connector UAMI name. Empty derives a portable name from suffix.')
param connectorIdentityName string = ''
@description('Optional existing Teams connector UAMI name. Empty derives a portable name from suffix.')
param teamsIdentityName string = ''
@description('Optional Foundry account name. Empty derives a portable name from suffix.')
param foundryAccountName string = ''
@description('Foundry project name.')
param foundryProjectName string = 'agent-sentinel-pjt'
param tags object = {
  application: 'agent-sentinel'
  environment: 'dev'
  'managed-by': 'bicep'
  'data-classification': 'synthetic'
}

@description('Immutable 40-character source commit deployed across web, API, and jobs.')
@minLength(40)
@maxLength(40)
param deploymentCommitSha string

@description('Required canonical SHA-256 digest for the web image.')
@minLength(71)
@maxLength(71)
param webImageDigest string
@description('Required canonical SHA-256 digest for the API image.')
@minLength(71)
@maxLength(71)
param apiImageDigest string
@description('Required canonical SHA-256 digest for the jobs image.')
@minLength(71)
@maxLength(71)
param jobsImageDigest string

@description('Data mode for the API tier (mock or live).')
@allowed(['mock','live'])
param agentSentinelDataMode string = 'mock'

@description('Global write switch. Keep false until JWT authorization and a private authenticated write test pass.')
param agentSentinelWriteEnabled bool = false

@description('Deploy the reviewed Front Door anonymous-mutation guard. Keep false until JWT read validation passes; enable before changing the write switch.')
param frontDoorAuthenticatedMutationGuardEnabled bool = false

@description('Foundry project endpoint URL for live mode.')
param foundryProjectEndpoint string = ''

@description('Foundry AAD tenant id for live mode.')
param foundryTenantId string = ''

@description('Foundry environment label for live mode.')
param foundryEnvironment string = 'validation'

@description('Optional JSON array of multiple Foundry tenant/project source definitions. Empty preserves the legacy single-project settings.')
param foundrySourcesJson string = ''

@description('Stable Agent Sentinel estate tenant used for aggregate persistence. Empty uses foundryTenantId for backward compatibility.')
param agentSentinelTenantId string = ''

@description('Stable Agent Sentinel estate environment used for aggregate persistence.')
param agentSentinelEnvironment string = ''

@description('Enable optional Microsoft Entra identity enrichment. Keep false until tenant-admin consent is complete.')
param entraConnectorEnabled bool = false
@description('Microsoft Entra tenant ID for identity enrichment. Empty while disabled.')
param entraConnectorTenantId string = ''
@description('Optional JSON array of Entra sources matched by id to Foundry sources.')
param entraSourcesJson string = ''
@description('Optional JSON array of explicit estate-scoped Foundry-to-Entra inventory authority bindings.')
param entraRunsAsBindingsJson string = ''
@description('Environment boundary for Entra identity enrichment. Must exactly match Foundry.')
param entraConnectorEnvironment string = ''
@description('Microsoft Graph resource base. Restricted by connector validation to the public Graph host.')
param entraConnectorGraphBaseUrl string = 'https://graph.microsoft.com'
@description('Enable bounded service-principal owner enrichment.')
param entraConnectorOwnersEnabled bool = false
@description('Enable bounded service-principal app-role assignment enrichment.')
param entraConnectorAppRolesEnabled bool = false
@description('Enable optional beta Agent Identity classification. Requires separate permission review.')
param entraConnectorAgentIdentityPreview bool = false
param entraConnectorMaxPages string = '20'
param entraConnectorMaxItems string = '1000'
param entraConnectorRequestTimeoutMs string = '15000'
param entraConnectorMaxRetries string = '2'
param entraConnectorMaxRetryAfterMs string = '30000'

@description('Enable read-only Power Platform ResourceQuery agent inventory. Keep false until tenant-scope read RBAC is approved.')
param powerPlatformConnectorEnabled bool = false
@description('Optional JSON array of up to 50 independent Power Platform tenant/environment sources.')
param powerPlatformSourcesJson string = ''
@description('Legacy primary Power Platform tenant ID. Empty while disabled or when source JSON is used.')
param powerPlatformTenantId string = ''
@description('Legacy primary Power Platform environment ID. Empty while disabled or when source JSON is used.')
param powerPlatformEnvironment string = ''
@description('Power Platform API resource base. Connector validation only permits the official public host.')
param powerPlatformApiBaseUrl string = 'https://api.powerplatform.com'
param powerPlatformPageSize string = '100'
param powerPlatformMaxPages string = '20'
param powerPlatformMaxItems string = '5000'
param powerPlatformRequestTimeoutMs string = '15000'
param powerPlatformMaxRetries string = '2'
param powerPlatformMaxRetryAfterMs string = '30000'
param powerPlatformMaxResponseBytes string = '2000000'

@description('Enable read-only Microsoft Agent 365 Graph v1.0 package catalog inventory. Keep false until licensing and tenant-admin application consent are approved.')
param agent365ConnectorEnabled bool = false
@description('Approved existing Agent 365 connector UAMI client ID. Empty keeps Agent 365 inactive.')
@allowed([
  ''
  '59dbea72-1e91-403a-89cf-e02cdb8da350'
])
param agent365ManagedIdentityClientId string = ''
@description('Optional JSON array of up to 50 independent Microsoft Agent 365 tenant sources.')
param agent365SourcesJson string = ''
@description('Legacy primary Agent 365 tenant ID. Empty while disabled or when source JSON is used.')
param agent365TenantId string = ''
@description('Legacy primary Agent 365 environment label. Empty while disabled or when source JSON is used.')
param agent365Environment string = ''
@description('Microsoft Graph base. Connector validation permits exactly the official Global service origin.')
param agent365GraphBaseUrl string = 'https://graph.microsoft.com'
param agent365MaxPages string = '20'
param agent365MaxItems string = '5000'
param agent365RequestTimeoutMs string = '15000'
param agent365MaxRetries string = '2'
param agent365MaxRetryAfterMs string = '30000'
param agent365MaxResponseBytes string = '2000000'

@description('Enable read-only Microsoft Defender for Cloud Apps alert and activity evidence. Keep false until licensing, tenant portal, and Investigation.Read application consent are approved.')
param defenderCloudAppsConnectorEnabled bool = false
@description('Optional JSON array of up to 50 independent Defender for Cloud Apps tenant sources.')
param defenderCloudAppsSourcesJson string = ''
@description('Legacy primary Defender for Cloud Apps tenant ID. Empty while disabled or when source JSON is used.')
param defenderCloudAppsTenantId string = ''
@description('Legacy primary local aggregate environment label. Empty while disabled or when source JSON is used.')
param defenderCloudAppsEnvironment string = ''
@description('Legacy primary official tenant portal HTTPS origin. Empty while disabled or when source JSON is used.')
param defenderCloudAppsApiBaseUrl string = ''
@description('Alternative legacy primary official tenant portal hostname. Empty while disabled or when API base URL is used.')
param defenderCloudAppsPortalHostname string = ''
param defenderCloudAppsLookbackHours string = '24'
param defenderCloudAppsPageSize string = '100'
param defenderCloudAppsMaxPages string = '20'
param defenderCloudAppsMaxItems string = '4000'
param defenderCloudAppsRequestTimeoutMs string = '15000'
param defenderCloudAppsMaxRetries string = '2'
param defenderCloudAppsMaxRetryAfterMs string = '30000'
param defenderCloudAppsMaxResponseBytes string = '2000000'

@description('Enable read-only Microsoft Purview sensitivity-label catalog evidence. Keep false until tenant-admin SensitivityLabel.Read application consent is approved.')
param purviewConnectorEnabled bool = false
@description('Optional JSON array of up to 50 unique Microsoft Purview tenant sources.')
param purviewSourcesJson string = ''
@description('Legacy primary Purview tenant ID. Empty while disabled or when source JSON is used.')
param purviewTenantId string = ''
@description('Legacy primary local aggregate environment label. Empty while disabled or when source JSON is used.')
param purviewEnvironment string = ''
@description('Microsoft Graph base. Connector validation permits exactly the official Global service origin.')
param purviewGraphBaseUrl string = 'https://graph.microsoft.com'
param purviewMaxPages string = '20'
param purviewMaxItems string = '5000'
param purviewRequestTimeoutMs string = '15000'
param purviewMaxRetries string = '2'
param purviewMaxRetryAfterMs string = '30000'
param purviewMaxResponseBytes string = '2000000'

@description('Enable bounded read-only Azure Resource Graph inventory. Existing resource-scoped access is used unless broader Reader scope is separately approved.')
param azureResourceGraphConnectorEnabled bool = false
@description('Optional JSON array of Azure Resource Graph tenant/subscription sources.')
param azureResourceGraphSourcesJson string = ''
param azureResourceGraphPageSize string = '200'
param azureResourceGraphMaxPages string = '20'
param azureResourceGraphMaxItems string = '5000'
param azureResourceGraphRequestTimeoutMs string = '15000'
param azureResourceGraphMaxRetries string = '2'
param azureResourceGraphMaxRetryAfterMs string = '30000'
param azureResourceGraphMaxResponseBytes string = '2000000'

@description('Enable read-only Microsoft Teams organization app catalog evidence. Keep false until tenant-admin AppCatalog.Read.All application consent is approved.')
param teamsDistributionConnectorEnabled bool = false
@description('Optional JSON array of up to 50 unique Microsoft Teams tenant catalog sources.')
param teamsDistributionSourcesJson string = ''
@description('Legacy primary Teams catalog tenant ID. Empty while disabled or when source JSON is used.')
param teamsDistributionTenantId string = ''
@description('Legacy primary local aggregate environment label. Empty while disabled or when source JSON is used.')
param teamsDistributionEnvironment string = ''
@description('Microsoft Graph base. Connector validation permits exactly the official Global service origin.')
param teamsDistributionGraphBaseUrl string = 'https://graph.microsoft.com'
param teamsDistributionMaxPages string = '20'
param teamsDistributionMaxItems string = '5000'
param teamsDistributionRequestTimeoutMs string = '15000'
param teamsDistributionMaxRetries string = '2'
param teamsDistributionMaxRetryAfterMs string = '30000'
param teamsDistributionMaxResponseBytes string = '2000000'

@description('Enable read-only Azure Monitor OTel telemetry. Disabled until instrumentation and workspace RBAC are validated.')
param azureMonitorConnectorEnabled bool = false
@description('Optional JSON array of Azure Monitor sources matched by id to Foundry sources.')
param azureMonitorSourcesJson string = ''

@description('Cosmos database id backing exposure findings.')
param cosmosDatabase string = 'agent-sentinel-db'

@description('Manifest ingestion container selected after reviewed copy validation. Keep the legacy container until cutover is approved.')
@allowed(['manifest-ingestions', 'manifest-ingestions-v2'])
param manifestIngestionsContainerName string = 'manifest-ingestions'

@description('Ingestion worker discovery interval in milliseconds.')
param discoveryIntervalMs string = '300000'
@description('API authentication mode. Keep disabled until Entra and WAF configuration are approved.')
@allowed(['disabled', 'mock', 'jwt'])
param authMode string = 'disabled'
@description('Entra tenant ID used for API token validation when authMode is jwt.')
param authTenantId string = ''
@description('API application ID URI / audience used for token validation.')
param authAudience string = ''
@description('Expected Entra v2 token issuer. Empty derives the tenant-specific issuer.')
param authIssuer string = ''
@description('Entra JWKS URI. Empty derives the tenant-specific discovery endpoint.')
param authJwksUri string = ''
@description('Public SPA application client ID. Contains no secret.')
param authSpaClientId string = ''
@description('Comma-separated fully qualified delegated API scopes requested by the SPA.')
param authSpaScopes string = ''
@description('Exact registered SPA redirect URI.')
param authSpaRedirectUri string = ''
@description('Exact post-logout redirect URI on the same origin.')
param authSpaPostLogoutRedirectUri string = ''
@description('Comma-separated delegated scopes that grant read access.')
param authReadScopes string = 'AgentSentinel.Read'
@description('Comma-separated delegated scopes that grant Analyst capabilities.')
param authWriteScopes string = 'AgentSentinel.Write'

@description('ACA environment default domain for private DNS zone creation (e.g. blackrock-0e55f941.koreacentral.azurecontainerapps.io). Empty string = skip DNS zone (use after first deployment). See deployment.md for post-deploy DNS step.')
param acaEnvDomain string = ''

var effectiveApplicationIdentityName = empty(applicationIdentityName) ? 'id-agent-sentinel-${suffix}' : applicationIdentityName
var effectiveConnectorIdentityName = empty(connectorIdentityName) ? 'id-agent-sentinel-connectors-${suffix}' : connectorIdentityName
var effectiveTeamsIdentityName = empty(teamsIdentityName) ? 'id-agent-sentinel-teams-${suffix}' : teamsIdentityName
var effectiveFoundryAccountName = empty(foundryAccountName) ? 'ais-agent-sentinel-${suffix}' : foundryAccountName
var validatedEntraRunsAsBindingsJson = string(empty(entraRunsAsBindingsJson) ? [] : json(entraRunsAsBindingsJson))

module network './modules/network.bicep' = {
  name: 'network'
  params: {
    location: location
    vnetName: format('vnet-as-{0}', suffix)
    tags: tags
  }
}

module observability './modules/observability.bicep' = {
  name: 'observability'
  params: {
    location: location
    workspaceName: format('law-as-{0}', suffix)
    appInsightsName: format('appi-as-{0}', suffix)
    tags: tags
  }
}

module foundry './modules/foundry.bicep' = {
  name: 'foundry'
  params: {
    accountName: effectiveFoundryAccountName
    projectName: foundryProjectName
    location: location
  }
}

module registry './modules/registry.bicep' = {
  name: 'registry'
  params: {
    location: location
    acrName: format('acr{0}', suffix)
    tags: tags
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    vnetId: network.outputs.vnetId
  }
  dependsOn: [network]
}

module keyVault './modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    location: location
    kvName: format('kv-as-{0}', suffix)
    tags: tags
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    vnetId: network.outputs.vnetId
  }
  dependsOn: [network]
}

module cosmos './modules/cosmos.bicep' = {
  name: 'cosmos'
  params: {
    location: location
    accountName: format('cosmos-as-{0}', suffix)
    tags: tags
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    vnetId: network.outputs.vnetId
  }
  dependsOn: [network]
}

module search './modules/search.bicep' = {
  name: 'search'
  params: {
    location: location
    searchName: format('search-as-{0}', suffix)
    tags: tags
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    vnetId: network.outputs.vnetId
  }
  dependsOn: [network]
}

module serviceBus './modules/servicebus.bicep' = {
  name: 'servicebus'
  params: {
    location: location
    sbName: format('sb-as-{0}', suffix)
    tags: tags
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    vnetId: network.outputs.vnetId
  }
  dependsOn: [network]
}

module identity './modules/identity.bicep' = {
  name: 'identity'
  params: {
    location: location
    tags: tags
    acrId: registry.outputs.id
    cosmosId: cosmos.outputs.id
    kvId: keyVault.outputs.id
    aiAccountId: foundry.outputs.aiAccountId
    sbNamespaceId: serviceBus.outputs.id
    searchId: search.outputs.id
    lawWorkspaceId: observability.outputs.workspaceId
    identityName: effectiveApplicationIdentityName
    connectorIdentityName: effectiveConnectorIdentityName
    teamsIdentityName: effectiveTeamsIdentityName
  }
  dependsOn: [registry, cosmos, keyVault, foundry, serviceBus, search, observability]
}

module postgres './modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    location: location
    serverName: format('pg-as-{0}', suffix)
    tags: tags
    delegatedSubnetResourceId: network.outputs.delegatedSubnetResourceId
    privateDnsZoneArmResourceId: network.outputs.postgresPrivateDnsZoneId
    adminObjectId: identity.outputs.principalId
    adminPrincipalName: identity.outputs.name
  }
  dependsOn: [network, identity]
}

module containerApps './modules/container-apps.bicep' = {
  name: 'container-apps'
  params: {
    location: location
    envName: format('aca-env-{0}', suffix)
    tags: tags
    subnetId: network.outputs.appsSubnetId
    lawWorkspaceId: observability.outputs.workspaceCustomerId
    lawWorkspaceKey: observability.outputs.workspaceSharedKey
    uamiId: identity.outputs.id
    uamiClientId: identity.outputs.clientId
    connectorUamiId: identity.outputs.connectorIdentityId
    connectorUamiClientId: identity.outputs.connectorIdentityClientId
    teamsUamiId: identity.outputs.teamsIdentityId
    teamsUamiClientId: identity.outputs.teamsIdentityClientId
    acrLoginServer: registry.outputs.loginServer
    cosmosEndpoint: cosmos.outputs.endpoint
    pgHost: postgres.outputs.fqdn
    searchEndpoint: search.outputs.endpoint
    sbFqdn: serviceBus.outputs.fqdn
    appInsightsConnectionString: observability.outputs.appInsightsConnectionString
    deploymentCommitSha: deploymentCommitSha
    webImageDigest: webImageDigest
    apiImageDigest: apiImageDigest
    jobsImageDigest: jobsImageDigest
    agentSentinelDataMode: agentSentinelDataMode
    agentSentinelWriteEnabled: agentSentinelWriteEnabled
    foundryProjectEndpoint: foundryProjectEndpoint
    advisoryEndpoint: foundry.outputs.openAiEndpoint
    advisoryModelDeployment: foundry.outputs.advisoryDeploymentName
    advisoryMode: 'mock'
    foundryTenantId: foundryTenantId
    foundryEnvironment: foundryEnvironment
    foundrySourcesJson: foundrySourcesJson
    agentSentinelTenantId: agentSentinelTenantId
    agentSentinelEnvironment: agentSentinelEnvironment
    entraConnectorEnabled: entraConnectorEnabled
    entraConnectorTenantId: entraConnectorTenantId
    entraSourcesJson: entraSourcesJson
    entraRunsAsBindingsJson: validatedEntraRunsAsBindingsJson
    entraConnectorEnvironment: entraConnectorEnvironment
    entraConnectorGraphBaseUrl: entraConnectorGraphBaseUrl
    entraConnectorOwnersEnabled: entraConnectorOwnersEnabled
    entraConnectorAppRolesEnabled: entraConnectorAppRolesEnabled
    entraConnectorAgentIdentityPreview: entraConnectorAgentIdentityPreview
    entraConnectorMaxPages: entraConnectorMaxPages
    entraConnectorMaxItems: entraConnectorMaxItems
    entraConnectorRequestTimeoutMs: entraConnectorRequestTimeoutMs
    entraConnectorMaxRetries: entraConnectorMaxRetries
    entraConnectorMaxRetryAfterMs: entraConnectorMaxRetryAfterMs
    powerPlatformConnectorEnabled: powerPlatformConnectorEnabled
    powerPlatformSourcesJson: powerPlatformSourcesJson
    powerPlatformTenantId: powerPlatformTenantId
    powerPlatformEnvironment: powerPlatformEnvironment
    powerPlatformApiBaseUrl: powerPlatformApiBaseUrl
    powerPlatformPageSize: powerPlatformPageSize
    powerPlatformMaxPages: powerPlatformMaxPages
    powerPlatformMaxItems: powerPlatformMaxItems
    powerPlatformRequestTimeoutMs: powerPlatformRequestTimeoutMs
    powerPlatformMaxRetries: powerPlatformMaxRetries
    powerPlatformMaxRetryAfterMs: powerPlatformMaxRetryAfterMs
    powerPlatformMaxResponseBytes: powerPlatformMaxResponseBytes
    agent365ConnectorEnabled: agent365ConnectorEnabled
    agent365ManagedIdentityClientId: agent365ManagedIdentityClientId
    agent365SourcesJson: agent365SourcesJson
    agent365TenantId: agent365TenantId
    agent365Environment: agent365Environment
    agent365GraphBaseUrl: agent365GraphBaseUrl
    agent365MaxPages: agent365MaxPages
    agent365MaxItems: agent365MaxItems
    agent365RequestTimeoutMs: agent365RequestTimeoutMs
    agent365MaxRetries: agent365MaxRetries
    agent365MaxRetryAfterMs: agent365MaxRetryAfterMs
    agent365MaxResponseBytes: agent365MaxResponseBytes
    defenderCloudAppsConnectorEnabled: defenderCloudAppsConnectorEnabled
    defenderCloudAppsSourcesJson: defenderCloudAppsSourcesJson
    defenderCloudAppsTenantId: defenderCloudAppsTenantId
    defenderCloudAppsEnvironment: defenderCloudAppsEnvironment
    defenderCloudAppsApiBaseUrl: defenderCloudAppsApiBaseUrl
    defenderCloudAppsPortalHostname: defenderCloudAppsPortalHostname
    defenderCloudAppsLookbackHours: defenderCloudAppsLookbackHours
    defenderCloudAppsPageSize: defenderCloudAppsPageSize
    defenderCloudAppsMaxPages: defenderCloudAppsMaxPages
    defenderCloudAppsMaxItems: defenderCloudAppsMaxItems
    defenderCloudAppsRequestTimeoutMs: defenderCloudAppsRequestTimeoutMs
    defenderCloudAppsMaxRetries: defenderCloudAppsMaxRetries
    defenderCloudAppsMaxRetryAfterMs: defenderCloudAppsMaxRetryAfterMs
    defenderCloudAppsMaxResponseBytes: defenderCloudAppsMaxResponseBytes
    purviewConnectorEnabled: purviewConnectorEnabled
    purviewSourcesJson: purviewSourcesJson
    purviewTenantId: purviewTenantId
    purviewEnvironment: purviewEnvironment
    purviewGraphBaseUrl: purviewGraphBaseUrl
    purviewMaxPages: purviewMaxPages
    purviewMaxItems: purviewMaxItems
    purviewRequestTimeoutMs: purviewRequestTimeoutMs
    purviewMaxRetries: purviewMaxRetries
    purviewMaxRetryAfterMs: purviewMaxRetryAfterMs
    purviewMaxResponseBytes: purviewMaxResponseBytes
    azureResourceGraphConnectorEnabled: azureResourceGraphConnectorEnabled
    azureResourceGraphSourcesJson: azureResourceGraphSourcesJson
    azureResourceGraphPageSize: azureResourceGraphPageSize
    azureResourceGraphMaxPages: azureResourceGraphMaxPages
    azureResourceGraphMaxItems: azureResourceGraphMaxItems
    azureResourceGraphRequestTimeoutMs: azureResourceGraphRequestTimeoutMs
    azureResourceGraphMaxRetries: azureResourceGraphMaxRetries
    azureResourceGraphMaxRetryAfterMs: azureResourceGraphMaxRetryAfterMs
    azureResourceGraphMaxResponseBytes: azureResourceGraphMaxResponseBytes
    teamsDistributionConnectorEnabled: teamsDistributionConnectorEnabled
    teamsDistributionSourcesJson: teamsDistributionSourcesJson
    teamsDistributionTenantId: teamsDistributionTenantId
    teamsDistributionEnvironment: teamsDistributionEnvironment
    teamsDistributionGraphBaseUrl: teamsDistributionGraphBaseUrl
    teamsDistributionMaxPages: teamsDistributionMaxPages
    teamsDistributionMaxItems: teamsDistributionMaxItems
    teamsDistributionRequestTimeoutMs: teamsDistributionRequestTimeoutMs
    teamsDistributionMaxRetries: teamsDistributionMaxRetries
    teamsDistributionMaxRetryAfterMs: teamsDistributionMaxRetryAfterMs
    teamsDistributionMaxResponseBytes: teamsDistributionMaxResponseBytes
    azureMonitorConnectorEnabled: azureMonitorConnectorEnabled
    azureMonitorSourcesJson: azureMonitorSourcesJson
    cosmosDatabase: cosmosDatabase
    manifestIngestionsContainerName: manifestIngestionsContainerName
    discoveryIntervalMs: discoveryIntervalMs
    authMode: authMode
    authTenantId: authTenantId
    authAudience: authAudience
    authIssuer: authIssuer
    authJwksUri: authJwksUri
    authSpaClientId: authSpaClientId
    authSpaScopes: authSpaScopes
    authSpaRedirectUri: authSpaRedirectUri
    authSpaPostLogoutRedirectUri: authSpaPostLogoutRedirectUri
    authReadScopes: authReadScopes
    authWriteScopes: authWriteScopes
  }
  dependsOn: [network, observability, foundry, identity, registry, cosmos, postgres, search, serviceBus]
}

// ?? ACA Environment Private DNS Zone ?????????????????????????????????????????
// ACA internal environments require a private DNS zone so the App Gateway
// can resolve *.{envDomain} to the ACA static IP within the VNet.
// acaEnvDomain is left empty on the first deploy (domain is not yet known).
// After first deploy, read `az containerapp env show ... --query defaultDomain`
// and set acaEnvDomain in dev.parameters.bicepparam for subsequent deploys.
// See deployment.md "Phase D" for the manual first-time DNS step.
resource acaPrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (!empty(acaEnvDomain)) {
  name: empty(acaEnvDomain) ? 'placeholder.local' : acaEnvDomain
  location: 'global'
  tags: tags
}

resource acaPrivateDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (!empty(acaEnvDomain)) {
  parent: acaPrivateDnsZone
  name: 'link-aca-vnet'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: network.outputs.vnetId
    }
  }
}

resource acaWildcardRecord 'Microsoft.Network/privateDnsZones/A@2020-06-01' = if (!empty(acaEnvDomain)) {
  parent: acaPrivateDnsZone
  name: '*'
  properties: {
    ttl: 300
    aRecords: [
      {
        ipv4Address: containerApps.outputs.envStaticIp
      }
    ]
  }
}

// ?? Application Gateway WAF v2 (regional diagnostic edge) ????????????????????
module appGateway './modules/application-gateway.bicep' = {
  name: 'application-gateway'
  params: {
    location: location
    tags: tags
    appgwName: format('appgw-as-{0}', suffix)
    publicIpName: format('pip-appgw-as-{0}', suffix)
    wafPolicyName: format('waf-appgw-as-{0}', suffix)
    subnetId: network.outputs.appgwSubnetId
    webFqdn: containerApps.outputs.webFqdn
  }
  dependsOn: [network, containerApps]
}

// ?? Front Door Premium (active HTTPS edge) ????????????????????????????????????
module frontdoor './modules/frontdoor.bicep' = {
  name: 'frontdoor'
  params: {
    profileName: format('fd-as-{0}', suffix)
    tags: tags
    webOriginHostName: containerApps.outputs.webFqdn
    acaEnvId: containerApps.outputs.acaEnvId
    acaPrivateLinkLocation: location
    authenticatedMutationGuardEnabled: frontDoorAuthenticatedMutationGuardEnabled
  }
  dependsOn: [containerApps]
}

// ?? Outputs ??????????????????????????????????????????????????????????????????
output identityId string = identity.outputs.id
output identityClientId string = identity.outputs.clientId
output registryLoginServer string = registry.outputs.loginServer
output cosmosEndpoint string = cosmos.outputs.endpoint
output postgresHost string = postgres.outputs.fqdn
output searchEndpoint string = search.outputs.endpoint
output serviceBusFqdn string = serviceBus.outputs.fqdn
output keyVaultUri string = keyVault.outputs.uri
output appInsightsConnectionString string = observability.outputs.appInsightsConnectionString
output containerAppsEnvironmentId string = containerApps.outputs.environmentId
output foundryProjectId string = foundry.outputs.projectId

// Container App FQDNs
output apiFqdn string = containerApps.outputs.apiFqdn
output webFqdn string = containerApps.outputs.webFqdn
output apiContainerAppName string = containerApps.outputs.apiContainerAppName
output webContainerAppName string = containerApps.outputs.webContainerAppName
output jobsContainerAppName string = containerApps.outputs.jobsContainerAppName

// Regional diagnostic edge (may be stopped when not in use)
output appGatewayPublicIp string = appGateway.outputs.publicIpAddress
output appGatewayHttpEndpoint string = appGateway.outputs.httpEndpoint
output appGatewayPublicFqdn string = appGateway.outputs.publicIpFqdn

// Active HTTPS public edge
output frontDoorEndpointHostName string = frontdoor.outputs.endpointHostName
output frontDoorAuthenticatedMutationGuardEnabled bool = frontdoor.outputs.authenticatedMutationGuardEnabled
output frontDoorAuthenticatedMutationGuardContractDigest string = frontdoor.outputs.authenticatedMutationGuardContractDigest
