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
var appDefinitions = [
  { slug: 'api', containerName: 'agent-sentinel-api', ingressEnabled: true }
  { slug: 'web', containerName: 'agent-sentinel-web', ingressEnabled: true }
  { slug: 'jobs', containerName: 'agent-sentinel-jobs', ingressEnabled: false }
]
var env = [
  { name: 'COSMOS_ENDPOINT', value: cosmosEndpoint }
  { name: 'PG_HOST', value: pgHost }
  { name: 'SEARCH_ENDPOINT', value: searchEndpoint }
  { name: 'SB_FQDN', value: sbFqdn }
  { name: 'AZURE_CLIENT_ID', value: uamiClientId }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
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
        external: true
        targetPort: 3000
        transport: 'auto'
      } : null
    }
    template: {
      containers: [
        {
          name: app.containerName
          image: format('{0}/{1}:latest', acrLoginServer, app.containerName)
          env: env
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 2
      }
    }
  }
}]

output environmentId string = environment.id
output apiFqdn string = apps[0].properties.configuration.ingress.fqdn
