export { PurviewConnectorError, PurviewGraphClient, PURVIEW_TOKEN_SCOPE } from './client.js'
export {
  PurviewCompositionConnector,
  PurviewLabelCatalogConnector,
  createOptionalPurviewConnector,
  safePurviewFailureReason,
} from './composition.js'
export { mapPurviewLabelsToSnapshot, mergePurviewSnapshots } from './normalize.js'
export { createPurviewSourceCredential, parsePurviewConfig } from './source.js'
export {
  PURVIEW_API_VERSION,
  PURVIEW_GRAPH_ORIGIN,
  PURVIEW_SENSITIVITY_LABELS_PATH,
  purviewConfigSchema,
  purviewLimitsSchema,
  purviewSensitivityLabelCollectionSchema,
  purviewSensitivityLabelSchema,
  purviewSourceConfigSchema,
  purviewSourcesConfigSchema,
  sanitizePurviewGraphBaseUrl,
} from './schemas.js'

export type { PurviewClientOptions, PurviewErrorCode } from './client.js'
export type { OptionalPurviewOptions, PurviewCompositionOptions } from './composition.js'
export type { PurviewSourceSnapshot } from './normalize.js'
export type { PurviewCredentialFactory } from './source.js'
export type {
  PurviewConfig,
  PurviewLimits,
  PurviewSensitivityLabel,
  PurviewSourceConfig,
} from './schemas.js'
