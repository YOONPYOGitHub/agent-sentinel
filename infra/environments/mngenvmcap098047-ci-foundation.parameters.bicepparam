using '../ci-foundation.bicep'

// Resolves existing vnet-as-m098047/build and acrm098047 from the suffix.
param location = 'koreacentral'
param suffix = 'm098047'
param adminSshPublicKey = readEnvironmentVariable('ADMIN_SSH_PUBLIC_KEY')
param vmSize = 'Standard_D2as_v5'
param tags = {
  application: 'agent-sentinel'
  environment: 'replacement-validation'
  'managed-by': 'bicep'
  component: 'ci-foundation'
}
