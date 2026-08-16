param location string
param sbName string
param tags object
param privateEndpointSubnetId string
@description('Virtual network containing the private endpoint subnet.')
param vnetId string

resource namespace 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: sbName
  location: location
  tags: tags
  sku: {
    name: 'Premium'
    tier: 'Premium'
    capacity: 1
  }
  properties: {
    disableLocalAuth: true
    publicNetworkAccess: 'Disabled'
    minimumTlsVersion: '1.2'
  }
}

var queueNames = [
  'findings-validation'
  'remediation-execution'
  'snapshot-ingestion'
]

resource queues 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = [for queueName in queueNames: {
  parent: namespace
  name: queueName
  properties: {
    maxDeliveryCount: 10
    lockDuration: 'PT5M'
    deadLetteringOnMessageExpiration: true
  }
}]

resource topic 'Microsoft.ServiceBus/namespaces/topics@2022-10-01-preview' = {
  parent: namespace
  name: 'domain-events'
  properties: {
    enablePartitioning: false
  }
}

var subscriptionNames = [
  'api-subscriber'
  'jobs-subscriber'
]

resource subscriptions 'Microsoft.ServiceBus/namespaces/topics/subscriptions@2022-10-01-preview' = [for subscriptionName in subscriptionNames: {
  parent: topic
  name: subscriptionName
  properties: {
    maxDeliveryCount: 10
    lockDuration: 'PT5M'
    deadLetteringOnMessageExpiration: true
  }
}]

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' existing = {
  name: 'privatelink.servicebus.windows.net'
}

resource endpoint 'Microsoft.Network/privateEndpoints@2024-01-01' = {
  name: 'pe-${sbName}'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'namespace'
        properties: {
          privateLinkServiceId: namespace.id
          groupIds: ['namespace']
        }
      }
    ]
  }
}

resource zoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-01-01' = {
  parent: endpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'servicebus'
        properties: {
          privateDnsZoneId: privateDnsZone.id
        }
      }
    ]
  }
}

output id string = namespace.id
output fqdn string = '${namespace.name}.servicebus.windows.net'
