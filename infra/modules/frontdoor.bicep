@description('Azure Front Door Premium profile name.')
param profileName string

@description('Tags to apply to all resources.')
param tags object

@description('Internal FQDN of the web container app (used as AFD origin host).')
param webOriginHostName string

@description('Resource ID of the ACA managed environment (for private-link origin approval).')
param acaEnvId string

@description('Azure region of the ACA environment (private-link location must match).')
param acaPrivateLinkLocation string

// ── WAF Policy (must be in Global) ─────────────────────────────────────────
resource wafPolicy 'Microsoft.Network/frontDoorWebApplicationFirewallPolicies@2024-02-01' = {
  name: replace(replace(profileName, '-', ''), 'fd', 'waffd')
  location: 'Global'
  tags: tags
  sku: {
    name: 'Premium_AzureFrontDoor'
  }
  properties: {
    policySettings: {
      enabledState: 'Enabled'
      mode: 'Prevention'
      requestBodyCheck: 'Enabled'
      customBlockResponseStatusCode: 403
    }
    managedRules: {
      managedRuleSets: [
        {
          ruleSetType: 'Microsoft_DefaultRuleSet'
          ruleSetVersion: '2.1'
          ruleSetAction: 'Block'
        }
        {
          ruleSetType: 'Microsoft_BotManagerRuleSet'
          ruleSetVersion: '1.1'
          ruleSetAction: 'Block'
        }
      ]
    }
  }
}

// ── Front Door Premium Profile ──────────────────────────────────────────────
resource profile 'Microsoft.Cdn/profiles@2024-02-01' = {
  name: profileName
  location: 'global'
  tags: tags
  sku: {
    name: 'Premium_AzureFrontDoor'
  }
}

// ── AFD Endpoint ────────────────────────────────────────────────────────────
resource endpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' = {
  parent: profile
  name: 'agent-sentinel'
  location: 'global'
  properties: {
    enabledState: 'Enabled'
  }
}

// ── Origin Groups ───────────────────────────────────────────────────────────
resource webOriginGroup 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = {
  parent: profile
  name: 'og-web'
  properties: {
    loadBalancingSettings: {
      sampleSize: 4
      successfulSamplesRequired: 3
      additionalLatencyInMilliseconds: 50
    }
    healthProbeSettings: {
      probePath: '/health'
      probeRequestType: 'GET'
      probeProtocol: 'Https'
      probeIntervalInSeconds: 30
    }
    sessionAffinityState: 'Disabled'
  }
}

// ── Origins (Private Link to internal ACA env) ──────────────────────────────
resource webOrigin 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = {
  parent: webOriginGroup
  name: 'aca-web'
  properties: {
    hostName: webOriginHostName
    httpPort: 80
    httpsPort: 443
    originHostHeader: webOriginHostName
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
    enforceCertificateNameCheck: true
    sharedPrivateLinkResource: {
      privateLink: {
        id: acaEnvId
      }
      privateLinkLocation: acaPrivateLinkLocation
      groupId: 'managedEnvironments'
      requestMessage: 'afd-web-origin'
    }
  }
}

// ── Route ───────────────────────────────────────────────────────────────────
// The catch-all route sends SPA and API traffic to web nginx. Nginx proxies
// /api/* to the environment-only API through ACA service discovery.
resource webRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = {
  parent: endpoint
  name: 'diagnostic-web'
  dependsOn: [webOrigin]
  properties: {
    originGroup: {
      id: webOriginGroup.id
    }
    patternsToMatch: [
      '/*'
    ]
    forwardingProtocol: 'HttpsOnly'
    httpsRedirect: 'Enabled'
    linkToDefaultDomain: 'Enabled'
    supportedProtocols: [
      'Http'
      'Https'
    ]
    enabledState: 'Enabled'
  }
}

// ── Security Policy (WAF ↔ Endpoint association) ────────────────────────────
resource securityPolicy 'Microsoft.Cdn/profiles/securityPolicies@2024-02-01' = {
  parent: profile
  name: 'sp-waf'
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: {
        id: wafPolicy.id
      }
      associations: [
        {
          domains: [
            {
              id: endpoint.id
            }
          ]
          patternsToMatch: [
            '/*'
          ]
        }
      ]
    }
  }
}

// ── Outputs ─────────────────────────────────────────────────────────────────
output endpointHostName string = endpoint.properties.hostName
output profileId string = profile.id
output wafPolicyId string = wafPolicy.id

@description('Shell command to list and approve the private-link connection requests after this deployment.')
output privateLinkApprovalHint string = 'az network private-endpoint-connection list --resource-group <rg> --name ${last(split(acaEnvId, '/'))} --type Microsoft.App/managedEnvironments'