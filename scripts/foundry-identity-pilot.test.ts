import { foundryManifest } from '@agent-sentinel/scenarios'
import type { FoundryAgent } from '@agent-sentinel/foundry-connector'
import { describe, expect, it, vi } from 'vitest'

import { AGENT_SENTINEL_MANAGED_MARKER } from './foundry-http.js'
import {
  FOUNDRY_IDENTITY_PILOT_CREATE_CONFIRMATION,
  FOUNDRY_IDENTITY_PILOT_MARKER,
  FOUNDRY_IDENTITY_PILOT_NAME,
  buildFoundryIdentityPilotPayload,
  buildFoundryIdentityPilotPlan,
  cleanupFoundryIdentityPilot,
  createFoundryIdentityPilot,
  pilotCleanupConfirmation,
  runFoundryIdentityPilotCli,
} from './foundry-identity-pilot.js'

function legacyAgents(): FoundryAgent[] {
  return foundryManifest.agents.map((agent, index) => ({
    id: `legacy-${index + 1}`,
    name: agent.name,
    version: agent.version,
    description: `${agent.description} ${AGENT_SENTINEL_MANAGED_MARKER}`,
    metadata: { manifestHash: agent.manifestHash! },
    instance_identity: null,
    blueprint: null,
    blueprint_reference: null,
  }))
}

function pilotAgent() {
  return {
    id: 'pilot-immutable-id',
    name: FOUNDRY_IDENTITY_PILOT_NAME,
    version: '1',
    description: `${AGENT_SENTINEL_MANAGED_MARKER} ${FOUNDRY_IDENTITY_PILOT_MARKER}`,
    metadata: {
      pilot: 'foundry-instance-identity',
      pilotVersion: '1',
    },
    instance_identity: {
      principal_id: '11111111-1111-4111-8111-111111111111',
      client_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'active' as const,
    },
    blueprint: {
      principal_id: '22222222-2222-4222-8222-222222222222',
      client_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      status: 'active' as const,
    },
    blueprint_reference: {
      type: 'ManagedAgentIdentityBlueprint' as const,
      blueprint_id: 'pilot-blueprint-id',
    },
  }
}

describe('Foundry identity pilot plan', () => {
  it('uses one fixed low-risk clone and lets stable v1 provision identity objects', () => {
    const plan = buildFoundryIdentityPilotPlan()
    const payload = buildFoundryIdentityPilotPayload()

    expect(plan.api.version).toBe('v1')
    expect(plan.source.name).toBe('customer-support-safe')
    expect(plan.api.create.path).toBe(
      `/agents/${FOUNDRY_IDENTITY_PILOT_NAME}/versions?api-version=v1`,
    )
    expect(payload).toMatchObject({
      definition: {
        kind: 'prompt',
        tools: [{ type: 'function', name: 'knowledge_search' }],
      },
      metadata: {
        syntheticOnly: 'true',
        externalTransfer: 'false',
        writeAccess: 'false',
      },
    })
    expect(payload).not.toHaveProperty('blueprint_reference')
    expect(payload).not.toHaveProperty('instance_identity')
    expect(JSON.stringify(payload)).not.toContain('principal_id')
    expect(JSON.stringify(payload)).not.toContain('client_id')
  })

  it('prints a plan without constructing a live client', async () => {
    const messages: string[] = []
    const log = (message: string) => {
      messages.push(message)
    }
    const clientFactory = vi.fn()

    await expect(runFoundryIdentityPilotCli(['plan'], { log, clientFactory })).resolves.toBe(0)
    expect(clientFactory).not.toHaveBeenCalled()
    const output = messages[0]
    expect(output).toContain('"mode": "plan-only"')
  })
})

describe('Foundry identity pilot create', () => {
  it('creates only the fixed pilot and verifies non-null identities without changing legacy agents', async () => {
    const legacy = legacyAgents()
    const pilot = pilotAgent()
    const client = {
      listAgents: vi
        .fn()
        .mockResolvedValueOnce(legacy)
        .mockResolvedValueOnce([...legacy, pilot]),
      getAgent: vi.fn().mockResolvedValue(pilot),
      createAgent: vi.fn().mockResolvedValue({ version: '1' }),
      deleteAgent: vi.fn(),
    }

    const evidence = await createFoundryIdentityPilot(
      client,
      FOUNDRY_IDENTITY_PILOT_CREATE_CONFIRMATION,
      vi.fn(),
    )
    expect(evidence).toMatchObject({
      action: 'created',
      agent: {
        id: pilot.id,
        principalId: pilot.instance_identity.principal_id,
        blueprintId: pilot.blueprint_reference.blueprint_id,
      },
    })
    expect(evidence.legacyAgents.some((agent) => agent.id === 'legacy-1')).toBe(true)
    expect(client.createAgent).toHaveBeenCalledOnce()
    expect(client.createAgent).toHaveBeenCalledWith(
      FOUNDRY_IDENTITY_PILOT_NAME,
      buildFoundryIdentityPilotPayload(),
    )
    expect(client.deleteAgent).not.toHaveBeenCalled()
  })

  it('fails before mutation when confirmation or the six-agent legacy baseline is wrong', async () => {
    const client = {
      listAgents: vi.fn().mockResolvedValue(legacyAgents().slice(0, 5)),
      getAgent: vi.fn(),
      createAgent: vi.fn(),
      deleteAgent: vi.fn(),
    }

    await expect(createFoundryIdentityPilot(client, 'wrong')).rejects.toThrow('Create requires')
    expect(client.listAgents).not.toHaveBeenCalled()
    await expect(
      createFoundryIdentityPilot(client, FOUNDRY_IDENTITY_PILOT_CREATE_CONFIRMATION),
    ).rejects.toThrow('Expected exactly 6 legacy agents')
    expect(client.createAgent).not.toHaveBeenCalled()
  })

  it('rejects any legacy agent that already has runtime identity', async () => {
    const legacy = legacyAgents()
    legacy[0] = {
      ...legacy[0]!,
      instance_identity: pilotAgent().instance_identity,
    }
    const client = {
      listAgents: vi.fn().mockResolvedValue(legacy),
      getAgent: vi.fn(),
      createAgent: vi.fn(),
      deleteAgent: vi.fn(),
    }

    await expect(
      createFoundryIdentityPilot(client, FOUNDRY_IDENTITY_PILOT_CREATE_CONFIRMATION),
    ).rejects.toThrow('already has an instance identity')
    expect(client.createAgent).not.toHaveBeenCalled()
  })
})

describe('Foundry identity pilot cleanup', () => {
  it('deletes only the exact pilot immutable ID and verifies the six legacy agents are unchanged', async () => {
    const legacy = legacyAgents()
    const pilot = pilotAgent()
    const client = {
      listAgents: vi
        .fn()
        .mockResolvedValueOnce([...legacy, pilot])
        .mockResolvedValueOnce(legacy),
      getAgent: vi.fn().mockResolvedValue(undefined),
      createAgent: vi.fn(),
      deleteAgent: vi.fn().mockResolvedValue(undefined),
    }

    await expect(
      cleanupFoundryIdentityPilot(client, pilot.id, pilotCleanupConfirmation(pilot.id), vi.fn()),
    ).resolves.toMatchObject({ action: 'deleted', agent: { id: pilot.id } })
    expect(client.deleteAgent).toHaveBeenCalledOnce()
    expect(client.deleteAgent).toHaveBeenCalledWith(FOUNDRY_IDENTITY_PILOT_NAME)
  })

  it('refuses a mismatched ID, confirmation, or ownership marker before deletion', async () => {
    const pilot = pilotAgent()
    const client = {
      listAgents: vi.fn().mockResolvedValue([...legacyAgents(), pilot]),
      getAgent: vi.fn(),
      createAgent: vi.fn(),
      deleteAgent: vi.fn(),
    }

    await expect(cleanupFoundryIdentityPilot(client, pilot.id, 'wrong')).rejects.toThrow(
      'Cleanup requires',
    )
    await expect(
      cleanupFoundryIdentityPilot(client, 'different-id', pilotCleanupConfirmation('different-id')),
    ).rejects.toThrow('does not identify')
    const unowned = {
      ...pilot,
      description: 'Unowned same-name resource.',
    }
    client.listAgents.mockResolvedValue([...legacyAgents(), unowned])
    await expect(
      cleanupFoundryIdentityPilot(client, pilot.id, pilotCleanupConfirmation(pilot.id)),
    ).rejects.toThrow('ownership markers')
    expect(client.deleteAgent).not.toHaveBeenCalled()
  })
})
