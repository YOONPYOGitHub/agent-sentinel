import type { EstateSnapshot, Evidence, Remediation } from '@agent-sentinel/domain'

export type ConnectorCapability =
  'discovery' | 'evidence' | 'events' | 'remediation-simulation' | 'remediation-execution'

export interface ConnectionTestResult {
  ok: boolean
  checkedAt: string
  message: string
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

export interface AgentConnector {
  readonly descriptor: ConnectorDescriptor
  testConnection(): Promise<ConnectionTestResult>
  discover(): Promise<EstateSnapshot>
  getEvidence(evidenceId: string): Promise<Evidence>
  execute?(
    remediation: Remediation,
    approval: ApprovalContext,
  ): Promise<{ remediation: Remediation; snapshot: EstateSnapshot }>
}

// ─── Connector Catalog Model ─────────────────────────────────────────────────

/** Lifecycle state of a connector from Agent Sentinel's perspective. */
export type ConnectorLifecycleState =
  | 'connected'
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
}

// ─── Universal Custom Manifest Adapter contract ──────────────────────────────

export {
  ADAPTER_DEFAULT_CONFIDENCE,
  ADAPTER_MAX_DECLARED_CONFIDENCE,
  DEFAULT_ACTION_DEPTH,
  ISO_DURATION_PATTERN,
  MANIFEST_LIMITS,
  MANIFEST_SCHEMA_VERSION,
  NO_SCHEME_PATTERN,
  PROHIBITED_ACTION_DEPTHS,
  STABLE_ID_PREFIX,
  SUPPORTED_MANIFEST_RELATIONSHIPS,
  SUPPORTED_MANIFEST_VERSIONS,
  UnsupportedManifestVersionError,
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
  ManifestProducer,
  ManifestSchemaVersion,
  ManifestValidationIssue,
  ManifestValidationResult,
  SourceProvenance,
  ToolDeclaration,
} from './manifest.js'
