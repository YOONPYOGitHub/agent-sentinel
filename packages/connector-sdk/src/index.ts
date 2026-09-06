import { estateContextSchema, observationWindowSchema } from '@agent-sentinel/domain'
import type {
  BusinessOutcomeEvidenceBundle,
  EstateContext,
  EstateSnapshot,
  Evidence,
  OutcomeCorrelation,
  Remediation,
} from '@agent-sentinel/domain'
import { z } from 'zod'

export {
  aggregateLiveSources,
  type AggregateLiveSourcesOptions,
  type LiveAggregationLimits,
  type LiveSourceAggregation,
  type LiveSourceDataState,
  type LiveSourceExecutionContext,
  type LiveSourceOutcome,
  type LiveSourceValue,
} from './live-aggregation.js'
import type { LiveSourceDataState } from './live-aggregation.js'

export type ConnectorCapability =
  'discovery' | 'evidence' | 'events' | 'remediation-simulation' | 'remediation-execution'

export interface ConnectionTestResult {
  ok: boolean
  checkedAt: string
  message: string
}

export type ConnectorReadiness =
  'ready' | 'degraded' | 'unavailable' | 'disabled' | 'authorization-required'

export type ConnectorCoverageStatus =
  'available' | 'disabled' | 'degraded' | 'authorization-required' | 'unavailable'

export interface ConnectorCapabilityCoverage {
  readonly status: ConnectorCoverageStatus
  readonly considered?: number
  readonly covered?: number
  readonly evidenceReferences: readonly string[]
  /** Stable, sanitized reason code. Never contains provider response data. */
  readonly reason?: string
}

export interface ExactIdentityCorrelationDiagnostics {
  readonly kind: 'exact-identity-correlation'
  readonly provider: 'microsoft-entra'
  readonly sourceId: string
  readonly sourceTenantId: string
  readonly sourceEnvironment: string
  readonly authoritativeAgentsConsidered: number
  readonly exactObjectIdMatches: number
  readonly exactApplicationIdMatches: number
  readonly exactAgentIdentityMatches: number
  readonly unmatched: number
  readonly ambiguous: number
  readonly runsAsEdgesEmitted: number
  readonly ownerCoverage: ConnectorCapabilityCoverage
  readonly appRoleCoverage: ConnectorCapabilityCoverage
  readonly previewCoverage: ConnectorCapabilityCoverage
  readonly evidenceReferences: readonly string[]
}

export interface ConnectorSourceProvenance {
  readonly estateTenantId: string
  readonly estateEnvironment: string
  readonly sourceConnectorId: string
  readonly sourceTenantId: string
  readonly sourceEnvironment: string
  readonly provider: string
  readonly providerObjectId: string
}

export interface ConnectorSourceHealth {
  readonly id: string
  readonly name: string
  readonly role: 'discovery' | 'enrichment'
  readonly enabled: boolean
  readonly configured: boolean
  readonly readiness: ConnectorReadiness
  readonly dataState?: LiveSourceDataState
  readonly checkedAt?: string
  /** Stable, sanitized reason code. Never contains provider response data. */
  readonly reason?: string
  readonly diagnostics?: ExactIdentityCorrelationDiagnostics
  readonly provenance?: ConnectorSourceProvenance
}

export interface ConnectorHealthReport {
  readonly overall: 'ready' | 'degraded' | 'unavailable'
  readonly partial: boolean
  readonly sources: readonly ConnectorSourceHealth[]
}

const connectorCapabilityCoverageSchema = z.strictObject({
  status: z.enum(['available', 'disabled', 'degraded', 'authorization-required', 'unavailable']),
  considered: z.number().int().min(0).optional(),
  covered: z.number().int().min(0).optional(),
  evidenceReferences: z.array(z.string().min(1).max(500)),
  reason: z.string().min(1).max(200).optional(),
})

const connectorSourceProvenanceSchema = z.strictObject({
  estateTenantId: z.string().min(1).max(128),
  estateEnvironment: z.string().min(1).max(128),
  sourceConnectorId: z.string().min(1).max(200),
  sourceTenantId: z.string().min(1).max(128),
  sourceEnvironment: z.string().min(1).max(128),
  provider: z.string().min(1).max(200),
  providerObjectId: z.string().min(1).max(500),
})

const exactIdentityCorrelationDiagnosticsSchema = z
  .strictObject({
    kind: z.literal('exact-identity-correlation'),
    provider: z.literal('microsoft-entra'),
    sourceId: z.string().min(1).max(200),
    sourceTenantId: z.string().min(1).max(128),
    sourceEnvironment: z.string().min(1).max(128),
    authoritativeAgentsConsidered: z.number().int().min(0),
    exactObjectIdMatches: z.number().int().min(0),
    exactApplicationIdMatches: z.number().int().min(0),
    exactAgentIdentityMatches: z.number().int().min(0),
    unmatched: z.number().int().min(0),
    ambiguous: z.number().int().min(0),
    runsAsEdgesEmitted: z.number().int().min(0),
    ownerCoverage: connectorCapabilityCoverageSchema,
    appRoleCoverage: connectorCapabilityCoverageSchema,
    previewCoverage: connectorCapabilityCoverageSchema,
    evidenceReferences: z.array(z.string().min(1).max(500)),
  })
  .superRefine((diagnostics, context) => {
    const exactMatches =
      diagnostics.exactObjectIdMatches +
      diagnostics.exactApplicationIdMatches +
      diagnostics.exactAgentIdentityMatches
    const categorizedAgents = exactMatches + diagnostics.unmatched + diagnostics.ambiguous
    if (categorizedAgents !== diagnostics.authoritativeAgentsConsidered) {
      context.addIssue({
        code: 'custom',
        path: ['authoritativeAgentsConsidered'],
        message:
          'Exact, unmatched, and ambiguous categories must account for every authoritative agent exactly once.',
      })
    }
    if (diagnostics.runsAsEdgesEmitted !== exactMatches) {
      context.addIssue({
        code: 'custom',
        path: ['runsAsEdgesEmitted'],
        message: 'Emitted RUNS_AS edges must equal the total exact identity matches.',
      })
    }
  })

export const connectorHealthReportSchema = z.strictObject({
  overall: z.enum(['ready', 'degraded', 'unavailable']),
  partial: z.boolean(),
  sources: z.array(
    z.strictObject({
      id: z.string().min(1).max(200),
      name: z.string().min(1).max(200),
      role: z.enum(['discovery', 'enrichment']),
      enabled: z.boolean(),
      configured: z.boolean(),
      readiness: z.enum(['ready', 'degraded', 'unavailable', 'disabled', 'authorization-required']),
      dataState: z
        .enum(['complete', 'partial', 'stale', 'unsupported', 'empty', 'failed', 'cancelled'])
        .optional(),
      checkedAt: z.iso.datetime().optional(),
      reason: z.string().min(1).max(200).optional(),
      diagnostics: exactIdentityCorrelationDiagnosticsSchema.optional(),
      provenance: connectorSourceProvenanceSchema.optional(),
    }),
  ),
})

export interface ConnectorHealthMeasurement {
  readonly estateId: string
  readonly tenantId: string
  readonly environment: string
  readonly connectorId: string
  readonly measuredAt: string
  readonly health: ConnectorHealthReport
}

export const connectorHealthMeasurementSchema = estateContextSchema
  .extend({
    estateId: estateContextSchema.shape.id,
    connectorId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    measuredAt: z.iso.datetime(),
    health: connectorHealthReportSchema,
  })
  .omit({ id: true })
  .strict()

export interface ConnectorHealthMeasurementIdentity {
  readonly estateId: string
  readonly tenantId: string
  readonly environment: string
  readonly connectorId: string
  readonly measuredAt: string
}

export class ConnectorHealthConflictError extends Error {
  override readonly name = 'ConnectorHealthConflictError'

  constructor(readonly identity: ConnectorHealthMeasurementIdentity) {
    super('A differing connector health measurement already exists for this identity.')
  }
}

export interface ConnectorHealthRepository {
  save(estate: EstateContext, measurement: ConnectorHealthMeasurement): Promise<void>
  findLatest(estate: EstateContext, connectorId: string): Promise<ConnectorHealthMeasurement | null>
}

export interface ConnectorDescriptor {
  id: string
  name: string
  apiVersion: string
  releaseStatus: 'mock' | 'preview' | 'ga'
  capabilities: readonly ConnectorCapability[]
  requiredPermissions: readonly string[]
  blindSpots: readonly string[]
}

export interface ApprovalContext {
  approvedBy: string
  approvedAt: string
  reason: string
}

export interface ConnectorOperationRequest {
  readonly signal?: AbortSignal
}

export interface AgentConnector {
  readonly descriptor: ConnectorDescriptor
  testConnection(): Promise<ConnectionTestResult>
  discover(): Promise<EstateSnapshot>
  getEvidence(evidenceId: string): Promise<Evidence>
  getConnectorHealth?(): ConnectorHealthReport
  execute?(
    remediation: Remediation,
    approval: ApprovalContext,
  ): Promise<{ remediation: Remediation; snapshot: EstateSnapshot }>
}

export type OperationAwareAgentConnector = Omit<AgentConnector, 'testConnection' | 'discover'> & {
  testConnection(request?: ConnectorOperationRequest): Promise<ConnectionTestResult>
  discover(request?: ConnectorOperationRequest): Promise<EstateSnapshot>
}

export interface RuntimeTelemetryRequest {
  tenantId: string
  agentId: string
  estateId?: string
  estateEnvironment?: string
  sourceConnectorId?: string
  sourceTenantId?: string
  sourceAgentId?: string
  sourceEnvironment?: string
}

const liveObservationWindowSchema = observationWindowSchema.extend({
  source: z.literal('azure-monitor-otel'),
})

const runtimeTelemetrySourceProvenanceSchema = z.strictObject({
  estateId: z.string().min(1).max(200),
  estateTenantId: z.string().min(1).max(200),
  estateEnvironment: z.string().min(1).max(200),
  sourceConnectorId: z.string().min(1).max(200),
  sourceTenantId: z.string().min(1).max(200),
  sourceEnvironment: z.string().min(1).max(200),
  provider: z.literal('azure-monitor-otel'),
  providerResourceId: z.string().min(1).max(500),
  providerAgentId: z.string().min(1).max(200),
})

export const runtimeObservationWindowsSchema = z
  .strictObject({
    baseline: liveObservationWindowSchema,
    observed: liveObservationWindowSchema,
    baselineEvidenceId: z.string().min(1).max(200),
    observedEvidenceId: z.string().min(1).max(200),
    queriedAt: z.iso.datetime(),
    provenance: runtimeTelemetrySourceProvenanceSchema.optional(),
  })
  .superRefine((windows, context) => {
    for (const [kind, window] of [
      ['baseline', windows.baseline],
      ['observed', windows.observed],
    ] as const) {
      if (new Date(window.windowEnd).getTime() <= new Date(window.windowStart).getTime()) {
        context.addIssue({
          code: 'custom',
          path: [kind],
          message: `Runtime ${kind} window end must be after its start.`,
        })
      }
    }
    if (
      windows.baseline.tenantId !== windows.observed.tenantId ||
      windows.baseline.agentId !== windows.observed.agentId ||
      windows.baseline.environment !== windows.observed.environment
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Runtime windows must have identical tenant, agent, and environment bindings.',
      })
    }
    if (
      new Date(windows.baseline.windowEnd).getTime() >
      new Date(windows.observed.windowStart).getTime()
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Runtime baseline and observed windows must not overlap.',
      })
    }
    if (new Date(windows.observed.windowEnd).getTime() > new Date(windows.queriedAt).getTime()) {
      context.addIssue({
        code: 'custom',
        message: 'Runtime observed window cannot end after the provider query time.',
      })
    }
  })
export type RuntimeObservationWindows = z.infer<typeof runtimeObservationWindowsSchema>

/**
 * Read-only runtime telemetry source. Implementations must return measured
 * observations or reject; they must never substitute synthetic observations.
 */
export interface RuntimeTelemetryConnector {
  readonly id: string
  readObservationWindows(
    request: RuntimeTelemetryRequest,
    options?: ConnectorOperationRequest,
  ): Promise<RuntimeObservationWindows>
  getConnectorHealth?(): ConnectorHealthReport
}

export interface BusinessOutcomeRequest {
  tenantId: string
  agentId: string
  environment: string
  acceptedCorrelations: readonly OutcomeCorrelation[]
}

/**
 * Read-only source of business outcomes that are explicitly correlated to an
 * agent run, correlation ID, or exact agent version.
 */
export interface BusinessOutcomeConnector {
  readonly id: string
  readBusinessOutcomes(request: BusinessOutcomeRequest): Promise<BusinessOutcomeEvidenceBundle>
}

export {
  projectRuntimeEvidence,
  runtimeTelemetryRequestForAgent,
  withoutSyntheticObservations,
  type RuntimeEvidenceProjection,
} from './runtime-evidence.js'

// ─── Connector Catalog Model ─────────────────────────────────────────────────

/** Lifecycle state of a connector from Agent Sentinel's perspective. */
export type ConnectorLifecycleState =
  | 'connected'
  | 'degraded'
  | 'available-to-configure'
  | 'authorization-required'
  | 'planned'
  | 'preview-authorization-required'
  | 'unavailable'

/** Distinct capability kinds a connector can contribute. */
export type ConnectorCapabilityKind =
  | 'discovery'
  | 'identity'
  | 'entitlement'
  | 'runtime-telemetry'
  | 'business-outcomes'
  | 'security-alerts'
  | 'data-governance'
  | 'lifecycle-admin'
  | 'write-remediation'

/** Whether Agent Sentinel consumes evidence from a system (read) or owns/writes data to it. */
export type ConnectorOwnershipModel = 'consumes' | 'owns'

/** A single entry in the connector catalog. */
export interface CatalogConnectorEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly lifecycleState: ConnectorLifecycleState
  readonly capabilities: readonly ConnectorCapabilityKind[]
  /** True when this system is authoritative for the evidence domain described by the connector. */
  readonly sourceOfTruth: boolean
  /** Whether Agent Sentinel consumes evidence or owns the data. */
  readonly ownershipModel: ConnectorOwnershipModel
  readonly prerequisiteNote?: string
  /** Scorecard dimensions that become evidence-backed when this connector is active. */
  readonly unlocksScorecard?: readonly string[]
  /** Relative Settings path for this connector, if configurable from within Agent Sentinel. */
  readonly settingsPath?: string
}

/** Full response returned by GET /api/connectors. */
export interface ConnectorsCollectionResponse {
  readonly active: {
    readonly id: string
    readonly mode: 'mock' | 'foundry'
    readonly source: 'mock' | 'foundry'
    readonly lifecycleState: ConnectorLifecycleState
    readonly writeEnabled?: boolean
    readonly projectEndpoint?: string
  }
  readonly catalog: readonly CatalogConnectorEntry[]
  readonly health?: ConnectorHealthReport
}

// ─── Universal Custom Manifest Adapter contract ──────────────────────────────

export {
  ADAPTER_DEFAULT_CONFIDENCE,
  ADAPTER_MAX_DECLARED_CONFIDENCE,
  DEFAULT_ACTION_DEPTH,
  ISO_DURATION_PATTERN,
  MANIFEST_LIMITS,
  MANIFEST_SCHEMA_VERSION,
  MAX_MANIFEST_SOURCES,
  NO_SCHEME_PATTERN,
  PROHIBITED_ACTION_DEPTHS,
  STABLE_ID_PREFIX,
  SUPPORTED_MANIFEST_RELATIONSHIPS,
  SUPPORTED_MANIFEST_VERSIONS,
  UnsupportedManifestVersionError,
  ManifestIngestionSourceLimitError,
  actionDepthSchema,
  adapterCapabilityDeclarationSchema,
  agentDeclarationSchema,
  computeManifestHash,
  dataSourceDeclarationSchema,
  edgeDeclarationSchema,
  edgeEndpointSchema,
  evidenceDeclarationSchema,
  identityDeclarationSchema,
  isProhibitedActionDepth,
  isSupportedManifestVersion,
  manifestEntityKindSchema,
  manifestEnvelopeSchema,
  manifestEvidenceTypeSchema,
  manifestSourceBindingSchema,
  manifestIngestionRecordSchema,
  manifestProducerSchema,
  manifestProvenance,
  manifestSchemaVersionSchema,
  mcpDependencyDeclarationSchema,
  normalizeManifestRelationship,
  sourceProvenanceSchema,
  stableId,
  toolDeclarationSchema,
  validateManifest,
} from './manifest.js'

export type {
  ActionDepth,
  AdapterCapabilityDeclaration,
  AgentDeclaration,
  DataSourceDeclaration,
  EdgeDeclaration,
  EdgeEndpoint,
  EvidenceDeclaration,
  IdentityDeclaration,
  MCPDependencyDeclaration,
  ManifestEntityKind,
  ManifestEnvelope,
  ManifestEvidenceType,
  ManifestIngestionRecord,
  ManifestIngestionRepository,
  ManifestProducer,
  ManifestSourceBinding,
  ManifestSchemaVersion,
  ManifestValidationIssue,
  ManifestValidationResult,
  SourceProvenance,
  ToolDeclaration,
} from './manifest.js'
