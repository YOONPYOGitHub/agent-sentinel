import { describe, expect, it } from 'vitest'

import { businessOutcomeEvidenceBundleSchema } from '@agent-sentinel/domain'

import { MockBusinessOutcomeConnector } from '../src/index.js'

describe('MockBusinessOutcomeConnector', () => {
  it('returns only explicitly synthetic source-cited outcomes', async () => {
    const bundle = businessOutcomeEvidenceBundleSchema.parse(
      await new MockBusinessOutcomeConnector().readBusinessOutcomes({
        tenantId: 'tenant-demo',
        agentId: 'hr-policy-agent',
        environment: 'production',
        acceptedCorrelations: [{ kind: 'agent-version', value: '12' }],
      }),
    )

    expect(bundle.observations).toHaveLength(1)
    expect(bundle.observations[0]).toMatchObject({
      outcomeName: 'Resolved policy inquiries',
      value: 18,
      unit: 'count',
      synthetic: true,
      evidenceId: 'mock-business-outcome-evidence-hr-policy-agent',
    })
    expect(bundle.evidence[0]?.evidenceTypes).toEqual(['synthetic_validation'])
  })

  it('returns an empty bundle instead of inventing an unknown agent outcome', async () => {
    await expect(
      new MockBusinessOutcomeConnector().readBusinessOutcomes({
        tenantId: 'tenant-demo',
        agentId: 'unknown-agent',
        environment: 'demo',
        acceptedCorrelations: [],
      }),
    ).resolves.toMatchObject({ observations: [], evidence: [] })
  })
})
