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
import {
  createOptionalPowerPlatformConnector,
  type PowerPlatformClientOptions,
  type PowerPlatformCredentialFactory,
} from '@agent-sentinel/power-platform-connector'
import type { TokenCredential } from '@azure/core-auth'

export type ConnectorMode = 'mock' | 'foundry'

export interface ConfiguredConnectorOptions {
  credential?: TokenCredential
  credentialFactory?: FoundryCredentialFactory
  entraClient?: EntraGraphClientOptions
  powerPlatformCredentialFactory?: PowerPlatformCredentialFactory
  powerPlatformClient?: PowerPlatformClientOptions
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
  const primarySource = config.sources[0]!
  const entra = createOptionalEntraEnrichmentConnector(foundry, env, {
    expectedSources: config.sources.map((source) => ({
      id: source.id,
      name: source.name,
      tenantId: source.tenantId,
      environment: source.environment,
    })),
    ...(options.credential !== undefined ? { credentialFactory: () => options.credential! } : {}),
    ...(options.entraClient !== undefined ? { clientFactory: () => options.entraClient! } : {}),
  })
  return {
    connector: createOptionalPowerPlatformConnector(entra, env, {
      ...(options.powerPlatformCredentialFactory !== undefined
        ? { credentialFactory: options.powerPlatformCredentialFactory }
        : options.credential !== undefined
          ? { credential: options.credential }
          : {}),
      ...(options.powerPlatformClient !== undefined ? { client: options.powerPlatformClient } : {}),
    }),
    mode,
    ...(config.sources.length === 1 ? { projectEndpoint: primarySource.projectEndpoint } : {}),
    tenantId: config.estateTenantId,
    environment: config.estateEnvironment,
    sourceCount: config.sources.length,
  }
}
