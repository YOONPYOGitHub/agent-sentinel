import type { TokenCredential } from '@azure/core-auth'
import {
  ClientAssertionCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity'

import { AzureResourceGraphConnectorError } from './client.js'
import {
  azureResourceGraphConfigSchema,
  azureResourceGraphLimitsSchema,
  type AzureResourceGraphConfig,
  type AzureResourceGraphLimits,
  type AzureResourceGraphSourceConfig,
} from './schemas.js'

export type AzureResourceGraphCredentialFactory = (
  source: AzureResourceGraphSourceConfig,
) => TokenCredential

export function createAzureResourceGraphSourceCredential(
  source: AzureResourceGraphSourceConfig,
): TokenCredential {
  if (source.credential?.mode === 'federated-app') {
    const managedIdentityClientId =
      source.credential.managedIdentityClientId ?? process.env['AZURE_CLIENT_ID']?.trim()
    if (!managedIdentityClientId) {
      throw new AzureResourceGraphConnectorError(
        'authentication',
        'Cross-tenant Azure Resource Graph federation requires a user-assigned managed identity.',
      )
    }
    const assertionCredential = new ManagedIdentityCredential({
      clientId: managedIdentityClientId,
    })
    return new ClientAssertionCredential(source.tenantId, source.credential.clientId, async () => {
      const assertion = await assertionCredential.getToken('api://AzureADTokenExchange/.default')
      if (assertion === null) {
        throw new AzureResourceGraphConnectorError(
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

function limitsFromEnvironment(environment: NodeJS.ProcessEnv): AzureResourceGraphLimits {
  return azureResourceGraphLimitsSchema.parse({
    pageSize: envNumber(environment, 'AZURE_RESOURCE_GRAPH_PAGE_SIZE'),
    maxPages: envNumber(environment, 'AZURE_RESOURCE_GRAPH_MAX_PAGES'),
    maxItems: envNumber(environment, 'AZURE_RESOURCE_GRAPH_MAX_ITEMS'),
    requestTimeoutMs: envNumber(environment, 'AZURE_RESOURCE_GRAPH_REQUEST_TIMEOUT_MS'),
    maxRetries: envNumber(environment, 'AZURE_RESOURCE_GRAPH_MAX_RETRIES'),
    maxRetryAfterMs: envNumber(environment, 'AZURE_RESOURCE_GRAPH_MAX_RETRY_AFTER_MS'),
    maxResponseBytes: envNumber(environment, 'AZURE_RESOURCE_GRAPH_MAX_RESPONSE_BYTES'),
  })
}

export function parseAzureResourceGraphConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AzureResourceGraphConfig {
  const sourcesJson = environment['AZURE_RESOURCE_GRAPH_SOURCES_JSON']?.trim()
  if (sourcesJson === undefined || sourcesJson === '') {
    throw new Error('AZURE_RESOURCE_GRAPH_SOURCES_JSON is required when the connector is enabled.')
  }
  let sources: unknown
  try {
    sources = JSON.parse(sourcesJson)
  } catch {
    throw new Error('AZURE_RESOURCE_GRAPH_SOURCES_JSON must be valid JSON.')
  }
  return azureResourceGraphConfigSchema.parse({
    limits: limitsFromEnvironment(environment),
    sources,
  })
}
