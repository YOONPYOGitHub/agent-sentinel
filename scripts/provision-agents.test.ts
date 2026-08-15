import { foundryManifest } from '@agent-sentinel/scenarios'
import { describe, expect, it, vi } from 'vitest'

import { AGENT_SENTINEL_MANAGED_MARKER } from './foundry-http.js'
import { provisionAgents } from './provision-agents.js'

const agent = foundryManifest.agents[0]
if (agent === undefined || agent.manifestHash === undefined) {
  throw new Error('Expected a hashed provisioning scenario.')
}

function client() {
  return {
    getAgent: vi.fn(),
    listAgents: vi.fn(),
    createAgent: vi.fn(),
  }
}

describe('agent provisioning', () => {
  it('creates a managed agent when no matching version exists', async () => {
    const foundry = client()
    foundry.listAgents.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'created-id',
        name: agent.name,
        description: `${AGENT_SENTINEL_MANAGED_MARKER} [hash:${agent.manifestHash}]`,
      },
    ])

    await expect(provisionAgents(foundry, [agent], vi.fn())).resolves.toEqual({
      created: 1,
      unchanged: 0,
      verified: 1,
    })
    expect(foundry.getAgent).not.toHaveBeenCalled()
    expect(foundry.createAgent).toHaveBeenCalledOnce()
    expect(foundry.createAgent.mock.calls[0]?.[0]).toBe(agent.name)
  })

  it('confirms an unchanged version by immutable ID and creates nothing', async () => {
    const existing = {
      id: 'immutable-agent-id',
      name: agent.name,
      description: `${AGENT_SENTINEL_MANAGED_MARKER} [hash:${agent.manifestHash}]`,
    }
    const foundry = client()
    foundry.listAgents.mockResolvedValue([existing])
    foundry.getAgent.mockResolvedValue(existing)

    await expect(provisionAgents(foundry, [agent], vi.fn())).resolves.toEqual({
      created: 0,
      unchanged: 1,
      verified: 1,
    })
    expect(foundry.getAgent).toHaveBeenCalledWith('immutable-agent-id')
    expect(foundry.createAgent).not.toHaveBeenCalled()
  })

  it('does not trust a same-name agent without the ownership marker', async () => {
    const foundry = client()
    foundry.listAgents.mockResolvedValueOnce([
      {
        id: 'unowned',
        name: agent.name,
        description: `[hash:${agent.manifestHash}]`,
      },
    ]).mockResolvedValueOnce([
      {
        id: 'owned',
        name: agent.name,
        description: `${AGENT_SENTINEL_MANAGED_MARKER} [hash:${agent.manifestHash}]`,
      },
    ])

    await provisionAgents(foundry, [agent], vi.fn())
    expect(foundry.getAgent).not.toHaveBeenCalled()
    expect(foundry.createAgent).toHaveBeenCalledOnce()
  })
})
