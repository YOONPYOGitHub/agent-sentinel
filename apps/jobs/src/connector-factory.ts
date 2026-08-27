import type { AgentConnector } from '@agent-sentinel/connector-sdk'
import {
  createOptionalEntraEnrichmentConnector,
  type EntraGraphClientOptions,
} from '@agent-sentinel/entra-identity-connector'
import {
  MultiFoundryConnector,
  createFoundrySourceCredential,
  parseFoundryPortfolioConfig,
  type FoundryCredentialFactory,
} from '@agent-sentinel/foundry-connector'
import { MockAgentConnector } from '@agent-sentinel/mock-connector'
import type { TokenCredential } from '@azure/core-auth'

export interface JobsConnectorOptions {
  credential?: TokenCredential
  credentialFactory?: FoundryCredentialFactory
  entraClient?: EntraGraphClientOptions
}

export function buildConnector(
  mode: 'mock' | 'foundry',
  environment: NodeJS.ProcessEnv = process.env,
  options: JobsConnectorOptions = {},
): AgentConnector {
  if (mode === 'mock') return new MockAgentConnector()
  const config = parseFoundryPortfolioConfig(environment)
  const credentialFactory =
    options.credentialFactory ??
    ((source) => options.credential ?? createFoundrySourceCredential(source))
  const foundry = new MultiFoundryConnector(config, credentialFactory)
  const sourceTenantIds = new Set(config.sources.map((source) => source.tenantId.toLowerCase()))
  if (
    environment['ENTRA_CONNECTOR_ENABLED']?.trim().toLowerCase() === 'true' &&
    (sourceTenantIds.size > 1 || !sourceTenantIds.has(config.estateTenantId.toLowerCase()))
  ) {
    throw new Error(
      'A single Entra enrichment source requires one Foundry tenant matching the estate tenant.',
    )
  }
  const primarySource = config.sources[0]!
  return createOptionalEntraEnrichmentConnector(foundry, environment, {
    credential: credentialFactory(primarySource),
    ...(options.entraClient !== undefined ? { client: options.entraClient } : {}),
    expectedTenantId: primarySource.tenantId,
    expectedEnvironment: config.estateEnvironment,
  })
}
