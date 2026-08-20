targetScope = 'resourceGroup'
param location string = resourceGroup().location
param suffix string = '260814'
param tags object = {
  application: 'agent-sentinel'
  environment: 'dev'
  'managed-by': 'bicep'
  'data-classification': 'synthetic'
}

@description('Required immutable image tag for Container App images (git SHA). Mutable tags are not permitted.')
param imageTag string

@description('Data mode for the API tier (mock or live).')
@allowed(['mock','live'])
param agentSentinelDataMode string = 'mock'

@description('Foundry project endpoint URL for live mode.')
param foundryProjectEndpoint string = ''

@description('Foundry AAD tenant id for live mode.')
param foundryTenantId string = ''

@description('Foundry environment label for live mode.')
param foundryEnvironment string = 'validation'

@description('Cosmos database id backing exposure findings.')
param cosmosDatabase string = 'agent-sentinel-db'

@description('Ingestion worker discovery interval in milliseconds.')
param discoveryIntervalMs string = '300000'

@description('ACA environment default domain for private DNS zone creation (e.g. blackrock-0e55f941.koreacentral.azurecontainerapps.io). Empty string = skip DNS zone (use after first deployment). See deployment.md for post-deploy DNS step.')
param acaEnvDomain string = ''

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
    accountName: 'ais-agent-sentinel-260814'
    projectName: 'agent-sentinel-pjt'
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
  }
  dependsOn: [registry, cosmos, keyVault, foundry, serviceBus, search]
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
    acrLoginServer: registry.outputs.loginServer
    cosmosEndpoint: cosmos.outputs.endpoint
    pgHost: postgres.outputs.fqdn
    searchEndpoint: search.outputs.endpoint
    sbFqdn: serviceBus.outputs.fqdn
    appInsightsConnectionString: observability.outputs.appInsightsConnectionString
    imageTag: imageTag
    agentSentinelDataMode: agentSentinelDataMode
    foundryProjectEndpoint: foundryProjectEndpoint
    advisoryEndpoint: foundry.outputs.openAiEndpoint
    advisoryModelDeployment: foundry.outputs.advisoryDeploymentName
    advisoryMode: 'mock'
    foundryTenantId: foundryTenantId
    foundryEnvironment: foundryEnvironment
    cosmosDatabase: cosmosDatabase
    discoveryIntervalMs: discoveryIntervalMs
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

// ?? Application Gateway WAF v2 (active public edge) ??????????????????????????
// Front Door Premium profile (fd-as-260814) is preserved for future investigation
// of the deploymentStatus NotStarted issue but does NOT carry production traffic.
// App Gateway is the working regional public entry point.
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

// ?? Front Door Premium (preserved, not routing production traffic) ????????????
// Status: deploymentStatus = NotStarted for private-link origins in koreacentral.
// Kept for future support investigation. Do not delete fd-as-260814.
module frontdoor './modules/frontdoor.bicep' = {
  name: 'frontdoor'
  params: {
    profileName: format('fd-as-{0}', suffix)
    tags: tags
    apiOriginHostName: containerApps.outputs.apiFqdn
    webOriginHostName: containerApps.outputs.webFqdn
    acaEnvId: containerApps.outputs.acaEnvId
    acaPrivateLinkLocation: location
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

// Active public edge: Application Gateway
output appGatewayPublicIp string = appGateway.outputs.publicIpAddress
output appGatewayHttpEndpoint string = appGateway.outputs.httpEndpoint
output appGatewayPublicFqdn string = appGateway.outputs.publicIpFqdn

// Front Door endpoint retained (inactive / not routing production traffic)
output frontDoorEndpointHostName string = frontdoor.outputs.endpointHostName
