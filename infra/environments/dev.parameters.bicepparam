using '../platform.bicep'

param location = 'koreacentral'
param suffix = '260814'
param tags = {
  application: 'agent-sentinel'
  environment: 'dev'
  'managed-by': 'bicep'
  'data-classification': 'synthetic'
}
