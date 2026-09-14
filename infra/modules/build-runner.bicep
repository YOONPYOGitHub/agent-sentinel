// build-runner.bicep
// Self-hosted GitHub Actions runner VM for private CI builds inside the Agent Sentinel VNet.
// No public IP. UAMI scoped to AcrPush only. All inbound denied; outbound restricted by NSG.

param location string
param tags object
param buildSubnetId string
param acrId string
param runnerIdentityName string

@description('SSH public key for azureuser. VM is accessed via Run Command only; SSH port is closed by NSG.')
param adminSshPublicKey string

@description('VM SKU for the private build runner. Select an available Korea Central SKU at deployment time.')
param vmSize string = 'Standard_D2s_v3'

// Separate UAMI from the application identity; AcrPush only.
resource runnerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: runnerIdentityName
  location: location
  tags: tags
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = {
  name: last(split(acrId, '/'))
}

var acrPushRole = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '8311e382-0749-4cb8-b61a-304f252e45ec'
)

resource acrPushAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, runnerIdentity.id, acrPushRole)
  scope: acr
  properties: {
    principalId: runnerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPushRole
  }
}

// NSG for build subnet.
// Inbound: deny all - self-hosted runner polls GitHub outbound; no inbound accepted.
// Outbound: allow only required egress (exact domains in docs/runbooks.md).
resource nsgBuild 'Microsoft.Network/networkSecurityGroups@2024-01-01' = {
  name: 'nsg-build-as'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'Allow-AzureAD-Outbound'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzureActiveDirectory'
          destinationPortRange: '443'
          description: 'Managed-identity IMDS and Entra token endpoints'
        }
      }
      {
        name: 'Allow-ARM-Outbound'
        properties: {
          priority: 110
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzureResourceManager'
          destinationPortRange: '443'
          description: 'Azure Resource Manager for deployment what-if and deploy'
        }
      }
      {
        name: 'Allow-AzureMonitor-Outbound'
        properties: {
          priority: 120
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'AzureMonitor'
          destinationPortRange: '443'
          description: 'Optional runner diagnostics'
        }
      }
      {
        name: 'Allow-VNet-Outbound'
        properties: {
          priority: 130
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'VirtualNetwork'
          destinationPortRange: '*'
          description: 'Intra-VNet: private endpoints for ACR, KV, etc.'
        }
      }
      {
        name: 'Allow-Internet-HTTPS-Outbound'
        properties: {
          priority: 200
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'Internet'
          destinationPortRange: '443'
          description: 'GitHub Actions, MCR, npm, git HTTPS'
        }
      }
      {
        name: 'Allow-Internet-HTTP-Outbound'
        properties: {
          priority: 210
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'Internet'
          destinationPortRange: '80'
          description: 'HTTP for OS package updates and CRL checks'
        }
      }
      {
        name: 'Deny-All-Outbound'
        properties: {
          priority: 4000
          direction: 'Outbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
          description: 'Block all other outbound'
        }
      }
      {
        name: 'Deny-All-Inbound'
        properties: {
          priority: 4000
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
          description: 'No inbound accepted'
        }
      }
    ]
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-01-01' = {
  name: 'nic-ci-runner-as'
  location: location
  tags: tags
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          subnet: {
            id: buildSubnetId
          }
          privateIPAllocationMethod: 'Dynamic'
        }
      }
    ]
    networkSecurityGroup: {
      id: nsgBuild.id
    }
  }
}

// Standard_D2s_v3: 2 vCPU / 8 GiB. No public IP. Access via Run Command only.
resource vm 'Microsoft.Compute/virtualMachines@2024-03-01' = {
  name: 'vm-ci-runner-as'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runnerIdentity.id}': {}
    }
  }
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        managedDisk: {
          storageAccountType: 'Premium_LRS'
        }
        diskSizeGB: 64
      }
    }
    osProfile: {
      computerName: 'ci-runner-as'
      adminUsername: 'azureuser'
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/azureuser/.ssh/authorized_keys'
              keyData: adminSshPublicKey
            }
          ]
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true
      }
    }
  }
  dependsOn: [acrPushAssignment]
}

output vmId string = vm.id
output vmName string = vm.name
output runnerIdentityId string = runnerIdentity.id
output runnerIdentityClientId string = runnerIdentity.properties.clientId
output runnerIdentityPrincipalId string = runnerIdentity.properties.principalId
output nsgId string = nsgBuild.id
