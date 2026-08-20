import { describe, expect, it } from 'vitest'
import { computeManifestHash, foundryManifest, foundryManifestSchema } from '../src/index.js'

describe('Foundry manifest', () => {
  it('validates all six agents', () => {
    expect(foundryManifestSchema.parse(foundryManifest).agents).toHaveLength(6)
    expect(foundryManifest.agents.map(({ name }) => name)).toEqual([
      'sales-research-vulnerable',
      'procurement-gated',
      'customer-support-safe',
      'hr-policy-overprivileged',
      'incident-triage-readonly',
      'external-transfer-unsafe',
    ])
  })
  it('computes stable hashes', () => {
    for (const agent of foundryManifest.agents) {
      expect(agent.manifestHash).toMatch(/^[a-f0-9]{64}$/)
      expect(computeManifestHash(agent)).toBe(agent.manifestHash)
    }
  })
  it('changes hashes when the model deployment changes', () => {
    const agent = foundryManifest.agents[0]!
    expect(
      computeManifestHash({
        ...agent,
        modelDeployment: `${agent.modelDeployment}-different`,
      }),
    ).not.toBe(agent.manifestHash)
  })
  it('preserves expected risk and trust', () => {
    expect(
      Object.fromEntries(
        foundryManifest.agents.map((a) => [a.name, [a.expectedRisk, a.expectedTrust]]),
      ),
    ).toEqual({
      'sales-research-vulnerable': ['high', 'untrusted'],
      'procurement-gated': ['medium', 'conditional'],
      'customer-support-safe': ['low', 'trusted'],
      'hr-policy-overprivileged': ['medium-high', 'conditional'],
      'incident-triage-readonly': ['low', 'trusted'],
      'external-transfer-unsafe': ['high', 'untrusted'],
    })
  })
})
