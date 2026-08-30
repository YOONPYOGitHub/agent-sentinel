import {
  projectRuntimeEvidence,
  runtimeObservationWindowsSchema,
  runtimeTelemetryRequestForAgent,
  type AgentConnector,
  type RuntimeObservationWindows,
  type RuntimeTelemetryConnector,
} from '@agent-sentinel/connector-sdk'
import type {
  AgentSentinelState,
  EstateSnapshot,
  Finding,
  Remediation,
  SnapshotRepository,
  ValidationRun,
} from '@agent-sentinel/domain'
import { MockAgentConnector } from '@agent-sentinel/mock-connector'
import { evaluateUncontrolledEgress } from '@agent-sentinel/policy-engine'

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
  tenantId: string
  environment: string
}

export class DemoService {
  private runtimeProjectionCache:
    | {
        key: string
        expiresAt: number
        value: Promise<{
          snapshot: EstateSnapshot
          status: NonNullable<AgentSentinelState['runtimeEvidence']>
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
            this.persistedReadModel.tenantId,
            this.persistedReadModel.environment,
          )
    if (snapshot === null) {
      throw new ReadModelUnavailableError(
        'No persisted estate snapshot is available for the configured tenant and environment.',
      )
    }
    const runtimeProjection = await this.withRuntimeEvidence(snapshot)
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
    }
  }

  private async withRuntimeEvidence(snapshot: EstateSnapshot): Promise<{
    snapshot: EstateSnapshot
    status: NonNullable<AgentSentinelState['runtimeEvidence']>
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
          failures: [],
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
  }> {
    const connector = this.runtimeTelemetryConnector
    if (connector === undefined) {
      throw new Error('Runtime telemetry connector is not configured.')
    }
    const requests = agents.flatMap((agent) => {
      const request = runtimeTelemetryRequestForAgent(snapshot, agent)
      return request === undefined ? [] : [{ agent, request }]
    })
    const results: Array<
      | { agentId: string; windows: RuntimeObservationWindows }
      | { agentId: string; reason: 'query-failed' }
    > = []
    const concurrency = 4
    for (let index = 0; index < requests.length; index += concurrency) {
      results.push(
        ...(await Promise.all(
          requests.slice(index, index + concurrency).map(async ({ agent, request }) => {
            try {
              return {
                agentId: agent.id,
                windows: runtimeObservationWindowsSchema.parse(
                  await connector.readObservationWindows(request),
                ),
              }
            } catch {
              return { agentId: agent.id, reason: 'query-failed' as const }
            }
          }),
        )),
      )
    }

    let projected = structuredClone(snapshot)
    let evidenceCount = 0
    let enrichedAgentCount = 0
    const failures: NonNullable<AgentSentinelState['runtimeEvidence']>['failures'] = []
    const queriedAt: string[] = []
    for (const result of results) {
      if ('reason' in result) {
        failures.push(result)
        continue
      }
      try {
        const projection = projectRuntimeEvidence(projected, result.windows)
        projected = projection.snapshot
        evidenceCount += projection.addedEvidenceCount
        if (projection.addedEvidenceCount > 0) enrichedAgentCount += 1
        queriedAt.push(result.windows.queriedAt)
      } catch {
        failures.push({ agentId: result.agentId, reason: 'projection-failed' })
      }
    }
    const successfulQueries = results.length - failures.length
    const incompleteCoverage = requests.length < agents.length || failures.length > 0
    const status =
      successfulQueries === 0 ? 'unavailable' : incompleteCoverage ? 'partial' : 'ready'
    return {
      snapshot: projected,
      status: {
        status,
        ...(queriedAt.length > 0 ? { queriedAt: queriedAt.sort().at(-1) } : {}),
        agentCount: agents.length,
        eligibleAgentCount: requests.length,
        queriedAgentCount: successfulQueries,
        enrichedAgentCount,
        evidenceCount,
        failures,
      },
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

  async approveRemediation(remediationId: string, approvedBy: string): Promise<AgentSentinelState> {
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
      remediation.approvedAt === undefined
    ) {
      throw new StateConflictError('Remediation requires a complete approval before execution.')
    }
    if (this.connector.execute === undefined) {
      throw new StateConflictError('The selected connector does not support remediation execution.')
    }
    const result = await this.connector.execute(remediation, {
      approvedBy: remediation.approvedBy,
      approvedAt: remediation.approvedAt,
      reason: 'Validated critical exposure with low-disruption containment available.',
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
