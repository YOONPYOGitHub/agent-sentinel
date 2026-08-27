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

export type ConnectorMode = 'mock' | 'foundry'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required when AGENT_SENTINEL_CONNECTOR=foundry.`)
  return value
}

export interface ConfiguredConnectorOptions {
  credential?: TokenCredential
  entraClient?: EntraGraphClientOptions
}

export function createConfiguredConnector(
  env: NodeJS.ProcessEnv = process.env,
  options: ConfiguredConnectorOptions = {},
): {
  connector: AgentConnector
  mode: ConnectorMode
  projectEndpoint?: string
} {
  const mode = env.AGENT_SENTINEL_CONNECTOR?.trim() || 'mock'
  if (mode === 'mock') return { connector: new MockAgentConnector(), mode }
  if (mode !== 'foundry')
    throw new Error(`AGENT_SENTINEL_CONNECTOR must be mock or foundry; received ${mode}.`)
  const config = foundryConnectorConfigSchema.parse({
    projectEndpoint: required(env, 'FOUNDRY_PROJECT_ENDPOINT'),
    tenantId: required(env, 'FOUNDRY_TENANT_ID'),
    environment: required(env, 'FOUNDRY_ENVIRONMENT'),
  })
  const credential = options.credential ?? new DefaultAzureCredential({ tenantId: config.tenantId })
  const foundry = new FoundryAgentConnector(config, credential)
  return {
    connector: createOptionalEntraEnrichmentConnector(foundry, env, {
      credential,
      ...(options.entraClient !== undefined ? { client: options.entraClient } : {}),
      expectedTenantId: config.tenantId,
      expectedEnvironment: config.environment,
    }),
    mode,
    projectEndpoint: config.projectEndpoint,
  }
}
