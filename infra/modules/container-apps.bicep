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
  { name: 'AZURE_CLIENT_ID',                       value: uamiClientId }
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
