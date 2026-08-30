import { createAdvisoryService, type AdvisoryContext } from '../apps/api/src/advisory-service.js'

const endpoint =
  process.env['AGENT_SENTINEL_ADVISORY_ENDPOINT'] ??
  'https://ais-agent-sentinel-260814.openai.azure.com'
const model = process.env['AGENT_SENTINEL_ADVISORY_MODEL'] ?? 'gpt-5.6-terra'

const context: AdvisoryContext = {
  finding: {
    id: 'live-advisory-validation',
    policyId: 'AS-POL-001',
    policyName: 'Unapproved external transfer or send',
    severity: 'critical',
    status: 'open',
    riskScore: 91,
    title: 'Synthetic agent can transfer data externally without approval',
    summary:
      'A synthetic agent declares an external transfer capability without an approval gate.',
    recommendation: 'Require approval before the synthetic external transfer.',
    affectedAgentId: 'synthetic-agent',
    affectedAgentName: 'Synthetic Validation Agent',
    declaredTools: ['external_send'],
    affectedNodeIds: ['synthetic-agent', 'synthetic-tool'],
    affectedEdgeIds: ['synthetic-edge'],
    evidenceIds: ['synthetic-evidence'],
    evidenceTypes: ['declared_configuration'],
    blastRadiusCount: 1,
    blastRadiusNodeIds: ['synthetic-tool'],
    firstSeen: '2026-08-20T00:00:00.000Z',
    lastSeen: '2026-08-20T00:00:00.000Z',
    sourceMode: 'foundry',
    validationStatus: 'theoretical',
    tenantId: 'synthetic-validation-tenant',
    snapshotId: 'synthetic-validation-snapshot',
  },
  snapshot: {
    tenantId: 'synthetic-validation-tenant',
    environment: 'isolated-validation',
    generatedAt: '2026-08-20T00:00:00.000Z',
    nodes: [
      {
        id: 'synthetic-agent',
        kind: 'agent',
        name: 'Synthetic Validation Agent',
        description: 'Synthetic agent used only for advisory model validation.',
        environment: 'isolated-validation',
        trust: 'conditional',
        evidenceIds: ['synthetic-evidence'],
        metadata: {},
      },
      {
        id: 'synthetic-tool',
        kind: 'tool',
        name: 'external_send',
        description: 'Synthetic external transfer capability.',
        environment: 'isolated-validation',
        trust: 'untrusted',
        evidenceIds: ['synthetic-evidence'],
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'synthetic-edge',
        from: 'synthetic-agent',
        to: 'synthetic-tool',
        relationship: 'CAN_CALL',
        evidenceIds: ['synthetic-evidence'],
        active: true,
        removable: false,
      },
    ],
    evidence: [
      {
        id: 'synthetic-evidence',
        source: 'Agent Sentinel synthetic validation',
        sourceObjectId: 'synthetic-agent',
        observedAt: '2026-08-20T00:00:00.000Z',
        freshness: 'live',
        confidence: 1,
        evidenceTypes: ['synthetic_validation'],
        summary:
          'Synthetic declared-configuration evidence for an external transfer capability without approval.',
      },
    ],
  },
}

const service = createAdvisoryService({
  ...process.env,
  AGENT_SENTINEL_ADVISORY_MODE: 'azure',
  AGENT_SENTINEL_ADVISORY_ENDPOINT: endpoint,
  AGENT_SENTINEL_ADVISORY_MODEL: model,
})
const narrative = await service.generate(context)

console.log(
  JSON.stringify({
    model: narrative.model,
    advisoryOnly: narrative.advisoryOnly,
    findingId: narrative.findingId,
    citationCount: narrative.citations.length,
    citedEvidenceIds: [...new Set(narrative.citations.map((citation) => citation.evidenceId))],
    summary: narrative.summary,
  }),
)
