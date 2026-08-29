export {
  TeamsDistributionConnectorError,
  TeamsDistributionGraphClient,
  TEAMS_DISTRIBUTION_TOKEN_SCOPE,
} from './client.js'
export {
  TeamsDistributionCatalogConnector,
  TeamsDistributionCompositionConnector,
  createOptionalTeamsDistributionConnector,
  safeTeamsDistributionFailureReason,
} from './composition.js'
export { mapTeamsDistributionAppsToSnapshot, mergeTeamsDistributionSnapshots } from './normalize.js'
export { createTeamsDistributionSourceCredential, parseTeamsDistributionConfig } from './source.js'
export {
  TEAMS_DISTRIBUTION_API_VERSION,
  TEAMS_DISTRIBUTION_APPS_PATH,
  TEAMS_DISTRIBUTION_GRAPH_ORIGIN,
  TEAMS_DISTRIBUTION_ORGANIZATION_FILTER,
  TEAMS_DISTRIBUTION_SELECT,
  sanitizeTeamsDistributionGraphBaseUrl,
  teamsAppCollectionSchema,
  teamsAppSchema,
  teamsDistributionConfigSchema,
  teamsDistributionLimitsSchema,
  teamsDistributionSourceConfigSchema,
  teamsDistributionSourcesConfigSchema,
} from './schemas.js'

export type { TeamsDistributionClientOptions, TeamsDistributionErrorCode } from './client.js'
export type {
  OptionalTeamsDistributionOptions,
  TeamsDistributionCompositionOptions,
} from './composition.js'
export type { TeamsDistributionSourceSnapshot } from './normalize.js'
export type { TeamsDistributionCredentialFactory } from './source.js'
export type {
  TeamsApp,
  TeamsDistributionConfig,
  TeamsDistributionLimits,
  TeamsDistributionSourceConfig,
} from './schemas.js'
