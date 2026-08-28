import type { TokenCredential } from '@azure/core-auth'
import {
  ClientAssertionCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity'

import { DefenderCloudAppsConnectorError } from './client.js'
import {
  defenderCloudAppsConfigSchema,
  defenderCloudAppsLimitsSchema,
  type DefenderCloudAppsConfig,
  type DefenderCloudAppsLimits,
  type DefenderCloudAppsSourceConfig,
} from './schemas.js'

export type DefenderCloudAppsCredentialFactory = (
  source: DefenderCloudAppsSourceConfig,
) => TokenCredential

export function createDefenderCloudAppsSourceCredential(
  source: DefenderCloudAppsSourceConfig,
): TokenCredential {
  if (source.credential?.mode === 'federated-app') {
    const managedIdentityClientId =
      source.credential.managedIdentityClientId ?? process.env['AZURE_CLIENT_ID']?.trim()
    if (!managedIdentityClientId) {
      throw new DefenderCloudAppsConnectorError(
        'authentication',
        'Cross-tenant Defender for Cloud Apps federation requires a user-assigned managed identity.',
      )
    }
    const assertionCredential = new ManagedIdentityCredential({
      clientId: managedIdentityClientId,
    })
    return new ClientAssertionCredential(source.tenantId, source.credential.clientId, async () => {
      const assertion = await assertionCredential.getToken('api://AzureADTokenExchange/.default')
      if (assertion === null) {
        throw new DefenderCloudAppsConnectorError(
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

function limitsFromEnvironment(environment: NodeJS.ProcessEnv): DefenderCloudAppsLimits {
  return defenderCloudAppsLimitsSchema.parse({
    lookbackHours: envNumber(environment, 'DEFENDER_CLOUD_APPS_LOOKBACK_HOURS'),
    pageSize: envNumber(environment, 'DEFENDER_CLOUD_APPS_PAGE_SIZE'),
    maxPages: envNumber(environment, 'DEFENDER_CLOUD_APPS_MAX_PAGES'),
    maxItems: envNumber(environment, 'DEFENDER_CLOUD_APPS_MAX_ITEMS'),
    requestTimeoutMs: envNumber(environment, 'DEFENDER_CLOUD_APPS_REQUEST_TIMEOUT_MS'),
    maxRetries: envNumber(environment, 'DEFENDER_CLOUD_APPS_MAX_RETRIES'),
    maxRetryAfterMs: envNumber(environment, 'DEFENDER_CLOUD_APPS_MAX_RETRY_AFTER_MS'),
    maxResponseBytes: envNumber(environment, 'DEFENDER_CLOUD_APPS_MAX_RESPONSE_BYTES'),
  })
}

export function parseDefenderCloudAppsConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DefenderCloudAppsConfig {
  let sources: unknown
  const sourcesJson = environment['DEFENDER_CLOUD_APPS_SOURCES_JSON']?.trim()
  if (sourcesJson !== undefined && sourcesJson !== '') {
    try {
      sources = JSON.parse(sourcesJson)
    } catch {
      throw new Error('DEFENDER_CLOUD_APPS_SOURCES_JSON must be valid JSON.')
    }
  } else {
    const tenantId = environment['DEFENDER_CLOUD_APPS_TENANT_ID']?.trim()
    const sourceEnvironment = environment['DEFENDER_CLOUD_APPS_ENVIRONMENT']?.trim()
    const apiBaseUrl = environment['DEFENDER_CLOUD_APPS_API_BASE_URL']?.trim()
    const portalHostname = environment['DEFENDER_CLOUD_APPS_PORTAL_HOSTNAME']?.trim()
    if (!tenantId || !sourceEnvironment || (!apiBaseUrl && !portalHostname)) {
      throw new Error(
        'DEFENDER_CLOUD_APPS_TENANT_ID, DEFENDER_CLOUD_APPS_ENVIRONMENT, and a tenant API base URL or portal hostname are required when no source JSON is supplied.',
      )
    }
    sources = [
      {
        id: 'primary',
        name: 'Primary Microsoft Defender for Cloud Apps tenant',
        tenantId,
        environment: sourceEnvironment,
        ...(apiBaseUrl ? { apiBaseUrl } : {}),
        ...(portalHostname ? { portalHostname } : {}),
      },
    ]
  }
  return defenderCloudAppsConfigSchema.parse({
    limits: limitsFromEnvironment(environment),
    sources,
  })
}
