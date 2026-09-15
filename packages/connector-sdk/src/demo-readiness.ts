import {
  AGENT365_APPROVED_MANAGED_IDENTITY_CLIENT_ID,
  hasSyntheticOrTestMarker,
  isConnectorSourceMigrationRequired,
  type AgentSentinelState,
  type ConnectorSourceReadModel,
} from '@agent-sentinel/domain'

import { z } from 'zod'

import type { ConnectorsCollectionResponse, ExactIdentityCorrelationDiagnostics } from './index.js'
export type {
  CatalogConnectorEntry,
  ConnectorCapabilityKind,
  ConnectorLifecycleState,
  ConnectorsCollectionResponse,
} from './index.js'

const capabilityCoverageSchema = z.strictObject({
  status: z.enum(['available', 'disabled', 'degraded', 'authorization-required', 'unavailable']),
  considered: z.number().int().min(0).optional(),
  covered: z.number().int().min(0).optional(),
  evidenceReferences: z.array(z.string()),
  reason: z.string().optional(),
})

const exactIdentityDiagnosticsSchema = z.strictObject({
  kind: z.literal('exact-identity-correlation'),
  provider: z.literal('microsoft-entra'),
  sourceId: z.string().min(1),
  sourceTenantId: z.string().min(1),
  sourceEnvironment: z.string().min(1),
  authoritativeAgentsConsidered: z.number().int().min(0),
  exactObjectIdMatches: z.number().int().min(0),
  exactApplicationIdMatches: z.number().int().min(0),
  exactAgentIdentityMatches: z.number().int().min(0),
  unmatched: z.number().int().min(0),
  ambiguous: z.number().int().min(0),
  runsAsEdgesEmitted: z.number().int().min(0),
  ownerCoverage: capabilityCoverageSchema,
  appRoleCoverage: capabilityCoverageSchema,
  previewCoverage: capabilityCoverageSchema,
  evidenceReferences: z.array(z.string()),
})

const connectorHealthSchema = z.strictObject({
  overall: z.enum(['ready', 'degraded', 'unavailable']),
  partial: z.boolean(),
  sourceSetFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  sources: z.array(
    z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
      role: z.enum(['discovery', 'enrichment']),
      enabled: z.boolean(),
      configured: z.boolean(),
      readiness: z.enum(['ready', 'degraded', 'unavailable', 'disabled', 'authorization-required']),
      dataState: z
        .enum(['complete', 'partial', 'stale', 'unsupported', 'empty', 'failed', 'cancelled'])
        .optional(),
      pages: z.number().int().min(0).optional(),
      records: z.number().int().min(0).optional(),
      checkedAt: z.iso.datetime().optional(),
      reason: z.string().optional(),
      diagnostics: exactIdentityDiagnosticsSchema.optional(),
      provenance: z
        .strictObject({
          estateTenantId: z.string().min(1),
          estateEnvironment: z.string().min(1),
          sourceConnectorId: z.string().min(1),
          sourceTenantId: z.string().min(1),
          sourceEnvironment: z.string().min(1),
          provider: z.string().min(1),
          providerObjectId: z.string().min(1),
        })
        .optional(),
    }),
  ),
})

export const connectorsCollectionResponseSchema = z.strictObject({
  active: z.strictObject({
    id: z.string().min(1),
    mode: z.enum(['mock', 'foundry']),
    source: z.enum(['mock', 'foundry']),
    lifecycleState: z.enum([
      'connected',
      'degraded',
      'available-to-configure',
      'authorization-required',
      'planned',
      'preview-authorization-required',
      'unavailable',
    ]),
    writeEnabled: z.boolean().optional().default(false),
    projectEndpoint: z.url().optional(),
  }),
  catalog: z.array(
    z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().min(1),
      lifecycleState: z.enum([
        'connected',
        'degraded',
        'available-to-configure',
        'authorization-required',
        'planned',
        'preview-authorization-required',
        'unavailable',
      ]),
      capabilities: z.array(
        z.enum([
          'discovery',
          'identity',
          'entitlement',
          'runtime-telemetry',
          'business-outcomes',
          'security-alerts',
          'data-governance',
          'lifecycle-admin',
          'write-remediation',
        ]),
      ),
      sourceOfTruth: z.boolean(),
      ownershipModel: z.enum(['consumes', 'owns']),
      prerequisiteNote: z.string().optional(),
      unlocksScorecard: z.array(z.string()).optional(),
      settingsPath: z.string().optional(),
    }),
  ),
  health: connectorHealthSchema.optional(),
})

export function parseConnectorsCollectionResponse(value: unknown): ConnectorsCollectionResponse {
  return connectorsCollectionResponseSchema.parse(value) as ConnectorsCollectionResponse
}

export const DEMO_AGENT365_HEALTH_SOURCE_ID = 'agent365:primary'
export const DEMO_AGENT365_CONFIGURATION_SOURCE_ID = 'agent365-primary'

export type DemoReadinessStatus = 'ready' | 'partial' | 'blocked' | 'unavailable'

export interface DemoReadinessCategory {
  readonly status: DemoReadinessStatus
  readonly summary: string
  readonly observedAt?: string
}

export interface DemoReadinessAssessment {
  readonly status: DemoReadinessStatus
  readonly observedAt: string
  readonly summary: string
  readonly requirements: readonly string[]
  readonly snapshot: DemoReadinessCategory & {
    readonly nodeCount: number
    readonly edgeCount: number
    readonly evidenceCount: number
  }
  readonly agent365: DemoReadinessCategory & {
    readonly sourceId: typeof DEMO_AGENT365_HEALTH_SOURCE_ID
    readonly catalogStatus?: string
    readonly readiness?: string
    readonly dataState?: string
    readonly pages?: number
    readonly records?: number
    readonly provenanceVerified: boolean
    readonly sourceSetFingerprintPresent: boolean
    readonly sourceSetFingerprint?: string
    readonly packageEvidenceCount: number
    readonly packageNodeCount: number
    readonly agentPackageCount: number
    readonly extensionPackageCount: number
    readonly liveSourceStatusCount: number
    readonly staleSourceStatusCount: number
    readonly unknownSourceStatusCount: number
    readonly syntheticOrUnknownCount: number
    readonly classifications: Readonly<Record<string, number>>
  }
  readonly connectorBinding: DemoReadinessCategory & {
    readonly configurationSourceId?: string
    readonly bindingSourceId?: string
    readonly deploymentManaged: boolean
    readonly enabled: boolean
    readonly credentialMode?: string
    readonly managedIdentityClientId: 'redacted' | 'not-present'
    readonly approvedManagedIdentity: boolean
    readonly testStatus?: string
  }
  readonly runsAs: DemoReadinessCategory & {
    readonly exactEdgeCount: number
    readonly nonExactEdgeCount: number
    readonly authoritativeAgentsConsidered: number
    readonly unmatched: number
    readonly ambiguous: number
    readonly unmatchedReasons: Readonly<Record<string, number>>
  }
  readonly otel: DemoReadinessCategory & {
    readonly runtimeStatus: string
    readonly evidenceObjectCount: number
    readonly sourceCount: number
    readonly completeSourceCount: number
    readonly acceptedRecordCount: number
    readonly invocationCount: number
    readonly liveInvocationCount: number
    readonly syntheticInvocationCount: number
    readonly traceSpanProvenanceCount: number
    readonly tokenCostProvenanceCount: number
    readonly failureCount: number
  }
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1
}

function packageClassifications(metadata: Readonly<Record<string, string>>): readonly string[] {
  const raw = metadata['packageClassifications']
  if (raw === undefined) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function summarizeDiagnostics(
  connectors: ConnectorsCollectionResponse,
): ExactIdentityCorrelationDiagnostics[] {
  return (connectors.health?.sources ?? []).flatMap((source) =>
    source.diagnostics?.kind === 'exact-identity-correlation' ? [source.diagnostics] : [],
  )
}

export function assessDemoReadiness(input: {
  readonly state: AgentSentinelState
  readonly connectors: ConnectorsCollectionResponse
  readonly connectorSources: readonly ConnectorSourceReadModel[]
}): DemoReadinessAssessment {
  const { state, connectors, connectorSources } = input
  const requirements: string[] = []
  const snapshot = state.snapshot

  const exactHealth = connectors.health?.sources.find(
    (source) => source.id === DEMO_AGENT365_HEALTH_SOURCE_ID,
  )
  const packageEvidence = snapshot.evidence.filter(
    (item) =>
      item.metadata?.['sourceConnector'] === 'agent365-package-catalog' &&
      item.metadata['sourceConnectorId'] === 'primary',
  )
  const packageNodes = snapshot.nodes.filter(
    (item) =>
      item.metadata['sourceConnector'] === 'agent365-package-catalog' &&
      item.metadata['sourceConnectorId'] === 'primary',
  )
  const classificationCounts: Record<string, number> = {}
  for (const node of packageNodes) {
    for (const classification of packageClassifications(node.metadata)) {
      increment(classificationCounts, classification)
    }
  }
  const agentPackageCount = packageNodes.filter(
    (item) => item.metadata['inventoryEntityType'] === 'agent-package',
  ).length
  const extensionPackageCount = packageNodes.filter(
    (item) => item.metadata['inventoryEntityType'] === 'extension-package',
  ).length
  const liveSourceStatusCount = packageEvidence.filter(
    (item) =>
      item.freshness === 'live' &&
      item.sourceStatus?.sourceId === DEMO_AGENT365_HEALTH_SOURCE_ID &&
      item.sourceStatus.status === 'live' &&
      item.sourceStatus.readiness === 'ready' &&
      item.sourceStatus.dataState === 'complete',
  ).length
  const staleSourceStatusCount = packageEvidence.filter(
    (item) => item.freshness === 'stale' || item.sourceStatus?.status === 'stale',
  ).length
  const unknownSourceStatusCount = packageEvidence.filter(
    (item) => item.sourceStatus === undefined || item.sourceStatus.status === 'unknown',
  ).length
  const syntheticOrUnknownCount = packageEvidence.filter(
    (item) =>
      item.evidenceTypes.includes('synthetic_validation') ||
      item.evidenceTypes.includes('unknown') ||
      hasSyntheticOrTestMarker(item.metadata ?? {}),
  ).length
  const provenanceVerified =
    exactHealth?.provenance?.sourceConnectorId === 'primary' &&
    exactHealth.provenance.provider === 'microsoft-graph-agent365-package-catalog' &&
    exactHealth.provenance.providerObjectId === '/v1.0/copilot/admin/catalog/packages'
  const agent365CatalogStatus = connectors.catalog.find(
    (entry) => entry.id === 'm365-agent-registry',
  )?.lifecycleState
  const agent365Ready =
    agent365CatalogStatus === 'connected' &&
    exactHealth?.readiness === 'ready' &&
    exactHealth.dataState === 'complete' &&
    (exactHealth.pages ?? 0) > 0 &&
    (exactHealth.records ?? 0) > 0 &&
    provenanceVerified &&
    connectors.health?.sourceSetFingerprint !== undefined &&
    packageEvidence.length > 0 &&
    packageNodes.length === packageEvidence.length &&
    exactHealth.records === packageEvidence.length &&
    liveSourceStatusCount === packageEvidence.length &&
    staleSourceStatusCount === 0 &&
    unknownSourceStatusCount === 0 &&
    syntheticOrUnknownCount === 0
  const agent365Status: DemoReadinessStatus =
    connectors.health === undefined || exactHealth === undefined
      ? 'unavailable'
      : agent365Ready
        ? 'ready'
        : 'blocked'
  if (!agent365Ready) {
    requirements.push(
      'Agent 365 source agent365:primary must report fresh ready/complete live package evidence with non-zero pages and records.',
    )
  }

  const binding = connectorSources.find(
    (source) =>
      source.connectorType === 'agent365' && source.runtimeBinding?.bindingSourceId === 'primary',
  )
  const bindingMigrating =
    binding === undefined ? false : isConnectorSourceMigrationRequired(binding)
  const runtimeBinding =
    binding !== undefined && 'runtimeBinding' in binding ? binding.runtimeBinding : undefined
  const approvedManagedIdentity =
    binding?.credential.mode === 'managed-identity' &&
    binding.credential.managedIdentityClientId.toLowerCase() ===
      AGENT365_APPROVED_MANAGED_IDENTITY_CLIENT_ID
  const bindingReady =
    binding !== undefined &&
    !bindingMigrating &&
    binding.sourceId === DEMO_AGENT365_CONFIGURATION_SOURCE_ID &&
    binding.origin === 'deployment' &&
    binding.enabled &&
    runtimeBinding?.bindingSourceId === 'primary' &&
    approvedManagedIdentity
  const bindingStatus: DemoReadinessStatus =
    binding === undefined ? 'unavailable' : bindingReady ? 'ready' : 'blocked'
  if (!bindingReady) {
    requirements.push(
      'The deployment-managed agent365-primary connector source must bind to primary with the approved managed identity.',
    )
  }

  const allRunsAs = snapshot.edges.filter((edge) => edge.relationship === 'RUNS_AS')
  const exactRunsAs = allRunsAs.filter((edge) => edge.runsAsBinding !== undefined)
  const diagnostics = summarizeDiagnostics(connectors)
  const authoritativeAgentsConsidered = diagnostics.reduce(
    (total, item) => total + item.authoritativeAgentsConsidered,
    0,
  )
  const unmatched = diagnostics.reduce((total, item) => total + item.unmatched, 0)
  const ambiguous = diagnostics.reduce((total, item) => total + item.ambiguous, 0)
  const emitted = diagnostics.reduce((total, item) => total + item.runsAsEdgesEmitted, 0)
  const unmatchedReasons: Record<string, number> = {}
  for (const node of snapshot.nodes) {
    if (node.kind !== 'agent' || node.metadata['entraCorrelationStatus'] !== 'unmatched') continue
    increment(unmatchedReasons, node.metadata['entraCorrelationReason'] ?? 'unspecified')
  }
  const explainedMissingProviderIds =
    exactRunsAs.length === 0 &&
    diagnostics.length > 0 &&
    authoritativeAgentsConsidered > 0 &&
    unmatched === authoritativeAgentsConsidered &&
    ambiguous === 0 &&
    Object.keys(unmatchedReasons).length === 1 &&
    unmatchedReasons['missing-authoritative-identifier'] === unmatched
  const runsAsReady =
    exactRunsAs.length > 0 && emitted === exactRunsAs.length && unmatched === 0 && ambiguous === 0
  const partiallyMatched =
    exactRunsAs.length > 0 && emitted === exactRunsAs.length && unmatched > 0 && ambiguous === 0
  const runsAsStatus: DemoReadinessStatus = runsAsReady
    ? 'ready'
    : explainedMissingProviderIds || partiallyMatched
      ? 'partial'
      : diagnostics.length === 0
        ? 'unavailable'
        : 'blocked'
  if (!runsAsReady) {
    requirements.push(
      explainedMissingProviderIds || partiallyMatched
        ? 'Provide exact provider identity IDs for the unmatched authoritative agents, then refresh ingestion.'
        : 'Resolve exact Entra correlation diagnostics so RUNS_AS edges are emitted from authoritative provider IDs.',
    )
  }

  const otelEvidence = snapshot.evidence.filter((item) => item.otel !== undefined)
  const liveOtelEvidence = otelEvidence.filter(
    (item) =>
      item.freshness === 'live' &&
      item.evidenceTypes.includes('observed_runtime') &&
      item.otel?.quality.status === 'available' &&
      item.otel.quality.classification === 'live',
  )
  const allInvocations = otelEvidence.flatMap((item) => item.otel?.invocations ?? [])
  const liveInvocations = liveOtelEvidence.flatMap((item) => item.otel?.invocations ?? [])
  const acceptedRecordCount = liveOtelEvidence.reduce(
    (total, item) => total + (item.otel?.quality.recordsAccepted ?? 0),
    0,
  )
  const syntheticInvocationCount = allInvocations.filter(
    (item) => item.provenance.classification === 'synthetic',
  ).length
  const runtimeSources = state.runtimeEvidence?.sources ?? []
  const completeSourceCount = runtimeSources.filter(
    (source) =>
      source.state === 'complete' &&
      source.providerResourceIds.length > 0 &&
      source.evidenceIds.length > 0,
  ).length
  const traceSpanProvenanceCount = liveInvocations.filter(
    (item) => item.provenance.traceId.length === 32 && item.provenance.spanId.length === 16,
  ).length
  const tokenCostProvenanceCount = liveInvocations.filter(
    (item) =>
      Number.isFinite(item.inputTokens) &&
      Number.isFinite(item.outputTokens) &&
      Number.isFinite(item.costUsd),
  ).length
  const runtimeStatus = state.runtimeEvidence?.status ?? 'not-reported'
  const failureCount = state.runtimeEvidence?.failures.length ?? 0
  const otelReady =
    runtimeStatus === 'ready' &&
    (state.runtimeEvidence?.evidenceCount ?? 0) > 0 &&
    runtimeSources.length > 0 &&
    completeSourceCount === runtimeSources.length &&
    acceptedRecordCount > 0 &&
    liveInvocations.length > 0 &&
    syntheticInvocationCount === 0 &&
    traceSpanProvenanceCount === liveInvocations.length &&
    tokenCostProvenanceCount === liveInvocations.length &&
    failureCount === 0
  const otelHasUnsafeEvidence =
    syntheticInvocationCount > 0 ||
    otelEvidence.some(
      (item) =>
        item.otel?.quality.classification === 'synthetic' ||
        item.otel?.quality.classification === 'mixed' ||
        item.otel?.quality.status === 'degraded',
    )
  const otelStatus: DemoReadinessStatus = otelReady
    ? 'ready'
    : otelHasUnsafeEvidence || failureCount > 0
      ? 'blocked'
      : 'partial'
  if (!otelReady) {
    requirements.push(
      runtimeStatus === 'not-configured'
        ? 'Configure the approved Azure Monitor OTel source and generate approved representative application traffic; then wait for persisted live trace/span/token/cost evidence.'
        : 'Generate approved representative application traffic and wait for persisted live trace/span/token/cost evidence with accepted records.',
    )
  }

  const categoryStatuses = [agent365Status, bindingStatus, runsAsStatus, otelStatus]
  const status: DemoReadinessStatus = categoryStatuses.includes('blocked')
    ? 'blocked'
    : categoryStatuses.includes('unavailable')
      ? 'unavailable'
      : categoryStatuses.includes('partial')
        ? 'partial'
        : 'ready'

  return {
    status,
    observedAt: snapshot.generatedAt,
    summary:
      status === 'ready'
        ? 'Live Agent 365, exact RUNS_AS, and live OTel evidence satisfy operational release-readiness gates; release approval remains separate.'
        : status === 'partial'
          ? 'Core live evidence is present, but explicitly identified operational evidence remains incomplete.'
          : status === 'blocked'
            ? 'One or more required live-evidence gates are blocked.'
            : 'Required deployment evidence could not be observed.',
    requirements: [...new Set(requirements)],
    snapshot: {
      status: snapshot.nodes.length > 0 && snapshot.evidence.length > 0 ? 'ready' : 'blocked',
      summary: `${snapshot.nodes.length} nodes, ${snapshot.edges.length} edges, ${snapshot.evidence.length} evidence objects.`,
      observedAt: snapshot.generatedAt,
      nodeCount: snapshot.nodes.length,
      edgeCount: snapshot.edges.length,
      evidenceCount: snapshot.evidence.length,
    },
    agent365: {
      status: agent365Status,
      summary: agent365Ready
        ? 'Exact Agent 365 source is fresh, complete, live, and non-empty.'
        : 'Exact Agent 365 live package evidence is not ready.',
      ...(exactHealth?.checkedAt === undefined ? {} : { observedAt: exactHealth.checkedAt }),
      sourceId: DEMO_AGENT365_HEALTH_SOURCE_ID,
      ...(agent365CatalogStatus === undefined ? {} : { catalogStatus: agent365CatalogStatus }),
      ...(exactHealth?.readiness === undefined ? {} : { readiness: exactHealth.readiness }),
      ...(exactHealth?.dataState === undefined ? {} : { dataState: exactHealth.dataState }),
      ...(exactHealth?.pages === undefined ? {} : { pages: exactHealth.pages }),
      ...(exactHealth?.records === undefined ? {} : { records: exactHealth.records }),
      provenanceVerified,
      sourceSetFingerprintPresent: connectors.health?.sourceSetFingerprint !== undefined,
      ...(connectors.health?.sourceSetFingerprint === undefined
        ? {}
        : { sourceSetFingerprint: connectors.health.sourceSetFingerprint }),
      packageEvidenceCount: packageEvidence.length,
      packageNodeCount: packageNodes.length,
      agentPackageCount,
      extensionPackageCount,
      liveSourceStatusCount,
      staleSourceStatusCount,
      unknownSourceStatusCount,
      syntheticOrUnknownCount,
      classifications: classificationCounts,
    },
    connectorBinding: {
      status: bindingStatus,
      summary: bindingReady
        ? 'Deployment runtime binding and approved managed identity are present; identity value is redacted.'
        : 'Exact deployment runtime binding or approved managed identity is unavailable.',
      ...(binding?.updatedAt === undefined ? {} : { observedAt: binding.updatedAt }),
      ...(binding?.sourceId === undefined ? {} : { configurationSourceId: binding.sourceId }),
      ...(runtimeBinding?.bindingSourceId === undefined
        ? {}
        : { bindingSourceId: runtimeBinding.bindingSourceId }),
      deploymentManaged: binding?.origin === 'deployment',
      enabled: binding?.enabled === true,
      ...(binding?.credential.mode === undefined
        ? {}
        : { credentialMode: binding.credential.mode }),
      managedIdentityClientId:
        binding?.credential.mode === 'managed-identity' ? 'redacted' : 'not-present',
      approvedManagedIdentity,
      ...(binding?.testStatus.status === undefined
        ? {}
        : { testStatus: binding.testStatus.status }),
    },
    runsAs: {
      status: runsAsStatus,
      summary: runsAsReady
        ? `${exactRunsAs.length} exact RUNS_AS edges match persisted diagnostics.`
        : explainedMissingProviderIds
          ? 'No exact RUNS_AS edges; diagnostics account for missing provider identity IDs.'
          : partiallyMatched
            ? 'Exact RUNS_AS edges exist, but some authoritative agents still lack provider identity IDs.'
            : 'Exact RUNS_AS evidence is incomplete or diagnostics do not explain the gap.',
      observedAt: snapshot.generatedAt,
      exactEdgeCount: exactRunsAs.length,
      nonExactEdgeCount: allRunsAs.length - exactRunsAs.length,
      authoritativeAgentsConsidered,
      unmatched,
      ambiguous,
      unmatchedReasons,
    },
    otel: {
      status: otelStatus,
      summary: otelReady
        ? 'Accepted live OTel evidence includes trace/span and token/cost provenance.'
        : 'Live OTel evidence is insufficient for operational release readiness.',
      ...(state.runtimeEvidence?.queriedAt === undefined
        ? {}
        : { observedAt: state.runtimeEvidence.queriedAt }),
      runtimeStatus,
      evidenceObjectCount: otelEvidence.length,
      acceptedRecordCount,
      sourceCount: runtimeSources.length,
      completeSourceCount,
      invocationCount: allInvocations.length,
      liveInvocationCount: liveInvocations.length,
      syntheticInvocationCount,
      traceSpanProvenanceCount,
      tokenCostProvenanceCount,
      failureCount,
    },
  }
}
