targetScope = 'resourceGroup'

param location string = resourceGroup().location
param suffix string = '260814'
param tags object = {
  application: 'agent-sentinel'
  environment: 'dev'
  'managed-by': 'bicep'
  'data-classification': 'synthetic'
}

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
  }
  dependsOn: [registry, cosmos, keyVault, foundry, serviceBus]
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
  }
  dependsOn: [network, observability, identity, registry, cosmos, postgres, search, serviceBus]
}

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
