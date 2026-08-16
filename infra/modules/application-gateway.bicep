@description('Azure region for all resources.')
param location string

@description('Tags to apply to all resources.')
param tags object

@description('Application Gateway resource name.')
param appgwName string

@description('Public IP resource name.')
param publicIpName string

@description('WAF policy resource name.')
param wafPolicyName string

@description('Resource ID of the dedicated Application Gateway subnet (/24).')
param subnetId string

@description('Internal FQDN of the web Container App (ACA environment VNet-accessible address).')
param webFqdn string

// ?? WAF Policy (Application Gateway regional ? not Front Door) ????????????????
// Prevention mode with OWASP 3.2 + Bot Manager rules.
resource wafPolicy 'Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies@2023-11-01' = {
  name: wafPolicyName
  location: location
  tags: tags
  properties: {
    policySettings: {
      requestBodyCheck: true
      maxRequestBodySizeInKb: 128
      fileUploadLimitInMb: 100
      state: 'Enabled'
      mode: 'Prevention'
    }
    // Temporary safety gate until Entra authentication is deployed; see RB-011.
    customRules: [
      {
        name: 'BlockApiMutationPreAuth'
        priority: 1
        ruleType: 'MatchRule'
        action: 'Block'
        matchConditions: [
          {
            matchVariables: [
              {
                variableName: 'RequestUri'
              }
            ]
            operator: 'BeginsWith'
            transforms: ['Lowercase']
            matchValues: ['/api/']
          }
          {
            matchVariables: [
              {
                variableName: 'RequestMethod'
              }
            ]
            operator: 'Equal'
            transforms: []
            negationConditon: true
            matchValues: ['GET', 'HEAD', 'OPTIONS']
          }
        ]
      }
    ]
    managedRules: {
      managedRuleSets: [
        {
          ruleSetType: 'OWASP'
          ruleSetVersion: '3.2'
        }
        {
          ruleSetType: 'Microsoft_BotManagerRuleSet'
          ruleSetVersion: '1.0'
        }
      ]
    }
  }
}

// ?? Public IP: Standard static, zone-redundant ???????????????????????????????
// ? TLS LIMITATION: This listener is HTTP-only (no custom domain certificate).
// This is an explicitly temporary smoke-test endpoint.
// Next step: obtain a domain, provision a certificate in Key Vault, and add an
// HTTPS listener with SSL termination (or migrate back to Front Door Premium
// once the Azure deployment-status issue is resolved).
resource publicIp 'Microsoft.Network/publicIPAddresses@2023-11-01' = {
  name: publicIpName
  location: location
  tags: tags
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  zones: ['1', '2', '3']
  properties: {
    publicIPAllocationMethod: 'Static'
    dnsSettings: {
      domainNameLabel: publicIpName
    }
  }
}

// ?? Application Gateway WAF v2 ???????????????????????????????????????????????
// Autoscale 1?3 instances. HTTP-only listener on port 80 (see TLS note above).
// Backend: web Container App internal FQDN; probe: GET /health HTTP 200.
// The API Container App is NOT in any backend pool ? it is unreachable from App Gateway.
resource appGw 'Microsoft.Network/applicationGateways@2023-11-01' = {
  name: appgwName
  location: location
  tags: tags
  zones: ['1', '2', '3']
  properties: {
    sku: {
      name: 'WAF_v2'
      tier: 'WAF_v2'
    }
    autoscaleConfiguration: {
      minCapacity: 1
      maxCapacity: 3
    }
    firewallPolicy: {
      id: wafPolicy.id
    }
    gatewayIPConfigurations: [
      {
        name: 'appgw-ip-config'
        properties: {
          subnet: {
            id: subnetId
          }
        }
      }
    ]
    frontendIPConfigurations: [
      {
        name: 'fe-public'
        properties: {
          publicIPAddress: {
            id: publicIp.id
          }
        }
      }
    ]
    frontendPorts: [
      {
        name: 'port-80'
        properties: {
          port: 80
        }
      }
    ]
    // Backend pool: only the web Container App. API is deliberately excluded.
    backendAddressPools: [
      {
        name: 'bp-web'
        properties: {
          backendAddresses: [
            {
              fqdn: webFqdn
            }
          ]
        }
      }
    ]
    probes: [
      {
        name: 'probe-web-health'
        properties: {
          protocol: 'Http'
          path: '/health'
          interval: 30
          timeout: 30
          unhealthyThreshold: 3
          // Picks host from backend HTTP settings so probe uses same FQDN as backend.
          pickHostNameFromBackendHttpSettings: true
          minServers: 0
          match: {
            statusCodes: ['200']
          }
        }
      }
    ]
    backendHttpSettingsCollection: [
      {
        name: 'bhs-web'
        properties: {
          port: 80
          protocol: 'Http'
          cookieBasedAffinity: 'Disabled'
          requestTimeout: 60
          // Host header = web FQDN so ACA internal LB routes to correct app.
          pickHostNameFromBackendAddress: true
          probe: {
            id: resourceId('Microsoft.Network/applicationGateways/probes', appgwName, 'probe-web-health')
          }
        }
      }
    ]
    httpListeners: [
      {
        name: 'listener-http'
        properties: {
          frontendIPConfiguration: {
            id: resourceId('Microsoft.Network/applicationGateways/frontendIPConfigurations', appgwName, 'fe-public')
          }
          frontendPort: {
            id: resourceId('Microsoft.Network/applicationGateways/frontendPorts', appgwName, 'port-80')
          }
          protocol: 'Http'
          requireServerNameIndication: false
        }
      }
    ]
    requestRoutingRules: [
      {
        name: 'rule-http-to-web'
        properties: {
          ruleType: 'Basic'
          priority: 100
          httpListener: {
            id: resourceId('Microsoft.Network/applicationGateways/httpListeners', appgwName, 'listener-http')
          }
          backendAddressPool: {
            id: resourceId('Microsoft.Network/applicationGateways/backendAddressPools', appgwName, 'bp-web')
          }
          backendHttpSettings: {
            id: resourceId('Microsoft.Network/applicationGateways/backendHttpSettingsCollection', appgwName, 'bhs-web')
          }
        }
      }
    ]
  }
}

output publicIpAddress string = publicIp.properties.ipAddress
output appGwId string = appGw.id
output publicIpFqdn string = publicIp.properties.dnsSettings.fqdn

@description('Public HTTP endpoint (smoke-test only, no TLS). Replace with HTTPS + custom domain.')
output httpEndpoint string = 'http://${publicIp.properties.ipAddress}'
