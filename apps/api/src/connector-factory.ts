import {
  createOptionalAgent365Connector,
  type Agent365ClientOptions,
  type Agent365CredentialFactory,
} from '@agent-sentinel/agent365-connector'
import type { AgentConnector } from '@agent-sentinel/connector-sdk'
import {
  createOptionalDefenderCloudAppsConnector,
  type DefenderCloudAppsClientOptions,
  type DefenderCloudAppsCredentialFactory,
} from '@agent-sentinel/defender-cloud-apps-connector'
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
import {
  createOptionalPurviewConnector,
  type PurviewClientOptions,
  type PurviewCredentialFactory,
} from '@agent-sentinel/purview-connector'
import type { TokenCredential } from '@azure/core-auth'

export type ConnectorMode = 'mock' | 'foundry'

export interface ConfiguredConnectorOptions {
  credential?: TokenCredential
  credentialFactory?: FoundryCredentialFactory
  entraClient?: EntraGraphClientOptions
  powerPlatformCredentialFactory?: PowerPlatformCredentialFactory
  powerPlatformClient?: PowerPlatformClientOptions
  agent365CredentialFactory?: Agent365CredentialFactory
  agent365Client?: Agent365ClientOptions
  defenderCloudAppsCredentialFactory?: DefenderCloudAppsCredentialFactory
  defenderCloudAppsClient?: DefenderCloudAppsClientOptions
  purviewCredentialFactory?: PurviewCredentialFactory
  purviewClient?: PurviewClientOptions
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
  const powerPlatform = createOptionalPowerPlatformConnector(entra, env, {
    ...(options.powerPlatformCredentialFactory !== undefined
      ? { credentialFactory: options.powerPlatformCredentialFactory }
      : options.credential !== undefined
        ? { credential: options.credential }
        : {}),
    ...(options.powerPlatformClient !== undefined ? { client: options.powerPlatformClient } : {}),
  })
  const agent365 = createOptionalAgent365Connector(powerPlatform, env, {
    ...(options.agent365CredentialFactory !== undefined
      ? { credentialFactory: options.agent365CredentialFactory }
      : options.credential !== undefined
        ? { credential: options.credential }
        : {}),
    ...(options.agent365Client !== undefined ? { client: options.agent365Client } : {}),
  })
  const defender = createOptionalDefenderCloudAppsConnector(agent365, env, {
    ...(options.defenderCloudAppsCredentialFactory !== undefined
      ? { credentialFactory: options.defenderCloudAppsCredentialFactory }
      : options.credential !== undefined
        ? { credential: options.credential }
        : {}),
    ...(options.defenderCloudAppsClient !== undefined
      ? { client: options.defenderCloudAppsClient }
      : {}),
  })
  return {
    connector: createOptionalPurviewConnector(defender, env, {
      ...(options.purviewCredentialFactory !== undefined
        ? { credentialFactory: options.purviewCredentialFactory }
        : options.credential !== undefined
          ? { credential: options.credential }
          : {}),
      ...(options.purviewClient !== undefined ? { client: options.purviewClient } : {}),
    }),
    mode,
    ...(config.sources.length === 1 ? { projectEndpoint: primarySource.projectEndpoint } : {}),
    tenantId: config.estateTenantId,
    environment: config.estateEnvironment,
    sourceCount: config.sources.length,
  }
}
