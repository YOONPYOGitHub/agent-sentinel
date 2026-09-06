import {
  aggregateLiveSources,
  projectRuntimeEvidence,
  runtimeObservationWindowsSchema,
  runtimeTelemetryRequestForAgent,
  ManifestIngestionSourceLimitError,
  MAX_MANIFEST_SOURCES,
  type AgentConnector,
  type ManifestIngestionRepository,
  type RuntimeObservationWindows,
  type RuntimeTelemetryConnector,
} from '@agent-sentinel/connector-sdk'
import type {
  AgentSentinelState,
  EstateContext,
  EstateSnapshot,
  Finding,
  ManifestConfigurationReconciliation,
  ManifestRuntimeVerification,
  Remediation,
  SnapshotRepository,
  ValidationRun,
} from '@agent-sentinel/domain'
import { MockAgentConnector } from '@agent-sentinel/mock-connector'
import { evaluateUncontrolledEgress } from '@agent-sentinel/policy-engine'

import {
  reconcileManifestConfigurationEvidence,
  verifyManifestRuntimeClaims,
  type RuntimeQueryCoverage,
} from './manifest-runtime-verification.js'

export class NotFoundError extends Error {
  override readonly name = 'NotFoundError'
}

export class StateConflictError extends Error {
  override readonly name = 'StateConflictError'
}

export class ReadModelUnavailableError extends Error {
  override readonly name = 'ReadModelUnavailableError'
}

export interface PersistedReadModel {
  snapshotRepository: SnapshotRepository
  estate: EstateContext
}

interface RuntimeEvidenceSourceRequest {
  readonly id: string
  readonly agent: EstateSnapshot['nodes'][number]
  readonly request: NonNullable<ReturnType<typeof runtimeTelemetryRequestForAgent>>
}

export class DemoService {
  private runtimeProjectionCache:
    | {
        key: string
        expiresAt: number
        value: Promise<{
          snapshot: EstateSnapshot
          status: NonNullable<AgentSentinelState['runtimeEvidence']>
          coverage: RuntimeQueryCoverage
        }>
      }
    | undefined

  constructor(
    private readonly connector: AgentConnector = new MockAgentConnector(),
    private readonly connectorMode: 'mock' | 'foundry' = 'mock',
    private readonly projectEndpoint?: string,
    private readonly persistedReadModel?: PersistedReadModel,
    private readonly persistedReadModelRequired = false,
    private readonly runtimeTelemetryConnector?: RuntimeTelemetryConnector,
    private readonly manifestIngestionRepository?: ManifestIngestionRepository,
  ) {}

  private validations: ValidationRun[] = []
  private remediations: Remediation[] = []
  private findingHistory: Finding[] | undefined

  async getState(): Promise<AgentSentinelState> {
    if (this.persistedReadModelRequired && this.persistedReadModel === undefined) {
      throw new ReadModelUnavailableError(
        'The persisted estate read model is not configured for this live deployment.',
      )
    }
    const snapshot =
      this.persistedReadModel === undefined
        ? await this.connector.discover()
        : await this.persistedReadModel.snapshotRepository.findLatest(
            this.persistedReadModel.estate,
          )
    if (snapshot === null) {
      throw new ReadModelUnavailableError(
        'No persisted estate snapshot is available for the configured tenant and environment.',
      )
    }
    const runtimeProjection = await this.withRuntimeEvidence(snapshot)
    const manifestAnalysis = await this.analyzeManifestEvidence(
      runtimeProjection.snapshot,
      runtimeProjection.coverage,
    )
    const currentFindings = evaluateUncontrolledEgress(runtimeProjection.snapshot)
    if (
      this.persistedReadModel === undefined &&
      this.findingHistory === undefined &&
      currentFindings.length > 0
    ) {
      this.findingHistory = currentFindings
    }
    return {
      snapshot: structuredClone(runtimeProjection.snapshot),
      findings: structuredClone(
        this.persistedReadModel === undefined
          ? (this.findingHistory ?? currentFindings)
          : currentFindings,
      ),
      validations: structuredClone(this.validations),
      remediations: structuredClone(this.remediations),
      runtimeEvidence: structuredClone(runtimeProjection.status),
      manifestRuntimeVerification: structuredClone(manifestAnalysis.runtime),
      manifestConfigurationReconciliation: structuredClone(manifestAnalysis.configuration),
    }
  }

  private async withRuntimeEvidence(snapshot: EstateSnapshot): Promise<{
    snapshot: EstateSnapshot
    status: NonNullable<AgentSentinelState['runtimeEvidence']>
    coverage: RuntimeQueryCoverage
  }> {
    const agents = snapshot.nodes.filter((node) => node.kind === 'agent')
    if (this.runtimeTelemetryConnector === undefined) {
      return {
        snapshot,
        status: {
          status: 'not-configured',
          agentCount: agents.length,
          eligibleAgentCount: 0,
          queriedAgentCount: 0,
          enrichedAgentCount: 0,
          evidenceCount: 0,
          sources: [],
          failures: [],
        },
        coverage: {
          configured: false,
          queriedAgentIds: new Set<string>(),
          failedAgentIds: new Set<string>(),
          projectionFailedAgentIds: new Set<string>(),
        },
      }
    }
    const key = `${snapshot.tenantId}\0${snapshot.environment}\0${snapshot.generatedAt}`
    if (
      this.runtimeProjectionCache?.key === key &&
      this.runtimeProjectionCache.expiresAt > Date.now()
    ) {
      return this.runtimeProjectionCache.value
    }
    const value = this.queryRuntimeEvidence(snapshot, agents)
    this.runtimeProjectionCache = { key, expiresAt: Date.now() + 60_000, value }
    return value
  }

  private async queryRuntimeEvidence(
    snapshot: EstateSnapshot,
    agents: EstateSnapshot['nodes'],
  ): Promise<{
    snapshot: EstateSnapshot
    status: NonNullable<AgentSentinelState['runtimeEvidence']>
    coverage: RuntimeQueryCoverage
  }> {
    const connector = this.runtimeTelemetryConnector
    if (connector === undefined) {
      throw new Error('Runtime telemetry connector is not configured.')
    }
    const requests = agents.flatMap((agent) => {
      const request = runtimeTelemetryRequestForAgent(
        snapshot,
        agent,
        this.persistedReadModel?.estate,
      )
      return request === undefined ? [] : [{ agent, request }]
    })
    if (requests.length === 0) {
      return {
        snapshot: structuredClone(snapshot),
        status: {
          status: 'unavailable',
          agentCount: agents.length,
          eligibleAgentCount: 0,
          queriedAgentCount: 0,
          enrichedAgentCount: 0,
          evidenceCount: 0,
          sources: [],
          failures: [],
        },
        coverage: {
          configured: true,
          queriedAgentIds: new Set(),
          failedAgentIds: new Set(),
          projectionFailedAgentIds: new Set(),
        },
      }
    }
    const aggregation = await aggregateLiveSources<
      RuntimeEvidenceSourceRequest,
      RuntimeObservationWindows
    >({
      sources: requests.map(({ agent, request }) => ({ id: agent.id, agent, request })),
      limits: {
        maxSources: 1_000,
        maxConcurrency: 4,
        maxDurationMs: 60_000,
        maxPagesPerSource: 1,
        maxRecordsPerSource: 10_000,
      },
      execute: async (source, context) => {
        const windows = runtimeObservationWindowsSchema.parse(
          await connector.readObservationWindows(source.request, { signal: context.signal }),
        )
        const observations = [...windows.baseline.observations, ...windows.observed.observations]
        return {
          state: observations.length === 0 ? ('empty' as const) : ('complete' as const),
          value: windows,
          pages: 1,
          records: observations.length,
          evidenceIds:
            observations.length === 0
              ? []
              : [windows.baselineEvidenceId, windows.observedEvidenceId],
          ...(observations.length === 0 ? { reason: 'empty' } : {}),
        }
      },
      failureReason: () => 'query-failed',
    })

    let projected = structuredClone(snapshot)
    let evidenceCount = 0
    let enrichedAgentCount = 0
    const failures: NonNullable<AgentSentinelState['runtimeEvidence']>['failures'] = []
    const queriedAgentIds = new Set<string>()
    const failedAgentIds = new Set<string>()
    const projectionSucceededAgentIds = new Set<string>()
    const projectionFailedAgentIds = new Set<string>()
    const queriedAt: string[] = []
    const sourceResults: NonNullable<AgentSentinelState['runtimeEvidence']>['sources'] = []
    for (const outcome of aggregation.outcomes) {
      const { agent, request } = outcome.source
      const commonSourceResult = {
        ...(this.persistedReadModel === undefined
          ? {}
          : { estateId: this.persistedReadModel.estate.id }),
        estateTenantId: snapshot.tenantId,
        estateEnvironment: snapshot.environment,
        snapshotGeneratedAt: snapshot.generatedAt,
        sourceConnectorId: request.sourceConnectorId!,
        sourceTenantId: request.sourceTenantId!,
        sourceEnvironment: request.sourceEnvironment!,
        sourceAgentId: request.sourceAgentId!,
        agentId: agent.id,
      }
      if (
        outcome.state === 'failed' ||
        outcome.state === 'cancelled' ||
        outcome.value === undefined
      ) {
        failures.push({ agentId: agent.id, reason: 'query-failed' })
        failedAgentIds.add(agent.id)
        sourceResults.push({
          ...commonSourceResult,
          state: outcome.state,
          windowIds: [],
          observationIds: [],
          evidenceIds: [],
          providerResourceIds: [],
          reason: outcome.reason ?? 'query-failed',
        })
        continue
      }
      const windows = outcome.value
      const observations = [...windows.baseline.observations, ...windows.observed.observations]
      const inputProviderResourceIds = [
        ...new Set([
          ...(windows.provenance === undefined ? [] : [windows.provenance.providerResourceId]),
          ...observations.flatMap((observation) =>
            observation.otelProvenance === undefined
              ? []
              : [observation.otelProvenance.providerResourceId],
          ),
        ]),
      ].sort()
      queriedAgentIds.add(agent.id)
      if (outcome.state === 'empty') {
        sourceResults.push({
          ...commonSourceResult,
          state: outcome.state,
          windowIds: [windows.baseline.windowId, windows.observed.windowId],
          observationIds: [],
          evidenceIds: [],
          providerResourceIds: inputProviderResourceIds,
          reason: outcome.reason ?? 'empty',
        })
        continue
      }
      try {
        const projection = projectRuntimeEvidence(projected, windows)
        projected = projection.snapshot
        const validatedObservations = [
          ...projection.windows.baseline.observations,
          ...projection.windows.observed.observations,
        ]
        const providerResourceIds = [
          ...new Set([
            ...(projection.windows.provenance === undefined
              ? []
              : [projection.windows.provenance.providerResourceId]),
            ...validatedObservations.flatMap((observation) =>
              observation.otelProvenance === undefined
                ? []
                : [observation.otelProvenance.providerResourceId],
            ),
          ]),
        ].sort()
        evidenceCount += projection.addedEvidenceCount
        if (projection.addedEvidenceCount > 0) enrichedAgentCount += 1
        if (
          projection.dataState.state === 'complete' ||
          projection.dataState.state === 'partial' ||
          projection.dataState.state === 'stale'
        ) {
          projectionSucceededAgentIds.add(agent.id)
        }
        queriedAt.push(windows.queriedAt)
        sourceResults.push({
          ...commonSourceResult,
          state: projection.dataState.state,
          windowIds: [projection.windows.baseline.windowId, projection.windows.observed.windowId],
          observationIds: validatedObservations.map((observation) => observation.id),
          evidenceIds: [...outcome.evidenceIds],
          providerResourceIds,
          ...(projection.dataState.reason === undefined
            ? {}
            : { reason: projection.dataState.reason }),
        })
      } catch {
        failures.push({ agentId: agent.id, reason: 'projection-failed' })
        projectionFailedAgentIds.add(agent.id)
        sourceResults.push({
          ...commonSourceResult,
          state: 'failed',
          windowIds: [windows.baseline.windowId, windows.observed.windowId],
          observationIds: observations.map((observation) => observation.id),
          evidenceIds: [],
          providerResourceIds: inputProviderResourceIds,
          reason: 'projection-failed',
        })
      }
    }
    const incompleteCoverage =
      requests.length < agents.length ||
      failures.length > 0 ||
      sourceResults.some((source) => source.state !== 'complete')
    const status =
      projectionSucceededAgentIds.size === 0
        ? 'unavailable'
        : incompleteCoverage
          ? 'partial'
          : 'ready'
    return {
      snapshot: projected,
      status: {
        status,
        ...(queriedAt.length > 0 ? { queriedAt: queriedAt.sort().at(-1) } : {}),
        agentCount: agents.length,
        eligibleAgentCount: requests.length,
        queriedAgentCount: queriedAgentIds.size,
        enrichedAgentCount,
        evidenceCount,
        sources: sourceResults,
        failures,
      },
      coverage: {
        configured: true,
        queriedAgentIds,
        failedAgentIds,
        projectionFailedAgentIds,
      },
    }
  }

  private async analyzeManifestEvidence(
    snapshot: EstateSnapshot,
    coverage: RuntimeQueryCoverage,
  ): Promise<{
    runtime: ManifestRuntimeVerification
    configuration: ManifestConfigurationReconciliation
  }> {
    const checkedAt = new Date().toISOString()
    if (this.manifestIngestionRepository === undefined) {
      return {
        runtime: {
          status: 'not-configured',
          checkedAt,
          counts: {
            verified: 0,
            noObservation: 0,
            ambiguous: 0,
            notCorrelatable: 0,
            unavailable: 0,
          },
          claims: [],
        },
        configuration: {
          status: 'not-configured',
          checkedAt,
          counts: {
            matched: 0,
            ambiguous: 0,
            notCorrelatable: 0,
            valueMatched: 0,
            valueMismatched: 0,
            valueUnavailable: 0,
            freeFormUnverified: 0,
          },
          claims: [],
        },
      }
    }
    try {
      const records = await this.manifestIngestionRepository.listLatest(
        snapshot.environment,
        MAX_MANIFEST_SOURCES,
      )
      return {
        runtime: verifyManifestRuntimeClaims(snapshot, records, coverage, checkedAt),
        configuration: reconcileManifestConfigurationEvidence(snapshot, records, checkedAt),
      }
    } catch (error) {
      const reason =
        error instanceof ManifestIngestionSourceLimitError
          ? 'source-limit-exceeded'
          : 'repository-unavailable'
      return {
        runtime: {
          status: 'unavailable',
          reason,
          checkedAt,
          counts: {
            verified: 0,
            noObservation: 0,
            ambiguous: 0,
            notCorrelatable: 0,
            unavailable: 0,
          },
          claims: [],
        },
        configuration: {
          status: 'unavailable',
          reason,
          checkedAt,
          counts: {
            matched: 0,
            ambiguous: 0,
            notCorrelatable: 0,
            valueMatched: 0,
            valueMismatched: 0,
            valueUnavailable: 0,
            freeFormUnverified: 0,
          },
          claims: [],
        },
      }
    }
  }

  getConnectorStatus(): Promise<{
    source: 'mock' | 'foundry'
    connectorId: string
    mode: 'mock' | 'foundry'
    projectEndpoint?: string
    writeEnabled?: boolean
  }> {
    const configuredWriteMode = process.env['AGENT_SENTINEL_WRITE_ENABLED']?.trim().toLowerCase()
    const result: {
      source: 'mock' | 'foundry'
      connectorId: string
      mode: 'mock' | 'foundry'
      projectEndpoint?: string
      writeEnabled?: boolean
    } = {
      source: this.connectorMode,
      connectorId: this.connector.descriptor.id,
      mode: this.connectorMode,
      writeEnabled:
        configuredWriteMode === 'true' ||
        (configuredWriteMode === undefined && this.connectorMode === 'mock'),
    }
    if (this.projectEndpoint !== undefined) {
      result.projectEndpoint = this.projectEndpoint
    }
    return Promise.resolve(result)
  }

  testConnectorConnection() {
    return this.connector.testConnection()
  }

  getConnectorHealth() {
    return this.connector.getConnectorHealth?.()
  }

  async validateFinding(findingId: string): Promise<AgentSentinelState> {
    const state = await this.getState()
    const finding = state.findings.find((candidate) => candidate.id === findingId)
    if (finding === undefined) throw new NotFoundError(`Unknown finding: ${findingId}`)
    if (finding.path.status !== 'theoretical') {
      throw new StateConflictError(
        finding.path.status === 'validated'
          ? 'Finding is already validated.'
          : 'Mitigated findings cannot be validated.',
      )
    }

    const now = new Date().toISOString()
    this.validations = [
      {
        id: `validation-${this.validations.length + 1}`,
        findingId,
        status: 'validated',
        startedAt: now,
        completedAt: now,
        syntheticCanary: 'AS-CANARY-CUSTOMER-7429',
        observedAtTarget: true,
        trace: [
          'Synthetic external document introduced an indirect instruction.',
          'Sales Research Agent accepted the injected tool request.',
          'Agent identity read a synthetic Customer 360 record.',
          'Canary value reached the simulated external MCP endpoint.',
        ],
      },
      ...this.validations,
    ]
    this.findingHistory = state.findings.map((candidate) =>
      candidate.id === findingId
        ? { ...candidate, path: { ...candidate.path, status: 'validated' } }
        : candidate,
    )
    return this.getState()
  }

  async proposeRemediation(findingId: string): Promise<AgentSentinelState> {
    const state = await this.getState()
    const finding = state.findings.find((candidate) => candidate.id === findingId)
    if (finding === undefined) throw new NotFoundError(`Unknown finding: ${findingId}`)
    if (finding.path.status !== 'validated') {
      throw new StateConflictError('Validate the finding before proposing remediation.')
    }
    if (!this.remediations.some((item) => item.findingId === findingId)) {
      this.remediations = [
        {
          id: 'remediation-block-external-mcp',
          findingId,
          title: 'Block unapproved MCP egress',
          description:
            'Disable the route from Customer 360 data to the External Enrichment MCP while preserving the sales research workflow.',
          targetEdgeId: 'edge-data-mcp',
          status: 'proposed',
          expectedRiskReduction: 91,
          businessDisruption: 'low',
          rollbackAvailable: true,
        },
      ]
    }
    return this.getState()
  }

  async approveRemediation(
    remediationId: string,
    approvedBy: string,
    approvalReason: string,
  ): Promise<AgentSentinelState> {
    const remediation = this.requireRemediation(remediationId)
    if (remediation.status !== 'proposed') {
      throw new StateConflictError('Only proposed remediations can be approved.')
    }
    this.remediations = this.remediations.map((candidate) =>
      candidate.id === remediationId
        ? {
            ...candidate,
            status: 'approved',
            approvedBy,
            approvedAt: new Date().toISOString(),
            approvalReason,
          }
        : candidate,
    )
    return this.getState()
  }

  async executeRemediation(remediationId: string): Promise<AgentSentinelState> {
    const remediation = this.requireRemediation(remediationId)
    if (
      remediation.status !== 'approved' ||
      remediation.approvedBy === undefined ||
      remediation.approvedAt === undefined ||
      remediation.approvalReason === undefined
    ) {
      throw new StateConflictError('Remediation requires a complete approval before execution.')
    }
    if (
      !this.connector.descriptor.capabilities.includes('remediation-execution') ||
      this.connector.execute === undefined
    ) {
      throw new StateConflictError('The selected connector does not support remediation execution.')
    }
    const result = await this.connector.execute(remediation, {
      approvedBy: remediation.approvedBy,
      approvedAt: remediation.approvedAt,
      reason: remediation.approvalReason,
    })
    this.remediations = [result.remediation]
    this.findingHistory = (this.findingHistory ?? []).map((finding) =>
      finding.id === remediation.findingId
        ? { ...finding, path: { ...finding.path, status: 'mitigated' } }
        : finding,
    )
    return this.getState()
  }

  async reset(): Promise<AgentSentinelState> {
    if (this.connector instanceof MockAgentConnector) this.connector.reset()
    this.runtimeProjectionCache = undefined
    this.validations = []
    this.remediations = []
    this.findingHistory = undefined
    return this.getState()
  }

  private requireRemediation(remediationId: string): Remediation {
    const remediation = this.remediations.find((candidate) => candidate.id === remediationId)
    if (remediation === undefined) throw new NotFoundError(`Unknown remediation: ${remediationId}`)
    return remediation
  }
}
