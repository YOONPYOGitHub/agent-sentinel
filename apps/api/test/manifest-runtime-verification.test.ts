import { describe, expect, it } from 'vitest'

import {
  computeManifestHash,
  manifestIngestionRecordSchema,
  type ManifestIngestionRecord,
} from '@agent-sentinel/connector-sdk'
import { estateSnapshotSchema, type EstateSnapshot } from '@agent-sentinel/domain'

import {
  reconcileManifestConfigurationEvidence,
  verifyManifestRuntimeClaims,
} from '../src/manifest-runtime-verification.js'

const binding = {
  sourceConnectorId: 'primary',
  sourceTenantId: 'source-tenant',
  sourceObjectId: 'provider-agent',
  sourceEnvironment: 'production',
}

function record(sourceBinding: typeof binding | null = binding): ManifestIngestionRecord {
  const subjectId = sourceBinding?.sourceObjectId ?? 'provider-agent'
  const envelope = {
    schemaVersion: '1.0' as const,
    manifestId: 'partner-manifest',
    tenantId: 'estate-tenant',
    environmentId: 'portfolio',
    producedAt: '2026-08-30T00:00:00.000Z',
    producer: { name: 'Partner registry' },
    capabilities: {
      supportsDiscovery: true,
      evidenceDepth: 'deep' as const,
      supportsRuntimeTelemetry: true,
      supportsActions: 'none' as const,
    },
    agents: [{ id: subjectId, displayName: 'Partner agent' }],
    tools: [],
    identities: [],
    dataSources: [],
    mcpDependencies: [],
    edges: [],
    evidence: [
      {
        id: 'runtime-claim',
        subjectId,
        evidenceType: 'runtime_observed' as const,
        confidence: 0.8,
        observedAt: '2026-08-30T00:00:00.000Z',
        ...(sourceBinding !== null ? { sourceBinding } : {}),
        claims: {},
      },
    ],
    metadata: {},
  }

  return manifestIngestionRecordSchema.parse({
    tenantId: envelope.tenantId,
    environmentId: envelope.environmentId,
    manifestId: envelope.manifestId,
    manifestHash: computeManifestHash(envelope),
    ingestedAt: '2026-08-30T00:01:00.000Z',
    ingestedBySubject: 'administrator',
    envelope,
    snapshot: {
      tenantId: envelope.tenantId,
      environment: envelope.environmentId,
      generatedAt: envelope.producedAt,
      nodes: [],
      edges: [],
      evidence: [],
    },
  })
}

function configurationRecord(sourceBinding: typeof binding | null = binding) {
  const value = record(sourceBinding)
  value.envelope.evidence[0]!.evidenceType = 'declared_configuration'
  return value
}

function snapshot(
  evidenceTypes: Array<'observed_runtime' | 'synthetic_validation'>,
): EstateSnapshot {
  return estateSnapshotSchema.parse({
    tenantId: 'estate-tenant',
    environment: 'portfolio',
    generatedAt: '2026-08-30T01:00:00.000Z',
    nodes: [
      {
        id: 'authoritative-agent',
        kind: 'agent',
        name: 'Authoritative agent',
        description: 'First-party discovery.',
        environment: 'production',
        evidenceIds: ['declared-evidence', ...evidenceTypes.map((type) => `${type}-evidence`)],
        metadata: binding,
      },
    ],
    edges: [],
    evidence: [
      {
        id: 'declared-evidence',
        source: 'Foundry',
        sourceObjectId: 'provider-agent',
        observedAt: '2026-08-30T00:00:00.000Z',
        freshness: 'live',
        confidence: 1,
        evidenceTypes: ['declared_configuration'],
        summary: 'Declared configuration.',
      },
      ...evidenceTypes.map((type) => ({
        id: `${type}-evidence`,
        source: 'Azure Monitor OpenTelemetry',
        sourceObjectId: `${type}-window`,
        observedAt: '2026-08-30T00:30:00.000Z',
        freshness: 'live' as const,
        confidence: 1,
        evidenceTypes: [type],
        summary: 'Measured telemetry.',
        metadata: { sourceConnector: 'azure-monitor-otel' },
      })),
    ],
  })
}

const queried = {
  configured: true,
  queriedAgentIds: new Set(['authoritative-agent']),
  failedAgentIds: new Set<string>(),
  projectionFailedAgentIds: new Set<string>(),
}

describe('manifest runtime verification', () => {
  it('verifies only exact bindings with non-synthetic runtime evidence', () => {
    const result = verifyManifestRuntimeClaims(
      snapshot(['observed_runtime']),
      [record()],
      queried,
      '2026-08-30T01:00:00.000Z',
    )
    expect(result.status).toBe('ready')
    expect(result.claims[0]).toMatchObject({
      status: 'verified',
      matchedNodeId: 'authoritative-agent',
      reason: 'non-synthetic-runtime-observation',
      corroboratingEvidenceIds: ['observed_runtime-evidence'],
    })

  })

  it('does not use synthetic canaries to verify a runtime claim', () => {
    const result = verifyManifestRuntimeClaims(
      snapshot(['synthetic_validation']),
      [record()],
      queried,
      '2026-08-30T01:00:00.000Z',
    )
    expect(result.claims[0]).toMatchObject({
      status: 'no-observation',
      reason: 'no-non-synthetic-runtime-observation',
    })

  })

  it('keeps missing and unmatched bindings explicitly non-correlatable', () => {
    const missing = verifyManifestRuntimeClaims(snapshot([]), [record(null)], queried)
    const unmatched = verifyManifestRuntimeClaims(
      snapshot([]),
      [record({ ...binding, sourceObjectId: 'other-agent' })],
      queried,
    )
    expect(missing.claims[0]?.reason).toBe('missing-source-binding')
    expect(unmatched.claims[0]?.reason).toBe('no-exact-source-match')
  })

  it('does not verify a manifest entity against a different authoritative node kind', () => {
    const estate = snapshot(['observed_runtime'])
    const claimRecord = record()
    claimRecord.envelope.agents = []
    claimRecord.envelope.tools = [{ id: 'provider-agent', displayName: 'Partner tool' }]

    const result = verifyManifestRuntimeClaims(estate, [claimRecord], queried)

    expect(result.claims[0]).toMatchObject({
      status: 'not-correlatable',
      reason: 'entity-kind-mismatch',
    })
  })

  describe('manifest configuration reconciliation', () => {
    it('matches one exact authoritative object without merging graph objects', () => {
      const estate = snapshot([])
      const result = reconcileManifestConfigurationEvidence(
        estate,
        [configurationRecord()],
        '2026-08-30T01:00:00.000Z',
      )

      expect(result.status).toBe('ready')
      expect(result.claims[0]).toMatchObject({
        status: 'matched-authoritative-object',
        matchedNodeId: 'authoritative-agent',
        authoritativeEvidenceIds: ['declared-evidence'],
        reason: 'exact-authoritative-object-match',
      })
      expect(estate.nodes).toHaveLength(1)
      expect(estate.edges).toHaveLength(0)
    })

    it('keeps unbound and mismatched declarations explicitly uncorrelated', () => {
      const missing = reconcileManifestConfigurationEvidence(snapshot([]), [
        configurationRecord(null),
      ])
      const mismatched = configurationRecord()
      mismatched.envelope.agents = [{ id: 'different-local-agent', displayName: 'Other agent' }]
      mismatched.envelope.evidence[0]!.subjectId = 'different-local-agent'

      expect(missing.claims[0]?.reason).toBe('missing-source-binding')
      expect(
        reconcileManifestConfigurationEvidence(snapshot([]), [mismatched]).claims[0],
      ).toMatchObject({
        status: 'not-correlatable',
        reason: 'subject-binding-mismatch',
      })
    })
  })

  it('rejects a source binding that names a different local manifest subject', () => {
    const claimRecord = record()
    claimRecord.envelope.agents = [{ id: 'different-local-agent', displayName: 'Other agent' }]
    claimRecord.envelope.evidence[0]!.subjectId = 'different-local-agent'

    const result = verifyManifestRuntimeClaims(
      snapshot(['observed_runtime']),
      [claimRecord],
      queried,
    )

    expect(result.claims[0]).toMatchObject({
      status: 'not-correlatable',
      reason: 'subject-binding-mismatch',
    })
  })

  it('reports telemetry query failure without treating absence as contradiction', () => {
    const result = verifyManifestRuntimeClaims(snapshot([]), [record()], {
      configured: true,
      queriedAgentIds: new Set<string>(),
      failedAgentIds: new Set(['authoritative-agent']),
      projectionFailedAgentIds: new Set<string>(),
    })
    expect(result.status).toBe('unavailable')
    expect(result.claims[0]).toMatchObject({
      status: 'unavailable',
      reason: 'telemetry-query-failed',
    })
  })

  it('distinguishes a projection failure from a telemetry query failure', () => {
    const result = verifyManifestRuntimeClaims(snapshot([]), [record()], {
      configured: true,
      queriedAgentIds: new Set(['authoritative-agent']),
      failedAgentIds: new Set<string>(),
      projectionFailedAgentIds: new Set(['authoritative-agent']),
    })
    expect(result.claims[0]).toMatchObject({
      status: 'unavailable',
      reason: 'telemetry-projection-failed',
    })
  })
})
