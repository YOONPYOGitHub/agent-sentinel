import { describe, expect, it } from 'vitest'

import type { EstateSnapshot } from '@agent-sentinel/domain'
import { FOUNDRY_API_VERSION, mapAgentToSnapshot } from '@agent-sentinel/foundry-connector'
import {
  createLiveGraphTraversalContextForSnapshot,
  trustedMockGraphTraversalContext,
} from '@agent-sentinel/graph-engine'
import { foundryManifest } from '@agent-sentinel/scenarios'

import {
  evaluateAllExposurePolicies,
  evaluateOverprivilegedEmployeeLookup,
  evaluateUnapprovedExternalTransfer,
  evaluateUnapprovedMutation,
  evaluateUncontrolledEgress,
} from '../src/index.js'

function agentToFoundry(agent: (typeof foundryManifest.agents)[number]) {
  return {
    id: agent.name,
    name: agent.displayName,
    version: agent.version,
    description: agent.description,
    model: agent.modelDeployment,
    instructions: agent.instructions,
    tools: agent.functions.map((fn) => ({
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
      },
    })),
    metadata: {
      owner: agent.owner,
      environment: agent.environment,
      approvalRequired: agent.approvalRequired ? 'true' : 'false',
      lifecycle: agent.lifecycle,
      version: agent.version,
    },
  }
}

function scenarioSnapshot(agentName: string): EstateSnapshot {
  const agent = foundryManifest.agents.find((candidate) => candidate.name === agentName)
  if (!agent) throw new Error(`Unknown agent: ${agentName}`)
  return mapAgentToSnapshot([agentToFoundry(agent)], FOUNDRY_API_VERSION, {
    tenantId: 'tenant-demo',
    environment: 'validation',
  })
}

function fullSnapshot(): EstateSnapshot {
  return mapAgentToSnapshot(foundryManifest.agents.map(agentToFoundry), FOUNDRY_API_VERSION, {
    tenantId: 'tenant-demo',
    environment: 'validation',
  })
}

const legacySnapshot: EstateSnapshot = {
  tenantId: 'tenant-demo',
  environment: 'demo',
  generatedAt: '2026-08-14T12:00:00.000Z',
  evidence: [
    {
      id: 'evidence',
      source: 'mock',
      sourceObjectId: 'object',
      observedAt: '2026-08-14T12:00:00.000Z',
      freshness: 'live',
      confidence: 1,
      evidenceTypes: ['synthetic_validation'],
      summary: 'Synthetic evidence',
    },
  ],
  nodes: [
    {
      id: 'input',
      kind: 'input',
      name: 'External document',
      description: 'Untrusted document',
      environment: 'demo',
      trust: 'untrusted',
      evidenceIds: ['evidence'],
      metadata: {},
    },
    {
      id: 'mcp',
      kind: 'mcp',
      name: 'External MCP',
      description: 'Unapproved MCP server',
      environment: 'demo',
      trust: 'untrusted',
      evidenceIds: ['evidence'],
      metadata: {},
    },
  ],
  edges: [
    {
      id: 'edge',
      from: 'input',
      to: 'mcp',
      relationship: 'CAN_EXFILTRATE_TO',
      evidenceIds: ['evidence'],
      active: true,
      removable: true,
    },
  ],
}

describe('uncontrolled egress policy (AS-POL-004)', () => {
  it('creates an explainable critical finding', () => {
    const findings = evaluateUncontrolledEgress(legacySnapshot, trustedMockGraphTraversalContext)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ severity: 'critical', policyId: 'AS-POL-004' })
  })
})

describe('AS-POL-001 unapproved external transfer', () => {
  it('flags sales-research-vulnerable', () => {
    const findings = evaluateUnapprovedExternalTransfer(
      scenarioSnapshot('sales-research-vulnerable'),
      trustedMockGraphTraversalContext,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('critical')
    expect(findings[0]?.riskScore).toBe(91)
    expect(findings[0]?.policyId).toBe('AS-POL-001')
    expect(findings[0]?.affectedAgentId).toBe('foundry-agent-sales-research-vulnerable')
    expect(findings[0]?.evidenceTypes).toEqual(['declared_configuration'])
    expect(findings[0]?.validationStatus).toBe('theoretical')
    expect(findings[0]?.sourceMode).toBe('foundry')
  })

  it('materializes the evidence-type union linked at evaluation time', () => {
    const snapshot = scenarioSnapshot('sales-research-vulnerable')
    snapshot.evidence.push({
      id: 'runtime-evidence',
      source: 'Azure Monitor OpenTelemetry',
      sourceObjectId: 'window-1',
      observedAt: snapshot.generatedAt,
      freshness: 'live',
      confidence: 1,
      evidenceTypes: ['observed_runtime'],
      summary: 'Measured runtime invocation evidence.',
    })
    snapshot.nodes.forEach((node) => node.evidenceIds.push('runtime-evidence'))
    snapshot.edges.forEach((edge) => edge.evidenceIds.push('runtime-evidence'))

    expect(
      evaluateUnapprovedExternalTransfer(snapshot, trustedMockGraphTraversalContext)[0]
        ?.evidenceTypes,
    ).toEqual(['declared_configuration', 'observed_runtime'])
  })

  it('flags external-transfer-unsafe', () => {
    const findings = evaluateUnapprovedExternalTransfer(
      scenarioSnapshot('external-transfer-unsafe'),
      trustedMockGraphTraversalContext,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.policyId).toBe('AS-POL-001')
  })

  it('does not treat missing approval metadata as an approval gate', () => {
    const snapshot = scenarioSnapshot('sales-research-vulnerable')
    const agent = snapshot.nodes.find((node) => node.kind === 'agent')
    if (!agent) throw new Error('Expected an agent node.')
    delete agent.metadata['approvalRequired']

    expect(
      evaluateUnapprovedExternalTransfer(snapshot, trustedMockGraphTraversalContext),
    ).toHaveLength(1)
  })

  it('does not flag procurement-gated (approval required)', () => {
    const snapshot = scenarioSnapshot('procurement-gated')
    expect(
      evaluateUnapprovedExternalTransfer(snapshot, trustedMockGraphTraversalContext),
    ).toHaveLength(0)
    expect(evaluateUnapprovedMutation(snapshot, trustedMockGraphTraversalContext)).toHaveLength(0)
  })

  it('does not flag customer-support-safe or incident-triage-readonly', () => {
    expect(
      evaluateAllExposurePolicies(
        scenarioSnapshot('customer-support-safe'),
        trustedMockGraphTraversalContext,
      ),
    ).toHaveLength(0)
    expect(
      evaluateAllExposurePolicies(
        scenarioSnapshot('incident-triage-readonly'),
        trustedMockGraphTraversalContext,
      ),
    ).toHaveLength(0)
  })
})

describe('AS-POL-002 overprivileged employee lookup', () => {
  it('flags hr-policy-overprivileged', () => {
    const findings = evaluateOverprivilegedEmployeeLookup(
      scenarioSnapshot('hr-policy-overprivileged'),
      trustedMockGraphTraversalContext,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]?.severity).toBe('high')
    expect(findings[0]?.riskScore).toBe(76)
    expect(findings[0]?.policyId).toBe('AS-POL-002')
  })
})

describe('AS-POL-003 unapproved mutation', () => {
  it('does not flag procurement-gated because approvalRequired=true', () => {
    expect(
      evaluateUnapprovedMutation(
        scenarioSnapshot('procurement-gated'),
        trustedMockGraphTraversalContext,
      ),
    ).toHaveLength(0)
  })
})

describe('evaluateAllExposurePolicies over the manifest', () => {
  it('returns expected total per agent', () => {
    const findings = evaluateAllExposurePolicies(fullSnapshot(), trustedMockGraphTraversalContext)
    const byPolicy = findings.reduce<Record<string, number>>((acc, finding) => {
      acc[finding.policyId] = (acc[finding.policyId] ?? 0) + 1
      return acc
    }, {})
    expect(byPolicy['AS-POL-001']).toBe(2)
    expect(byPolicy['AS-POL-002']).toBe(1)
    expect(byPolicy['AS-POL-003'] ?? 0).toBe(0)
    const criticals = findings.filter((f) => f.severity === 'critical')
    expect(criticals.length).toBeGreaterThanOrEqual(2)
  })

  it('reuses one live authority validation across every policy finding', () => {
    const snapshot = fullSnapshot()
    let authorityReads = 0
    for (const item of snapshot.evidence) {
      const authority = item.authority
      Object.defineProperty(item, 'authority', {
        configurable: true,
        enumerable: true,
        get() {
          authorityReads += 1
          return authority
        },
      })
    }
    const context = createLiveGraphTraversalContextForSnapshot(snapshot, {
      estate: {
        id: 'policy-estate',
        tenantId: snapshot.tenantId,
        environment: snapshot.environment,
      },
      clock: () => new Date(Date.parse(snapshot.generatedAt) + 60_000),
    })
    authorityReads = 0

    expect(evaluateAllExposurePolicies(snapshot, context).length).toBeGreaterThan(0)
    expect(authorityReads).toBe(0)
  })
})
