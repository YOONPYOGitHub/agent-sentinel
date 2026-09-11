import {
  createOptionalAgent365Connector,
  type Agent365CompositionOptions,
  type Agent365ClientOptions,
  type Agent365CredentialFactory,
} from '@agent-sentinel/agent365-connector'
import {
  createOptionalAzureResourceGraphConnector,
  type AzureResourceGraphClientOptions,
  type AzureResourceGraphCredentialFactory,
} from '@agent-sentinel/azure-resource-graph-connector'
import type { AgentConnector } from '@agent-sentinel/connector-sdk'
import {
  buildDeploymentConnectorSources,
  createAgent365RuntimeConnector,
  DeploymentConnectorSourceRepository,
  resolveAgent365Runtime,
  type ResolvedAgent365Runtime,
} from '@agent-sentinel/connector-runtime'
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
import {
  createOptionalTeamsDistributionConnector,
  type TeamsDistributionClientOptions,
  type TeamsDistributionCredentialFactory,
} from '@agent-sentinel/teams-distribution-connector'
import type { TokenCredential } from '@azure/core-auth'
import type { ConnectorSourceRepository, EstateContext } from '@agent-sentinel/domain'

export type ConnectorMode = 'mock' | 'foundry'

export interface ConfiguredConnectorOptions {
  estate?: EstateContext
  credential?: TokenCredential
  credentialFactory?: FoundryCredentialFactory
  entraClient?: EntraGraphClientOptions
  powerPlatformCredentialFactory?: PowerPlatformCredentialFactory
  powerPlatformClient?: PowerPlatformClientOptions
  agent365CredentialFactory?: Agent365CredentialFactory
  agent365Client?: Agent365ClientOptions
  azureResourceGraphCredentialFactory?: AzureResourceGraphCredentialFactory
  azureResourceGraphClient?: AzureResourceGraphClientOptions
  defenderCloudAppsCredentialFactory?: DefenderCloudAppsCredentialFactory
  defenderCloudAppsClient?: DefenderCloudAppsClientOptions
  purviewCredentialFactory?: PurviewCredentialFactory
  purviewClient?: PurviewClientOptions
  teamsDistributionCredentialFactory?: TeamsDistributionCredentialFactory
  teamsDistributionClient?: TeamsDistributionClientOptions
  agent365Runtime?: ResolvedAgent365Runtime
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
  if (
    options.estate !== undefined &&
    (options.estate.tenantId !== config.estateTenantId ||
      options.estate.environment !== config.estateEnvironment)
  ) {
    throw new Error('Configured connector boundary does not match the requested estate.')
  }
  const scopedConfig =
    options.estate === undefined ? config : { ...config, estateId: options.estate.id }
  const credentialFactory =
    options.credentialFactory ??
    ((source) => options.credential ?? createFoundrySourceCredential(source))
  const foundry = new MultiFoundryConnector(scopedConfig, credentialFactory)
  const primarySource = scopedConfig.sources[0]!
  const entra = createOptionalEntraEnrichmentConnector(foundry, env, {
    expectedSources: scopedConfig.sources.map((source) => ({
      id: source.id,
      name: source.name,
      tenantId: source.tenantId,
      environment: source.environment,
      projectId: new URL(source.projectEndpoint).pathname.split('/').at(-1)!,
    })),
    estateId: scopedConfig.estateId,
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
  const agent365Options = {
    ...(options.agent365CredentialFactory !== undefined
      ? { credentialFactory: options.agent365CredentialFactory }
      : options.credential !== undefined
        ? { credential: options.credential }
        : {}),
    ...(options.agent365Client !== undefined ? { client: options.agent365Client } : {}),
  }
  const agent365 =
    options.agent365Runtime === undefined
      ? createOptionalAgent365Connector(powerPlatform, env, agent365Options)
      : createAgent365RuntimeConnector(powerPlatform, options.agent365Runtime, {
          ...(options.agent365CredentialFactory !== undefined
            ? { credentialFactory: options.agent365CredentialFactory }
            : options.credential !== undefined
              ? { credentialFactory: () => options.credential! }
              : {}),
          ...(options.agent365Client !== undefined
            ? { clientFactory: () => options.agent365Client! }
            : {}),
        } satisfies Agent365CompositionOptions)
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
  const purview = createOptionalPurviewConnector(defender, env, {
    ...(options.purviewCredentialFactory !== undefined
      ? { credentialFactory: options.purviewCredentialFactory }
      : options.credential !== undefined
        ? { credential: options.credential }
        : {}),
    ...(options.purviewClient !== undefined ? { client: options.purviewClient } : {}),
  })
  const azureResourceGraph = createOptionalAzureResourceGraphConnector(purview, env, {
    ...(options.azureResourceGraphCredentialFactory !== undefined
      ? { credentialFactory: options.azureResourceGraphCredentialFactory }
      : options.credential !== undefined
        ? { credential: options.credential }
        : {}),
    ...(options.azureResourceGraphClient !== undefined
      ? { client: options.azureResourceGraphClient }
      : {}),
  })
  return {
    connector: createOptionalTeamsDistributionConnector(azureResourceGraph, env, {
      ...(options.teamsDistributionCredentialFactory !== undefined
        ? { credentialFactory: options.teamsDistributionCredentialFactory }
        : options.credential !== undefined
          ? { credential: options.credential }
          : {}),
      ...(options.teamsDistributionClient !== undefined
        ? { client: options.teamsDistributionClient }
        : {}),
    }),
    mode,
    ...(scopedConfig.sources.length === 1
      ? { projectEndpoint: primarySource.projectEndpoint }
      : {}),
    tenantId: scopedConfig.estateTenantId,
    environment: scopedConfig.estateEnvironment,
    sourceCount: scopedConfig.sources.length,
  }
}

export async function createConfiguredConnectorForEstate(
  estate: EstateContext,
  repository: ConnectorSourceRepository,
  env: NodeJS.ProcessEnv = process.env,
  options: ConfiguredConnectorOptions = {},
): Promise<ReturnType<typeof createConfiguredConnector>> {
  const deploymentSources = buildDeploymentConnectorSources(env, { estates: [estate] }, 'live')
  const runtimeRepository =
    deploymentSources.length === 0
      ? repository
      : new DeploymentConnectorSourceRepository(repository, deploymentSources)
  const agent365Runtime = await resolveAgent365Runtime(runtimeRepository, estate)
  return createConfiguredConnector(env, { ...options, estate, agent365Runtime })
}
