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

export type ConnectorMode = 'mock' | 'foundry'

export interface ConfiguredConnectorOptions {
  credential?: TokenCredential
  credentialFactory?: FoundryCredentialFactory
  entraClient?: EntraGraphClientOptions
}

export function createConfiguredConnector(
  env: NodeJS.ProcessEnv = process.env,
  options: ConfiguredConnectorOptions = {},
): {
  connector: AgentConnector
  mode: ConnectorMode
  projectEndpoint?: string
  tenantId?: string
  environment?: string
  sourceCount?: number
} {
  const mode = env.AGENT_SENTINEL_CONNECTOR?.trim() || 'mock'
  if (mode === 'mock') return { connector: new MockAgentConnector(), mode }
  if (mode !== 'foundry')
    throw new Error(`AGENT_SENTINEL_CONNECTOR must be mock or foundry; received ${mode}.`)
  const config = parseFoundryPortfolioConfig(env)
  const credentialFactory =
    options.credentialFactory ??
    ((source) => options.credential ?? createFoundrySourceCredential(source))
  const foundry = new MultiFoundryConnector(config, credentialFactory)
  const sourceTenantIds = new Set(config.sources.map((source) => source.tenantId.toLowerCase()))
  if (
    env['ENTRA_CONNECTOR_ENABLED']?.trim().toLowerCase() === 'true' &&
    (sourceTenantIds.size > 1 || !sourceTenantIds.has(config.estateTenantId.toLowerCase()))
  ) {
    throw new Error(
      'A single Entra enrichment source requires one Foundry tenant matching the estate tenant.',
    )
  }
  const primarySource = config.sources[0]!
  return {
    connector: createOptionalEntraEnrichmentConnector(foundry, env, {
      credential: credentialFactory(primarySource),
      ...(options.entraClient !== undefined ? { client: options.entraClient } : {}),
      expectedTenantId: primarySource.tenantId,
      expectedEnvironment: config.estateEnvironment,
    }),
    mode,
    ...(config.sources.length === 1 ? { projectEndpoint: primarySource.projectEndpoint } : {}),
    tenantId: config.estateTenantId,
    environment: config.estateEnvironment,
    sourceCount: config.sources.length,
  }
}
