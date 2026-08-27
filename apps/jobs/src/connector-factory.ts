import type { AgentConnector } from '@agent-sentinel/connector-sdk'
import {
  createOptionalEntraEnrichmentConnector,
  type EntraGraphClientOptions,
} from '@agent-sentinel/entra-identity-connector'
import {
  FoundryAgentConnector,
  foundryConnectorConfigSchema,
} from '@agent-sentinel/foundry-connector'
import { MockAgentConnector } from '@agent-sentinel/mock-connector'
import type { TokenCredential } from '@azure/core-auth'
import { DefaultAzureCredential } from '@azure/identity'

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

export interface JobsConnectorOptions {
  credential?: TokenCredential
  entraClient?: EntraGraphClientOptions
}

export function buildConnector(
  mode: 'mock' | 'foundry',
  environment: NodeJS.ProcessEnv = process.env,
  options: JobsConnectorOptions = {},
): AgentConnector {
  if (mode === 'mock') return new MockAgentConnector()
  const config = foundryConnectorConfigSchema.parse({
    projectEndpoint: required(environment, 'FOUNDRY_PROJECT_ENDPOINT'),
    tenantId: required(environment, 'FOUNDRY_TENANT_ID'),
    environment: required(environment, 'FOUNDRY_ENVIRONMENT'),
  })
  const credential = options.credential ?? new DefaultAzureCredential({ tenantId: config.tenantId })
  const foundry = new FoundryAgentConnector(config, credential)
  return createOptionalEntraEnrichmentConnector(foundry, environment, {
    credential,
    ...(options.entraClient !== undefined ? { client: options.entraClient } : {}),
    expectedTenantId: config.tenantId,
    expectedEnvironment: config.environment,
  })
}
