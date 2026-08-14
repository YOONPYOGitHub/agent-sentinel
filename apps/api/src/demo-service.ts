import type {
  AgentSentinelState,
  Finding,
  Remediation,
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

export class DemoService {
  private readonly connector = new MockAgentConnector()
  private validations: ValidationRun[] = []
  private remediations: Remediation[] = []
  private findingHistory: Finding[] | undefined

  async getState(): Promise<AgentSentinelState> {
    const snapshot = await this.connector.discover()
    const currentFindings = evaluateUncontrolledEgress(snapshot)
    if (this.findingHistory === undefined && currentFindings.length > 0) {
      this.findingHistory = currentFindings
    }

    return {
      snapshot,
      findings: structuredClone(this.findingHistory ?? currentFindings),
      validations: structuredClone(this.validations),
      remediations: structuredClone(this.remediations),
    }
  }

  async validateFinding(findingId: string): Promise<AgentSentinelState> {
    const state = await this.getState()
    const finding = state.findings.find((candidate) => candidate.id === findingId)
    if (finding === undefined) {
      throw new NotFoundError(`Unknown finding: ${findingId}`)
    }
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
    if (finding === undefined) {
      throw new NotFoundError(`Unknown finding: ${findingId}`)
    }
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
    this.connector.reset()
    this.validations = []
    this.remediations = []
    this.findingHistory = undefined
    return this.getState()
  }

  private requireRemediation(remediationId: string): Remediation {
    const remediation = this.remediations.find((candidate) => candidate.id === remediationId)
    if (remediation === undefined) {
      throw new NotFoundError(`Unknown remediation: ${remediationId}`)
    }
    return remediation
  }
}
