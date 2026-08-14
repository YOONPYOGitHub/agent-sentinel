import type { AgentConnector, ApprovalContext } from '@agent-sentinel/connector-sdk'
import {
  assertEstateSnapshot,
  type EstateSnapshot,
  type Evidence,
  type Remediation,
} from '@agent-sentinel/domain'
import { disableEdge } from '@agent-sentinel/graph-engine'

const observedAt = '2026-08-14T12:00:00.000Z'

const evidence: Evidence[] = [
  {
    id: 'evidence-external-document',
    source: 'Microsoft Defender for Cloud Apps',
    sourceObjectId: 'session-48A2/document-188',
    observedAt,
    freshness: 'live',
    confidence: 0.98,
    summary: 'External document entered the Sales Research Agent session.',
  },
  {
    id: 'evidence-agent-manifest',
    source: 'Microsoft Copilot Studio',
    sourceObjectId: 'agent/sales-research/v17',
    observedAt,
    freshness: 'recent',
    confidence: 1,
    summary: 'Published agent manifest and configured identity.',
  },
  {
    id: 'evidence-identity-role',
    source: 'Microsoft Entra ID',
    sourceObjectId: 'servicePrincipal/agent-sales-research',
    observedAt,
    freshness: 'live',
    confidence: 1,
    summary: 'Agent identity holds the broad CRM.Data.Read.All application permission.',
  },
  {
    id: 'evidence-crm-classification',
    source: 'Microsoft Purview',
    sourceObjectId: 'dataAsset/dynamics-customer-360',
    observedAt,
    freshness: 'recent',
    confidence: 0.97,
    summary: 'Customer 360 dataset is classified Confidential.',
  },
  {
    id: 'evidence-mcp-observation',
    source: 'Agent Sentinel MCP Gateway',
    sourceObjectId: 'mcp/external-enrichment',
    observedAt,
    freshness: 'live',
    confidence: 0.99,
    summary: 'Remote MCP endpoint is not present in the approved Trust Catalog.',
  },
  {
    id: 'evidence-egress-trace',
    source: 'Azure Monitor',
    sourceObjectId: 'trace/74df91',
    observedAt,
    freshness: 'live',
    confidence: 0.96,
    summary: 'CRM-derived payload can be passed to the remote MCP tool call.',
  },
]

export function createSeedSnapshot(): EstateSnapshot {
  return assertEstateSnapshot({
    tenantId: 'contoso-ai-lab',
    environment: 'Demo / Korea Central',
    generatedAt: observedAt,
    evidence,
    nodes: [
      {
        id: 'external-document',
        kind: 'input',
        name: 'Quarterly account brief',
        description: 'External document containing an indirect prompt injection.',
        environment: 'demo',
        trust: 'untrusted',
        evidenceIds: ['evidence-external-document'],
        metadata: { channel: 'SharePoint upload', activity: '12 minutes ago' },
      },
      {
        id: 'sales-research-agent',
        kind: 'agent',
        name: 'Sales Research Agent',
        description: 'Creates account briefs for enterprise sellers.',
        environment: 'demo',
        owner: 'Sales AI Platform',
        trust: 'conditional',
        evidenceIds: ['evidence-agent-manifest'],
        metadata: { version: '17', platform: 'Copilot Studio', status: 'Published' },
      },
      {
        id: 'sales-agent-identity',
        kind: 'identity',
        name: 'agent-sales-research-prod',
        description: 'Service principal used by the Sales Research Agent.',
        environment: 'demo',
        owner: 'Sales AI Platform',
        trust: 'trusted',
        evidenceIds: ['evidence-identity-role'],
        metadata: { permission: 'CRM.Data.Read.All', privilege: 'High' },
      },
      {
        id: 'customer-360-data',
        kind: 'data',
        name: 'Customer 360',
        description: 'Dynamics customer, opportunity, and contact data.',
        environment: 'demo',
        owner: 'Revenue Operations',
        sensitivity: 'confidential',
        trust: 'trusted',
        evidenceIds: ['evidence-crm-classification'],
        metadata: { records: '148,220', label: 'Confidential' },
      },
      {
        id: 'external-enrichment-mcp',
        kind: 'mcp',
        name: 'External Enrichment MCP',
        description: 'Remote enrichment server outside the approved Trust Catalog.',
        environment: 'external',
        owner: 'Unknown publisher',
        trust: 'untrusted',
        evidenceIds: ['evidence-mcp-observation'],
        metadata: { endpoint: 'mcp.partner-labs.example', catalog: 'Unapproved' },
      },
    ],
    edges: [
      {
        id: 'edge-document-agent',
        from: 'external-document',
        to: 'sales-research-agent',
        relationship: 'TRIGGERS',
        evidenceIds: ['evidence-external-document', 'evidence-agent-manifest'],
        active: true,
      },
      {
        id: 'edge-agent-identity',
        from: 'sales-research-agent',
        to: 'sales-agent-identity',
        relationship: 'RUNS_AS',
        evidenceIds: ['evidence-agent-manifest', 'evidence-identity-role'],
        active: true,
      },
      {
        id: 'edge-identity-data',
        from: 'sales-agent-identity',
        to: 'customer-360-data',
        relationship: 'CAN_READ',
        evidenceIds: ['evidence-identity-role', 'evidence-crm-classification'],
        active: true,
      },
      {
        id: 'edge-data-mcp',
        from: 'customer-360-data',
        to: 'external-enrichment-mcp',
        relationship: 'CAN_EXFILTRATE_TO',
        evidenceIds: ['evidence-egress-trace', 'evidence-mcp-observation'],
        active: true,
        removable: true,
      },
    ],
  })
}

export class MockAgentConnector implements AgentConnector {
  readonly descriptor = {
    id: 'mock-agent-estate',
    name: 'Seeded Agent Estate',
    apiVersion: '2026-08-14',
    releaseStatus: 'mock' as const,
    capabilities: [
      'discovery',
      'evidence',
      'remediation-simulation',
      'remediation-execution',
    ] as const,
    requiredPermissions: [],
    blindSpots: ['Synthetic data only', 'No production control-plane execution'],
  }

  private snapshot = createSeedSnapshot()

  testConnection() {
    return Promise.resolve({
      ok: true,
      checkedAt: new Date().toISOString(),
      message: 'Synthetic connector is ready.',
    })
  }

  discover(): Promise<EstateSnapshot> {
    return Promise.resolve(structuredClone(this.snapshot))
  }

  getEvidence(evidenceId: string): Promise<Evidence> {
    const item = this.snapshot.evidence.find((candidate) => candidate.id === evidenceId)
    if (item === undefined) {
      return Promise.reject(new Error(`Unknown evidence: ${evidenceId}`))
    }
    return Promise.resolve(structuredClone(item))
  }

  execute(
    remediation: Remediation,
    approval: ApprovalContext,
  ): Promise<{ remediation: Remediation; snapshot: EstateSnapshot }> {
    if (remediation.status !== 'approved') {
      return Promise.reject(new Error('Remediation must be approved before execution.'))
    }
    if (approval.approvedBy !== remediation.approvedBy) {
      return Promise.reject(new Error('Approval context does not match the remediation approver.'))
    }

    this.snapshot = disableEdge(this.snapshot, remediation.targetEdgeId)
    return Promise.resolve({
      snapshot: structuredClone(this.snapshot),
      remediation: {
        ...remediation,
        status: 'completed',
        executedAt: new Date().toISOString(),
      },
    })
  }

  reset(): void {
    this.snapshot = createSeedSnapshot()
  }
}
