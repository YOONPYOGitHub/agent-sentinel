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
  it('preserves an exact source-set fingerprint on reports and persisted measurements', () => {
    const sourceSetFingerprint = 'a'.repeat(64)
    const input = measurement()
    Object.assign(input, { sourceSetFingerprint })
    Object.assign(input.health, { sourceSetFingerprint })

    const parsed = connectorHealthMeasurementSchema.parse(input)

    expect(parsed.sourceSetFingerprint).toBe(sourceSetFingerprint)
    expect(parsed.health.sourceSetFingerprint).toBe(sourceSetFingerprint)
  })

  it('preserves an optional exact persisted snapshot binding', () => {
    const input = measurement()
    Object.assign(input, {
      snapshotBinding: {
        snapshotGeneratedAt: '2026-09-04T12:59:00.000Z',
        evidenceDigest: 'b'.repeat(64),
      },
    })

    expect(connectorHealthMeasurementSchema.parse(input).snapshotBinding).toEqual({
      snapshotGeneratedAt: '2026-09-04T12:59:00.000Z',
      evidenceDigest: 'b'.repeat(64),
    })
  })

  it('rejects malformed persisted snapshot bindings', () => {
    const input = measurement()
    Object.assign(input, {
      snapshotBinding: {
        snapshotGeneratedAt: 'not-a-date',
        evidenceDigest: 'not-a-digest',
      },
    })

    expect(connectorHealthMeasurementSchema.safeParse(input).success).toBe(false)
  })

  it('preserves typed data state and exact source provenance', () => {
    const input = measurement()
    Object.assign(input.health.sources[0], {
      dataState: 'partial',
      provenance: {
        estateTenantId: 'tenant-a',
        estateEnvironment: 'validation',
        sourceConnectorId: 'primary',
        sourceTenantId: 'tenant-a',
        sourceEnvironment: 'validation',
        provider: 'microsoft-entra',
        providerObjectId: 'service-principal-inventory',
      },
    })

    expect(connectorHealthMeasurementSchema.parse(input).health.sources[0]).toMatchObject({
      dataState: 'partial',
      provenance: {
        estateTenantId: 'tenant-a',
        estateEnvironment: 'validation',
        sourceConnectorId: 'primary',
        sourceTenantId: 'tenant-a',
        sourceEnvironment: 'validation',
        provider: 'microsoft-entra',
        providerObjectId: 'service-principal-inventory',
      },
    })
  })

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
