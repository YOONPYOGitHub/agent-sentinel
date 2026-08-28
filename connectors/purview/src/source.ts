import type { TokenCredential } from '@azure/core-auth'
import {
  ClientAssertionCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity'

import { PurviewConnectorError } from './client.js'
import {
  PURVIEW_GRAPH_ORIGIN,
  purviewConfigSchema,
  purviewLimitsSchema,
  type PurviewConfig,
  type PurviewLimits,
  type PurviewSourceConfig,
} from './schemas.js'

export type PurviewCredentialFactory = (source: PurviewSourceConfig) => TokenCredential

export function createPurviewSourceCredential(source: PurviewSourceConfig): TokenCredential {
  if (source.credential?.mode === 'federated-app') {
    const managedIdentityClientId =
      source.credential.managedIdentityClientId ?? process.env['AZURE_CLIENT_ID']?.trim()
    if (!managedIdentityClientId) {
      throw new PurviewConnectorError(
        'authentication',
        'Cross-tenant Purview federation requires a user-assigned managed identity.',
      )
    }
    const assertionCredential = new ManagedIdentityCredential({
      clientId: managedIdentityClientId,
    })
    return new ClientAssertionCredential(source.tenantId, source.credential.clientId, async () => {
      const assertion = await assertionCredential.getToken('api://AzureADTokenExchange/.default')
      if (assertion === null) {
        throw new PurviewConnectorError(
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

function limitsFromEnvironment(environment: NodeJS.ProcessEnv): PurviewLimits {
  return purviewLimitsSchema.parse({
    maxPages: envNumber(environment, 'PURVIEW_MAX_PAGES'),
    maxItems: envNumber(environment, 'PURVIEW_MAX_ITEMS'),
    requestTimeoutMs: envNumber(environment, 'PURVIEW_REQUEST_TIMEOUT_MS'),
    maxRetries: envNumber(environment, 'PURVIEW_MAX_RETRIES'),
    maxRetryAfterMs: envNumber(environment, 'PURVIEW_MAX_RETRY_AFTER_MS'),
    maxResponseBytes: envNumber(environment, 'PURVIEW_MAX_RESPONSE_BYTES'),
  })
}

export function parsePurviewConfig(environment: NodeJS.ProcessEnv = process.env): PurviewConfig {
  let sources: unknown
  const sourcesJson = environment['PURVIEW_SOURCES_JSON']?.trim()
  if (sourcesJson !== undefined && sourcesJson !== '') {
    try {
      sources = JSON.parse(sourcesJson)
    } catch {
      throw new Error('PURVIEW_SOURCES_JSON must be valid JSON.')
    }
  } else {
    const tenantId = environment['PURVIEW_TENANT_ID']?.trim()
    const sourceEnvironment = environment['PURVIEW_ENVIRONMENT']?.trim()
    if (!tenantId || !sourceEnvironment) {
      throw new Error(
        'PURVIEW_TENANT_ID and PURVIEW_ENVIRONMENT are required when no source JSON is supplied.',
      )
    }
    sources = [
      {
        id: 'primary',
        name: 'Primary Microsoft Purview tenant',
        tenantId,
        environment: sourceEnvironment,
      },
    ]
  }
  return purviewConfigSchema.parse({
    graphBaseUrl: environment['PURVIEW_GRAPH_BASE_URL']?.trim() || PURVIEW_GRAPH_ORIGIN,
    limits: limitsFromEnvironment(environment),
    sources,
  })
}
