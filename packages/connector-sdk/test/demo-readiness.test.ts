import { describe, expect, it } from 'vitest'

import type { ConnectorsCollectionResponse } from '../src/index.js'
import { assessDemoReadiness } from '../src/demo-readiness.js'

function fixture() {
  const generatedAt = '2026-09-12T00:00:00.000Z'
  const providerId = '11111111-1111-4111-8111-111111111111'
  const state = {
    snapshot: {
      tenantId: 'tenant-a',
      environment: 'production',
      generatedAt,
      nodes: [
        {
          id: 'package-agent',
          kind: 'agent' as const,
          name: 'Package agent',
          description: 'Authoritative package.',
          environment: 'production',
          evidenceIds: ['package-evidence'],
          metadata: {
            sourceConnector: 'agent365-package-catalog',
            sourceConnectorId: 'primary',
            inventoryEntityType: 'agent-package',
            packageClassifications: JSON.stringify(['agent365-agent']),
            entraCorrelationStatus: 'matched',
          },
        },
        {
          id: 'identity',
          kind: 'identity' as const,
          name: 'Identity',
          description: 'Authoritative identity.',
          environment: 'production',
          evidenceIds: ['identity-evidence'],
          metadata: {},
        },
      ],
      edges: [
        {
          id: 'runs-as',
          from: 'package-agent',
          to: 'identity',
          relationship: 'RUNS_AS' as const,
          evidenceIds: ['package-evidence', 'identity-evidence'],
          active: true,
          removable: false,
          runsAsBinding: {
            agent: {
              estateId: 'default',
              sourceId: 'foundry:primary',
              tenantId: 'tenant-a',
              environment: 'production',
              provider: 'azure-ai-foundry-agent-service',
              sourceObjectId: 'project-a',
              providerObjectId: 'agent-a',
              snapshotGeneratedAt: generatedAt,
              sourceRelease: 'ga',
            },
            identity: {
              estateId: 'default',
              sourceId: 'entra:primary',
              tenantId: 'tenant-a',
              environment: 'production',
              provider: 'microsoft-entra',
              sourceObjectId: 'directory-a',
              providerObjectId: providerId,
              snapshotGeneratedAt: generatedAt,
              sourceRelease: 'v1.0',
            },
            identifier: { kind: 'object-id' as const, value: providerId },
          },
        },
      ],
      evidence: [
        {
          id: 'package-evidence',
          source: 'Agent 365',
          sourceObjectId: 'primary:package-a',
          observedAt: generatedAt,
          freshness: 'live' as const,
          confidence: 1,
          evidenceTypes: ['declared_configuration' as const],
          summary: 'Authoritative package evidence.',
          metadata: {
            sourceConnector: 'agent365-package-catalog',
            sourceConnectorId: 'primary',
            inventoryEntityType: 'agent-package',
            packageClassifications: JSON.stringify(['agent365-agent']),
          },
          sourceStatus: {
            status: 'live' as const,
            sourceId: 'agent365:primary',
            readiness: 'ready' as const,
            dataState: 'complete' as const,
            checkedAt: generatedAt,
          },
        },
        {
          id: 'identity-evidence',
          source: 'Entra',
          sourceObjectId: `directory-a:${providerId}`,
          observedAt: generatedAt,
          freshness: 'live' as const,
          confidence: 1,
          evidenceTypes: ['declared_configuration' as const],
          summary: 'Identity evidence.',
        },
        {
          id: 'otel-evidence',
          source: 'Azure Monitor',
          sourceObjectId: 'trace-a',
          observedAt: generatedAt,
          freshness: 'live' as const,
          confidence: 1,
          evidenceTypes: ['observed_runtime' as const],
          summary: 'Runtime evidence.',
          otel: {
            quality: {
              status: 'available' as const,
              classification: 'live' as const,
              caveats: [],
              recordsReceived: 4,
              recordsAccepted: 4,
              duplicatesRemoved: 0,
              pagesProcessed: 1,
            },
            invocations: [
              {
                id: 'invocation-a',
                observedAt: generatedAt,
                latencyMs: 50,
                inputTokens: 10,
                outputTokens: 20,
                costUsd: 0.01,
                success: true,
                toolCallNames: [],
                provenance: {
                  snapshotGeneratedAt: generatedAt,
                  estateId: 'default',
                  estateTenantId: 'tenant-a',
                  estateEnvironment: 'production',
                  sourceConnectorId: 'azure-monitor-primary',
                  sourceTenantId: 'tenant-a',
                  sourceProjectId: 'project-a',
                  sourceEnvironment: 'production',
                  provider: 'azure-monitor-otel' as const,
                  providerResourceId: 'workspace-a',
                  providerAgentId: 'agent-a',
                  traceId: 'a'.repeat(32),
                  spanId: 'b'.repeat(16),
                  observedAt: generatedAt,
                  classification: 'live' as const,
                  sampling: { state: 'complete' as const, rate: 1 },
                  aggregation: { kind: 'raw' as const },
                  partial: false,
                  evidenceIds: ['otel-evidence'],
                },
              },
            ],
          },
        },
      ],
    },
    findings: [],
    validations: [],
    remediations: [],
    runtimeEvidence: {
      status: 'ready' as const,
      queriedAt: generatedAt,
      agentCount: 1,
      eligibleAgentCount: 1,
      queriedAgentCount: 1,
      enrichedAgentCount: 1,
      evidenceCount: 1,
      sources: [
        {
          estateId: 'default',
          estateTenantId: 'tenant-a',
          estateEnvironment: 'production',
          snapshotGeneratedAt: generatedAt,
          sourceConnectorId: 'azure-monitor-primary',
          sourceTenantId: 'tenant-a',
          sourceProjectId: 'project-a',
          sourceEnvironment: 'production',
          sourceAgentId: 'agent-a',
          agentId: 'package-agent',
          state: 'complete' as const,
          windowIds: ['observed-window'],
          observationIds: ['invocation-a'],
          evidenceIds: ['otel-evidence'],
          providerResourceIds: ['workspace-a'],
        },
      ],
      failures: [],
    },
  }
  const connectors: ConnectorsCollectionResponse = {
    active: {
      id: 'foundry',
      mode: 'foundry',
      source: 'foundry',
      lifecycleState: 'connected',
      writeEnabled: false,
    },
    catalog: [
      {
        id: 'm365-agent-registry',
        name: 'Agent 365',
        description: 'Catalog.',
        lifecycleState: 'connected',
        capabilities: ['discovery'],
        sourceOfTruth: true,
        ownershipModel: 'consumes',
      },
    ],
    health: {
      overall: 'ready',
      partial: false,
      sourceSetFingerprint: 'c'.repeat(64),
      sources: [
        {
          id: 'agent365:primary',
          name: 'Agent 365',
          role: 'discovery',
          enabled: true,
          configured: true,
          readiness: 'ready',
          dataState: 'complete',
          pages: 2,
          records: 1,
          checkedAt: generatedAt,
          provenance: {
            estateTenantId: 'tenant-a',
            estateEnvironment: 'production',
            sourceConnectorId: 'primary',
            sourceTenantId: 'tenant-a',
            sourceEnvironment: 'production',
            provider: 'microsoft-graph-agent365-package-catalog',
            providerObjectId: '/v1.0/copilot/admin/catalog/packages',
          },
        },
        {
          id: 'entra:primary',
          name: 'Entra',
          role: 'enrichment',
          enabled: true,
          configured: true,
          readiness: 'ready',
          dataState: 'complete',
          diagnostics: {
            kind: 'exact-identity-correlation',
            provider: 'microsoft-entra',
            sourceId: 'primary',
            sourceTenantId: 'tenant-a',
            sourceEnvironment: 'production',
            authoritativeAgentsConsidered: 1,
            exactObjectIdMatches: 1,
            exactApplicationIdMatches: 0,
            exactAgentIdentityMatches: 0,
            unmatched: 0,
            ambiguous: 0,
            runsAsEdgesEmitted: 1,
            ownerCoverage: { status: 'disabled', evidenceReferences: [] },
            appRoleCoverage: { status: 'disabled', evidenceReferences: [] },
            previewCoverage: { status: 'disabled', evidenceReferences: [] },
            evidenceReferences: ['package-evidence', 'identity-evidence'],
          },
        },
      ],
    },
  }
  const connectorSources = [
    {
      estateId: 'default',
      tenantId: 'tenant-a',
      environment: 'production',
      sourceId: 'agent365-primary',
      connectorType: 'agent365' as const,
      displayName: 'Agent 365',
      enabled: true,
      origin: 'deployment' as const,
      configuration: {
        type: 'agent365' as const,
        graphBaseUrl: 'https://graph.microsoft.com',
        limits: {
          maxPages: 20,
          maxItems: 5000,
          requestTimeoutMs: 15000,
          maxRetries: 2,
          maxRetryAfterMs: 30000,
          maxResponseBytes: 2000000,
        },
      },
      credential: {
        mode: 'managed-identity' as const,
        managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
      },
      runtimeBinding: { bindingSourceId: 'primary' },
      testStatus: { status: 'not-tested' as const },
      version: 1,
      etag: 'etag-a',
      createdBy: { type: 'deployment' as const, id: 'deployment' },
      updatedBy: { type: 'deployment' as const, id: 'deployment' },
      createdAt: generatedAt,
      updatedAt: generatedAt,
    },
  ]
  return { state, connectors, connectorSources }
}

describe('assessDemoReadiness', () => {
  it('reports ready only for complete live Agent365, exact RUNS_AS, and live OTel evidence', () => {
    const assessment = assessDemoReadiness(fixture())
    expect(assessment.status).toBe('ready')
    expect(assessment.agent365.packageEvidenceCount).toBe(1)
    expect(assessment.runsAs.exactEdgeCount).toBe(1)
    expect(assessment.otel.liveInvocationCount).toBe(1)
    expect(assessment.connectorBinding.managedIdentityClientId).toBe('redacted')
    expect(JSON.stringify(assessment)).not.toContain('59dbea72')
  })

  it('does not present a deployment timestamp placeholder as observed evidence', () => {
    const value = fixture()
    value.connectorSources[0]!.updatedAt = '1970-01-01T00:00:00.000Z'

    const assessment = assessDemoReadiness(value)

    expect(assessment.connectorBinding.status).toBe('ready')
    expect(assessment.connectorBinding).not.toHaveProperty('observedAt')
  })

  it('preserves a recorded connector configuration update timestamp', () => {
    const value = fixture()

    expect(assessDemoReadiness(value).connectorBinding.observedAt).toBe(
      value.connectorSources[0]!.updatedAt,
    )
  })

  it('never promotes empty Agent365 or zero OTel evidence to ready', () => {
    const value = fixture()
    value.connectors.health!.sources[0] = {
      ...value.connectors.health!.sources[0]!,
      dataState: 'empty',
      records: 0,
    }
    value.state.runtimeEvidence = {
      ...value.state.runtimeEvidence!,
      status: 'partial',
      evidenceCount: 0,
    }
    value.state.snapshot.evidence = value.state.snapshot.evidence.filter(
      (item) => item.id === 'identity-evidence',
    )
    const assessment = assessDemoReadiness(value)
    expect(assessment.agent365.status).toBe('blocked')
    expect(assessment.otel.status).toBe('partial')
    expect(assessment.requirements.join(' ')).toContain(
      'approved representative application traffic',
    )
    expect(assessment.status).toBe('blocked')
  })

  it.each(['partial', 'stale', 'empty'] as const)(
    'does not promote Agent365 %s health to ready',
    (dataState) => {
      const value = fixture()
      value.connectors.health!.sources[0] = {
        ...value.connectors.health!.sources[0]!,
        dataState,
      }
      expect(assessDemoReadiness(value).agent365.status).toBe('blocked')
    },
  )

  it('blocks synthetic or stale package evidence', () => {
    const value = fixture()
    const packageEvidence = value.state.snapshot.evidence[0]!
    value.state.snapshot.evidence[0] = {
      ...packageEvidence,
      freshness: 'stale',
      evidenceTypes: ['declared_configuration', 'synthetic_validation'],
      sourceStatus: {
        status: 'stale',
        sourceId: 'agent365:primary',
        readiness: 'degraded',
        dataState: 'stale',
        checkedAt: '2026-09-10T00:00:00.000Z',
      },
    }
    const assessment = assessDemoReadiness(value)
    expect(assessment.agent365.status).toBe('blocked')
    expect(assessment.agent365.staleSourceStatusCount).toBe(1)
    expect(assessment.agent365.syntheticOrUnknownCount).toBe(1)
  })

  it('allows zero RUNS_AS to be partial only for exact missing-provider-id diagnostics', () => {
    const value = fixture()
    value.state.snapshot.edges = []
    value.state.snapshot.nodes[0]!.metadata.entraCorrelationStatus = 'unmatched'
    value.state.snapshot.nodes[0]!.metadata.entraCorrelationReason =
      'missing-authoritative-identifier'
    const diagnostic = value.connectors.health!.sources[1]!.diagnostics!
    value.connectors.health!.sources[1] = {
      ...value.connectors.health!.sources[1]!,
      diagnostics: {
        ...diagnostic,
        exactObjectIdMatches: 0,
        unmatched: 1,
        runsAsEdgesEmitted: 0,
      },
    }
    const assessment = assessDemoReadiness(value)
    expect(assessment.runsAs.status).toBe('partial')
    expect(assessment.runsAs.unmatchedReasons).toEqual({
      'missing-authoritative-identifier': 1,
    })
  })

  it('blocks zero RUNS_AS when diagnostics do not precisely explain missing provider IDs', () => {
    const value = fixture()
    value.state.snapshot.edges = []
    value.state.snapshot.nodes[0]!.metadata.entraCorrelationStatus = 'unmatched'
    value.state.snapshot.nodes[0]!.metadata.entraCorrelationReason = 'no-exact-source-match'
    const diagnostic = value.connectors.health!.sources[1]!.diagnostics!
    value.connectors.health!.sources[1] = {
      ...value.connectors.health!.sources[1]!,
      diagnostics: {
        ...diagnostic,
        exactObjectIdMatches: 0,
        unmatched: 1,
        runsAsEdgesEmitted: 0,
      },
    }
    expect(assessDemoReadiness(value).runsAs.status).toBe('blocked')
  })
})
