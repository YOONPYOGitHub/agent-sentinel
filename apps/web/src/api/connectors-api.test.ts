import { afterEach, describe, expect, it, vi } from 'vitest'

import { connectorsApi } from './connectors-api'

afterEach(() => {
  vi.unstubAllGlobals()
})

const validResponse = {
  active: {
    id: 'mock-agent-estate',
    mode: 'mock',
    source: 'mock',
    lifecycleState: 'connected',
    writeEnabled: true,
  },
  catalog: [
    {
      id: 'azure-ai-foundry',
      name: 'Azure AI Foundry',
      description: 'Discovers agents.',
      lifecycleState: 'available-to-configure',
      capabilities: ['discovery'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
    },
    {
      id: 'm365-agent-registry',
      name: 'Microsoft Agent 365',
      description: 'Authoritative registry.',
      lifecycleState: 'authorization-required',
      capabilities: ['discovery', 'identity'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
    },
  ],
}

describe('connectorsApi', () => {
  it('parses a valid collection response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(validResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const result = await connectorsApi.listConnectors()
    expect(result.active.mode).toBe('mock')
    expect(result.catalog).toHaveLength(2)
    expect(result.catalog[0]?.id).toBe('azure-ai-foundry')
  })

  it('preserves per-source health and degraded lifecycle state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...validResponse,
            active: { ...validResponse.active, lifecycleState: 'degraded' },
            health: {
              overall: 'degraded',
              partial: true,
              sources: [
                {
                  id: 'project-a',
                  name: 'Project A',
                  role: 'discovery',
                  enabled: true,
                  configured: true,
                  readiness: 'ready',
                },
                {
                  id: 'project-b',
                  name: 'Project B',
                  role: 'discovery',
                  enabled: true,
                  configured: true,
                  readiness: 'unavailable',
                  reason: 'authentication-or-access',
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    const result = await connectorsApi.listConnectors()
    expect(result.active.lifecycleState).toBe('degraded')
    expect(result.health?.sources).toHaveLength(2)
  })

  it('rejects an invalid lifecycle state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...validResponse,
            catalog: [{ ...validResponse.catalog[0], lifecycleState: 'not-a-real-state' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    await expect(connectorsApi.listConnectors()).rejects.toThrow()
  })

  it('surfaces the API error message on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Service unavailable.' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    await expect(connectorsApi.listConnectors()).rejects.toThrow('Service unavailable.')
  })

  it('defaults writeEnabled to false when omitted', async () => {
    const withoutWrite = {
      ...validResponse,
      active: { ...validResponse.active, writeEnabled: undefined },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(withoutWrite), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const result = await connectorsApi.listConnectors()
    expect(result.active.writeEnabled).toBe(false)
  })
})
