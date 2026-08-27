import type {
  AgentConnector,
  ApprovalContext,
  ConnectorHealthReport,
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
import {
  ClientAssertionCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity'
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

const foundrySourceCredentialSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('default'),
    managedIdentityClientId: z.string().uuid().optional(),
  }),
  z.strictObject({
    mode: z.literal('federated-app'),
    clientId: z.string().uuid(),
    managedIdentityClientId: z.string().uuid().optional(),
  }),
])

export const foundrySourceConfigSchema = foundryConnectorConfigSchema.extend({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().trim().min(1).max(100),
  credential: foundrySourceCredentialSchema.optional(),
})
export type FoundrySourceConfig = z.infer<typeof foundrySourceConfigSchema>

export const foundryPortfolioConfigSchema = z
  .strictObject({
    estateTenantId: z.string().trim().min(1),
    estateEnvironment: z.string().trim().min(1),
    sources: z.array(foundrySourceConfigSchema).min(1).max(50),
  })
  .superRefine((config, context) => {
    const ids = new Set<string>()
    const endpoints = new Set<string>()
    for (const [index, source] of config.sources.entries()) {
      if (ids.has(source.id)) {
        context.addIssue({
          code: 'custom',
          path: ['sources', index, 'id'],
          message: `Duplicate Foundry source id: ${source.id}`,
        })
      }
      ids.add(source.id)
      if (endpoints.has(source.projectEndpoint)) {
        context.addIssue({
          code: 'custom',
          path: ['sources', index, 'projectEndpoint'],
          message: `Duplicate Foundry project endpoint: ${source.projectEndpoint}`,
        })
      }
      endpoints.add(source.projectEndpoint)
    }
  })
export type FoundryPortfolioConfig = z.infer<typeof foundryPortfolioConfigSchema>
export type FoundryCredentialFactory = (source: FoundrySourceConfig) => TokenCredential

export function createFoundrySourceCredential(source: FoundrySourceConfig): TokenCredential {
  if (source.credential?.mode === 'federated-app') {
    const managedIdentityClientId =
      source.credential.managedIdentityClientId ?? process.env['AZURE_CLIENT_ID']?.trim()
    if (!managedIdentityClientId) {
      throw new FoundryConnectorError(
        'Cross-tenant federation requires a user-assigned managed identity client ID.',
      )
    }
    const assertionCredential = new ManagedIdentityCredential({
      clientId: managedIdentityClientId,
    })
    return new ClientAssertionCredential(source.tenantId, source.credential.clientId, async () => {
      const assertion = await assertionCredential.getToken('api://AzureADTokenExchange/.default')
      if (assertion === null) {
        throw new FoundryConnectorError(
          'Managed identity did not return a workload identity federation assertion.',
        )
      }
      return assertion.token
    })
  }
  return new DefaultAzureCredential({
    tenantId: source.tenantId,
    ...(source.credential?.managedIdentityClientId !== undefined
      ? { managedIdentityClientId: source.credential.managedIdentityClientId }
      : {}),
  })
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name} is required for Foundry discovery.`)
  return value
}

export function parseFoundryPortfolioConfig(
  environment: NodeJS.ProcessEnv = process.env,
): FoundryPortfolioConfig {
  const sourcesJson = environment['FOUNDRY_SOURCES_JSON']?.trim()
  if (sourcesJson === undefined || sourcesJson.length === 0) {
    const projectEndpoint = requiredEnvironment(environment, 'FOUNDRY_PROJECT_ENDPOINT')
    const tenantId = requiredEnvironment(environment, 'FOUNDRY_TENANT_ID')
    const source = foundrySourceConfigSchema.parse({
      id: 'primary',
      name: 'Primary Foundry project',
      projectEndpoint,
      tenantId,
      environment: requiredEnvironment(environment, 'FOUNDRY_ENVIRONMENT'),
    })
    return foundryPortfolioConfigSchema.parse({
      estateTenantId: environment['AGENT_SENTINEL_TENANT_ID']?.trim() || tenantId,
      estateEnvironment: environment['AGENT_SENTINEL_ENVIRONMENT']?.trim() || source.environment,
      sources: [source],
    })
  }

  let sources: unknown
  try {
    sources = JSON.parse(sourcesJson)
  } catch {
    throw new Error('FOUNDRY_SOURCES_JSON must be valid JSON.')
  }
  return foundryPortfolioConfigSchema.parse({
    estateTenantId: requiredEnvironment(environment, 'AGENT_SENTINEL_TENANT_ID'),
    estateEnvironment:
      environment['AGENT_SENTINEL_ENVIRONMENT']?.trim() ||
      requiredEnvironment(environment, 'FOUNDRY_ENVIRONMENT'),
    sources,
  })
}

const functionToolSchema = z
  .object({
    type: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    function: z
      .object({
        name: z.string(),
        description: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  })
  .passthrough()
const agentVersionSchema = z
  .object({
    version: z.string(),
    description: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    definition: z
      .object({
        kind: z.string(),
        name: z.string().optional(),
        model: z.string(),
        instructions: z.string().optional(),
        tools: z.array(functionToolSchema).optional(),
      })
      .passthrough(),
  })
  .passthrough()
export const foundryAgentDefinitionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().nullable().optional(),
    version: z.string().optional(),
    displayName: z.string().optional(),
    description: z.string().nullable().optional(),
    model: z.string().optional(),
    instructions: z.string().nullable().optional(),
    tools: z.array(functionToolSchema).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    versions: z.object({ latest: agentVersionSchema }).optional(),
  })
  .passthrough()
  .transform((agent) => {
    const latest = agent.versions?.latest
    return {
      ...agent,
      version: agent.version ?? latest?.version,
      description: agent.description ?? latest?.description,
      model: agent.model ?? latest?.definition.model,
      instructions: agent.instructions ?? latest?.definition.instructions,
      tools: agent.tools ?? latest?.definition.tools,
      metadata: agent.metadata ?? latest?.metadata,
    }
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
  return (agent.tools ?? []).flatMap((tool) =>
    tool.type === 'function'
      ? [tool.function?.name ?? tool.name].filter((name): name is string => name !== undefined)
      : [],
  )
}

function trust(agent: FoundryAgentDefinition): 'trusted' | 'conditional' | 'untrusted' {
  const names = toolNames(agent)
  if (names.includes('external_send') || names.includes('external_transfer')) return 'untrusted'
  if (agent.metadata?.approvalRequired === 'true') return 'conditional'
  return 'trusted'
}

const identityMetadataKeys = [
  'entraServicePrincipalId',
  'servicePrincipalId',
  'entraAgentIdentityId',
  'agentIdentityId',
  'entraAppId',
  'appId',
  'entraClientId',
  'clientId',
] as const
const entraIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function explicitIdentityMetadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    identityMetadataKeys.flatMap((key) => {
      const value = metadata[key]
      return value !== undefined && entraIdPattern.test(value) ? [[key, value]] : []
    }),
  )
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
        ...explicitIdentityMetadata(metadata),
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
    const continuation =
      response.headers.get('x-ms-continuation') ??
      response.headers.get('x-ms-continuation-token') ??
      undefined
    return continuation === undefined ? { body } : { body, continuation }
  }
}

interface FoundrySourceState {
  config: FoundrySourceConfig
  connector: FoundryAgentConnector
  readiness: 'ready' | 'unavailable'
  checkedAt: string | undefined
  reason: 'not-queried' | 'authentication-or-access' | 'discovery-failed' | undefined
}

function sourceProjectId(endpoint: string): string {
  return new URL(endpoint).pathname.split('/').at(-1) ?? 'unknown'
}

function sourceScopedId(sourceId: string, id: string): string {
  return sourceId === 'primary' ? id : `foundry-source-${sourceId}--${id}`
}

function scopeFoundrySnapshot(
  snapshot: EstateSnapshot,
  source: FoundrySourceConfig,
  estateTenantId: string,
  estateEnvironment: string,
): EstateSnapshot {
  const nodeIds = new Map(
    snapshot.nodes.map((node) => [node.id, sourceScopedId(source.id, node.id)]),
  )
  const evidenceIds = new Map(
    snapshot.evidence.map((item) => [item.id, sourceScopedId(source.id, item.id)]),
  )
  return assertEstateSnapshot({
    tenantId: estateTenantId,
    environment: estateEnvironment,
    generatedAt: snapshot.generatedAt,
    nodes: snapshot.nodes.map((node) => ({
      ...node,
      id: nodeIds.get(node.id)!,
      evidenceIds: node.evidenceIds.map((id) => evidenceIds.get(id) ?? id),
      metadata: {
        ...node.metadata,
        sourceConnectorId: source.id,
        sourceConnectorName: source.name,
        sourceTenantId: source.tenantId,
        sourceProjectId: sourceProjectId(source.projectEndpoint),
        sourceEnvironment: source.environment,
      },
    })),
    edges: snapshot.edges.map((edge) => ({
      ...edge,
      id: sourceScopedId(source.id, edge.id),
      from: nodeIds.get(edge.from) ?? edge.from,
      to: nodeIds.get(edge.to) ?? edge.to,
      evidenceIds: edge.evidenceIds.map((id) => evidenceIds.get(id) ?? id),
    })),
    evidence: snapshot.evidence.map((item) => ({
      ...item,
      id: evidenceIds.get(item.id)!,
      source: `${item.source} · ${source.name}`,
      sourceObjectId: `${source.id}:${item.sourceObjectId}`,
      metadata: {
        sourceConnectorId: source.id,
        sourceConnectorName: source.name,
        sourceTenantId: source.tenantId,
        sourceProjectId: sourceProjectId(source.projectEndpoint),
        sourceEnvironment: source.environment,
      },
    })),
  })
}

function mergeFoundrySnapshots(
  snapshots: readonly EstateSnapshot[],
  estateTenantId: string,
  estateEnvironment: string,
): EstateSnapshot {
  const ids = new Set<string>()
  const requireUnique = (id: string): void => {
    if (ids.has(id)) throw new FoundryConnectorError(`Duplicate aggregated Foundry id: ${id}`)
    ids.add(id)
  }
  const nodes = snapshots.flatMap((snapshot) => snapshot.nodes)
  const edges = snapshots.flatMap((snapshot) => snapshot.edges)
  const evidence = snapshots.flatMap((snapshot) => snapshot.evidence)
  for (const item of [...nodes, ...edges, ...evidence]) requireUnique(item.id)
  return assertEstateSnapshot({
    tenantId: estateTenantId,
    environment: estateEnvironment,
    generatedAt: snapshots
      .map((snapshot) => snapshot.generatedAt)
      .sort()
      .at(-1)!,
    nodes,
    edges,
    evidence,
  })
}

export class MultiFoundryConnector implements AgentConnector {
  readonly descriptor: ConnectorDescriptor = {
    id: 'azure-ai-foundry-agent-service',
    name: 'Azure AI Foundry Agent Service',
    apiVersion: FOUNDRY_API_VERSION,
    releaseStatus: 'ga',
    capabilities: ['discovery', 'evidence'],
    requiredPermissions: ['Azure AI User on every configured Foundry project'],
    blindSpots: [
      'Declared configuration does not prove observed runtime behavior.',
      'Each tenant/project requires an independently valid credential and role assignment.',
    ],
  }

  private readonly config: FoundryPortfolioConfig
  private readonly sources: FoundrySourceState[]
  private evidenceById = new Map<string, Evidence>()

  constructor(
    configInput: FoundryPortfolioConfig,
    credentialFactory: FoundryCredentialFactory = createFoundrySourceCredential,
  ) {
    this.config = foundryPortfolioConfigSchema.parse(configInput)
    this.sources = this.config.sources.map((config) => ({
      config,
      connector: new FoundryAgentConnector(
        {
          projectEndpoint: config.projectEndpoint,
          tenantId: config.tenantId,
          environment: config.environment,
        },
        credentialFactory(config),
      ),
      readiness: 'unavailable',
      checkedAt: undefined,
      reason: 'not-queried',
    }))
  }

  async testConnection() {
    const results = await Promise.all(
      this.sources.map(async (source) => ({
        source,
        result: await source.connector.testConnection(),
      })),
    )
    for (const { source, result } of results) {
      source.checkedAt = result.checkedAt
      source.readiness = result.ok ? 'ready' : 'unavailable'
      source.reason = result.ok ? undefined : 'authentication-or-access'
    }
    const ready = results.filter(({ result }) => result.ok).length
    return {
      ok: ready === results.length,
      checkedAt: new Date().toISOString(),
      message:
        ready === results.length
          ? `All ${ready} configured Foundry sources are reachable.`
          : `${ready} of ${results.length} configured Foundry sources are reachable.`,
    }
  }

  async discover(): Promise<EstateSnapshot> {
    const results = await Promise.allSettled(
      this.sources.map(async (source) => ({
        source,
        snapshot: await source.connector.discover(),
      })),
    )
    const snapshots: EstateSnapshot[] = []
    for (const [index, result] of results.entries()) {
      const source = this.sources[index]!
      source.checkedAt = new Date().toISOString()
      if (result.status === 'fulfilled') {
        source.readiness = 'ready'
        source.reason = undefined
        snapshots.push(
          scopeFoundrySnapshot(
            result.value.snapshot,
            source.config,
            this.config.estateTenantId,
            this.config.estateEnvironment,
          ),
        )
      } else {
        source.readiness = 'unavailable'
        source.reason = 'discovery-failed'
      }
    }
    if (snapshots.length === 0) {
      throw new FoundryConnectorError('No configured Foundry source completed discovery.')
    }
    const snapshot = mergeFoundrySnapshots(
      snapshots,
      this.config.estateTenantId,
      this.config.estateEnvironment,
    )
    this.evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
    return snapshot
  }

  getConnectorHealth(): ConnectorHealthReport {
    const ready = this.sources.filter((source) => source.readiness === 'ready').length
    return {
      overall: ready === 0 ? 'unavailable' : ready === this.sources.length ? 'ready' : 'degraded',
      partial: ready > 0 && ready < this.sources.length,
      sources: this.sources.map((source) => ({
        id: `foundry:${source.config.id}`,
        name: source.config.name,
        role: 'discovery',
        enabled: true,
        configured: true,
        readiness: source.readiness,
        ...(source.checkedAt !== undefined ? { checkedAt: source.checkedAt } : {}),
        ...(source.reason !== undefined ? { reason: source.reason } : {}),
      })),
    }
  }

  getEvidence(id: string): Promise<Evidence> {
    const item = this.evidenceById.get(id)
    if (item === undefined) {
      throw new FoundryConnectorError(`Aggregated Foundry evidence was not found: ${id}`)
    }
    return Promise.resolve(structuredClone(item))
  }

  execute(): Promise<{ remediation: Remediation; snapshot: EstateSnapshot }> {
    return Promise.reject(new Error('Live remediation not supported for Foundry connector'))
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

export function createMultiFoundryConnector(
  environment: NodeJS.ProcessEnv = process.env,
  credentialFactory?: FoundryCredentialFactory,
): MultiFoundryConnector {
  return new MultiFoundryConnector(parseFoundryPortfolioConfig(environment), credentialFactory)
}
