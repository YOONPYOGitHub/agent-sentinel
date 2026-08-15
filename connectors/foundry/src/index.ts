import type {
  AgentConnector,
  ApprovalContext,
  ConnectorDescriptor,
} from '@agent-sentinel/connector-sdk'
import {
  assertEstateSnapshot,
  type EstateSnapshot,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type Remediation,
} from '@agent-sentinel/domain'
import type { TokenCredential } from '@azure/core-auth'
import { DefaultAzureCredential } from '@azure/identity'
import { z } from 'zod'

export const FOUNDRY_API_VERSION = 'v1'
const TOKEN_SCOPE = 'https://ai.azure.com/.default'

export function sanitizeFoundryProjectEndpoint(endpoint: string): string {
  let url: URL
  try {
    url = new URL(endpoint.trim())
  } catch {
    throw new Error('Invalid Azure AI Foundry project endpoint.')
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !url.hostname.toLowerCase().endsWith('.services.ai.azure.com') ||
    !/^\/api\/projects\/[A-Za-z0-9][A-Za-z0-9._-]*\/?$/.test(url.pathname)
  ) {
    throw new Error('Invalid Azure AI Foundry project endpoint.')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export const foundryConnectorConfigSchema = z.strictObject({
  projectEndpoint: z.string().url().transform(sanitizeFoundryProjectEndpoint),
  tenantId: z.string().min(1),
  environment: z.string().min(1),
})
export const foundryConfigSchema = foundryConnectorConfigSchema
export type FoundryConnectorConfig = z.infer<typeof foundryConnectorConfigSchema>

const functionToolSchema = z.object({ type: z.string(), name: z.string().optional(), description: z.string().optional(), parameters: z.record(z.string(), z.unknown()).optional(), function: z.object({ name: z.string(), description: z.string().optional(), parameters: z.record(z.string(), z.unknown()).optional() }).optional() }).passthrough()
const agentVersionSchema = z.object({ version: z.string(), description: z.string().nullable().optional(), metadata: z.record(z.string(), z.string()).optional(), definition: z.object({ kind: z.string(), name: z.string().optional(), model: z.string(), instructions: z.string().optional(), tools: z.array(functionToolSchema).optional() }).passthrough() }).passthrough()
export const foundryAgentDefinitionSchema = z.object({
  id: z.string().min(1), name: z.string().nullable().optional(), version: z.string().optional(), displayName: z.string().optional(), description: z.string().nullable().optional(), model: z.string().optional(), instructions: z.string().nullable().optional(), tools: z.array(functionToolSchema).optional(), metadata: z.record(z.string(), z.string()).optional(), versions: z.object({ latest: agentVersionSchema }).optional(),
}).passthrough().transform((agent) => {
  const latest = agent.versions?.latest
  return { ...agent, version: agent.version ?? latest?.version, description: agent.description ?? latest?.description, model: agent.model ?? latest?.definition.model, instructions: agent.instructions ?? latest?.definition.instructions, tools: agent.tools ?? latest?.definition.tools, metadata: agent.metadata ?? latest?.metadata }
})
export const foundryAgentSchema = foundryAgentDefinitionSchema
export type FoundryAgentDefinition = z.input<typeof foundryAgentDefinitionSchema>
export type FoundryAgent = FoundryAgentDefinition
export const foundryAgentPageSchema = z
  .object({
    data: z.array(foundryAgentDefinitionSchema).optional(),
    value: z.array(foundryAgentDefinitionSchema).optional(),
    has_more: z.boolean().optional(),
    nextLink: z.string().optional(),
    continuationToken: z.string().optional(),
  })
  .passthrough()
  .superRefine((page, ctx) => {
    if (page.data === undefined && page.value === undefined)
      ctx.addIssue({ code: 'custom', message: 'Agent list response must contain data or value.' })
  })

export class FoundryConnectorError extends Error {
  override readonly name = 'FoundryConnectorError'
}
function toolNames(agent: FoundryAgentDefinition): string[] {
  return (agent.tools ?? []).flatMap((tool) => tool.type === 'function' ? [tool.function?.name ?? tool.name].filter((name): name is string => name !== undefined) : [])
}

function trust(agent: FoundryAgentDefinition): 'trusted' | 'conditional' | 'untrusted' {
  const names = toolNames(agent)
  if (names.includes('external_send') || names.includes('external_transfer')) return 'untrusted'
  if (agent.metadata?.approvalRequired === 'true') return 'conditional'
  return 'trusted'
}

export function mapAgentToSnapshot(
  agents: FoundryAgentDefinition[],
  apiVersion: string,
  config: Pick<FoundryConnectorConfig, 'tenantId' | 'environment'> = {
    tenantId: 'unknown',
    environment: 'unknown',
  },
): EstateSnapshot {
  const generatedAt = new Date().toISOString()
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const evidence: Evidence[] = []
  for (const agent of agents) {
    const agentId = `foundry-agent-${agent.id}`
    const evidenceId = `foundry-evidence-${agent.id}`
    const metadata = agent.metadata ?? {}
    nodes.push({
      id: agentId,
      kind: 'agent',
      name: agent.name ?? agent.displayName ?? agent.id,
      description: agent.description ?? 'No description declared.',
      environment: metadata.environment ?? config.environment,
      owner: metadata.owner,
      trust: trust(agent),
      evidenceIds: [evidenceId],
      metadata: {
        platform: 'Azure AI Foundry Agent Service',
        version: agent.version ?? metadata.version ?? '',
        modelDeployment: agent.model ?? '',
        lifecycle: metadata.lifecycle ?? 'active',
        approvalRequired: metadata.approvalRequired ?? 'false',
        apiVersion,
      },
    })
    for (const tool of agent.tools ?? []) {
      if (tool.type !== 'function') continue
      const toolName = tool.function?.name ?? tool.name
      if (toolName === undefined) continue
      const toolDescription = tool.function?.description ?? tool.description
      const toolId = `foundry-tool-${agent.id}-${toolName}`
      nodes.push({
        id: toolId,
        kind: 'tool',
        name: toolName,
        description: toolDescription ?? `Declared function ${toolName}.`,
        environment: metadata.environment ?? config.environment,
        trust: 'conditional',
        evidenceIds: [evidenceId],
        metadata: { platform: 'Azure AI Foundry Agent Service', apiVersion },
      })
      edges.push({
        id: `foundry-edge-${agent.id}-${toolName}`,
        from: agentId,
        to: toolId,
        relationship: 'CAN_CALL',
        evidenceIds: [evidenceId],
        active: true,
        removable: false,
      })
    }
    evidence.push({
      id: evidenceId,
      source: 'Azure AI Foundry Agent Service',
      sourceObjectId: agent.id,
      observedAt: generatedAt,
      freshness: 'live',
      confidence: 1,
      summary: `Declared configuration for ${agent.name ?? agent.id}; this is not observed runtime behavior.`,
    })
  }
  return assertEstateSnapshot({
    tenantId: config.tenantId,
    environment: config.environment,
    generatedAt,
    nodes,
    edges,
    evidence,
  })
}

function errorMessage(value: unknown): string | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null &&
    'message' in value.error &&
    typeof value.error.message === 'string'
  )
    return value.error.message
  return undefined
}

export class FoundryAgentConnector implements AgentConnector {
  readonly descriptor: ConnectorDescriptor = {
    id: 'azure-ai-foundry-agent-service',
    name: 'Azure AI Foundry Agent Service',
    apiVersion: FOUNDRY_API_VERSION,
    releaseStatus: 'ga',
    capabilities: ['discovery', 'evidence'],
    requiredPermissions: ['Azure AI User'],
    blindSpots: ['Declared configuration does not prove observed runtime behavior.'],
  }
  private readonly config: FoundryConnectorConfig
  private evidenceById = new Map<string, Evidence>()
  constructor(
    config: FoundryConnectorConfig,
    private readonly credential: TokenCredential,
  ) {
    this.config = foundryConnectorConfigSchema.parse(config)
  }
  async testConnection() {
    const checkedAt = new Date().toISOString()
    try {
      await this.listAgents(1)
      return { ok: true, checkedAt, message: 'Azure AI Foundry Agent Service is reachable.' }
    } catch (error: unknown) {
      return {
        ok: false,
        checkedAt,
        message: error instanceof Error ? error.message : 'Unknown Foundry connection error.',
      }
    }
  }
  async discover(): Promise<EstateSnapshot> {
    const snapshot = mapAgentToSnapshot(await this.listAgents(), FOUNDRY_API_VERSION, this.config)
    this.evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
    return snapshot
  }
  getEvidence(id: string): Promise<Evidence> {
    const item = this.evidenceById.get(id)
    if (item === undefined) throw new FoundryConnectorError(`Foundry evidence was not found: ${id}`)
    return Promise.resolve(structuredClone(item))
  }
  execute(
    remediation: Remediation,
    approval: ApprovalContext,
  ): Promise<{ remediation: Remediation; snapshot: EstateSnapshot }> {
    void remediation
    void approval
    return Promise.reject(new Error('Live remediation not supported for Foundry connector'))
  }
  private async listAgents(maximum?: number): Promise<FoundryAgentDefinition[]> {
    const initial = new URL(`${this.config.projectEndpoint.replace(/\/+$/, '')}/agents`)
    initial.searchParams.set('api-version', FOUNDRY_API_VERSION)
    const agents: FoundryAgentDefinition[] = []
    let next: URL | undefined = initial
    while (next !== undefined) {
      const response = await this.request(next)
      const page = foundryAgentPageSchema.parse(response.body)
      agents.push(...(page.data ?? page.value ?? []))
      if (maximum !== undefined && agents.length >= maximum) return agents.slice(0, maximum)
      next = undefined
      if (page.nextLink !== undefined) {
        const candidate = new URL(page.nextLink, initial)
        if (candidate.origin !== initial.origin || candidate.pathname !== initial.pathname)
          throw new FoundryConnectorError('Untrusted agents nextLink.')
        candidate.searchParams.set('api-version', FOUNDRY_API_VERSION)
        next = candidate
      } else {
        const token = page.continuationToken ?? response.continuation
        if (token !== undefined) {
          next = new URL(initial)
          next.searchParams.set('continuationToken', token)
        }
      }
    }
    return agents
  }
  private async request(url: URL): Promise<{ body: unknown; continuation?: string }> {
    const token = await this.credential.getToken(TOKEN_SCOPE)
    if (token === null)
      throw new FoundryConnectorError('Azure credential did not return a Foundry access token.')
    const response = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token.token}` },
    })
    let body: unknown
    try {
      body = await response.json()
    } catch (error: unknown) {
      throw new FoundryConnectorError(
        `Foundry returned an unreadable response: ${error instanceof Error ? error.message : 'non-JSON response'}`,
      )
    }
    if (!response.ok)
      throw new FoundryConnectorError(
        errorMessage(body) ?? `Foundry request failed with status ${response.status}.`,
      )
    const continuation = response.headers.get('x-ms-continuation') ?? response.headers.get('x-ms-continuation-token') ?? undefined
    return continuation === undefined ? { body } : { body, continuation }
  }
}

export function createFoundryConnector(
  environment: NodeJS.ProcessEnv = process.env,
  credential: TokenCredential = new DefaultAzureCredential(),
): FoundryAgentConnector {
  return new FoundryAgentConnector(
    {
      projectEndpoint: environment.FOUNDRY_PROJECT_ENDPOINT ?? '',
      tenantId: environment.FOUNDRY_TENANT_ID ?? '',
      environment: environment.FOUNDRY_ENVIRONMENT ?? '',
    },
    credential,
  )
}
