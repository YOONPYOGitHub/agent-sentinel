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
