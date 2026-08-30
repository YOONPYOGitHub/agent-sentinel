import { describe, expect, it } from 'vitest'

import { estateSnapshotSchema, evidenceSchema } from '../src/index.js'

describe('estateSnapshotSchema', () => {
  it('preserves legacy evidence without misclassifying its provenance', () => {
    expect(
      evidenceSchema.parse({
        id: 'legacy-evidence',
        source: 'Legacy connector',
        sourceObjectId: 'object-1',
        observedAt: '2026-08-14T12:00:00.000Z',
        freshness: 'recent',
        confidence: 0.8,
        summary: 'Legacy evidence without an explicit evidence type.',
      }).evidenceTypes,
    ).toEqual(['unknown'])
  })

  it('rejects duplicate evidence types', () => {
    const result = evidenceSchema.safeParse({
      id: 'runtime-evidence',
      source: 'Azure Monitor OpenTelemetry',
      sourceObjectId: 'window-1',
      observedAt: '2026-08-14T12:00:00.000Z',
      freshness: 'live',
      confidence: 1,
      evidenceTypes: ['observed_runtime', 'observed_runtime'],
      summary: 'Measured runtime observations.',
    })

    expect(result.success).toBe(false)
  })

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
