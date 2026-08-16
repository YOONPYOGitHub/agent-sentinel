param location string
param vnetName string
param tags object

// NSG for Application Gateway WAF v2 subnet ? rules required by Azure platform.
resource nsgAppGw 'Microsoft.Network/networkSecurityGroups@2024-01-01' = {
  name: 'nsg-appgw-as'
  location: location
  tags: tags
  properties: {
    securityRules: [
      // Azure platform: infrastructure health probes from GatewayManager
      {
        name: 'Allow-GatewayManager-Inbound'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'GatewayManager'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '65200-65535'
        }
      }
      // Azure Load Balancer health probes
      {
        name: 'Allow-AzureLoadBalancer-Inbound'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: 'AzureLoadBalancer'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
      // Public HTTP ? temporary smoke-test endpoint until custom domain + TLS is configured
      {
        name: 'Allow-HTTP-Inbound'
        properties: {
          priority: 200
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '80'
        }
      }
    ]
  }
}

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
      // Dedicated /24 subnet for Application Gateway WAF v2. Must contain no other resources.
      {
        name: 'appgw'
        properties: {
          addressPrefix: '10.0.5.0/24'
          networkSecurityGroup: {
            id: nsgAppGw.id
          }
        }
      }
      // Dedicated /24 for the self-hosted GitHub Actions CI runner VM.
      // NSG (nsg-build-as) is applied by build-runner.bicep after ci-foundation deployment.
      // No delegation required; VM NIC attaches directly.
      {
        name: 'build'
        properties: {
          addressPrefix: '10.0.6.0/24'
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
output appgwSubnetId string = vnet.properties.subnets[4].id
output buildSubnetId string = vnet.properties.subnets[5].id
output postgresPrivateDnsZoneId string = dnsZones[1].id
