import { describe, expect, it } from 'vitest'

import { connectorHealthMeasurementSchema } from '../src/index.js'

function measurement(overrides: Record<string, number> = {}) {
  return {
    estateId: 'estate-a',
    tenantId: 'tenant-a',
    environment: 'validation',
    connectorId: 'foundry',
    measuredAt: '2026-09-04T13:00:00.000Z',
    health: {
      overall: 'ready',
      partial: false,
      sources: [
        {
          id: 'entra:primary',
          name: 'Primary Entra source',
          role: 'enrichment',
          enabled: true,
          configured: true,
          readiness: 'ready',
          diagnostics: {
            kind: 'exact-identity-correlation',
            provider: 'microsoft-entra',
            sourceId: 'primary',
            sourceTenantId: 'tenant-a',
            sourceEnvironment: 'validation',
            authoritativeAgentsConsidered: 3,
            exactObjectIdMatches: 1,
            exactApplicationIdMatches: 0,
            exactAgentIdentityMatches: 1,
            unmatched: 1,
            ambiguous: 0,
            runsAsEdgesEmitted: 2,
            ownerCoverage: { status: 'disabled', evidenceReferences: [] },
            appRoleCoverage: { status: 'disabled', evidenceReferences: [] },
            previewCoverage: { status: 'disabled', evidenceReferences: [] },
            evidenceReferences: ['agent-evidence', 'identity-evidence'],
            ...overrides,
          },
        },
      ],
    },
  }
}

describe('connector health diagnostics schema', () => {
  it('accepts disjoint correlation categories and matching RUNS_AS counts', () => {
    expect(connectorHealthMeasurementSchema.safeParse(measurement()).success).toBe(true)
  })

  it('rejects categories that do not account for authoritative agents exactly once', () => {
    expect(connectorHealthMeasurementSchema.safeParse(measurement({ ambiguous: 1 })).success).toBe(
      false,
    )
  })

  it('rejects a RUNS_AS count that differs from the exact-match total', () => {
    expect(
      connectorHealthMeasurementSchema.safeParse(measurement({ runsAsEdgesEmitted: 1 })).success,
    ).toBe(false)
  })
})
