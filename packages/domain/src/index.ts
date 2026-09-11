import { z } from 'zod'

import type { EstateContext } from './estate.js'
import { evidenceSchema, evidenceTypeSchema, type Evidence } from './evidence.js'
import { runsAsBindingSchema } from './evidence-authority.js'
import {
  otelWindowQualitySchema,
  runtimeOtelEvidenceItemSchema,
  runtimeOtelProvenanceSchema,
} from './otel-evidence.js'
import { sourceProjectIdSchema } from './source-project.js'

export { estateContextSchema, estateIdSchema } from './estate.js'
export type { EstateContext } from './estate.js'

export {
  AGENT365_APPROVED_MANAGED_IDENTITY_CLIENT_ID,
  AGENT365_MAX_RETRY_AFTER_MS,
  agent365AggregationSchema,
  connectorTypeSchema,
  connectorSourceConfigurationSchema,
  connectorSourceIdSchema,
  connectorCredentialMetadataSchema,
  connectorSourceActorSchema,
  connectorSourceTestStatusSchema,
  connectorSourceCreateInputSchema,
  connectorSourceUpdateInputSchema,
  connectorSourceDefinitionSchema,
  connectorSourceMigrationSchema,
  connectorSourceMigrationRequiredSchema,
  connectorSourceReadModelSchema,
  hydratePersistedConnectorSourceDefinition,
  isConnectorSourceMigrationRequired,
  connectorSourceMutationContextSchema,
  connectorSourceAuditRecordSchema,
  connectorSourceAuditReadModelSchema,
  evaluateAgent365SourcePolicy,
  hydratePersistedConnectorSourceAuditRecord,
} from './connector-source.js'
export type {
  Agent365SourcePolicyDecision,
  Agent365SourcePolicyInactiveReason,
  Agent365SourcePolicyInput,
  ConnectorType,
  ConnectorSourceConfiguration,
  ConnectorCredentialMetadata,
  ConnectorSourceActor,
  ConnectorSourceTestStatus,
  ConnectorSourceCreateInput,
  ConnectorSourceUpdateInput,
  ConnectorSourceDefinition,
  ConnectorSourceMigration,
  ConnectorSourceMigrationRequired,
  ConnectorSourceReadModel,
  ConnectorSourceMutationContext,
  ConnectorSourceAuditRecord,
  ConnectorSourceAuditReadModel,
} from './connector-source.js'

export {
  agentCorrelationKindSchema,
  agentCorrelationSchema,
  agentCorrelationsSchema,
} from './correlation.js'
export type { AgentCorrelationKind, AgentCorrelation } from './correlation.js'

export { SOURCE_PROJECT_ID_MAX_LENGTH, sourceProjectIdSchema } from './source-project.js'
export type { SourceProjectId } from './source-project.js'

export { evidenceSchema, evidenceTypeSchema } from './evidence.js'
export type { Evidence, EvidenceType } from './evidence.js'

export { evidenceAuthoritySchema, runsAsBindingSchema } from './evidence-authority.js'
export type { EvidenceAuthority, RunsAsBinding } from './evidence-authority.js'

export {
  otelEvidenceStatusSchema,
  otelEvidenceClassificationSchema,
  otelSignalTypeSchema,
  otelEvidenceCaveatSchema,
  otelSamplingSchema,
  otelAggregationSchema,
  otelEvidenceProvenanceSchema,
  otelEvidenceClaimSchema,
  representativeOtelEvidenceSchema,
  otelWindowQualitySchema,
  runtimeOtelProvenanceSchema,
  runtimeOtelEvidenceItemSchema,
  otelEvidenceDetailsSchema,
} from './otel-evidence.js'
export type {
  OtelEvidenceStatus,
  OtelEvidenceClassification,
  OtelSignalType,
  OtelEvidenceCaveat,
  OtelSampling,
  OtelAggregation,
  OtelEvidenceProvenance,
  OtelEvidenceClaim,
  RepresentativeOtelEvidence,
  OtelWindowQuality,
  RuntimeOtelProvenance,
  RuntimeOtelEvidenceItem,
  OtelEvidenceDetails,
} from './otel-evidence.js'

export const nodeKindSchema = z.enum([
  'input',
  'agent',
  'identity',
  'data',
  'mcp',
  'tool',
  'control',
])

export type NodeKind = z.infer<typeof nodeKindSchema>

export const graphNodeSchema = z.object({
  id: z.string().min(1),
  kind: nodeKindSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  environment: z.string().min(1),
  owner: z.string().min(1).optional(),
  sensitivity: z.enum(['public', 'internal', 'confidential', 'highly-confidential']).optional(),
  trust: z.enum(['trusted', 'conditional', 'untrusted']).optional(),
  evidenceIds: z.array(z.string().min(1)).min(1),
  metadata: z.record(z.string(), z.string()).default({}),
})

export type GraphNode = z.infer<typeof graphNodeSchema>

export const relationshipSchema = z.enum([
  'TRIGGERS',
  'RUNS_AS',
  'CAN_READ',
  'CAN_CALL',
  'CAN_EXFILTRATE_TO',
  'PROTECTED_BY',
])

export type Relationship = z.infer<typeof relationshipSchema>

export const graphEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  relationship: relationshipSchema,
  evidenceIds: z.array(z.string().min(1)).min(1),
  active: z.boolean(),
  removable: z.boolean().default(false),
  runsAsBinding: runsAsBindingSchema.optional(),
})

export type GraphEdge = z.infer<typeof graphEdgeSchema>

export const estateSnapshotSchema = z
  .object({
    tenantId: z.string().min(1),
    environment: z.string().min(1),
    generatedAt: z.iso.datetime(),
    nodes: z.array(graphNodeSchema),
    edges: z.array(graphEdgeSchema),
    evidence: z.array(evidenceSchema),
  })
  .superRefine((snapshot, context) => {
    const evidenceIds = new Set(snapshot.evidence.map((evidence) => evidence.id))

    for (const [nodeIndex, node] of snapshot.nodes.entries()) {
      for (const [evidenceIndex, evidenceId] of node.evidenceIds.entries()) {
        if (!evidenceIds.has(evidenceId)) {
          context.addIssue({
            code: 'custom',
            message: `Node ${node.id} references unknown evidence ${evidenceId}.`,
            path: ['nodes', nodeIndex, 'evidenceIds', evidenceIndex],
          })
        }
      }
    }

    for (const [edgeIndex, edge] of snapshot.edges.entries()) {
      for (const [evidenceIndex, evidenceId] of edge.evidenceIds.entries()) {
        if (!evidenceIds.has(evidenceId)) {
          context.addIssue({
            code: 'custom',
            message: `Edge ${edge.id} references unknown evidence ${evidenceId}.`,
            path: ['edges', edgeIndex, 'evidenceIds', evidenceIndex],
          })
        }
      }
    }
  })

export type EstateSnapshot = z.infer<typeof estateSnapshotSchema>

export const PERSISTED_ESTATE_SNAPSHOT_SCHEMA_VERSION = 2

export interface AuthoritativeRuntimeAgentBinding {
  sourceConnectorId: string
  sourceTenantId: string
  sourceProjectId: string
  sourceAgentId: string
  sourceEnvironment: string
}

export function hasSyntheticOrTestMarker(metadata: Readonly<Record<string, string>>): boolean {
  return Object.entries(metadata).some(([key, value]) => {
    const normalizedValue = value.trim().toLowerCase()
    const markerValues = [
      'true',
      '1',
      'yes',
      'synthetic',
      'test',
      'tested',
      'testing',
      'fixture',
      'mock',
    ]
    return (
      (/(synthetic|test|fixture|mock)/i.test(key) && markerValues.includes(normalizedValue)) ||
      (/(mode|classification)$/i.test(key) &&
        ['synthetic', 'test', 'tested', 'testing', 'fixture', 'mock'].includes(normalizedValue))
    )
  })
}

function hasNonAuthoritativeSignals(evidence: Evidence): boolean {
  const metadata = evidence.metadata ?? {}
  return (
    metadata['sourceOfTruth'] === 'false' ||
    metadata['isNonAuthoritative'] === 'true' ||
    hasSyntheticOrTestMarker(metadata) ||
    evidence.evidenceTypes.includes('synthetic_validation') ||
    evidence.evidenceTypes.includes('unknown')
  )
}

function optionalBoundaryMatches(
  metadata: Readonly<Record<string, string>>,
  key: string,
  expected: string | undefined,
): boolean {
  return metadata[key] === undefined || (expected !== undefined && metadata[key] === expected)
}

function evidenceMatchesRuntimeAgentBoundary(
  evidence: Evidence,
  snapshot: Pick<EstateSnapshot, 'tenantId' | 'environment' | 'generatedAt'>,
  agent: GraphNode,
  binding: AuthoritativeRuntimeAgentBinding,
  expectedEstateId?: string,
): boolean {
  const metadata = evidence.metadata ?? {}
  if (
    hasNonAuthoritativeSignals(evidence) ||
    !optionalBoundaryMatches(metadata, 'estateId', expectedEstateId) ||
    !optionalBoundaryMatches(metadata, 'estateTenantId', snapshot.tenantId) ||
    !optionalBoundaryMatches(metadata, 'estateEnvironment', snapshot.environment) ||
    !optionalBoundaryMatches(metadata, 'sourceId', agent.metadata['sourceId']) ||
    !optionalBoundaryMatches(metadata, 'sourceConnectorId', binding.sourceConnectorId) ||
    !optionalBoundaryMatches(metadata, 'sourceTenantId', binding.sourceTenantId) ||
    !optionalBoundaryMatches(metadata, 'sourceProjectId', binding.sourceProjectId) ||
    !optionalBoundaryMatches(metadata, 'sourceEnvironment', binding.sourceEnvironment) ||
    !optionalBoundaryMatches(metadata, 'provider', agent.metadata['provider']) ||
    !optionalBoundaryMatches(metadata, 'sourceObjectId', binding.sourceAgentId) ||
    !optionalBoundaryMatches(metadata, 'providerAgentId', binding.sourceAgentId) ||
    !optionalBoundaryMatches(metadata, 'providerObjectId', binding.sourceAgentId) ||
    !optionalBoundaryMatches(metadata, 'trustSubjectAgentId', binding.sourceAgentId) ||
    !optionalBoundaryMatches(metadata, 'snapshotGeneratedAt', snapshot.generatedAt) ||
    !optionalBoundaryMatches(metadata, 'sourceRelease', agent.metadata['sourceRelease'])
  ) {
    return false
  }
  const authority = evidence.authority
  if (authority === undefined) return true
  return (
    expectedEstateId !== undefined &&
    authority.estateId === expectedEstateId &&
    authority.sourceId === agent.metadata['sourceId'] &&
    authority.tenantId === binding.sourceTenantId &&
    authority.environment === binding.sourceEnvironment &&
    authority.provider === agent.metadata['provider'] &&
    authority.sourceObjectId === binding.sourceProjectId &&
    authority.providerObjectId === binding.sourceAgentId &&
    authority.snapshotGeneratedAt === snapshot.generatedAt &&
    authority.sourceRelease === agent.metadata['sourceRelease']
  )
}

export function authoritativeRuntimeAgentBinding(
  snapshot: {
    tenantId: string
    environment: string
    generatedAt: string
    evidence: readonly Evidence[]
  },
  agent: GraphNode,
  estate?: EstateContext,
): AuthoritativeRuntimeAgentBinding | undefined {
  if (
    agent.kind !== 'agent' ||
    agent.metadata['sourceOfTruth'] !== 'true' ||
    agent.metadata['isNonAuthoritative'] === 'true' ||
    hasSyntheticOrTestMarker(agent.metadata) ||
    (estate !== undefined &&
      (estate.tenantId !== snapshot.tenantId || estate.environment !== snapshot.environment))
  ) {
    return undefined
  }
  const sourceConnectorId = agent.metadata['sourceConnectorId']
  const sourceTenantId = agent.metadata['sourceTenantId']
  const sourceProjectId = agent.metadata['sourceProjectId']
  const sourceAgentId = agent.metadata['sourceObjectId']
  const sourceEnvironment = agent.metadata['sourceEnvironment']
  if (
    sourceConnectorId === undefined ||
    sourceTenantId === undefined ||
    sourceProjectId === undefined ||
    sourceAgentId === undefined ||
    sourceEnvironment === undefined ||
    agent.environment !== sourceEnvironment ||
    (agent.metadata['providerAgentId'] !== undefined &&
      agent.metadata['providerAgentId'] !== sourceAgentId)
  ) {
    return undefined
  }
  const binding = {
    sourceConnectorId,
    sourceTenantId,
    sourceProjectId,
    sourceAgentId,
    sourceEnvironment,
  }
  const evidenceById = new Map<string, Evidence[]>()
  for (const evidence of snapshot.evidence) {
    const records = evidenceById.get(evidence.id) ?? []
    records.push(evidence)
    evidenceById.set(evidence.id, records)
  }
  if (
    agent.evidenceIds.length === 0 ||
    agent.evidenceIds.some((evidenceId) => !evidenceById.has(evidenceId))
  ) {
    return undefined
  }
  const citedEvidence = agent.evidenceIds.flatMap(
    (evidenceId) => evidenceById.get(evidenceId) ?? [],
  )
  const declaredEvidence = citedEvidence.filter((evidence) =>
    evidence.evidenceTypes.includes('declared_configuration'),
  )
  const expectedEstateId = estate?.id ?? agent.metadata['estateId']
  if (
    declaredEvidence.length === 0 ||
    declaredEvidence.some(
      (evidence) =>
        !evidenceMatchesRuntimeAgentBoundary(evidence, snapshot, agent, binding, expectedEstateId),
    )
  ) {
    return undefined
  }
  const authoritativeEvidence = declaredEvidence.some((evidence) => {
    const metadata = evidence.metadata
    return (
      evidence.evidenceTypes.length === 1 &&
      evidence.evidenceTypes[0] === 'declared_configuration' &&
      metadata?.['sourceOfTruth'] === 'true' &&
      metadata['estateTenantId'] === snapshot.tenantId &&
      metadata['estateEnvironment'] === snapshot.environment &&
      metadata['sourceConnectorId'] === sourceConnectorId &&
      metadata['sourceTenantId'] === sourceTenantId &&
      metadata['sourceProjectId'] === sourceProjectId &&
      metadata['sourceEnvironment'] === sourceEnvironment &&
      metadata['sourceObjectId'] === sourceAgentId
    )
  })
  return authoritativeEvidence ? binding : undefined
}

const legacyRuntimeOtelProvenanceSchema = runtimeOtelProvenanceSchema.partial({
  snapshotGeneratedAt: true,
  sourceProjectId: true,
})

const legacyRuntimeOtelEvidenceItemSchema = z.strictObject({
  ...runtimeOtelEvidenceItemSchema.shape,
  toolCallNames: runtimeOtelEvidenceItemSchema.shape.toolCallNames.optional(),
  provenance: legacyRuntimeOtelProvenanceSchema,
})

const legacyRuntimeEvidenceSchema = z.object({
  ...evidenceSchema.shape,
  otel: z.strictObject({
    quality: otelWindowQualitySchema,
    invocations: z.array(legacyRuntimeOtelEvidenceItemSchema).max(500),
  }),
})

const legacyEstateSnapshotSchema = z.object({
  tenantId: z.string().min(1),
  environment: z.string().min(1),
  generatedAt: z.iso.datetime(),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
  evidence: z.array(z.unknown()),
})

type RuntimeProjectAuthorityBinding = Pick<
  z.infer<typeof legacyRuntimeOtelProvenanceSchema>,
  'sourceConnectorId' | 'sourceTenantId' | 'sourceEnvironment' | 'providerAgentId'
>

type RuntimeProjectAuthorityIndex = ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>

function runtimeProjectAuthorityKey(binding: RuntimeProjectAuthorityBinding): string {
  return JSON.stringify([
    binding.sourceConnectorId,
    binding.sourceTenantId,
    binding.sourceEnvironment,
    binding.providerAgentId,
  ])
}

function createRuntimeProjectAuthorityIndex(
  snapshot: z.infer<typeof legacyEstateSnapshotSchema>,
  validEvidence: readonly Evidence[],
  runtimeEvidenceIds: ReadonlySet<string>,
  estate: EstateContext,
): RuntimeProjectAuthorityIndex {
  const projectsByEvidence = new Map<string, Map<string, Set<string>>>()
  const authoritySnapshot = {
    tenantId: snapshot.tenantId,
    environment: snapshot.environment,
    generatedAt: snapshot.generatedAt,
    evidence: validEvidence,
  }
  for (const node of snapshot.nodes) {
    const binding = authoritativeRuntimeAgentBinding(authoritySnapshot, node, estate)
    if (binding === undefined) continue
    const sourceProjectId = sourceProjectIdSchema.safeParse(binding.sourceProjectId)
    if (!sourceProjectId.success) continue
    const associatedRuntimeEvidenceIds: string[] = []
    for (const evidenceId of node.evidenceIds) {
      if (runtimeEvidenceIds.has(evidenceId)) associatedRuntimeEvidenceIds.push(evidenceId)
    }

    const authorityKey = runtimeProjectAuthorityKey({
      sourceConnectorId: binding.sourceConnectorId,
      sourceTenantId: binding.sourceTenantId,
      sourceEnvironment: binding.sourceEnvironment,
      providerAgentId: binding.sourceAgentId,
    })
    for (const evidenceId of associatedRuntimeEvidenceIds) {
      let projectsByAuthority = projectsByEvidence.get(evidenceId)
      if (projectsByAuthority === undefined) {
        projectsByAuthority = new Map()
        projectsByEvidence.set(evidenceId, projectsByAuthority)
      }
      let projects = projectsByAuthority.get(authorityKey)
      if (projects === undefined) {
        projects = new Set()
        projectsByAuthority.set(authorityKey, projects)
      }
      projects.add(sourceProjectId.data)
    }
  }
  return projectsByEvidence
}

function exactRuntimeProjectId(
  authorityIndex: RuntimeProjectAuthorityIndex,
  evidenceId: string,
  binding: RuntimeProjectAuthorityBinding,
  claimedProjectId?: string,
): string | undefined {
  const projects = authorityIndex.get(evidenceId)?.get(runtimeProjectAuthorityKey(binding))
  if (projects === undefined || projects.size !== 1) return undefined
  const [sourceProjectId] = projects
  return claimedProjectId === undefined || claimedProjectId === sourceProjectId
    ? sourceProjectId
    : undefined
}

function migrationRequiredLegacyRuntimeEvidence(
  evidence: z.infer<typeof legacyRuntimeEvidenceSchema>,
): Evidence {
  return evidenceSchema.parse({
    id: evidence.id,
    source: evidence.source,
    sourceObjectId: evidence.sourceObjectId,
    observedAt: evidence.observedAt,
    freshness: evidence.freshness,
    confidence: 0,
    evidenceTypes: ['unknown'],
    ...(evidence.uri === undefined ? {} : { uri: evidence.uri }),
    summary: evidence.summary,
    metadata: {
      ...evidence.metadata,
      sourceOfTruth: 'false',
      isNonAuthoritative: 'true',
      migrationStatus: 'migration-required',
      migrationReason: 'legacy-runtime-evidence-missing-exact-source-context',
    },
  })
}

function hydrateLegacyPersistedEstateSnapshot(
  value: unknown,
  expectedEstateId: string,
): EstateSnapshot {
  const legacy = legacyEstateSnapshotSchema.parse(value)
  const validEvidence: Evidence[] = []
  const runtimeEvidenceIds = new Set<string>()
  for (const candidate of legacy.evidence) {
    const parsed = evidenceSchema.safeParse(candidate)
    if (parsed.success) validEvidence.push(parsed.data)
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      'id' in candidate &&
      typeof candidate.id === 'string' &&
      'otel' in candidate
    ) {
      runtimeEvidenceIds.add(candidate.id)
      if (!parsed.success) {
        const evidenceWithoutOtel = { ...candidate }
        delete evidenceWithoutOtel['otel']
        const baseEvidence = evidenceSchema.safeParse(evidenceWithoutOtel)
        if (baseEvidence.success) validEvidence.push(baseEvidence.data)
      }
    }
  }
  const authorityIndex = createRuntimeProjectAuthorityIndex(
    legacy,
    validEvidence,
    runtimeEvidenceIds,
    {
      id: expectedEstateId,
      tenantId: legacy.tenantId,
      environment: legacy.environment,
    },
  )
  const evidence = legacy.evidence.map((candidate) => {
    if (typeof candidate === 'object' && candidate !== null && 'otel' in candidate) {
      const runtimeEvidence = legacyRuntimeEvidenceSchema.parse(candidate)
      if (runtimeEvidence.otel.invocations.length === 0) {
        return migrationRequiredLegacyRuntimeEvidence(runtimeEvidence)
      }
      const invocations = runtimeEvidence.otel.invocations.map((invocation) => {
        const provenance = invocation.provenance
        const sourceProjectId =
          provenance.estateId === expectedEstateId &&
          provenance.estateTenantId === legacy.tenantId &&
          provenance.estateEnvironment === legacy.environment &&
          (provenance.snapshotGeneratedAt === undefined ||
            provenance.snapshotGeneratedAt === legacy.generatedAt)
            ? exactRuntimeProjectId(
                authorityIndex,
                runtimeEvidence.id,
                provenance,
                provenance.sourceProjectId,
              )
            : undefined
        if (sourceProjectId === undefined) return undefined
        return runtimeOtelEvidenceItemSchema.parse({
          ...invocation,
          toolCallNames: invocation.toolCallNames ?? [],
          provenance: {
            ...invocation.provenance,
            sourceProjectId,
            snapshotGeneratedAt: invocation.provenance.snapshotGeneratedAt ?? legacy.generatedAt,
          },
        })
      })
      if (invocations.some((invocation) => invocation === undefined)) {
        return migrationRequiredLegacyRuntimeEvidence(runtimeEvidence)
      }
      return evidenceSchema.parse({
        ...runtimeEvidence,
        otel: {
          ...runtimeEvidence.otel,
          invocations,
        },
      })
    }
    const currentEvidence = evidenceSchema.safeParse(candidate)
    if (currentEvidence.success) return currentEvidence.data
    return evidenceSchema.parse(candidate)
  })
  return estateSnapshotSchema.parse({ ...legacy, evidence })
}

export function hydratePersistedEstateSnapshot(
  value: unknown,
  expectedEstateId: string,
  persistedSchemaVersion?: number,
): EstateSnapshot {
  if (persistedSchemaVersion === PERSISTED_ESTATE_SNAPSHOT_SCHEMA_VERSION) {
    return estateSnapshotSchema.parse(value)
  }
  if (persistedSchemaVersion === 1) {
    return hydrateLegacyPersistedEstateSnapshot(value, expectedEstateId)
  }
  if (persistedSchemaVersion !== undefined) {
    throw new Error(`Unsupported persisted estate snapshot version: ${persistedSchemaVersion}`)
  }
  const current = estateSnapshotSchema.safeParse(value)
  return current.success
    ? current.data
    : hydrateLegacyPersistedEstateSnapshot(value, expectedEstateId)
}

export function assertPersistableEstateSnapshot(
  estate: EstateContext,
  value: unknown,
): EstateSnapshot {
  const snapshot = estateSnapshotSchema.parse(value)
  if (snapshot.tenantId !== estate.tenantId || snapshot.environment !== estate.environment) {
    throw new Error('Snapshot boundary does not match the target estate.')
  }
  const runtimeEvidenceIds = new Set(
    snapshot.evidence.flatMap((evidence) => (evidence.otel === undefined ? [] : [evidence.id])),
  )
  const authorityIndex = createRuntimeProjectAuthorityIndex(
    snapshot,
    snapshot.evidence,
    runtimeEvidenceIds,
    estate,
  )
  for (const evidence of snapshot.evidence) {
    const invocations = evidence.otel?.invocations ?? []
    if (invocations.length === 0) continue
    const metadata = evidence.metadata
    const sourceConnectorId = metadata?.['sourceConnectorId']
    const sourceTenantId = metadata?.['sourceTenantId']
    const claimedSourceProjectId = metadata?.['sourceProjectId']
    const sourceEnvironment = metadata?.['sourceEnvironment']
    const sourceAgentId = metadata?.['sourceAgentId']
    const sourceProjectId =
      metadata?.['sourceConnector'] === 'azure-monitor-otel' &&
      metadata['estateId'] === estate.id &&
      metadata['estateTenantId'] === estate.tenantId &&
      metadata['estateEnvironment'] === estate.environment &&
      sourceConnectorId !== undefined &&
      sourceTenantId !== undefined &&
      claimedSourceProjectId !== undefined &&
      sourceEnvironment !== undefined &&
      sourceAgentId !== undefined
        ? exactRuntimeProjectId(
            authorityIndex,
            evidence.id,
            {
              sourceConnectorId,
              sourceTenantId,
              sourceEnvironment,
              providerAgentId: sourceAgentId,
            },
            claimedSourceProjectId,
          )
        : undefined
    for (const invocation of invocations) {
      const provenance = invocation.provenance
      const sourceBindingMatches =
        sourceProjectId !== undefined &&
        sourceConnectorId === provenance.sourceConnectorId &&
        sourceTenantId === provenance.sourceTenantId &&
        sourceProjectId === provenance.sourceProjectId &&
        sourceEnvironment === provenance.sourceEnvironment &&
        sourceAgentId === provenance.providerAgentId
      if (
        provenance.estateId !== estate.id ||
        provenance.estateTenantId !== estate.tenantId ||
        provenance.estateEnvironment !== estate.environment ||
        provenance.snapshotGeneratedAt !== snapshot.generatedAt ||
        provenance.observedAt !== invocation.observedAt ||
        !sourceBindingMatches
      ) {
        throw new Error(
          `OpenTelemetry invocation provenance does not match the target estate and snapshot source binding: ${evidence.id}/${invocation.id}`,
        )
      }
    }
  }
  return snapshot
}

export const riskFactorsSchema = z.object({
  reachability: z.number().min(0).max(1),
  exploitability: z.number().min(0).max(1),
  businessImpact: z.number().min(0).max(1),
  privilege: z.number().min(0).max(1),
  dataSensitivity: z.number().min(0).max(1),
  activity: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  compensatingControlDiscount: z.number().min(0).max(1),
})

export type RiskFactors = z.infer<typeof riskFactorsSchema>

export const attackPathSchema = z.object({
  id: z.string().min(1),
  nodeIds: z.array(z.string().min(1)).min(2),
  edgeIds: z.array(z.string().min(1)).min(1),
  evidenceIds: z.array(z.string().min(1)).min(1),
  riskScore: z.number().min(0).max(100),
  factors: riskFactorsSchema,
  status: z.enum(['theoretical', 'validated', 'mitigated']),
})

export type AttackPath = z.infer<typeof attackPathSchema>

export const findingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  path: attackPathSchema,
  owner: z.string().min(1),
  policyId: z.string().min(1),
  detectedAt: z.iso.datetime(),
  recommendation: z.string().min(1),
})

export type Finding = z.infer<typeof findingSchema>

export const validationRunSchema = z.object({
  id: z.string().min(1),
  findingId: z.string().min(1),
  status: z.enum(['queued', 'running', 'validated', 'not-reproduced', 'failed']),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
  syntheticCanary: z.string().min(1),
  observedAtTarget: z.boolean().optional(),
  trace: z.array(z.string()),
})

export type ValidationRun = z.infer<typeof validationRunSchema>

export const remediationSchema = z.object({
  id: z.string().min(1),
  findingId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  targetEdgeId: z.string().min(1),
  status: z.enum(['proposed', 'approved', 'executing', 'completed', 'failed', 'rolled-back']),
  expectedRiskReduction: z.number().min(0).max(100),
  businessDisruption: z.enum(['none', 'low', 'medium', 'high']),
  approvedBy: z.string().min(1).optional(),
  approvedAt: z.iso.datetime().optional(),
  approvalReason: z.string().min(10).max(500).optional(),
  executedAt: z.iso.datetime().optional(),
  rollbackAvailable: z.boolean(),
})

export type Remediation = z.infer<typeof remediationSchema>

export const manifestRuntimeClaimVerificationStatusSchema = z.enum([
  'verified',
  'no-observation',
  'ambiguous',
  'not-correlatable',
  'unavailable',
])
export type ManifestRuntimeClaimVerificationStatus = z.infer<
  typeof manifestRuntimeClaimVerificationStatusSchema
>

export const manifestRuntimeVerificationSchema = z.object({
  status: z.enum(['not-configured', 'no-claims', 'ready', 'partial', 'unavailable']),
  reason: z.enum(['repository-unavailable', 'source-limit-exceeded']).optional(),
  checkedAt: z.iso.datetime(),
  counts: z.object({
    verified: z.number().int().min(0),
    noObservation: z.number().int().min(0),
    ambiguous: z.number().int().min(0),
    notCorrelatable: z.number().int().min(0),
    unavailable: z.number().int().min(0),
  }),
  claims: z.array(
    z.object({
      manifestId: z.string().min(1),
      evidenceId: z.string().min(1),
      subjectId: z.string().min(1),
      status: manifestRuntimeClaimVerificationStatusSchema,
      matchedNodeId: z.string().min(1).optional(),
      corroboratingEvidenceIds: z.array(z.string().min(1)),
      reason: z.enum([
        'missing-source-binding',
        'subject-binding-mismatch',
        'no-exact-source-match',
        'multiple-exact-source-matches',
        'entity-kind-mismatch',
        'unsupported-node-kind',
        'no-owning-agent',
        'ambiguous-owning-agent',
        'telemetry-not-queried',
        'telemetry-query-failed',
        'telemetry-projection-failed',
        'no-non-synthetic-runtime-observation',
        'non-synthetic-runtime-observation',
      ]),
    }),
  ),
})
export type ManifestRuntimeVerification = z.infer<typeof manifestRuntimeVerificationSchema>

export const manifestConfigurationComparableFieldSchema = z.enum([
  'agent.platform',
  'agent.version',
  'agent.model',
  'agent.approvalRequired',
  'tool.toolType',
  'identity.principalType',
  'data.sensitivity',
  'data.classification',
  'mcp.endpointRef',
  'mcp.approved',
])
export type ManifestConfigurationComparableField = z.infer<
  typeof manifestConfigurationComparableFieldSchema
>

const manifestConfigurationComparableValueSchema = z.union([z.string(), z.boolean()])

export const manifestConfigurationReconciliationSchema = z.object({
  status: z.enum(['not-configured', 'no-claims', 'ready', 'partial', 'unavailable']),
  reason: z.enum(['repository-unavailable', 'source-limit-exceeded']).optional(),
  checkedAt: z.iso.datetime(),
  counts: z.object({
    matched: z.number().int().min(0),
    ambiguous: z.number().int().min(0),
    notCorrelatable: z.number().int().min(0),
    valueMatched: z.number().int().min(0),
    valueMismatched: z.number().int().min(0),
    valueUnavailable: z.number().int().min(0),
    freeFormUnverified: z.number().int().min(0),
  }),
  claims: z.array(
    z.object({
      manifestId: z.string().min(1),
      evidenceId: z.string().min(1),
      subjectId: z.string().min(1),
      status: z.enum(['matched-authoritative-object', 'ambiguous', 'not-correlatable']),
      matchedNodeId: z.string().min(1).optional(),
      authoritativeEvidenceIds: z.array(z.string().min(1)),
      reason: z.enum([
        'exact-authoritative-object-match',
        'missing-source-binding',
        'subject-binding-mismatch',
        'no-exact-source-match',
        'multiple-exact-source-matches',
        'entity-kind-mismatch',
      ]),
      comparisons: z.array(
        z.object({
          field: manifestConfigurationComparableFieldSchema,
          status: z.enum(['matched', 'mismatched', 'unavailable']),
          manifestValue: manifestConfigurationComparableValueSchema,
          authoritativeValue: manifestConfigurationComparableValueSchema.optional(),
          reason: z.enum([
            'exact-value-match',
            'value-mismatch',
            'authoritative-value-not-exposed',
            'invalid-authoritative-value',
          ]),
        }),
      ),
      unverifiedClaimKeys: z.array(z.string().min(1)),
    }),
  ),
})
export type ManifestConfigurationReconciliation = z.infer<
  typeof manifestConfigurationReconciliationSchema
>

export const agentSentinelStateSchema = z.object({
  snapshot: estateSnapshotSchema,
  findings: z.array(findingSchema),
  validations: z.array(validationRunSchema),
  remediations: z.array(remediationSchema),
  runtimeEvidence: z
    .object({
      status: z.enum(['not-configured', 'ready', 'partial', 'unavailable']),
      queriedAt: z.iso.datetime().optional(),
      agentCount: z.number().int().min(0),
      eligibleAgentCount: z.number().int().min(0),
      queriedAgentCount: z.number().int().min(0),
      enrichedAgentCount: z.number().int().min(0),
      evidenceCount: z.number().int().min(0),
      sources: z
        .array(
          z.strictObject({
            estateId: z.string().min(1).optional(),
            estateTenantId: z.string().min(1),
            estateEnvironment: z.string().min(1),
            snapshotGeneratedAt: z.iso.datetime(),
            sourceConnectorId: z.string().min(1).max(200),
            sourceTenantId: z.string().min(1).max(200),
            sourceProjectId: sourceProjectIdSchema,
            sourceEnvironment: z.string().min(1).max(200),
            sourceAgentId: z.string().min(1).max(200),
            agentId: z.string().min(1).max(200),
            state: z.enum([
              'complete',
              'partial',
              'stale',
              'unsupported',
              'empty',
              'failed',
              'cancelled',
            ]),
            windowIds: z.array(z.string().min(1).max(200)).max(2),
            observationIds: z.array(z.string().min(1).max(200)).max(10_000),
            evidenceIds: z.array(z.string().min(1).max(200)).max(4),
            providerResourceIds: z.array(z.string().min(1).max(500)).max(100),
            reason: z.string().min(1).optional(),
          }),
        )
        .optional(),
      failures: z.array(
        z.object({
          agentId: z.string().min(1),
          reason: z.enum(['query-failed', 'projection-failed']),
        }),
      ),
    })
    .optional(),
  manifestRuntimeVerification: manifestRuntimeVerificationSchema.optional(),
  manifestConfigurationReconciliation: manifestConfigurationReconciliationSchema.optional(),
})

export type AgentSentinelState = z.infer<typeof agentSentinelStateSchema>

export function assertEstateSnapshot(value: unknown): EstateSnapshot {
  return estateSnapshotSchema.parse(value)
}

export type {
  SnapshotRepository,
  FindingRepository,
  EvidenceRepository,
  ValidationRunRepository,
} from './repositories.js'

export {
  businessOutcomeUnitSchema,
  outcomeCorrelationSchema,
  businessOutcomeObservationSchema,
  businessOutcomeEvidenceBundleSchema,
  businessValueClaimSchema,
  businessValueAssessmentSchema,
} from './business-value.js'
export type {
  BusinessOutcomeUnit,
  OutcomeCorrelation,
  BusinessOutcomeObservation,
  BusinessOutcomeEvidenceBundle,
  BusinessValueClaim,
  BusinessValueAssessment,
} from './business-value.js'

export const exposureFindingStatusSchema = z.enum(['open', 'validated', 'mitigated', 'resolved'])
export type ExposureFindingStatus = z.infer<typeof exposureFindingStatusSchema>

export const exposureFindingSeveritySchema = z.enum(['low', 'medium', 'high', 'critical'])
export type ExposureFindingSeverity = z.infer<typeof exposureFindingSeveritySchema>

export const exposureFindingSchema = z.object({
  id: z.string().min(1),
  policyId: z.string().min(1),
  policyName: z.string().min(1),
  severity: exposureFindingSeveritySchema,
  status: exposureFindingStatusSchema,
  riskScore: z.number().min(0).max(100),
  title: z.string().min(1),
  summary: z.string().min(1),
  recommendation: z.string().min(1),
  affectedAgentId: z.string().min(1),
  affectedAgentName: z.string().min(1),
  declaredTools: z.array(z.string().min(1)),
  affectedNodeIds: z.array(z.string().min(1)),
  affectedEdgeIds: z.array(z.string().min(1)),
  evidenceIds: z.array(z.string().min(1)),
  evidenceTypes: z.array(evidenceTypeSchema),
  blastRadiusCount: z.number().int().min(0),
  blastRadiusNodeIds: z.array(z.string().min(1)),
  firstSeen: z.iso.datetime(),
  lastSeen: z.iso.datetime(),
  sourceMode: z.enum(['mock', 'foundry', 'manifest']),
  validationStatus: z.enum(['theoretical', 'validated', 'mitigated']),
  tenantId: z.string().min(1),
  snapshotId: z.string().min(1),
})
export type ExposureFinding = z.infer<typeof exposureFindingSchema>

export const remediationPreviewSchema = z.object({
  findingId: z.string().min(1),
  actionId: z.string().min(1),
  actionType: z.literal('block-route'),
  title: z.string().min(1),
  description: z.string().min(1),
  targetEdgeIds: z.array(z.string().min(1)),
  simulationOnly: z.literal(true),
  before: z.object({
    riskScore: z.number().min(0).max(100),
    blastRadiusCount: z.number().int().min(0),
  }),
  after: z.object({
    riskScore: z.number().min(0).max(100),
    blastRadiusCount: z.number().int().min(0),
  }),
  impact: z.object({
    riskReduction: z.number().min(0).max(100),
    blastRadiusReduction: z.number().int().min(0),
    businessDisruption: z.enum(['none', 'low', 'medium', 'high', 'unknown']),
    workflowImpact: z.enum(['preserved', 'review-required', 'unknown']),
    rollbackAvailable: z.boolean(),
  }),
  residualFindings: z.array(exposureFindingSchema),
  residualRoutes: z.array(
    z.object({
      findingId: z.string().min(1),
      policyId: z.string().min(1),
      riskScore: z.number().min(0).max(100),
      nodeIds: z.array(z.string().min(1)).min(1),
      edgeIds: z.array(z.string().min(1)).min(1),
      evidenceIds: z.array(z.string().min(1)).min(1),
    }),
  ),
  uncertainty: z.array(
    z.object({
      code: z.enum([
        'stale-evidence',
        'unknown-evidence',
        'synthetic-evidence',
        'declared-configuration-only',
        'theoretical-analysis',
        'analysis-coverage-unknown',
        'missing-evidence',
        'no-active-target-routes',
        'partial-target-coverage',
      ]),
      message: z.string().min(1),
      evidenceIds: z.array(z.string().min(1)),
    }),
  ),
  citedEvidence: z.array(evidenceSchema),
  beforeGraph: estateSnapshotSchema,
  afterGraph: estateSnapshotSchema,
})
export type RemediationPreview = z.infer<typeof remediationPreviewSchema>

export const exposureFreshnessSchema = z.object({
  snapshotId: z.string().min(1),
  generatedAt: z.iso.datetime(),
  sourceMode: z.enum(['mock', 'foundry']),
  agentCount: z.number().int().min(0),
})
export type ExposureFreshness = z.infer<typeof exposureFreshnessSchema>

export const exposurePageSchema = z.object({
  findings: z.array(exposureFindingSchema),
  total: z.number().int().min(0),
  facets: z.object({
    severity: z.record(z.string(), z.number().int().min(0)),
    status: z.record(z.string(), z.number().int().min(0)),
    policyId: z.record(z.string(), z.number().int().min(0)),
  }),
  freshness: exposureFreshnessSchema.optional(),
})
export type ExposurePage = z.infer<typeof exposurePageSchema>

export const governancePolicyPostureSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.string().min(1),
  severity: exposureFindingSeveritySchema,
  riskScore: z.number().min(0).max(100),
  status: z.enum(['compliant', 'needs-attention', 'not-evaluated']),
  openFindings: z.number().int().min(0),
  affectedAgents: z.number().int().min(0),
  evidenceBasis: z.enum(['declared_configuration', 'observed_runtime', 'synthetic_validation']),
})
export type GovernancePolicyPosture = z.infer<typeof governancePolicyPostureSchema>

export const governancePostureSchema = z.object({
  policies: z.array(governancePolicyPostureSchema),
  summary: z.object({
    totalPolicies: z.number().int().min(0),
    compliantPolicies: z.number().int().min(0),
    policiesNeedingAttention: z.number().int().min(0),
    openFindings: z.number().int().min(0),
    affectedAgents: z.number().int().min(0),
  }),
  latestEvidenceAt: z.iso.datetime().optional(),
  sourceMode: z.enum(['mock', 'foundry']),
  evidenceBasis: z.literal('declared_configuration'),
  evaluationCoverage: z.enum(['complete', 'findings-only']),
})
export type GovernancePosture = z.infer<typeof governancePostureSchema>

export const advisoryCitationSchema = z.object({
  evidenceId: z.string().min(1),
  claim: z.string().min(1),
})
export type AdvisoryCitation = z.infer<typeof advisoryCitationSchema>

export const incidentNarrativeSchema = z.object({
  findingId: z.string().min(1),
  model: z.string().min(1),
  generatedAt: z.iso.datetime(),
  summary: z.string().min(1),
  attackPathExplanation: z.string().min(1),
  impactExplanation: z.string().min(1),
  recommendationExplanation: z.string().min(1),
  sectionCitations: z.object({
    summary: z.array(z.string().min(1)).min(1),
    attackPathExplanation: z.array(z.string().min(1)).min(1),
    impactExplanation: z.array(z.string().min(1)).min(1),
    recommendationExplanation: z.array(z.string().min(1)).min(1),
    uncertainty: z.array(z.string().min(1)).min(1),
  }),
  uncertainty: z.array(z.string().min(1)),
  citations: z.array(advisoryCitationSchema).min(1),
  advisoryOnly: z.literal(true),
})
export type IncidentNarrative = z.infer<typeof incidentNarrativeSchema>

export type {
  ExposureFindingFacets,
  ExposureFindingRepository,
  ExposureFindingListFilters,
  GovernanceCaseListFilters,
  GovernanceCaseRepository,
  ConnectorSourceRepository,
  ConnectorSourceAuditCursor,
  ConnectorSourceWriteResult,
} from './repositories.js'

export {
  governanceCaseKindSchema,
  governanceCaseStatusSchema,
  governanceCaseTransitionOpSchema,
  governanceActorCapabilitySchema,
  governanceCaseSourceModeSchema,
  governanceLifecycleActionSchema,
  governanceAuthorizationContextSchema,
  governanceEvidenceSourceSchema,
  governanceCaseTransitionSchema,
  governanceCaseSchema,
  governanceCaseDetailSchema,
  governanceQueueSummarySchema,
  governanceQueuePageSchema,
  VALID_TRANSITIONS,
  TRANSITION_RESULT,
  CASE_SLA_MS,
  computeOverdue,
  validTransitionsForCase,
} from './governance-queue.js'

export type {
  GovernanceActorCapability,
  GovernanceAuthorizationContext,
  GovernanceCase,
  GovernanceCaseDetail,
  GovernanceCaseKind,
  GovernanceCaseSourceMode,
  GovernanceCaseStatus,
  GovernanceCaseTransition,
  GovernanceCaseTransitionOp,
  GovernanceEvidenceSource,
  GovernanceLifecycleAction,
  GovernanceQueuePage,
  GovernanceQueueSummary,
} from './governance-queue.js'

// ---------------------------------------------------------------------------
// Behavior baseline and drift-analysis domain types
// ---------------------------------------------------------------------------

export {
  observationSourceSchema,
  runtimeObservationSchema,
  observationWindowSchema,
  assessRuntimeOtelQuality,
  analysisStatusSchema,
  distributionStatsSchema,
  toolSequenceSummarySchema,
  baselineWindowSchema,
  driftDimensionSchema,
  driftSeveritySchema,
  toolSequenceChangeSchema,
  evidenceCoverageSchema,
  dimensionDriftResultSchema,
  driftAnalysisResultSchema,
} from './behavior-baseline.js'

export type {
  ObservationSource,
  RuntimeObservation,
  ObservationWindow,
  RuntimeOtelFreshnessContext,
  RuntimeOtelQualityAssessment,
  AnalysisStatus,
  DistributionStats,
  ToolSequenceSummary,
  BaselineWindow,
  DriftDimension,
  DriftSeverity,
  ToolSequenceChange,
  EvidenceCoverage,
  DimensionDriftResult,
  DriftAnalysisResult,
} from './behavior-baseline.js'

export {
  tokenEconomicsAnalysisStatusSchema,
  tokenEconomicsAnomalyDimensionSchema,
  tokenEconomicsAnomalySchema,
  tokenEconomicsAttributionSchema,
  tokenEconomicsAttributionValueSchema,
  tokenEconomicsCoverageSchema,
  tokenEconomicsReportSchema,
} from './token-economics.js'

export type {
  TokenEconomicsAnalysisStatus,
  TokenEconomicsAnomalyDimension,
  TokenEconomicsAnomaly,
  TokenEconomicsAttribution,
  TokenEconomicsAttributionValue,
  TokenEconomicsCoverage,
  TokenEconomicsReport,
} from './token-economics.js'
