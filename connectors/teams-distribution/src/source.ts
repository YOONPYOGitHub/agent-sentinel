import type { TokenCredential } from '@azure/core-auth'
import {
  ClientAssertionCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity'

import { TeamsDistributionConnectorError } from './client.js'
import {
  TEAMS_DISTRIBUTION_GRAPH_ORIGIN,
  teamsDistributionConfigSchema,
  teamsDistributionLimitsSchema,
  type TeamsDistributionConfig,
  type TeamsDistributionLimits,
  type TeamsDistributionSourceConfig,
} from './schemas.js'

export type TeamsDistributionCredentialFactory = (
  source: TeamsDistributionSourceConfig,
) => TokenCredential

export function createTeamsDistributionSourceCredential(
  source: TeamsDistributionSourceConfig,
): TokenCredential {
  if (source.credential?.mode === 'federated-app') {
    const managedIdentityClientId =
      source.credential.managedIdentityClientId ?? process.env['AZURE_CLIENT_ID']?.trim()
    if (!managedIdentityClientId) {
      throw new TeamsDistributionConnectorError(
        'authentication',
        'Cross-tenant Teams distribution federation requires a user-assigned managed identity.',
      )
    }
    const assertionCredential = new ManagedIdentityCredential({
      clientId: managedIdentityClientId,
    })
    return new ClientAssertionCredential(source.tenantId, source.credential.clientId, async () => {
      const assertion = await assertionCredential.getToken('api://AzureADTokenExchange/.default')
      if (assertion === null) {
        throw new TeamsDistributionConnectorError(
          'authentication',
          'Managed identity did not return a workload identity federation assertion.',
        )
      }
      return assertion.token
    })
  }
  return new DefaultAzureCredential({
    tenantId: source.tenantId,
    ...(source.credential?.managedIdentityClientId !== undefined
      ? { managedIdentityClientId: source.credential.managedIdentityClientId }
      : {}),
  })
}

function envNumber(environment: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = environment[name]?.trim()
  if (value === undefined || value === '') return undefined
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${name} must be a number.`)
  return number
}

function limitsFromEnvironment(environment: NodeJS.ProcessEnv): TeamsDistributionLimits {
  return teamsDistributionLimitsSchema.parse({
    maxPages: envNumber(environment, 'TEAMS_DISTRIBUTION_MAX_PAGES'),
    maxItems: envNumber(environment, 'TEAMS_DISTRIBUTION_MAX_ITEMS'),
    requestTimeoutMs: envNumber(environment, 'TEAMS_DISTRIBUTION_REQUEST_TIMEOUT_MS'),
    maxRetries: envNumber(environment, 'TEAMS_DISTRIBUTION_MAX_RETRIES'),
    maxRetryAfterMs: envNumber(environment, 'TEAMS_DISTRIBUTION_MAX_RETRY_AFTER_MS'),
    maxResponseBytes: envNumber(environment, 'TEAMS_DISTRIBUTION_MAX_RESPONSE_BYTES'),
  })
}

export function parseTeamsDistributionConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TeamsDistributionConfig {
  let sources: unknown
  const sourcesJson = environment['TEAMS_DISTRIBUTION_SOURCES_JSON']?.trim()
  if (sourcesJson !== undefined && sourcesJson !== '') {
    try {
      sources = JSON.parse(sourcesJson)
    } catch {
      throw new Error('TEAMS_DISTRIBUTION_SOURCES_JSON must be valid JSON.')
    }
  } else {
    const tenantId = environment['TEAMS_DISTRIBUTION_TENANT_ID']?.trim()
    const sourceEnvironment = environment['TEAMS_DISTRIBUTION_ENVIRONMENT']?.trim()
    if (!tenantId || !sourceEnvironment) {
      throw new Error(
        'TEAMS_DISTRIBUTION_TENANT_ID and TEAMS_DISTRIBUTION_ENVIRONMENT are required when no source JSON is supplied.',
      )
    }
    sources = [
      {
        id: 'primary',
        name: 'Primary Microsoft Teams tenant app catalog',
        tenantId,
        environment: sourceEnvironment,
      },
    ]
  }
  return teamsDistributionConfigSchema.parse({
    graphBaseUrl:
      environment['TEAMS_DISTRIBUTION_GRAPH_BASE_URL']?.trim() || TEAMS_DISTRIBUTION_GRAPH_ORIGIN,
    limits: limitsFromEnvironment(environment),
    sources,
  })
}
