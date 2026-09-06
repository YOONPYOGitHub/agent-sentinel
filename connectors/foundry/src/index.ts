import type {
  AgentConnector,
  ApprovalContext,
  ConnectorSourceHealth,
  ConnectorSourceProvenance,
  ConnectorHealthReport,
  ConnectorDescriptor,
} from '@agent-sentinel/connector-sdk'
import {
  assertEstateSnapshot,
  evidenceSchema,
  evidenceTypeSchema,
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
const FOUNDRY_PROVIDER = 'azure-ai-foundry-agent-service'

export interface FoundryDiscoveryLimits {
  readonly requestTimeoutMs: number
  readonly maxPages: number
  readonly maxItems: number
  readonly maxResponseBytes: number
  readonly maxTotalResponseBytes: number
  readonly maxContinuationLength: number
}

export const DEFAULT_FOUNDRY_DISCOVERY_LIMITS: FoundryDiscoveryLimits = Object.freeze({
  requestTimeoutMs: 30_000,
  maxPages: 100,
  maxItems: 10_000,
  maxResponseBytes: 4 * 1024 * 1024,
  maxTotalResponseBytes: 16 * 1024 * 1024,
  maxContinuationLength: 4_096,
})

const foundryDiscoveryLimitsSchema = z.strictObject({
  requestTimeoutMs: z.number().int().positive().max(300_000),
  maxPages: z.number().int().positive().max(1_000),
  maxItems: z.number().int().positive().max(100_000),
  maxResponseBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
  maxTotalResponseBytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1024 * 1024),
  maxContinuationLength: z.number().int().positive().max(16_384),
})

export interface FoundryConnectorOptions {
  readonly fetch?: typeof fetch
  readonly limits?: Partial<FoundryDiscoveryLimits>
  readonly signal?: AbortSignal
}

export interface FoundryDiscoveryRequest {
  readonly signal?: AbortSignal
}

export type FoundryDiscoveryFailureReason =
  | 'not-queried'
  | 'portfolio-incomplete'
  | 'authentication-or-access'
  | 'credential-failed'
  | 'request-timeout'
  | 'request-aborted'
  | 'provider-request-failed'
  | 'response-too-large'
  | 'total-response-too-large'
  | 'page-limit-exceeded'
  | 'item-limit-exceeded'
  | 'malformed-page'
  | 'repeated-continuation'
  | 'unsafe-continuation-url'
  | 'unexpected-failure'

export interface FoundrySourceProvenance extends ConnectorSourceProvenance {
  readonly provider: typeof FOUNDRY_PROVIDER
}

export interface FoundryConnectorSourceHealth extends Omit<
  ConnectorSourceHealth,
  'reason' | 'provenance'
> {
  readonly reason?: FoundryDiscoveryFailureReason
  readonly provenance: FoundrySourceProvenance
}

export interface FoundryConnectorHealthReport extends Omit<ConnectorHealthReport, 'sources'> {
  readonly sources: readonly FoundryConnectorSourceHealth[]
}

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

export const FOUNDRY_TRUST_REQUIRED_PLANES = [
  'identity',
  'runtime',
  'tools',
  'data',
  'distribution',
  'cloud-resources',
  'approval-controls',
  'provenance',
] as const

const foundryTrustPlaneSchema = z.enum(FOUNDRY_TRUST_REQUIRED_PLANES)
const exactTrustIdentifierSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, {
    message: 'Trust binding identifiers must not contain surrounding whitespace.',
  })
const foundryTrustSubjectSchema = z.strictObject({
  agentId: exactTrustIdentifierSchema,
  sourceId: exactTrustIdentifierSchema,
  tenantId: exactTrustIdentifierSchema,
  environment: exactTrustIdentifierSchema,
})
const foundryTrustIssuerSchema = z.strictObject({
  id: exactTrustIdentifierSchema,
  authenticationMode: z.enum(['managed-identity', 'workload-identity', 'jwt']),
})
const foundryTrustEvidenceInputSchema = z.strictObject({
  id: exactTrustIdentifierSchema,
  plane: foundryTrustPlaneSchema,
  subject: foundryTrustSubjectSchema,
  source: z.string().trim().min(1),
  sourceObjectId: exactTrustIdentifierSchema,
  observedAt: z.iso.datetime(),
  confidence: z.number().min(0).max(1),
  evidenceTypes: z
    .array(evidenceTypeSchema)
    .min(1)
    .max(evidenceTypeSchema.options.length)
    .refine((types) => new Set(types).size === types.length, {
      message: 'Trust evidence types must be unique.',
    }),
  uri: z.url().optional(),
  summary: z.string().trim().min(1),
  metadata: z.record(z.string(), z.string()).optional(),
})
const foundryTrustCompositionInputSchema = z
  .strictObject({
    tier: z.enum(['trusted', 'conditional', 'untrusted']),
    subject: foundryTrustSubjectSchema,
    evidence: z.array(foundryTrustEvidenceInputSchema).min(1),
  })
  .superRefine((input, context) => {
    const evidenceIds = input.evidence.map((item) => item.id)
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'Trust assessment evidence identifiers must be unique.',
      })
    }
    for (const [index, item] of input.evidence.entries()) {
      if (
        item.subject.agentId !== input.subject.agentId ||
        item.subject.sourceId !== input.subject.sourceId ||
        item.subject.tenantId !== input.subject.tenantId ||
        item.subject.environment !== input.subject.environment
      ) {
        context.addIssue({
          code: 'custom',
          path: ['evidence', index, 'subject'],
          message: 'Trust evidence subject binding must exactly match the assessment subject.',
        })
      }
    }
  })
const foundryTrustAssessmentSchema = z.strictObject({
  tier: z.enum(['trusted', 'conditional', 'untrusted']),
  subject: foundryTrustSubjectSchema,
  issuer: foundryTrustIssuerSchema,
  assessedAt: z.iso.datetime(),
  sourceMode: z.enum(['live', 'synthetic']),
  planeEvidence: z.array(
    z.strictObject({
      plane: foundryTrustPlaneSchema,
      evidenceReferences: z.array(z.string().min(1)).min(1),
    }),
  ),
  evidence: z.array(evidenceSchema).min(1),
})
export type FoundryTrustAssessment = z.output<typeof foundryTrustAssessmentSchema>

const authenticatedServerAssessments = new WeakSet<object>()
const LIVE_EVIDENCE_WINDOW_MS = 15 * 60 * 1000
const RECENT_EVIDENCE_WINDOW_MS = 24 * 60 * 60 * 1000

export interface VerifiedFoundryServerAuthContext {
  issuerId: string
  authenticationMode: 'managed-identity' | 'workload-identity' | 'jwt'
}

export interface FoundryTrustCompositionContext {
  auth: VerifiedFoundryServerAuthContext
  clock: () => Date
}

const verifiedFoundryServerAuthContextSchema = z.strictObject({
  issuerId: exactTrustIdentifierSchema,
  authenticationMode: foundryTrustIssuerSchema.shape.authenticationMode,
})

function derivedFreshness(observedAt: string, evaluatedAt: string): Evidence['freshness'] {
  const age = Date.parse(evaluatedAt) - Date.parse(observedAt)
  if (age <= LIVE_EVIDENCE_WINDOW_MS) return 'live'
  if (age <= RECENT_EVIDENCE_WINDOW_MS) return 'recent'
  return 'stale'
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

export function composeFoundryTrustAssessment(
  input: unknown,
  context: FoundryTrustCompositionContext,
): FoundryTrustAssessment {
  const parsed = foundryTrustCompositionInputSchema.parse(input)
  const auth = verifiedFoundryServerAuthContextSchema.parse(context.auth)
  const issuer = foundryTrustIssuerSchema.parse({
    id: auth.issuerId,
    authenticationMode: auth.authenticationMode,
  })
  const assessedAt = context.clock().toISOString()
  const futureEvidence = parsed.evidence.find(
    (item) => Date.parse(item.observedAt) > Date.parse(assessedAt),
  )
  if (futureEvidence !== undefined) {
    throw new FoundryConnectorError(
      `Trust evidence ${futureEvidence.id} cannot be observed after the server assessment time.`,
    )
  }
  const planeEvidence = FOUNDRY_TRUST_REQUIRED_PLANES.flatMap((plane) => {
    const evidenceReferences = parsed.evidence
      .filter((item) => item.plane === plane)
      .map((item) => item.id)
    return evidenceReferences.length > 0 ? [{ plane, evidenceReferences }] : []
  })
  const sourceMode = parsed.evidence.some((item) =>
    item.evidenceTypes.includes('synthetic_validation'),
  )
    ? 'synthetic'
    : 'live'
  const assessment = foundryTrustAssessmentSchema.parse({
    tier: parsed.tier,
    subject: parsed.subject,
    issuer,
    assessedAt,
    sourceMode,
    planeEvidence,
    evidence: parsed.evidence.map(({ plane, subject, ...item }) => ({
      ...item,
      freshness: derivedFreshness(item.observedAt, assessedAt),
      metadata: {
        ...item.metadata,
        trustPlane: plane,
        trustSubjectAgentId: subject.agentId,
        trustSubjectSourceId: subject.sourceId,
        trustSubjectTenantId: subject.tenantId,
        trustSubjectEnvironment: subject.environment,
      },
    })),
  })
  const immutableAssessment = deepFreeze(assessment)
  authenticatedServerAssessments.add(immutableAssessment)
  return immutableAssessment
}

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
    trustAssessment: z.unknown().optional(),
    versions: z.object({ latest: agentVersionSchema }).optional(),
  })
  .passthrough()
  .transform((agent) => {
    const { trustAssessment: ignoredTrustAssessment, ...inventory } = agent
    void ignoredTrustAssessment
    const latest = agent.versions?.latest
    return {
      ...inventory,
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
    if (page.data !== undefined && page.value !== undefined)
      ctx.addIssue({
        code: 'custom',
        message: 'Agent list response must not contain both data and value.',
      })
  })

export class FoundryConnectorError extends Error {
  override readonly name: string = 'FoundryConnectorError'

  constructor(
    message: string,
    readonly reason: FoundryDiscoveryFailureReason = 'unexpected-failure',
  ) {
    super(message)
  }
}

export interface FoundryPortfolioSourceFailure {
  readonly sourceId: string
  readonly reason: FoundryDiscoveryFailureReason
  readonly provenance: FoundrySourceProvenance
}

export class FoundryPortfolioIncompleteError extends FoundryConnectorError {
  override readonly name = 'FoundryPortfolioIncompleteError'
  readonly failures: readonly FoundryPortfolioSourceFailure[]

  constructor(
    failures: readonly FoundryPortfolioSourceFailure[],
    readonly configuredSourceCount: number,
  ) {
    super(
      `Foundry portfolio discovery incomplete: ${failures.length} of ${configuredSourceCount} configured sources failed.`,
      'portfolio-incomplete',
    )
    this.failures = Object.freeze(
      failures.map((failure) =>
        Object.freeze({
          ...failure,
          provenance: Object.freeze({ ...failure.provenance }),
        }),
      ),
    )
  }
}
function toolNames(agent: FoundryAgentDefinition): string[] {
  return (agent.tools ?? []).flatMap((tool) =>
    tool.type === 'function'
      ? [tool.function?.name ?? tool.name].filter((name): name is string => name !== undefined)
      : [],
  )
}

type NormalizedFoundryAgent = z.output<typeof foundryAgentDefinitionSchema>

interface FoundryTrustResult {
  trust: 'trusted' | 'conditional' | 'untrusted'
  status: 'missing' | 'binding-mismatch' | 'complete' | 'incomplete'
  evidence: Evidence[]
  evidenceIds: string[]
  missingPlanes: string[]
  sourceMode: 'live' | 'synthetic' | undefined
  issuerId: string | undefined
  assessedAt: string | undefined
}

function normalizedTrustEvidenceId(agentId: string, evidenceId: string): string {
  return `foundry-trust-evidence-${agentId}-${evidenceId}`
}

export interface FoundrySnapshotComposition {
  sourceId: string
  trustAssessments: readonly FoundryTrustAssessment[]
  clock?: () => Date
}

function exactTrustSubject(
  assessment: FoundryTrustAssessment,
  agentId: string,
  composition: FoundrySnapshotComposition,
  config: Pick<FoundryConnectorConfig, 'tenantId' | 'environment'>,
): boolean {
  return (
    assessment.subject.agentId === agentId &&
    assessment.subject.sourceId === composition.sourceId &&
    assessment.subject.tenantId === config.tenantId &&
    assessment.subject.environment === config.environment
  )
}

function evaluateTrust(
  agent: NormalizedFoundryAgent,
  config: Pick<FoundryConnectorConfig, 'tenantId' | 'environment'>,
  composition: FoundrySnapshotComposition,
  evaluatedAt: string,
): FoundryTrustResult {
  const names = toolNames(agent)
  const serverAssessments = composition.trustAssessments.filter((assessment) =>
    authenticatedServerAssessments.has(assessment),
  )
  const matchingAssessments = serverAssessments.filter((assessment) =>
    exactTrustSubject(assessment, agent.id, composition, config),
  )
  if (matchingAssessments.length > 1) {
    throw new FoundryConnectorError(
      `Multiple authenticated trust assessments bind to Foundry agent ${agent.id}.`,
    )
  }
  const assessment = matchingAssessments[0]
  if (assessment === undefined) {
    const bindingMismatch = serverAssessments.some(
      (candidate) => candidate.subject.agentId === agent.id,
    )
    return {
      trust:
        names.includes('external_send') || names.includes('external_transfer')
          ? 'untrusted'
          : 'conditional',
      status: bindingMismatch ? 'binding-mismatch' : 'missing',
      evidence: [],
      evidenceIds: [],
      missingPlanes: [...FOUNDRY_TRUST_REQUIRED_PLANES],
      sourceMode: undefined,
      issuerId: undefined,
      assessedAt: undefined,
    }
  }

  if (Date.parse(assessment.assessedAt) > Date.parse(evaluatedAt)) {
    throw new FoundryConnectorError(
      `Trust assessment for Foundry agent ${agent.id} is future-dated.`,
    )
  }
  const futureEvidence = assessment.evidence.find(
    (item) => Date.parse(item.observedAt) > Date.parse(evaluatedAt),
  )
  if (futureEvidence !== undefined) {
    throw new FoundryConnectorError(
      `Trust evidence ${futureEvidence.id} for Foundry agent ${agent.id} is future-dated.`,
    )
  }
  const evaluatedEvidence = assessment.evidence.map((item) => ({
    ...item,
    freshness: derivedFreshness(item.observedAt, evaluatedAt),
  }))
  const evidenceById = new Map(evaluatedEvidence.map((item) => [item.id, item]))
  const planeEvidence = new Map(
    assessment.planeEvidence.map((plane) => [plane.plane, plane.evidenceReferences]),
  )
  const missingPlanes = FOUNDRY_TRUST_REQUIRED_PLANES.filter((plane) => {
    const references = planeEvidence.get(plane)
    return (
      references === undefined ||
      references.length === 0 ||
      references.some((reference) => !evidenceById.has(reference))
    )
  })
  const citedEvidenceIds = new Set(
    assessment.planeEvidence.flatMap((plane) => plane.evidenceReferences),
  )
  const citedEvidence = [...citedEvidenceIds]
    .map((id) => evidenceById.get(id))
    .filter((item): item is Evidence => item !== undefined)
  const runtimeEvidenceIds = new Set(planeEvidence.get('runtime') ?? [])
  const complete =
    assessment.sourceMode === 'live' &&
    missingPlanes.length === 0 &&
    citedEvidence.length > 0 &&
    citedEvidence.some(
      (item) => runtimeEvidenceIds.has(item.id) && item.evidenceTypes.includes('observed_runtime'),
    ) &&
    citedEvidence.every(
      (item) =>
        item.freshness === 'live' &&
        item.confidence > 0 &&
        !item.evidenceTypes.includes('unknown') &&
        !item.evidenceTypes.includes('synthetic_validation'),
    )
  const evidence = evaluatedEvidence.map((item) => ({
    ...item,
    id: normalizedTrustEvidenceId(agent.id, item.id),
    metadata: {
      ...item.metadata,
      trustAssessmentSourceMode: assessment.sourceMode,
      trustAssessmentTier: assessment.tier,
      trustAssessmentObservedAt: assessment.assessedAt,
      trustAssessmentIssuerId: assessment.issuer.id,
      trustAssessmentIssuerAuthenticationMode: assessment.issuer.authenticationMode,
    },
  }))

  return {
    trust:
      assessment.tier === 'untrusted'
        ? 'untrusted'
        : complete && assessment.tier === 'trusted'
          ? 'trusted'
          : names.includes('external_send') || names.includes('external_transfer')
            ? 'untrusted'
            : 'conditional',
    status: complete ? 'complete' : 'incomplete',
    evidence,
    evidenceIds: citedEvidence.map((item) => normalizedTrustEvidenceId(agent.id, item.id)),
    missingPlanes,
    sourceMode: assessment.sourceMode,
    issuerId: assessment.issuer.id,
    assessedAt: assessment.assessedAt,
  }
}

const identityMetadataKeys = [
  'entraServicePrincipalId',
  'servicePrincipalId',
  'objectId',
  'entraAgentIdentityId',
  'agentIdentityId',
  'entraAppId',
  'appId',
  'entraClientId',
  'clientId',
] as const

function explicitIdentityMetadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    identityMetadataKeys.flatMap((key) => {
      const value = metadata[key]
      return value !== undefined ? [[key, value]] : []
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
  composition: FoundrySnapshotComposition = {
    sourceId: 'primary',
    trustAssessments: [],
  },
): EstateSnapshot {
  const generatedAt = (composition.clock?.() ?? new Date()).toISOString()
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const evidence: Evidence[] = []
  for (const agentInput of agents) {
    const agent = foundryAgentDefinitionSchema.parse(agentInput)
    const agentId = `foundry-agent-${agent.id}`
    const evidenceId = `foundry-evidence-${agent.id}`
    const metadata = agent.metadata ?? {}
    const trustResult = evaluateTrust(agent, config, composition, generatedAt)
    nodes.push({
      id: agentId,
      kind: 'agent',
      name: agent.name ?? agent.displayName ?? agent.id,
      description: agent.description ?? 'No description declared.',
      environment: config.environment,
      owner: metadata.owner,
      trust: trustResult.trust,
      evidenceIds: [evidenceId, ...trustResult.evidenceIds],
      metadata: {
        platform: 'Azure AI Foundry Agent Service',
        version: agent.version ?? metadata.version ?? '',
        modelDeployment: agent.model ?? '',
        lifecycle: metadata.lifecycle ?? 'active',
        approvalRequired:
          metadata.approvalRequired === 'true' || metadata.approvalRequired === 'false'
            ? metadata.approvalRequired
            : 'unknown',
        trustAssessmentStatus: trustResult.status,
        ...(trustResult.sourceMode !== undefined
          ? { trustAssessmentSourceMode: trustResult.sourceMode }
          : {}),
        ...(trustResult.issuerId !== undefined
          ? { trustAssessmentIssuerId: trustResult.issuerId }
          : {}),
        ...(trustResult.assessedAt !== undefined
          ? { trustAssessmentAssessedAt: trustResult.assessedAt }
          : {}),
        ...(trustResult.evidenceIds.length > 0
          ? { trustAssessmentEvidenceIds: trustResult.evidenceIds.join(',') }
          : {}),
        ...(trustResult.missingPlanes.length > 0
          ? { trustAssessmentMissingPlanes: trustResult.missingPlanes.join(',') }
          : {}),
        ...(metadata.businessUnit !== undefined ? { businessUnit: metadata.businessUnit } : {}),
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
        environment: config.environment,
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
      evidenceTypes: ['declared_configuration'],
      summary: `Declared configuration for ${agent.name ?? agent.id}; this is not observed runtime behavior.`,
    })
    evidence.push(...trustResult.evidence)
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

function discoveryFailureReason(error: unknown): FoundryDiscoveryFailureReason {
  if (error instanceof FoundryConnectorError) return error.reason
  if (error instanceof z.ZodError) return 'malformed-page'
  return 'unexpected-failure'
}

function readinessForFailure(reason: FoundryDiscoveryFailureReason): 'degraded' | 'unavailable' {
  return reason === 'authentication-or-access' || reason === 'credential-failed'
    ? 'unavailable'
    : 'degraded'
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
  private readonly fetcher: typeof fetch
  private readonly limits: FoundryDiscoveryLimits
  private readonly defaultSignal: AbortSignal | undefined
  private evidenceById = new Map<string, Evidence>()
  private lastFailureReason: FoundryDiscoveryFailureReason | undefined = 'not-queried'
  constructor(
    config: FoundryConnectorConfig,
    private readonly credential: TokenCredential,
    private readonly composition: FoundrySnapshotComposition = {
      sourceId: 'primary',
      trustAssessments: [],
    },
    options: FoundryConnectorOptions = {},
  ) {
    this.config = foundryConnectorConfigSchema.parse(config)
    this.fetcher = options.fetch ?? globalThis.fetch
    this.defaultSignal = options.signal
    this.limits = foundryDiscoveryLimitsSchema.parse({
      ...DEFAULT_FOUNDRY_DISCOVERY_LIMITS,
      ...options.limits,
    })
  }
  async testConnection() {
    const checkedAt = new Date().toISOString()
    try {
      await this.listAgents(1, this.defaultSignal)
      this.lastFailureReason = undefined
      return { ok: true, checkedAt, message: 'Azure AI Foundry Agent Service is reachable.' }
    } catch (error: unknown) {
      this.lastFailureReason = discoveryFailureReason(error)
      return {
        ok: false,
        checkedAt,
        message: error instanceof Error ? error.message : 'Unknown Foundry connection error.',
      }
    }
  }
  async discover(request: FoundryDiscoveryRequest = {}): Promise<EstateSnapshot> {
    this.evidenceById = new Map()
    try {
      const snapshot = mapAgentToSnapshot(
        await this.listAgents(undefined, request.signal ?? this.defaultSignal),
        FOUNDRY_API_VERSION,
        this.config,
        this.composition,
      )
      this.evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
      this.lastFailureReason = undefined
      return snapshot
    } catch (error: unknown) {
      this.lastFailureReason = discoveryFailureReason(error)
      throw error
    }
  }
  getLastFailureReason(): FoundryDiscoveryFailureReason | undefined {
    return this.lastFailureReason
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
  private async listAgents(
    maximum?: number,
    signal?: AbortSignal,
  ): Promise<FoundryAgentDefinition[]> {
    const initial = new URL(`${this.config.projectEndpoint.replace(/\/+$/, '')}/agents`)
    initial.searchParams.set('api-version', FOUNDRY_API_VERSION)
    const agents: FoundryAgentDefinition[] = []
    const seenContinuations = new Set<string>([initial.href])
    let pageCount = 0
    let totalResponseBytes = 0
    let next: URL | undefined = initial
    while (next !== undefined) {
      if (pageCount >= this.limits.maxPages) {
        throw new FoundryConnectorError(
          `Foundry discovery exceeded the ${this.limits.maxPages} page limit.`,
          'page-limit-exceeded',
        )
      }
      const response = await this.request(next, totalResponseBytes, signal)
      pageCount += 1
      totalResponseBytes += response.bytes
      let page: z.output<typeof foundryAgentPageSchema>
      try {
        page = foundryAgentPageSchema.parse(response.body)
      } catch {
        throw new FoundryConnectorError(
          'Foundry returned a malformed agent list page.',
          'malformed-page',
        )
      }
      const pageAgents = page.data ?? page.value ?? []
      if (agents.length + pageAgents.length > this.limits.maxItems) {
        throw new FoundryConnectorError(
          `Foundry discovery exceeded the ${this.limits.maxItems} item limit.`,
          'item-limit-exceeded',
        )
      }
      agents.push(...pageAgents)
      next = this.resolveContinuation(page, response.continuation, initial)
      if (next !== undefined && seenContinuations.has(next.href)) {
        throw new FoundryConnectorError(
          'Foundry returned a repeated pagination continuation.',
          'repeated-continuation',
        )
      }
      if (next !== undefined) seenContinuations.add(next.href)
      if (maximum !== undefined && agents.length >= maximum) return agents.slice(0, maximum)
    }
    return agents
  }

  private resolveContinuation(
    page: z.output<typeof foundryAgentPageSchema>,
    responseContinuation: string | undefined,
    initial: URL,
  ): URL | undefined {
    const nextLink =
      page.nextLink === undefined ? undefined : this.validateContinuationUrl(page.nextLink, initial)
    if (page.continuationToken !== undefined) {
      this.validateContinuationToken(page.continuationToken)
    }
    if (responseContinuation !== undefined) {
      this.validateContinuationToken(responseContinuation)
    }
    if (
      page.continuationToken !== undefined &&
      responseContinuation !== undefined &&
      page.continuationToken !== responseContinuation
    ) {
      throw new FoundryConnectorError(
        'Foundry returned conflicting continuation tokens.',
        'malformed-page',
      )
    }
    const continuationToken = page.continuationToken ?? responseContinuation
    const hasContinuation = nextLink !== undefined || continuationToken !== undefined
    if (page.has_more === true && !hasContinuation) {
      throw new FoundryConnectorError(
        'Foundry returned a page marked incomplete without a continuation.',
        'malformed-page',
      )
    }
    if (page.has_more === false && hasContinuation) {
      throw new FoundryConnectorError(
        'Foundry returned continuation metadata for a complete page.',
        'malformed-page',
      )
    }
    if (page.has_more === false) return undefined
    if (nextLink !== undefined) {
      nextLink.searchParams.set('api-version', FOUNDRY_API_VERSION)
      return nextLink
    }
    if (continuationToken === undefined) return undefined
    const next = new URL(initial)
    next.searchParams.set('continuationToken', continuationToken)
    return next
  }

  private validateContinuationUrl(value: string, initial: URL): URL {
    if (
      value.length === 0 ||
      value.length > this.limits.maxContinuationLength ||
      value.trim() !== value
    ) {
      throw new FoundryConnectorError(
        'Foundry returned an invalid agents nextLink.',
        'unsafe-continuation-url',
      )
    }
    let candidate: URL
    try {
      candidate = new URL(value, initial)
    } catch {
      throw new FoundryConnectorError(
        'Foundry returned an invalid agents nextLink.',
        'unsafe-continuation-url',
      )
    }
    if (
      candidate.protocol !== 'https:' ||
      candidate.username !== '' ||
      candidate.password !== '' ||
      candidate.hash !== '' ||
      candidate.origin !== initial.origin ||
      candidate.pathname !== initial.pathname
    ) {
      throw new FoundryConnectorError(
        'Foundry returned an untrusted agents nextLink.',
        'unsafe-continuation-url',
      )
    }
    return candidate
  }

  private validateContinuationToken(token: string): void {
    if (
      token.length === 0 ||
      token.length > this.limits.maxContinuationLength ||
      token.trim() !== token
    ) {
      throw new FoundryConnectorError(
        'Foundry returned an invalid continuation token.',
        'malformed-page',
      )
    }
  }
  private async request(
    url: URL,
    totalResponseBytes: number,
    externalSignal?: AbortSignal,
  ): Promise<{ body: unknown; bytes: number; continuation?: string }> {
    if (externalSignal?.aborted === true) {
      throw new FoundryConnectorError('Foundry discovery was aborted.', 'request-aborted')
    }
    const timeoutController = new AbortController()
    const timeoutState = { expired: false }
    const timeout = setTimeout(() => {
      timeoutState.expired = true
      timeoutController.abort()
    }, this.limits.requestTimeoutMs)
    const signal =
      externalSignal === undefined
        ? timeoutController.signal
        : AbortSignal.any([externalSignal, timeoutController.signal])
    try {
      return await this.requestWithSignal(url, totalResponseBytes, signal, timeoutController)
    } catch (error: unknown) {
      if (error instanceof FoundryConnectorError) throw error
      if (timeoutState.expired)
        throw new FoundryConnectorError('Foundry request timed out.', 'request-timeout')
      if (signal.aborted)
        throw new FoundryConnectorError('Foundry discovery was aborted.', 'request-aborted')
      throw new FoundryConnectorError(
        'Foundry request failed before a complete response was received.',
        'provider-request-failed',
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  private async requestWithSignal(
    url: URL,
    totalResponseBytes: number,
    signal: AbortSignal,
    abortController: AbortController,
  ): Promise<{ body: unknown; bytes: number; continuation?: string }> {
    let token
    try {
      token = await this.credential.getToken(TOKEN_SCOPE, { abortSignal: signal })
    } catch {
      if (signal.aborted) throw signal.reason
      throw new FoundryConnectorError(
        'Azure credential failed to return a Foundry access token.',
        'credential-failed',
      )
    }
    if (token === null)
      throw new FoundryConnectorError(
        'Azure credential did not return a Foundry access token.',
        'credential-failed',
      )
    const response = await this.fetcher(url, {
      signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token.token}` },
    })
    const bytes = await this.readResponseBytes(response, totalResponseBytes, abortController)
    let body: unknown
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      throw new FoundryConnectorError(
        'Foundry returned a malformed JSON response.',
        'malformed-page',
      )
    }
    if (!response.ok) {
      const reason =
        response.status === 401 || response.status === 403
          ? 'authentication-or-access'
          : 'provider-request-failed'
      throw new FoundryConnectorError(
        errorMessage(body) ?? `Foundry request failed with status ${response.status}.`,
        reason,
      )
    }
    const continuation =
      response.headers.get('x-ms-continuation') ??
      response.headers.get('x-ms-continuation-token') ??
      undefined
    return continuation === undefined
      ? { body, bytes: bytes.byteLength }
      : { body, bytes: bytes.byteLength, continuation }
  }

  private async readResponseBytes(
    response: Response,
    totalResponseBytes: number,
    abortController: AbortController,
  ): Promise<Uint8Array> {
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
      const bytes = Number(declaredLength)
      if (bytes > this.limits.maxResponseBytes) {
        abortController.abort()
        throw new FoundryConnectorError(
          `Foundry response exceeded the ${this.limits.maxResponseBytes} byte response limit.`,
          'response-too-large',
        )
      }
      if (totalResponseBytes + bytes > this.limits.maxTotalResponseBytes) {
        abortController.abort()
        throw new FoundryConnectorError(
          `Foundry discovery exceeded the ${this.limits.maxTotalResponseBytes} byte total response limit.`,
          'total-response-too-large',
        )
      }
    }
    if (response.body === null) return new Uint8Array()
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytesRead = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytesRead += chunk.value.byteLength
      if (bytesRead > this.limits.maxResponseBytes) {
        abortController.abort()
        throw new FoundryConnectorError(
          `Foundry response exceeded the ${this.limits.maxResponseBytes} byte response limit.`,
          'response-too-large',
        )
      }
      if (totalResponseBytes + bytesRead > this.limits.maxTotalResponseBytes) {
        abortController.abort()
        throw new FoundryConnectorError(
          `Foundry discovery exceeded the ${this.limits.maxTotalResponseBytes} byte total response limit.`,
          'total-response-too-large',
        )
      }
      chunks.push(chunk.value)
    }
    const body = new Uint8Array(bytesRead)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    return body
  }
}

interface FoundrySourceState {
  config: FoundrySourceConfig
  connector: FoundryAgentConnector
  readiness: 'ready' | 'degraded' | 'unavailable'
  checkedAt: string | undefined
  reason: FoundryDiscoveryFailureReason | undefined
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
        sourceObjectId: node.id.startsWith('foundry-agent-')
          ? node.id.slice('foundry-agent-'.length)
          : node.id,
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
        ...item.metadata,
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
    trustAssessments: readonly FoundryTrustAssessment[] = [],
    options: FoundryConnectorOptions = {},
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
        {
          sourceId: config.id,
          trustAssessments,
        },
        options,
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
      source.reason = result.ok ? undefined : source.connector.getLastFailureReason()
      source.readiness = source.reason === undefined ? 'ready' : readinessForFailure(source.reason)
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
    this.evidenceById = new Map()
    const results = await Promise.allSettled(
      this.sources.map(async (source) => ({
        source,
        snapshot: await source.connector.discover(),
      })),
    )
    const snapshots: EstateSnapshot[] = []
    const failures: FoundryPortfolioSourceFailure[] = []
    const checkedAt = new Date().toISOString()
    for (const [index, result] of results.entries()) {
      const source = this.sources[index]!
      source.checkedAt = checkedAt
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
        source.reason = discoveryFailureReason(result.reason)
        source.readiness = readinessForFailure(source.reason)
        failures.push({
          sourceId: source.config.id,
          reason: source.reason,
          provenance: this.sourceProvenance(source.config),
        })
      }
    }
    if (failures.length > 0) {
      throw new FoundryPortfolioIncompleteError(failures, this.sources.length)
    }
    const snapshot = mergeFoundrySnapshots(
      snapshots,
      this.config.estateTenantId,
      this.config.estateEnvironment,
    )
    this.evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
    return snapshot
  }

  private sourceProvenance(source: FoundrySourceConfig): FoundrySourceProvenance {
    return {
      estateTenantId: this.config.estateTenantId,
      estateEnvironment: this.config.estateEnvironment,
      sourceConnectorId: source.id,
      sourceTenantId: source.tenantId,
      sourceEnvironment: source.environment,
      provider: FOUNDRY_PROVIDER,
      providerObjectId: sourceProjectId(source.projectEndpoint),
    }
  }

  getConnectorHealth(): FoundryConnectorHealthReport {
    const ready = this.sources.filter((source) => source.readiness === 'ready').length
    const degraded = this.sources.some((source) => source.readiness === 'degraded')
    return {
      overall:
        ready === this.sources.length
          ? 'ready'
          : ready > 0 || degraded
            ? 'degraded'
            : 'unavailable',
      partial: ready > 0 && ready < this.sources.length,
      sources: this.sources.map((source) => ({
        id: `foundry:${source.config.id}`,
        name: source.config.name,
        role: 'discovery',
        enabled: true,
        configured: true,
        readiness: source.readiness,
        provenance: this.sourceProvenance(source.config),
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
