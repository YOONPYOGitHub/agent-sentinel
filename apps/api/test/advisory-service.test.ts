import { describe, expect, it, vi } from 'vitest'

import type { AdvisoryContext, AdvisoryProvider } from '../src/advisory-service.js'
import {
  AdvisoryGroundingError,
  AdvisoryService,
  MockAdvisoryProvider,
  buildAdvisoryInput,
  createAdvisoryService,
} from '../src/advisory-service.js'

const context: AdvisoryContext = {
  finding: {
    id: 'finding-1',
    policyId: 'AS-POL-001',
    policyName: 'Unapproved external transfer',
    severity: 'critical',
    status: 'open',
    riskScore: 91,
    title: 'External transfer for owner@example.com',
    summary: 'api_key=secret-value is present in raw source data.',
    recommendation: 'Require approval.',
    affectedAgentId: 'agent-1',
    affectedAgentName: 'Sales agent',
    declaredTools: ['external_send'],
    affectedNodeIds: ['agent-1', 'tool-1'],
    affectedEdgeIds: ['edge-1'],
    evidenceIds: ['evidence-1'],
    evidenceTypes: ['declared_configuration'],
    blastRadiusCount: 1,
    blastRadiusNodeIds: ['tool-1'],
    firstSeen: '2026-08-20T00:00:00.000Z',
    lastSeen: '2026-08-20T00:00:00.000Z',
    sourceMode: 'mock',
    validationStatus: 'theoretical',
    tenantId: 'tenant-demo',
    snapshotId: 'snapshot-1',
  },
  snapshot: {
    tenantId: 'tenant-demo',
    environment: 'validation',
    generatedAt: '2026-08-20T00:00:00.000Z',
    nodes: [
      {
        id: 'agent-1',
        kind: 'agent',
        name: 'Sales agent',
        description: 'Synthetic agent',
        environment: 'validation',
        evidenceIds: ['evidence-1'],
        metadata: {},
      },
      {
        id: 'tool-1',
        kind: 'tool',
        name: 'external_send',
        description: 'Synthetic external tool',
        environment: 'validation',
        evidenceIds: ['evidence-1'],
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'edge-1',
        from: 'agent-1',
        to: 'tool-1',
        relationship: 'CAN_CALL',
        evidenceIds: ['evidence-1'],
        active: true,
        removable: false,
      },
    ],
    evidence: [
      {
        id: 'evidence-1',
        source: 'Synthetic connector',
        sourceObjectId: 'agent-1',
        observedAt: '2026-08-20T00:00:00.000Z',
        freshness: 'live',
        confidence: 1,
        evidenceTypes: ['synthetic_validation'],
        summary: 'Contact owner@example.com with token=secret-value.',
      },
    ],
  },
}

describe('advisory service', () => {
  it('redacts likely secrets and email addresses before provider use', () => {
    const input = buildAdvisoryInput({
      ...context,
      snapshot: {
        ...context.snapshot,
        evidence: [
          {
            ...context.snapshot.evidence[0]!,
            summary:
              'Contact owner@example.com. Authorization: Bearer eyJabc.def.ghi; Authorization: Basic dXNlcjpwYXNz; AccountKey=account-secret; https://user:password@example.test/path\n-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----',
          },
        ],
      },
    })
    expect(JSON.stringify(input)).not.toContain('owner@example.com')
    expect(JSON.stringify(input)).not.toContain('account-secret')
    expect(JSON.stringify(input)).not.toContain('user:password')
    expect(JSON.stringify(input)).not.toContain('eyJabc.def.ghi')
    expect(JSON.stringify(input)).not.toContain('dXNlcjpwYXNz')
    expect(JSON.stringify(input)).not.toContain('private-key-material')
    expect(JSON.stringify(input)).toContain('[REDACTED_EMAIL]')
    expect(JSON.stringify(input)).toContain('[REDACTED_SECRET]')
    expect(JSON.stringify(input)).not.toContain('evidence-1')
    expect(JSON.stringify(input)).not.toContain('agent-1')
    expect(JSON.stringify(input)).toContain('"id":"EV1"')
  })

  it('generates a schema-valid advisory narrative in mock mode', async () => {
    const narrative = await new AdvisoryService(new MockAdvisoryProvider()).generate(context)
    expect(narrative).toMatchObject({
      findingId: 'finding-1',
      model: 'deterministic-advisory-mock',
      advisoryOnly: true,
    })
    expect(narrative.citations).toEqual([expect.objectContaining({ evidenceId: 'evidence-1' })])
  })

  it('rejects citations outside the supplied evidence graph', async () => {
    const provider: AdvisoryProvider = {
      model: 'invalid-provider',
      generate: () =>
        Promise.resolve({
          summary: 'summary',
          attackPathExplanation: 'path',
          impactExplanation: 'impact',
          recommendationExplanation: 'recommendation',
          sectionCitations: {
            summary: ['fabricated-evidence'],
            attackPathExplanation: ['fabricated-evidence'],
            impactExplanation: ['fabricated-evidence'],
            recommendationExplanation: ['fabricated-evidence'],
            uncertainty: ['fabricated-evidence'],
          },
          uncertainty: ['unknown'],
          citations: [{ evidenceId: 'fabricated-evidence', claim: 'fabricated claim' }],
        }),
    }
    await expect(new AdvisoryService(provider).generate(context)).rejects.toThrow(
      AdvisoryGroundingError,
    )
  })

  it('rejects citations to snapshot evidence withheld from the model input', async () => {
    const provider: AdvisoryProvider = {
      model: 'withheld-provider',
      generate: () =>
        Promise.resolve({
          summary: 'summary',
          attackPathExplanation: 'path',
          impactExplanation: 'impact',
          recommendationExplanation: 'recommendation',
          sectionCitations: {
            summary: ['withheld-evidence'],
            attackPathExplanation: ['withheld-evidence'],
            impactExplanation: ['withheld-evidence'],
            recommendationExplanation: ['withheld-evidence'],
            uncertainty: ['withheld-evidence'],
          },
          uncertainty: ['unknown'],
          citations: [{ evidenceId: 'withheld-evidence', claim: 'unsupported claim' }],
        }),
    }
    const withheldContext: AdvisoryContext = {
      ...context,
      snapshot: {
        ...context.snapshot,
        evidence: [
          ...context.snapshot.evidence,
          {
            id: 'withheld-evidence',
            source: 'Unrelated connector',
            sourceObjectId: 'unrelated-object',
            observedAt: '2026-08-20T00:00:00.000Z',
            freshness: 'recent',
            confidence: 1,
            evidenceTypes: ['unknown'],
            summary: 'Unrelated evidence.',
          },
        ],
      },
    }
    await expect(new AdvisoryService(provider).generate(withheldContext)).rejects.toThrow(
      AdvisoryGroundingError,
    )
  })

  it('caches a narrative by tenant, snapshot, finding, and model', async () => {
    const generate = vi.fn<AdvisoryProvider['generate']>().mockResolvedValue({
      summary: 'summary',
      attackPathExplanation: 'path',
      impactExplanation: 'impact',
      recommendationExplanation: 'recommendation',
      sectionCitations: {
        summary: ['EV1'],
        attackPathExplanation: ['EV1'],
        impactExplanation: ['EV1'],
        recommendationExplanation: ['EV1'],
        uncertainty: ['EV1'],
      },
      uncertainty: ['unknown'],
      citations: [{ evidenceId: 'EV1', claim: 'grounded claim' }],
    })
    const service = new AdvisoryService({ model: 'cached-provider', generate })
    await service.generate(context)
    await service.generate(context)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('expires cached narratives and regenerates them', async () => {
    const generate = vi.fn<AdvisoryProvider['generate']>().mockResolvedValue({
      summary: 'summary',
      attackPathExplanation: 'path',
      impactExplanation: 'impact',
      recommendationExplanation: 'recommendation',
      sectionCitations: {
        summary: ['EV1'],
        attackPathExplanation: ['EV1'],
        impactExplanation: ['EV1'],
        recommendationExplanation: ['EV1'],
        uncertainty: ['EV1'],
      },
      uncertainty: ['unknown'],
      citations: [{ evidenceId: 'EV1', claim: 'grounded claim' }],
    })
    const service = new AdvisoryService(
      { model: 'expiring-provider', generate },
      { maxEntries: 1, ttlMs: 0 },
    )
    await service.generate(context)
    await service.generate(context)
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent requests for the same tenant snapshot and finding', async () => {
    let resolveProvider: ((value: unknown) => void) | undefined
    const generate = vi.fn<AdvisoryProvider['generate']>().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProvider = resolve
        }),
    )
    const service = new AdvisoryService({ model: 'coalesced-provider', generate })
    const first = service.generate(context)
    const second = service.generate(context)
    expect(generate).toHaveBeenCalledTimes(1)
    resolveProvider?.({
      summary: 'summary',
      attackPathExplanation: 'path',
      impactExplanation: 'impact',
      recommendationExplanation: 'recommendation',
      sectionCitations: {
        summary: ['EV1'],
        attackPathExplanation: ['EV1'],
        impactExplanation: ['EV1'],
        recommendationExplanation: ['EV1'],
        uncertainty: ['EV1'],
      },
      uncertainty: ['unknown'],
      citations: [{ evidenceId: 'EV1', claim: 'grounded claim' }],
    })
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('maps evidence aliases in model prose back to real evidence ids', async () => {
    const provider: AdvisoryProvider = {
      model: 'alias-provider',
      generate: () =>
        Promise.resolve({
          summary: 'Summary grounded in N1.',
          attackPathExplanation: 'Path grounded in R1.',
          impactExplanation: 'Impact grounded in EV1.',
          recommendationExplanation: 'Recommendation grounded in EV1.',
          sectionCitations: {
            summary: ['N1'],
            attackPathExplanation: ['R1'],
            impactExplanation: ['EV1'],
            recommendationExplanation: ['EV1'],
            uncertainty: ['EV1'],
          },
          uncertainty: ['Runtime behavior remains uncertain under EV1.'],
          citations: [{ evidenceId: 'R1', claim: 'R1 supports this claim.' }],
        }),
    }

    const narrative = await new AdvisoryService(provider).generate(context)

    expect(narrative.summary).toContain('evidence-1')
    expect(narrative.summary).not.toContain('N1')
    expect(narrative.citations[0]?.claim).toContain('evidence-1')
  })

  it('requires Azure advisory configuration when azure mode is selected', () => {
    expect(() => createAdvisoryService({ AGENT_SENTINEL_ADVISORY_MODE: 'azure' })).toThrow(
      'AGENT_SENTINEL_ADVISORY_ENDPOINT',
    )
  })
})
