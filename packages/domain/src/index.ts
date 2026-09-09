import { z } from 'zod'

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
  hydratePersistedConnectorSourceAuditRecord,
} from './connector-source.js'
export type {
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

function exactLegacyRuntimeProjectId(
  snapshot: z.infer<typeof legacyEstateSnapshotSchema>,
  evidenceId: string,
  provenance: z.infer<typeof legacyRuntimeOtelProvenanceSchema>,
  validEvidenceById: ReadonlyMap<string, Evidence>,
): string | undefined {
  if (
    provenance.estateTenantId !== snapshot.tenantId ||
    provenance.estateEnvironment !== snapshot.environment ||
    (provenance.snapshotGeneratedAt !== undefined &&
      provenance.snapshotGeneratedAt !== snapshot.generatedAt)
  ) {
    return undefined
  }
  const projects = new Set(
    snapshot.nodes.flatMap((node) => {
      const sourceProjectId = sourceProjectIdSchema.safeParse(node.metadata['sourceProjectId'])
      if (
        node.kind !== 'agent' ||
        !node.evidenceIds.includes(evidenceId) ||
        node.metadata['sourceOfTruth'] !== 'true' ||
        node.metadata['isNonAuthoritative'] === 'true' ||
        node.metadata['sourceConnectorId'] !== provenance.sourceConnectorId ||
        node.metadata['sourceTenantId'] !== provenance.sourceTenantId ||
        node.metadata['sourceEnvironment'] !== provenance.sourceEnvironment ||
        node.metadata['sourceObjectId'] !== provenance.providerAgentId ||
        node.environment !== provenance.sourceEnvironment ||
        !sourceProjectId.success
      ) {
        return []
      }
      const hasExactDeclaration = node.evidenceIds.some((declaredEvidenceId) => {
        const declared = validEvidenceById.get(declaredEvidenceId)
        const metadata = declared?.metadata
        return (
          declared?.evidenceTypes.length === 1 &&
          declared.evidenceTypes[0] === 'declared_configuration' &&
          metadata?.['sourceOfTruth'] === 'true' &&
          metadata['estateTenantId'] === snapshot.tenantId &&
          metadata['estateEnvironment'] === snapshot.environment &&
          metadata['sourceConnectorId'] === provenance.sourceConnectorId &&
          metadata['sourceTenantId'] === provenance.sourceTenantId &&
          metadata['sourceProjectId'] === sourceProjectId.data &&
          metadata['sourceEnvironment'] === provenance.sourceEnvironment &&
          metadata['sourceObjectId'] === provenance.providerAgentId
        )
      })
      return hasExactDeclaration ? [sourceProjectId.data] : []
    }),
  )
  if (projects.size !== 1) return undefined
  const [sourceProjectId] = projects
  return provenance.sourceProjectId === undefined || provenance.sourceProjectId === sourceProjectId
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

export function hydratePersistedEstateSnapshot(value: unknown): EstateSnapshot {
  const current = estateSnapshotSchema.safeParse(value)
  if (current.success) return current.data

  const legacy = legacyEstateSnapshotSchema.parse(value)
  const validEvidenceById = new Map<string, Evidence>()
  for (const candidate of legacy.evidence) {
    const parsed = evidenceSchema.safeParse(candidate)
    if (parsed.success) validEvidenceById.set(parsed.data.id, parsed.data)
  }
  const evidence = legacy.evidence.map((candidate) => {
    const currentEvidence = evidenceSchema.safeParse(candidate)
    if (currentEvidence.success) return currentEvidence.data
    const runtimeEvidence = legacyRuntimeEvidenceSchema.parse(candidate)
    const invocations = runtimeEvidence.otel.invocations.map((invocation) => {
      const sourceProjectId = exactLegacyRuntimeProjectId(
        legacy,
        runtimeEvidence.id,
        invocation.provenance,
        validEvidenceById,
      )
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
  })
  return estateSnapshotSchema.parse({ ...legacy, evidence })
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
