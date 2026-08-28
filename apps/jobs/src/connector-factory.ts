import {
  createOptionalAgent365Connector,
  type Agent365ClientOptions,
  type Agent365CredentialFactory,
} from '@agent-sentinel/agent365-connector'
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

export interface JobsConnectorOptions {
  credential?: TokenCredential
  credentialFactory?: FoundryCredentialFactory
  entraClient?: EntraGraphClientOptions
  powerPlatformCredentialFactory?: PowerPlatformCredentialFactory
  powerPlatformClient?: PowerPlatformClientOptions
  agent365CredentialFactory?: Agent365CredentialFactory
  agent365Client?: Agent365ClientOptions
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
  const entra = createOptionalEntraEnrichmentConnector(foundry, environment, {
    expectedSources: config.sources.map((source) => ({
      id: source.id,
      name: source.name,
      tenantId: source.tenantId,
      environment: source.environment,
    })),
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
  return createOptionalAgent365Connector(powerPlatform, environment, {
    ...(options.agent365CredentialFactory !== undefined
      ? { credentialFactory: options.agent365CredentialFactory }
      : options.credential !== undefined
        ? { credential: options.credential }
        : {}),
    ...(options.agent365Client !== undefined ? { client: options.agent365Client } : {}),
  })
}
