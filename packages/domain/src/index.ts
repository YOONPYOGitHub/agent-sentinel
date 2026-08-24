import { z } from 'zod'

export const evidenceSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceObjectId: z.string().min(1),
  observedAt: z.iso.datetime(),
  freshness: z.enum(['live', 'recent', 'stale']),
  confidence: z.number().min(0).max(1),
  uri: z.url().optional(),
  summary: z.string().min(1),
})

export type Evidence = z.infer<typeof evidenceSchema>

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
  executedAt: z.iso.datetime().optional(),
  rollbackAvailable: z.boolean(),
})

export type Remediation = z.infer<typeof remediationSchema>

export const agentSentinelStateSchema = z.object({
  snapshot: estateSnapshotSchema,
  findings: z.array(findingSchema),
  validations: z.array(validationRunSchema),
  remediations: z.array(remediationSchema),
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

export const evidenceTypeSchema = z.enum([
  'declared_configuration',
  'observed_runtime',
  'synthetic_validation',
])
export type EvidenceType = z.infer<typeof evidenceTypeSchema>

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
  sourceMode: z.enum(['mock', 'foundry']),
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
  targetEdgeIds: z.array(z.string().min(1)).min(1),
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
} from './repositories.js'

export {
  governanceCaseKindSchema,
  governanceCaseStatusSchema,
  governanceCaseTransitionOpSchema,
  governanceActorCapabilitySchema,
  governanceCaseSourceModeSchema,
  governanceCaseTransitionSchema,
  governanceCaseSchema,
  governanceCaseDetailSchema,
  governanceQueueSummarySchema,
  governanceQueuePageSchema,
  VALID_TRANSITIONS,
  TRANSITION_RESULT,
  CASE_SLA_MS,
  computeOverdue,
} from './governance-queue.js'

export type {
  GovernanceActorCapability,
  GovernanceCase,
  GovernanceCaseDetail,
  GovernanceCaseKind,
  GovernanceCaseSourceMode,
  GovernanceCaseStatus,
  GovernanceCaseTransition,
  GovernanceCaseTransitionOp,
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
