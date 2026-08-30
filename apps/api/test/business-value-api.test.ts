import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BusinessOutcomeConnector } from '@agent-sentinel/connector-sdk'
import { businessValueAssessmentSchema, estateSnapshotSchema } from '@agent-sentinel/domain'

import { createApp } from '../src/app.js'

afterEach(() => {
  delete process.env['AGENT_SENTINEL_CONNECTOR']
  delete process.env['FOUNDRY_PROJECT_ENDPOINT']
  delete process.env['FOUNDRY_TENANT_ID']
  delete process.env['FOUNDRY_ENVIRONMENT']
})

function liveSnapshotRepository() {
  const snapshot = estateSnapshotSchema.parse({
    tenantId: 'tenant-demo',
    environment: 'validation',
    generatedAt: '2026-08-31T00:00:00.000Z',
    nodes: [
      {
        id: 'live-agent',
        kind: 'agent',
        name: 'Live agent',
        description: 'Authoritative agent.',
        environment: 'production',
        evidenceIds: ['evidence-1'],
        metadata: { version: '1' },
      },
    ],
    edges: [],
    evidence: [
      {
        id: 'evidence-1',
        source: 'Foundry',
        sourceObjectId: 'live-agent',
        observedAt: '2026-08-31T00:00:00.000Z',
        freshness: 'live',
        confidence: 1,
        evidenceTypes: ['declared_configuration'],
        summary: 'Declared agent configuration.',
      },
    ],
  })
  return {
    save: vi.fn(),
    findLatest: vi.fn().mockResolvedValue(snapshot),
    findById: vi.fn().mockResolvedValue(snapshot),
    list: vi.fn().mockResolvedValue([snapshot]),
  }
}

function configureLiveFoundry() {
  process.env['AGENT_SENTINEL_CONNECTOR'] = 'foundry'
  process.env['FOUNDRY_PROJECT_ENDPOINT'] =
    'https://example.services.ai.azure.com/api/projects/test'
  process.env['FOUNDRY_TENANT_ID'] = 'tenant-demo'
  process.env['FOUNDRY_ENVIRONMENT'] = 'validation'
}

describe('business value API', () => {
  it('returns source-cited synthetic outcomes in mock mode', async () => {
    process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
    const app = await createApp(undefined, { mode: 'disabled' }, { dataMode: 'mock' })
    const response = await app.inject({
      method: 'GET',
      url: '/api/business-value/agents/hr-policy-agent',
    })
    const assessment = businessValueAssessmentSchema.parse(response.json())

    expect(response.statusCode).toBe(200)
    expect(assessment.status).toBe('sourced')
    expect(assessment.claims[0]).toMatchObject({
      outcomeName: 'Resolved policy inquiries',
      value: 18,
      unit: 'count',
      synthetic: true,
    })
    expect(assessment.evidence[0]?.evidenceTypes).toEqual(['synthetic_validation'])
    await app.close()
  })

  it('returns typed unknown in live mode without an outcome source', async () => {
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        businessOutcomeConnector: null,
        runtimeTelemetryConnector: null,
        exposureRepository: {
          upsert: (finding) => Promise.resolve(finding),
          findById: () => Promise.resolve(null),
          listByTenant: () => Promise.resolve({ items: [], total: 0 }),
          getFacets: () => Promise.resolve({ severity: {}, status: {}, policyId: {} }),
          resolveAbsent: () => Promise.resolve([]),
        },
      },
    )
    const response = await app.inject({
      method: 'GET',
      url: '/api/business-value/agents/live-agent',
    })
    const assessment = businessValueAssessmentSchema.parse(response.json())

    expect(assessment).toMatchObject({
      status: 'unknown',
      reason: 'no-outcome-source-configured',
      claims: [],
      evidence: [],
    })
    await app.close()
  })

  it('rejects synthetic observations from an injected live connector', async () => {
    configureLiveFoundry()
    const connector: BusinessOutcomeConnector = {
      id: 'live-outcome-source',
      readBusinessOutcomes: () =>
        Promise.resolve({
          queriedAt: '2026-08-31T00:00:00.000Z',
          observations: [
            {
              id: 'outcome-1',
              tenantId: 'tenant-demo',
              agentId: 'live-agent',
              environment: 'production',
              source: 'Injected source',
              sourceObjectId: 'object-1',
              observedAt: '2026-08-30T12:00:00.000Z',
              outcomeName: 'Completed cases',
              value: 1,
              unit: 'count',
              correlation: { kind: 'agent-version', value: '1' },
              evidenceId: 'evidence-1',
              confidence: 1,
              freshness: 'live',
              synthetic: true,
            },
          ],
          evidence: [
            {
              id: 'evidence-1',
              source: 'Injected source',
              sourceObjectId: 'object-1',
              observedAt: '2026-08-30T12:00:00.000Z',
              freshness: 'live',
              confidence: 1,
              evidenceTypes: ['synthetic_validation'],
              summary: 'Synthetic outcome.',
            },
          ],
        }),
    }
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        businessOutcomeConnector: connector,
        runtimeTelemetryConnector: null,
        snapshotRepository: liveSnapshotRepository(),
        exposureRepository: {
          upsert: (finding) => Promise.resolve(finding),
          findById: () => Promise.resolve(null),
          listByTenant: () => Promise.resolve({ items: [], total: 0 }),
          getFacets: () => Promise.resolve({ severity: {}, status: {}, policyId: {} }),
          resolveAbsent: () => Promise.resolve([]),
        },
      },
    )
    const response = await app.inject({
      method: 'GET',
      url: '/api/business-value/agents/live-agent',
    })
    expect(businessValueAssessmentSchema.parse(response.json())).toMatchObject({
      status: 'unknown',
      reason: 'outcome-contract-invalid',
    })
    await app.close()
  })

  it('preserves a valid exact-correlated live outcome claim without aggregation', async () => {
    configureLiveFoundry()
    const connector: BusinessOutcomeConnector = {
      id: 'live-outcome-source',
      readBusinessOutcomes: () =>
        Promise.resolve({
          queriedAt: '2026-08-31T00:00:00.000Z',
          observations: [
            {
              id: 'outcome-live-1',
              tenantId: 'tenant-demo',
              agentId: 'live-agent',
              environment: 'production',
              source: 'Case outcome system',
              sourceObjectId: 'case-batch-1',
              observedAt: '2026-08-30T12:00:00.000Z',
              outcomeName: 'Resolved cases',
              value: 7,
              unit: 'count',
              correlation: { kind: 'agent-version', value: '1' },
              evidenceId: 'outcome-live-evidence-1',
              confidence: 1,
              freshness: 'live',
              synthetic: false,
            },
          ],
          evidence: [
            {
              id: 'outcome-live-evidence-1',
              source: 'Case outcome system',
              sourceObjectId: 'case-batch-1',
              observedAt: '2026-08-30T12:00:00.000Z',
              freshness: 'live',
              confidence: 1,
              evidenceTypes: ['observed_runtime'],
              summary: 'Seven resolved cases with exact correlation.',
            },
          ],
        }),
    }
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        businessOutcomeConnector: connector,
        runtimeTelemetryConnector: null,
        snapshotRepository: liveSnapshotRepository(),
        exposureRepository: {
          upsert: (finding) => Promise.resolve(finding),
          findById: () => Promise.resolve(null),
          listByTenant: () => Promise.resolve({ items: [], total: 0 }),
          getFacets: () => Promise.resolve({ severity: {}, status: {}, policyId: {} }),
          resolveAbsent: () => Promise.resolve([]),
        },
      },
    )
    const response = await app.inject({
      method: 'GET',
      url: '/api/business-value/agents/live-agent',
    })
    const assessment = businessValueAssessmentSchema.parse(response.json())

    expect(assessment).toMatchObject({
      status: 'sourced',
      sourcesChecked: ['live-outcome-source'],
      claims: [
        {
          outcomeName: 'Resolved cases',
          value: 7,
          unit: 'count',
          evidenceId: 'outcome-live-evidence-1',
          synthetic: false,
        },
      ],
    })
    await app.close()
  })

  it('returns sanitized unknown when the authoritative agent binding cannot be read', async () => {
    configureLiveFoundry()
    const connector: BusinessOutcomeConnector = {
      id: 'live-outcome-source',
      readBusinessOutcomes: () => Promise.reject(new Error('must not be reached')),
    }
    const app = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'live',
        businessOutcomeConnector: connector,
        runtimeTelemetryConnector: null,
        snapshotRepository: {
          save: vi.fn(),
          findLatest: () => Promise.reject(new Error('private Cosmos detail')),
          findById: vi.fn().mockResolvedValue(null),
          list: vi.fn().mockResolvedValue([]),
        },
        exposureRepository: {
          upsert: (finding) => Promise.resolve(finding),
          findById: () => Promise.resolve(null),
          listByTenant: () => Promise.resolve({ items: [], total: 0 }),
          getFacets: () => Promise.resolve({ severity: {}, status: {}, policyId: {} }),
          resolveAbsent: () => Promise.resolve([]),
        },
      },
    )
    const response = await app.inject({
      method: 'GET',
      url: '/api/business-value/agents/live-agent',
    })
    const assessment = businessValueAssessmentSchema.parse(response.json())

    expect(response.statusCode).toBe(200)
    expect(assessment).toMatchObject({
      status: 'unknown',
      reason: 'outcome-binding-unavailable',
      claims: [],
      evidence: [],
    })
    expect(response.body).not.toContain('private Cosmos detail')
    await app.close()
  })
})
