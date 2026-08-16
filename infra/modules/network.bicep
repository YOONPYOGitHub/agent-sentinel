param location string
param vnetName string
param tags object

resource vnet 'Microsoft.Network/virtualNetworks@2024-01-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: ['10.0.0.0/16']
    }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: '10.0.0.0/23'
          delegations: [
            {
              name: 'Microsoft.App-environments'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: '10.0.2.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
      {
        name: 'database'
        properties: {
          addressPrefix: '10.0.3.0/24'
          delegations: [
            {
              name: 'Microsoft.DBforPostgreSQL-flexibleServers'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
        }
      }
      {
        name: 'integration'
        properties: {
          addressPrefix: '10.0.4.0/24'
        }
      }
    ]
  }
}

var dnsZoneNames = [
  'privatelink.documents.azure.com'
  'privatelink.postgres.database.azure.com'
  'privatelink.search.windows.net'
  'privatelink.servicebus.windows.net'
  'privatelink.azurecr.io'
  'privatelink.vaultcore.azure.net'
]

resource dnsZones 'Microsoft.Network/privateDnsZones@2020-06-01' = [for zoneName in dnsZoneNames: {
  name: zoneName
  location: 'global'
  tags: tags
}]

resource dnsLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = [for (zoneName, index) in dnsZoneNames: {
  parent: dnsZones[index]
  name: 'link-agent-sentinel'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}]

output vnetId string = vnet.id
output appsSubnetId string = vnet.properties.subnets[0].id
output privateEndpointSubnetId string = vnet.properties.subnets[1].id
output delegatedSubnetResourceId string = vnet.properties.subnets[2].id
output integrationSubnetId string = vnet.properties.subnets[3].id
output postgresPrivateDnsZoneId string = dnsZones[1].id
