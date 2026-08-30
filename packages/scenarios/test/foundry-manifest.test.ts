import { describe, expect, it } from 'vitest'

import { computeManifestHash, foundryManifest, type AgentDefinition } from '../src/index.js'

function withoutHash(agent: AgentDefinition): Omit<AgentDefinition, 'manifestHash'> {
  const definition = structuredClone(agent)
  delete definition.manifestHash
  return definition
}

describe('Foundry scenario manifest hash', () => {
  it('changes for every field written to the provider payload or managed metadata', () => {
    const agent = foundryManifest.agents[0]!
    const base = withoutHash(agent)
    const original = computeManifestHash(base)
    const variants: Array<Omit<AgentDefinition, 'manifestHash'>> = [
      { ...base, name: `${base.name}-changed` },
      { ...base, version: `${base.version}-changed` },
      { ...base, description: `${base.description} Changed.` },
      { ...base, modelDeployment: `${base.modelDeployment}-changed` },
      { ...base, instructions: `${base.instructions} Changed.` },
      {
        ...base,
        functions: base.functions.map((fn, index) =>
          index === 0 ? { ...fn, description: `${fn.description} Changed.` } : fn,
        ),
      },
      { ...base, owner: `${base.owner} Changed` },
      { ...base, environment: `${base.environment}-changed` },
      { ...base, lifecycle: 'deprecated' },
      { ...base, approvalRequired: !base.approvalRequired },
      { ...base, expectedRisk: base.expectedRisk === 'low' ? 'high' : 'low' },
      { ...base, expectedTrust: base.expectedTrust === 'trusted' ? 'untrusted' : 'trusted' },
    ]

    for (const variant of variants) {
      expect(computeManifestHash(variant)).not.toBe(original)
    }
  })

  it('ignores presentation-only fields not written to Foundry', () => {
    const agent = foundryManifest.agents[0]!
    const presentationVariant = {
      ...withoutHash(agent),
      displayName: `${agent.displayName} Changed`,
      platform: agent.platform,
    }
    expect(computeManifestHash(presentationVariant)).toBe(agent.manifestHash)
  })
})
