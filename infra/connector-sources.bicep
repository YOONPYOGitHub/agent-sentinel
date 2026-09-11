targetScope = 'resourceGroup'

@description('Existing Cosmos DB account that owns the connector source container.')
param cosmosAccountName string

@description('Existing Cosmos SQL database that owns the connector source container.')
param cosmosDatabaseName string = 'agent-sentinel-db'

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' existing = {
  name: cosmosAccountName
}

resource cosmosDatabase 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' existing = {
  parent: cosmosAccount
  name: cosmosDatabaseName
}

resource connectorSourcesContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: cosmosDatabase
  name: 'connector-sources'
  properties: {
    resource: {
      id: 'connector-sources'
      partitionKey: {
        paths: ['/estateId']
        kind: 'Hash'
      }
      indexingPolicy: {
        automatic: true
        indexingMode: 'consistent'
        includedPaths: [
          {
            path: '/documentType/?'
          }
          {
            path: '/tenantId/?'
          }
          {
            path: '/environment/?'
          }
          {
            path: '/source/sourceId/?'
          }
          {
            path: '/source/updatedAt/?'
          }
          {
            path: '/deleted/?'
          }
          {
            path: '/sourceId/?'
          }
          {
            path: '/occurredAt/?'
          }
          {
            path: '/audit/id/?'
          }
        ]
        excludedPaths: [
          {
            path: '/*'
          }
          {
            path: '/"_etag"/?'
          }
        ]
        compositeIndexes: [
          [
            {
              path: '/source/updatedAt'
              order: 'descending'
            }
            {
              path: '/source/sourceId'
              order: 'ascending'
            }
          ]
          [
            {
              path: '/occurredAt'
              order: 'ascending'
            }
            {
              path: '/audit/id'
              order: 'ascending'
            }
          ]
        ]
      }
    }
  }
}

output connectorSourcesContainerId string = connectorSourcesContainer.id
