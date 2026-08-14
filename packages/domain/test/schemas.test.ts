import { describe, expect, it } from 'vitest'

import { estateSnapshotSchema } from '../src/index.js'

describe('estateSnapshotSchema', () => {
  it('rejects relationships without evidence', () => {
    const result = estateSnapshotSchema.safeParse({
      tenantId: 'tenant-demo',
      environment: 'demo',
      generatedAt: '2026-08-14T12:00:00.000Z',
      nodes: [],
      edges: [
        {
          id: 'edge-1',
          from: 'a',
          to: 'b',
          relationship: 'CAN_CALL',
          evidenceIds: [],
          active: true,
          removable: true,
        },
      ],
      evidence: [],
    })

    expect(result.success).toBe(false)
  })

  it('rejects dangling evidence references', () => {
    const result = estateSnapshotSchema.safeParse({
      tenantId: 'tenant-demo',
      environment: 'demo',
      generatedAt: '2026-08-14T12:00:00.000Z',
      nodes: [
        {
          id: 'agent-1',
          kind: 'agent',
          name: 'Agent',
          description: 'Synthetic agent',
          environment: 'demo',
          evidenceIds: ['missing-evidence'],
          metadata: {},
        },
      ],
      edges: [],
      evidence: [],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('unknown evidence')
    }
  })
})
