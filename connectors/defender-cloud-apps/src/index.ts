export {
  DefenderCloudAppsClient,
  DefenderCloudAppsConnectorError,
  DEFENDER_CLOUD_APPS_TOKEN_SCOPE,
} from './client.js'
export {
  DefenderCloudAppsCompositionConnector,
  DefenderCloudAppsEvidenceConnector,
  createOptionalDefenderCloudAppsConnector,
  safeDefenderCloudAppsFailureReason,
} from './composition.js'
export {
  mapDefenderCloudAppsCollectionToSnapshot,
  mergeDefenderCloudAppsSnapshots,
} from './normalize.js'
export { createDefenderCloudAppsSourceCredential, parseDefenderCloudAppsConfig } from './source.js'
export {
  DEFENDER_CLOUD_APPS_ACTIVITIES_PATH,
  DEFENDER_CLOUD_APPS_ALERTS_PATH,
  DEFENDER_CLOUD_APPS_API_VERSION,
  DEFENDER_CLOUD_APPS_RESOURCE_APP_ID,
  defenderCloudAppsActivityCollectionSchema,
  defenderCloudAppsActivitySchema,
  defenderCloudAppsAlertCollectionSchema,
  defenderCloudAppsAlertSchema,
  defenderCloudAppsConfigSchema,
  defenderCloudAppsLimitsSchema,
  defenderCloudAppsSourceConfigSchema,
  defenderCloudAppsSourcesConfigSchema,
  sanitizeDefenderCloudAppsApiBaseUrl,
} from './schemas.js'

export type {
  DefenderCloudAppsClientOptions,
  DefenderCloudAppsCollection,
  DefenderCloudAppsErrorCode,
} from './client.js'
export type {
  DefenderCloudAppsCompositionOptions,
  OptionalDefenderCloudAppsOptions,
} from './composition.js'
export type { DefenderCloudAppsSourceSnapshot } from './normalize.js'
export type { DefenderCloudAppsCredentialFactory } from './source.js'
export type {
  DefenderCloudAppsActivity,
  DefenderCloudAppsAlert,
  DefenderCloudAppsConfig,
  DefenderCloudAppsLimits,
  DefenderCloudAppsSourceConfig,
} from './schemas.js'
