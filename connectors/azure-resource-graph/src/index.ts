export {
  AzureResourceGraphClient,
  AzureResourceGraphConnectorError,
  AZURE_RESOURCE_GRAPH_TOKEN_SCOPE,
} from './client.js'
export {
  AzureResourceGraphCompositionConnector,
  AzureResourceInventoryConnector,
  createOptionalAzureResourceGraphConnector,
  safeAzureResourceGraphFailureReason,
} from './composition.js'
export { mapAzureResourcesToSnapshot, mergeAzureResourceGraphSnapshots } from './normalize.js'
export {
  createAzureResourceGraphSourceCredential,
  parseAzureResourceGraphConfig,
} from './source.js'
export {
  AZURE_RESOURCE_GRAPH_API_VERSION,
  AZURE_RESOURCE_GRAPH_ORIGIN,
  AZURE_RESOURCE_GRAPH_PATH,
  AZURE_RESOURCE_GRAPH_QUERY,
  AZURE_RESOURCE_TYPES,
  azureResourceGraphConfigSchema,
  azureResourceGraphLimitsSchema,
  azureResourceGraphResourceSchema,
  azureResourceGraphResponseSchema,
  azureResourceGraphSourceConfigSchema,
  azureResourceGraphSourcesConfigSchema,
} from './schemas.js'

export type { AzureResourceGraphClientOptions, AzureResourceGraphErrorCode } from './client.js'
export type {
  AzureResourceGraphCompositionOptions,
  OptionalAzureResourceGraphOptions,
} from './composition.js'
export type { AzureResourceGraphSourceSnapshot } from './normalize.js'
export type { AzureResourceGraphCredentialFactory } from './source.js'
export type {
  AzureResourceGraphConfig,
  AzureResourceGraphLimits,
  AzureResourceGraphResource,
  AzureResourceGraphResponse,
  AzureResourceGraphSourceConfig,
} from './schemas.js'
