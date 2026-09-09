import { describe, expect, it } from 'vitest'

import {
  SOURCE_PROJECT_ID_MAX_LENGTH,
  agentSentinelStateSchema,
  estateSnapshotSchema,
  evidenceSchema,
} from '../src/index.js'

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

  it('preserves exact evidence authority and rejects malformed authority identifiers', () => {
    const authority = {
      estateId: 'estate-a',
      sourceId: 'foundry:project-a',
      tenantId: '99999999-9999-4999-8999-999999999999',
      environment: 'production',
      provider: 'azure-ai-foundry-agent-service',
      sourceObjectId: 'project-a',
      providerObjectId: 'agent-a',
      snapshotGeneratedAt: '2026-09-09T00:00:00.000Z',
      sourceRelease: '2025-05-01',
    }
    const parsed = evidenceSchema.parse({
      id: 'foundry-evidence',
      source: 'Azure AI Foundry Agent Service',
      sourceObjectId: 'project-a:agent-a',
      observedAt: '2026-09-09T00:00:00.000Z',
      freshness: 'live',
      confidence: 1,
      evidenceTypes: ['declared_configuration'],
      summary: 'Authoritative Foundry agent configuration.',
      authority,
    })

    expect(parsed.authority).toEqual(authority)
    expect(
      evidenceSchema.safeParse({
        ...parsed,
        authority: { ...authority, sourceId: 'shared-primary' },
      }).success,
    ).toBe(false)
    expect(
      evidenceSchema.safeParse({
        ...parsed,
        sourceObjectId: 'other-project:agent-a',
      }).success,
    ).toBe(false)
    expect(
      evidenceSchema.safeParse({
        ...parsed,
        authority: {
          ...authority,
          sourceId: 'entra:directory-a',
          provider: 'microsoft-entra',
          sourceObjectId: authority.tenantId,
          providerObjectId: '00000003-0000-0000-c000-000000000000',
          sourceRelease: 'v1.0',
        },
        sourceObjectId: 'directory-a:00000003-0000-0000-c000-000000000000',
      }).success,
    ).toBe(true)
  })

  it('canonicalizes Entra authority GUID casing and rejects malformed tenant boundaries', () => {
    const tenantId = '99999999-9999-4999-8999-999999999999'
    const providerObjectId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    const parsed = evidenceSchema.parse({
      id: 'entra-evidence',
      source: 'Microsoft Entra',
      sourceObjectId: `directory-a:${providerObjectId}`,
      observedAt: '2026-09-09T00:00:00.000Z',
      freshness: 'live',
      confidence: 1,
      evidenceTypes: ['declared_configuration'],
      summary: 'Authoritative Entra identity.',
      authority: {
        estateId: 'estate-a',
        sourceId: 'entra:directory-a',
        tenantId: tenantId.toUpperCase(),
        environment: 'directory',
        provider: 'microsoft-entra',
        sourceObjectId: tenantId.toUpperCase(),
        providerObjectId,
        snapshotGeneratedAt: '2026-09-09T00:00:00.000Z',
        sourceRelease: 'v1.0',
      },
    })

    expect(parsed.authority).toMatchObject({
      tenantId,
      sourceObjectId: tenantId,
      providerObjectId: providerObjectId.toLowerCase(),
    })
    expect(
      evidenceSchema.safeParse({
        ...parsed,
        authority: {
          ...parsed.authority,
          tenantId: 'not-a-guid',
          sourceObjectId: 'not-a-guid',
        },
      }).success,
    ).toBe(false)
  })

  it('preserves a complete exact RUNS_AS binding on the edge', () => {
    const generatedAt = '2026-09-09T00:00:00.000Z'
    const result = estateSnapshotSchema.parse({
      tenantId: '99999999-9999-4999-8999-999999999999',
      environment: 'portfolio',
      generatedAt,
      nodes: [
        {
          id: 'foundry-agent-a',
          kind: 'agent',
          name: 'Agent A',
          description: 'Foundry agent.',
          environment: 'production',
          evidenceIds: ['foundry-evidence'],
          metadata: {},
        },
        {
          id: 'entra-principal-a',
          kind: 'identity',
          name: 'Principal A',
          description: 'Entra service principal.',
          environment: 'directory',
          evidenceIds: ['entra-evidence'],
          metadata: {},
        },
      ],
      edges: [
        {
          id: 'runs-as-a',
          from: 'foundry-agent-a',
          to: 'entra-principal-a',
          relationship: 'RUNS_AS',
          evidenceIds: ['foundry-evidence', 'entra-evidence'],
          active: true,
          removable: false,
          runsAsBinding: {
            agent: {
              estateId: 'estate-a',
              sourceId: 'foundry:project-a',
              tenantId: '99999999-9999-4999-8999-999999999999',
              environment: 'production',
              provider: 'azure-ai-foundry-agent-service',
              sourceObjectId: 'project-a',
              providerObjectId: 'agent-a',
              snapshotGeneratedAt: generatedAt,
              sourceRelease: '2025-05-01',
            },
            identity: {
              estateId: 'estate-a',
              sourceId: 'entra:directory-a',
              tenantId: '99999999-9999-4999-8999-999999999999',
              environment: 'directory',
              provider: 'microsoft-entra',
              sourceObjectId: '99999999-9999-4999-8999-999999999999',
              providerObjectId: '11111111-1111-4111-8111-111111111111',
              snapshotGeneratedAt: generatedAt,
              sourceRelease: 'v1.0',
            },
            identifier: {
              kind: 'object-id',
              value: '11111111-1111-4111-8111-111111111111',
            },
          },
        },
      ],
      evidence: [
        {
          id: 'foundry-evidence',
          source: 'Foundry',
          sourceObjectId: 'agent-a',
          observedAt: generatedAt,
          freshness: 'live',
          confidence: 1,
          evidenceTypes: ['declared_configuration'],
          summary: 'Foundry evidence.',
        },
        {
          id: 'entra-evidence',
          source: 'Entra',
          sourceObjectId: '11111111-1111-4111-8111-111111111111',
          observedAt: generatedAt,
          freshness: 'live',
          confidence: 1,
          evidenceTypes: ['declared_configuration'],
          summary: 'Entra evidence.',
        },
      ],
    })

    expect(result.edges[0]?.runsAsBinding?.identifier.kind).toBe('object-id')
  })

  it('preserves cross-tenant RUNS_AS endpoint authority within one estate', () => {
    const generatedAt = '2026-09-09T00:00:00.000Z'
    const result = estateSnapshotSchema.safeParse({
      tenantId: '77777777-7777-4777-8777-777777777777',
      environment: 'portfolio',
      generatedAt,
      nodes: [
        {
          id: 'foundry-agent-a',
          kind: 'agent',
          name: 'Agent A',
          description: 'Foundry agent.',
          environment: 'production',
          evidenceIds: ['foundry-evidence'],
          metadata: {},
        },
        {
          id: 'entra-principal-a',
          kind: 'identity',
          name: 'Principal A',
          description: 'Entra service principal.',
          environment: 'directory',
          evidenceIds: ['entra-evidence'],
          metadata: {},
        },
      ],
      edges: [
        {
          id: 'runs-as-a',
          from: 'foundry-agent-a',
          to: 'entra-principal-a',
          relationship: 'RUNS_AS',
          evidenceIds: ['foundry-evidence', 'entra-evidence'],
          active: true,
          removable: false,
          runsAsBinding: {
            agent: {
              estateId: 'estate-a',
              sourceId: 'foundry:project-a',
              tenantId: '99999999-9999-4999-8999-999999999999',
              environment: 'production',
              provider: 'azure-ai-foundry-agent-service',
              sourceObjectId: 'project-a',
              providerObjectId: 'agent-a',
              snapshotGeneratedAt: generatedAt,
              sourceRelease: 'v1',
            },
            identity: {
              estateId: 'estate-a',
              sourceId: 'entra:directory-b',
              tenantId: '88888888-8888-4888-8888-888888888888',
              environment: 'directory',
              provider: 'microsoft-entra',
              sourceObjectId: '88888888-8888-4888-8888-888888888888',
              providerObjectId: '11111111-1111-4111-8111-111111111111',
              snapshotGeneratedAt: generatedAt,
              sourceRelease: 'v1.0',
            },
            identifier: {
              kind: 'object-id',
              value: '11111111-1111-4111-8111-111111111111',
            },
          },
        },
      ],
      evidence: [
        {
          id: 'foundry-evidence',
          source: 'Foundry',
          sourceObjectId: 'agent-a',
          observedAt: generatedAt,
          freshness: 'live',
          confidence: 1,
          evidenceTypes: ['declared_configuration'],
          summary: 'Foundry evidence.',
        },
        {
          id: 'entra-evidence',
          source: 'Entra',
          sourceObjectId: '11111111-1111-4111-8111-111111111111',
          observedAt: generatedAt,
          freshness: 'live',
          confidence: 1,
          evidenceTypes: ['declared_configuration'],
          summary: 'Entra evidence.',
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  it('uses the shared source project ID boundary in runtime state', () => {
    const sourceProjectId = 'p'.repeat(SOURCE_PROJECT_ID_MAX_LENGTH)
    const state = {
      snapshot: {
        tenantId: 'tenant-a',
        environment: 'production',
        generatedAt: '2026-09-10T00:00:00.000Z',
        nodes: [],
        edges: [],
        evidence: [],
      },
      findings: [],
      validations: [],
      remediations: [],
      runtimeEvidence: {
        status: 'ready',
        agentCount: 1,
        eligibleAgentCount: 1,
        queriedAgentCount: 1,
        enrichedAgentCount: 1,
        evidenceCount: 1,
        sources: [
          {
            estateId: 'estate-a',
            estateTenantId: 'tenant-a',
            estateEnvironment: 'production',
            snapshotGeneratedAt: '2026-09-10T00:00:00.000Z',
            sourceConnectorId: 'source-a',
            sourceTenantId: 'tenant-a',
            sourceProjectId: ` ${sourceProjectId} `,
            sourceEnvironment: 'production',
            sourceAgentId: 'provider-agent-a',
            agentId: 'agent-a',
            state: 'complete',
            windowIds: [],
            observationIds: [],
            evidenceIds: [],
            providerResourceIds: [],
          },
        ],
        failures: [],
      },
    }

    expect(
      agentSentinelStateSchema.parse(state).runtimeEvidence?.sources?.[0]?.sourceProjectId,
    ).toBe(sourceProjectId)
    expect(
      agentSentinelStateSchema.safeParse({
        ...state,
        runtimeEvidence: {
          ...state.runtimeEvidence,
          sources: [
            {
              ...state.runtimeEvidence.sources[0]!,
              sourceProjectId: `${sourceProjectId}x`,
            },
          ],
        },
      }).success,
    ).toBe(false)
  })
})
