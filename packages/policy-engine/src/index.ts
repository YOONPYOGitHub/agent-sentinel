import type {
  EstateSnapshot,
  EvidenceType,
  ExposureFinding,
  Finding,
  RiskFactors,
} from '@agent-sentinel/domain'
import { calculateBlastRadius, findAttackPaths } from '@agent-sentinel/graph-engine'

export const uncontrolledEgressPolicy = {
  id: 'AS-POL-004',
  name: 'Sensitive data requires controlled egress',
  description:
    'Untrusted input must not reach confidential data and an unapproved external endpoint.',
  severity: 'critical' as const,
}

const defaultFactors: RiskFactors = {
  reachability: 1,
  exploitability: 0.98,
  businessImpact: 0.97,
  privilege: 0.96,
  dataSensitivity: 1,
  activity: 0.92,
  confidence: 0.97,
  compensatingControlDiscount: 0.05,
}

export function evaluateUncontrolledEgress(snapshot: EstateSnapshot): Finding[] {
  const sourceNodeIds = snapshot.nodes
    .filter((node) => node.kind === 'input' && node.trust === 'untrusted')
    .map((node) => node.id)
  const targetNodeIds = snapshot.nodes
    .filter((node) => node.kind === 'mcp' && node.trust === 'untrusted')
    .map((node) => node.id)

  const paths = findAttackPaths(snapshot, {
    sourceNodeIds,
    targetNodeIds,
    factors: defaultFactors,
  })

  return paths.map((path, index) => ({
    id: `finding-uncontrolled-egress-${index + 1}`,
    title: 'Confidential data can reach an unapproved MCP server',
    summary:
      'An indirect prompt injection can traverse an overprivileged agent identity and expose confidential CRM data to an external endpoint.',
    severity: uncontrolledEgressPolicy.severity,
    path,
    owner: 'Sales AI Platform',
    policyId: uncontrolledEgressPolicy.id,
    detectedAt: snapshot.generatedAt,
    recommendation:
      'Block the unapproved MCP route, require approval for sensitive reads, and replace broad CRM permissions with a scoped role.',
  }))
}

// ---------------------------------------------------------------------------
// Exposure policies (declared-configuration analysis)
// ---------------------------------------------------------------------------

interface AgentToolContext {
  agentId: string
  agentName: string
  approvalRequired: boolean
  outgoingEdges: EstateSnapshot['edges']
  toolNodesByEdge: Map<string, EstateSnapshot['nodes'][number]>
  declaredTools: string[]
}

function collectAgentContexts(snapshot: EstateSnapshot): AgentToolContext[] {
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]))
  const agents = snapshot.nodes.filter((node) => node.kind === 'agent')
  const contexts: AgentToolContext[] = []
  for (const agent of agents) {
    const outgoingEdges = snapshot.edges.filter(
      (edge) => edge.from === agent.id && edge.relationship === 'CAN_CALL' && edge.active,
    )
    const toolNodesByEdge = new Map<string, EstateSnapshot['nodes'][number]>()
    const declaredTools: string[] = []
    for (const edge of outgoingEdges) {
      const toolNode = nodeById.get(edge.to)
      if (!toolNode || toolNode.kind !== 'tool') continue
      toolNodesByEdge.set(edge.id, toolNode)
      declaredTools.push(toolNode.name)
    }
    contexts.push({
      agentId: agent.id,
      agentName: agent.name,
      approvalRequired: agent.metadata['approvalRequired'] === 'true',
      outgoingEdges,
      toolNodesByEdge,
      declaredTools,
    })
  }
  return contexts
}

const EXTERNAL_TRANSFER_TOOLS = new Set(['external_send', 'external_transfer'])
const SENSITIVE_LOOKUP_TOOL = 'employee_lookup'
const SENSITIVE_PARAMS = ['salary', 'medical', 'performance']
const MUTATION_TOOLS = new Set([
  'create_purchase_order',
  'create_order',
  'submit_form',
  'update_record',
  'delete_record',
  'write_file',
  'send_message',
])

const declaredEvidenceType: EvidenceType = 'declared_configuration'

interface ExposureBuildInput {
  snapshot: EstateSnapshot
  context: AgentToolContext
  matchingEdges: EstateSnapshot['edges']
  policyId: string
  policyName: string
  severity: ExposureFinding['severity']
  riskScore: number
  title: string
  summary: string
  recommendation: string
}

function buildExposureFinding(input: ExposureBuildInput): ExposureFinding {
  const { snapshot, context, matchingEdges } = input
  const evidenceIds = new Set<string>()
  const affectedNodeIds = new Set<string>([context.agentId])
  const affectedEdgeIds: string[] = []
  const agentNode = snapshot.nodes.find((node) => node.id === context.agentId)
  agentNode?.evidenceIds.forEach((id) => evidenceIds.add(id))
  for (const edge of matchingEdges) {
    affectedEdgeIds.push(edge.id)
    affectedNodeIds.add(edge.to)
    edge.evidenceIds.forEach((id) => evidenceIds.add(id))
    const toolNode = snapshot.nodes.find((node) => node.id === edge.to)
    toolNode?.evidenceIds.forEach((id) => evidenceIds.add(id))
  }
  const blastRadius = calculateBlastRadius(snapshot, context.agentId)
  return {
    id: `exposure-${input.policyId.toLowerCase()}-${context.agentId}`,
    policyId: input.policyId,
    policyName: input.policyName,
    severity: input.severity,
    status: 'open',
    riskScore: input.riskScore,
    title: input.title,
    summary: input.summary,
    recommendation: input.recommendation,
    affectedAgentId: context.agentId,
    affectedAgentName: context.agentName,
    declaredTools: [...context.declaredTools],
    affectedNodeIds: [...affectedNodeIds],
    affectedEdgeIds,
    evidenceIds: [...evidenceIds],
    evidenceTypes: [declaredEvidenceType],
    blastRadiusCount: blastRadius.length,
    blastRadiusNodeIds: blastRadius.map((node) => node.id),
    firstSeen: snapshot.generatedAt,
    lastSeen: snapshot.generatedAt,
    sourceMode: 'foundry',
    validationStatus: 'theoretical',
    tenantId: snapshot.tenantId,
    snapshotId: `${snapshot.tenantId}-${snapshot.environment}-${snapshot.generatedAt}`,
  }
}

export const unapprovedExternalTransferPolicy = {
  id: 'AS-POL-001',
  name: 'Unapproved external transfer or send',
  severity: 'critical' as const,
  riskScore: 91,
}

export function evaluateUnapprovedExternalTransfer(snapshot: EstateSnapshot): ExposureFinding[] {
  const findings: ExposureFinding[] = []
  for (const context of collectAgentContexts(snapshot)) {
    if (context.approvalRequired) continue
    const matching = context.outgoingEdges.filter((edge) => {
      const tool = context.toolNodesByEdge.get(edge.id)
      return tool !== undefined && EXTERNAL_TRANSFER_TOOLS.has(tool.name)
    })
    if (matching.length === 0) continue
    findings.push(
      buildExposureFinding({
        snapshot,
        context,
        matchingEdges: matching,
        policyId: unapprovedExternalTransferPolicy.id,
        policyName: unapprovedExternalTransferPolicy.name,
        severity: unapprovedExternalTransferPolicy.severity,
        riskScore: unapprovedExternalTransferPolicy.riskScore,
        title: `${context.agentName} can transfer data externally without approval`,
        summary:
          'The agent declares an external send or transfer capability but no approval gate is required. An external egress path may be used without human review.',
        recommendation:
          'Require explicit human approval for external send or transfer, or remove the capability from the declared configuration.',
      }),
    )
  }
  return findings
}

export const overprivilegedEmployeeLookupPolicy = {
  id: 'AS-POL-002',
  name: 'Overprivileged employee lookup without approval',
  severity: 'high' as const,
  riskScore: 76,
}

export function evaluateOverprivilegedEmployeeLookup(snapshot: EstateSnapshot): ExposureFinding[] {
  const findings: ExposureFinding[] = []
  for (const context of collectAgentContexts(snapshot)) {
    if (context.approvalRequired) continue
    const matching = context.outgoingEdges.filter((edge) => {
      const tool = context.toolNodesByEdge.get(edge.id)
      if (!tool || tool.name !== SENSITIVE_LOOKUP_TOOL) return false
      const description = (tool.description ?? '').toLowerCase()
      const metadata = Object.values(tool.metadata).join(' ').toLowerCase()
      const haystack = `${description} ${metadata}`
      return SENSITIVE_PARAMS.some((token) => haystack.includes(token))
    })
    const alwaysMatch = context.outgoingEdges.filter((edge) => {
      const tool = context.toolNodesByEdge.get(edge.id)
      return tool !== undefined && tool.name === SENSITIVE_LOOKUP_TOOL
    })
    const finalMatches = matching.length > 0 ? matching : alwaysMatch
    if (finalMatches.length === 0) continue
    findings.push(
      buildExposureFinding({
        snapshot,
        context,
        matchingEdges: finalMatches,
        policyId: overprivilegedEmployeeLookupPolicy.id,
        policyName: overprivilegedEmployeeLookupPolicy.name,
        severity: overprivilegedEmployeeLookupPolicy.severity,
        riskScore: overprivilegedEmployeeLookupPolicy.riskScore,
        title: `${context.agentName} can read sensitive employee data without approval`,
        summary:
          'The agent declares an employee lookup capability that can access sensitive fields (salary, medical, or performance) without an approval gate.',
        recommendation:
          'Restrict employee_lookup to the minimum required fields, or require human approval before returning salary, medical, or performance data.',
      }),
    )
  }
  return findings
}

export const unapprovedMutationPolicy = {
  id: 'AS-POL-003',
  name: 'Mutation tool without approval',
  severity: 'high' as const,
  riskScore: 72,
}

export function evaluateUnapprovedMutation(snapshot: EstateSnapshot): ExposureFinding[] {
  const findings: ExposureFinding[] = []
  for (const context of collectAgentContexts(snapshot)) {
    if (context.approvalRequired) continue
    const matching = context.outgoingEdges.filter((edge) => {
      const tool = context.toolNodesByEdge.get(edge.id)
      return tool !== undefined && MUTATION_TOOLS.has(tool.name)
    })
    if (matching.length === 0) continue
    findings.push(
      buildExposureFinding({
        snapshot,
        context,
        matchingEdges: matching,
        policyId: unapprovedMutationPolicy.id,
        policyName: unapprovedMutationPolicy.name,
        severity: unapprovedMutationPolicy.severity,
        riskScore: unapprovedMutationPolicy.riskScore,
        title: `${context.agentName} can mutate systems without approval`,
        summary:
          'The agent declares a mutation capability (create, update, delete, submit, or send) but no approval gate is required. State changes may execute without human review.',
        recommendation:
          'Require approval before executing mutation tools, or restrict the declared capability set to read-only tools.',
      }),
    )
  }
  return findings
}

export function evaluateAllExposurePolicies(snapshot: EstateSnapshot): ExposureFinding[] {
  return [
    ...evaluateUnapprovedExternalTransfer(snapshot),
    ...evaluateOverprivilegedEmployeeLookup(snapshot),
    ...evaluateUnapprovedMutation(snapshot),
  ]
}
