import { describe, expect, it, vi } from 'vitest'

import { cleanupAgents } from './cleanup-agents.js'
import { AGENT_SENTINEL_MANAGED_MARKER } from './foundry-http.js'

describe('agent cleanup', () => {
  it('makes no changes during dry-run and ignores unowned agents', async () => {
    const client = {
      listAgents: vi.fn().mockResolvedValue([
        {
          id: 'owned',
          name: 'sales-research-vulnerable',
          description: AGENT_SENTINEL_MANAGED_MARKER,
        },
        {
          id: 'unowned',
          name: 'sales-research-vulnerable',
          description: 'Manually created.',
        },
      ]),
      deleteAgent: vi.fn(),
    }

    await expect(cleanupAgents(client, true, vi.fn())).resolves.toBe(1)
    expect(client.deleteAgent).not.toHaveBeenCalled()
  })
})
