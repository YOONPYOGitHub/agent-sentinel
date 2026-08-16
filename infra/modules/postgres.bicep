param location string
param serverName string
param tags object
param delegatedSubnetResourceId string
param privateDnsZoneArmResourceId string
param adminObjectId string

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01' = {
  name: serverName
  location: location
  tags: tags
  sku: {
    name: 'Standard_D2ds_v5'
    tier: 'GeneralPurpose'
  }
  properties: {
    version: '16'
    availabilityZone: '1'
    highAvailability: {
      mode: 'ZoneRedundant'
      standbyAvailabilityZone: '2'
    }
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Enabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: tenant().tenantId
    }
    network: {
      delegatedSubnetResourceId: delegatedSubnetResourceId
      privateDnsZoneArmResourceId: privateDnsZoneArmResourceId
      publicNetworkAccess: 'Disabled'
    }
  }
}

resource administrator 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2023-12-01' = {
  parent: server
  name: adminObjectId
  properties: {
    principalName: 'id-agent-sentinel-260814'
    principalType: 'ServicePrincipal'
    tenantId: tenant().tenantId
  }
}

output id string = server.id
output fqdn string = server.properties.fullyQualifiedDomainName
