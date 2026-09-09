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
import { createAzureMonitorOtelConnector } from '@agent-sentinel/azure-monitor-otel-connector'
import type { AgentConnector, RuntimeTelemetryConnector } from '@agent-sentinel/connector-sdk'
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

export interface JobsConnectorOptions {
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

export function validateJobsStartupConfiguration(
  mode: 'mock' | 'foundry',
  estate: EstateContext,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (mode === 'mock') return
  buildDeploymentConnectorSources(environment, { estates: [estate] }, 'live')
}

export function buildRuntimeTelemetryConnector(
  mode: 'mock' | 'foundry',
  environment: NodeJS.ProcessEnv = process.env,
  credential?: TokenCredential,
): RuntimeTelemetryConnector | undefined {
  return mode === 'foundry'
    ? createAzureMonitorOtelConnector(environment, credential, 'live')
    : undefined
}

export function buildConnector(
  mode: 'mock' | 'foundry',
  environment: NodeJS.ProcessEnv = process.env,
  options: JobsConnectorOptions = {},
): AgentConnector {
  if (mode === 'mock') return new MockAgentConnector()
  const config = parseFoundryPortfolioConfig(environment)
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
  const entra = createOptionalEntraEnrichmentConnector(foundry, environment, {
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
  const powerPlatform = createOptionalPowerPlatformConnector(entra, environment, {
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
      ? createOptionalAgent365Connector(powerPlatform, environment, agent365Options)
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
  const defender = createOptionalDefenderCloudAppsConnector(agent365, environment, {
    ...(options.defenderCloudAppsCredentialFactory !== undefined
      ? { credentialFactory: options.defenderCloudAppsCredentialFactory }
      : options.credential !== undefined
        ? { credential: options.credential }
        : {}),
    ...(options.defenderCloudAppsClient !== undefined
      ? { client: options.defenderCloudAppsClient }
      : {}),
  })
  const purview = createOptionalPurviewConnector(defender, environment, {
    ...(options.purviewCredentialFactory !== undefined
      ? { credentialFactory: options.purviewCredentialFactory }
      : options.credential !== undefined
        ? { credential: options.credential }
        : {}),
    ...(options.purviewClient !== undefined ? { client: options.purviewClient } : {}),
  })
  const azureResourceGraph = createOptionalAzureResourceGraphConnector(purview, environment, {
    ...(options.azureResourceGraphCredentialFactory !== undefined
      ? { credentialFactory: options.azureResourceGraphCredentialFactory }
      : options.credential !== undefined
        ? { credential: options.credential }
        : {}),
    ...(options.azureResourceGraphClient !== undefined
      ? { client: options.azureResourceGraphClient }
      : {}),
  })
  return createOptionalTeamsDistributionConnector(azureResourceGraph, environment, {
    ...(options.teamsDistributionCredentialFactory !== undefined
      ? { credentialFactory: options.teamsDistributionCredentialFactory }
      : options.credential !== undefined
        ? { credential: options.credential }
        : {}),
    ...(options.teamsDistributionClient !== undefined
      ? { client: options.teamsDistributionClient }
      : {}),
  })
}

export async function buildConnectorForEstate(
  estate: EstateContext,
  repository: ConnectorSourceRepository,
  environment: NodeJS.ProcessEnv = process.env,
  options: JobsConnectorOptions = {},
): Promise<AgentConnector> {
  const deploymentSources = buildDeploymentConnectorSources(
    environment,
    { estates: [estate] },
    'live',
  )
  const runtimeRepository =
    deploymentSources.length === 0
      ? repository
      : new DeploymentConnectorSourceRepository(repository, deploymentSources)
  const agent365Runtime = await resolveAgent365Runtime(runtimeRepository, estate)
  return buildConnector('foundry', environment, { ...options, estate, agent365Runtime })
}
