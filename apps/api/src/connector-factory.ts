import type { AgentConnector } from '@agent-sentinel/connector-sdk'
import {
  FoundryAgentConnector,
  foundryConnectorConfigSchema,
} from '@agent-sentinel/foundry-connector'
import { MockAgentConnector } from '@agent-sentinel/mock-connector'
import { DefaultAzureCredential } from '@azure/identity'
export type ConnectorMode = 'mock' | 'foundry'
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required when AGENT_SENTINEL_CONNECTOR=foundry.`)
  return value
}
export function createConfiguredConnector(env: NodeJS.ProcessEnv = process.env): {
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
  return {
    connector: new FoundryAgentConnector(config, new DefaultAzureCredential()),
    mode,
    projectEndpoint: config.projectEndpoint,
  }
}
