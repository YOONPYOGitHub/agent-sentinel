import { describe, expect, it } from 'vitest'

import type {
  ConnectorSourceDefinition,
  ConnectorSourceReadModel,
  ConnectorSourceRepository,
  EstateContext,
  EstateSnapshot,
} from '@agent-sentinel/domain'
import { hydratePersistedConnectorSourceDefinition } from '@agent-sentinel/domain'
import type { AgentConnector } from '@agent-sentinel/connector-sdk'

import {
  AGENT365_HEALTH_MAX_AGE_MS,
  agent365SourceSetFingerprint,
  buildDeploymentConnectorSources,
  createAgent365RuntimeConnector,
  DeploymentConnectorSourceRepository,
  Agent365HealthAwareSnapshotRepository,
  projectAgent365SnapshotHealth,
  reconcileAgent365PersistedHealth,
  resolveAgent365Runtime,
  synthesizeAgent365UnmeasuredHealth,
} from '../src/index.js'
import type { ConnectorHealthMeasurement } from '@agent-sentinel/connector-sdk'
import type { ConnectorHealthReport } from '@agent-sentinel/connector-sdk'
import { computeSnapshotEvidenceDigest } from '@agent-sentinel/connector-sdk'

const estate: EstateContext = {
  id: 'estate-a',
  tenantId: '11111111-1111-4111-8111-111111111111',
  environment: 'production',
}

function source(
  sourceId: string,
  options: {
    enabled?: boolean
    connectorType?: ConnectorSourceDefinition['connectorType']
    credential?: ConnectorSourceDefinition['credential']
    estate?: EstateContext
    origin?: 'deployment' | 'user'
    maxRetryAfterMs?: number
    aggregation?: {
      maxConcurrency: number
      maxDurationMs: number
    }
  } = {},
): ConnectorSourceDefinition {
  const boundary = options.estate ?? estate
  const connectorType = options.connectorType ?? 'agent365'
  const origin = options.origin ?? 'deployment'
  const actor =
    origin === 'deployment'
      ? ({ type: 'deployment', id: 'deployment-json' } as const)
      : ({ type: 'service-principal', id: 'configuration-api' } as const)
  return {
    estateId: boundary.id,
    tenantId: boundary.tenantId,
    environment: boundary.environment,
    sourceId,
    connectorType,
    displayName: `${sourceId} display`,
    enabled: options.enabled ?? true,
    origin,
    configuration:
      connectorType === 'agent365'
        ? {
            type: 'agent365',
            graphBaseUrl: 'https://graph.microsoft.com',
            limits: {
              maxPages: 3,
              maxItems: 500,
              requestTimeoutMs: 5_000,
              maxRetries: 1,
              maxRetryAfterMs: options.maxRetryAfterMs ?? 1_000,
              maxResponseBytes: 50_000,
            },
            ...(options.aggregation === undefined ? {} : { aggregation: options.aggregation }),
          }
        : {
            type: 'manifest',
            manifestId: 'manifest-a',
          },
    credential: options.credential ?? {
      mode: 'managed-identity',
      managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
    },
    testStatus: { status: 'not-tested' },
    version: 2,
    etag: `etag-${sourceId}`,
    createdBy: actor,
    updatedBy: actor,
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  }
}

function migrationRequiredOtelSource(
  sourceId = 'azure-monitor-legacy',
  boundary: EstateContext = estate,
): ConnectorSourceReadModel {
  return hydratePersistedConnectorSourceDefinition({
    estateId: boundary.id,
    tenantId: boundary.tenantId,
    environment: boundary.environment,
    sourceId,
    connectorType: 'azure-monitor-otel',
    displayName: 'Legacy Azure Monitor',
    enabled: true,
    origin: 'user',
    configuration: {
      type: 'azure-monitor-otel',
      workspaceId: '00000000-0000-4000-8000-000000000003',
      logsBaseUrl: 'https://api.loganalytics.io',
      baselineWindowHours: 168,
      observedWindowHours: 24,
      requestTimeoutMs: 15_000,
      maxResponseBytes: 4_194_304,
    },
    credential: { mode: 'default' },
    testStatus: { status: 'not-tested' },
    version: 1,
    etag: `etag-${sourceId}`,
    createdBy: { type: 'service-principal', id: 'configuration-api' },
    updatedBy: { type: 'service-principal', id: 'configuration-api' },
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  })
}

function migrationRequiredAgent365Source(
  sourceId = 'agent365-legacy-retry',
): ConnectorSourceReadModel {
  const current = source(sourceId, { origin: 'user' })
  if (current.configuration.type !== 'agent365') {
    throw new Error('Expected an Agent 365 source fixture.')
  }
  return hydratePersistedConnectorSourceDefinition({
    ...current,
    configuration: {
      ...current.configuration,
      limits: {
        ...current.configuration.limits,
        maxRetryAfterMs: 120_000,
      },
    },
  })
}

function repository(
  values: readonly ConnectorSourceReadModel[],
  listOverride?: ConnectorSourceRepository['list'],
): ConnectorSourceRepository {
  return {
    create: () => Promise.reject(new Error('not used')),
    findById: () => Promise.resolve(null),
    list:
      listOverride ??
      ((_estate, limit = 100, cursor) =>
        Promise.resolve(
          values
            .filter((value) => cursor === undefined || value.sourceId > cursor)
            .toSorted((left, right) => left.sourceId.localeCompare(right.sourceId))
            .slice(0, limit),
        )),
    update: () => Promise.reject(new Error('not used')),
    delete: () => Promise.reject(new Error('not used')),
    listAudit: () => Promise.resolve([]),
  }
}

function baseConnector(): AgentConnector {
  const snapshot: EstateSnapshot = {
    tenantId: estate.tenantId,
    environment: estate.environment,
    generatedAt: '2026-09-09T00:00:00.000Z',
    nodes: [],
    edges: [],
    evidence: [],
  }
  return {
    descriptor: {
      id: 'base',
      name: 'Base',
      apiVersion: '1',
      releaseStatus: 'ga',
      capabilities: ['discovery'],
      requiredPermissions: [],
      blindSpots: [],
    },
    testConnection: () =>
      Promise.resolve({
        ok: true,
        checkedAt: '2026-09-09T00:00:00.000Z',
        message: 'ready',
      }),
    discover: () => Promise.resolve(snapshot),
    getEvidence: () => Promise.reject(new Error('not found')),
    getConnectorHealth: () => ({
      overall: 'ready',
      partial: false,
      sources: [
        {
          id: 'base',
          name: 'Base',
          role: 'discovery',
          enabled: true,
          configured: true,
          readiness: 'ready',
        },
      ],
    }),
  }
}

function retainedAgent365Snapshot(sourceId = 'deployment'): EstateSnapshot {
  const evidenceId = 'agent365-package-evidence'
  return {
    tenantId: estate.tenantId,
    environment: estate.environment,
    generatedAt: '2026-09-09T00:00:00.000Z',
    nodes: [
      {
        id: 'agent365-package',
        kind: 'agent',
        name: 'Retained package',
        description: 'Retained Agent 365 package evidence.',
        environment: estate.environment,
        evidenceIds: [evidenceId],
        metadata: {
          sourceConnector: 'agent365-package-catalog',
          sourceConnectorId: sourceId,
          sourceTenantId: estate.tenantId,
          sourceEnvironment: estate.environment,
          sourceProviderObjectId: 'P_1',
        },
      },
    ],
    edges: [],
    evidence: [
      {
        id: evidenceId,
        source: 'Microsoft Graph v1.0 Agent 365 package catalog',
        sourceObjectId: `${sourceId}:P_1`,
        observedAt: '2026-09-09T00:00:00.000Z',
        freshness: 'live',
        confidence: 1,
        evidenceTypes: ['declared_configuration'],
        summary: 'Retained Agent 365 package catalog record.',
        metadata: {
          sourceConnector: 'agent365-package-catalog',
          sourceConnectorId: sourceId,
          sourceTenantId: estate.tenantId,
          sourceEnvironment: estate.environment,
          sourceProviderObjectId: 'P_1',
        },
      },
    ],
  }
}

function agent365Health(
  sourceId: string,
  overrides: Partial<ConnectorHealthReport['sources'][number]> = {},
): ConnectorHealthReport {
  return {
    overall: 'ready',
    partial: false,
    sources: [
      {
        id: `agent365:${sourceId}`,
        name: 'Agent 365',
        role: 'discovery',
        enabled: true,
        configured: true,
        readiness: 'ready',
        dataState: 'complete',
        checkedAt: '2026-09-09T00:05:00.000Z',
        provenance: {
          estateTenantId: estate.tenantId,
          estateEnvironment: estate.environment,
          sourceConnectorId: sourceId,
          sourceTenantId: estate.tenantId,
          sourceEnvironment: estate.environment,
          provider: 'microsoft-graph-agent365-package-catalog',
          providerObjectId: '/v1.0/copilot/admin/catalog/packages',
        },
        ...overrides,
      },
    ],
  }
}

describe('Agent 365 runtime source resolution', () => {
  it('excludes a migration-required legacy OTel source while resolving active Agent 365', async () => {
    const resolved = await resolveAgent365Runtime(
      repository([migrationRequiredOtelSource(), source('agent365-active')]),
      estate,
    )

    expect(resolved.bindings.map((binding) => binding.sourceId)).toEqual(['agent365-active'])
    expect(resolved.config?.sources.map((value) => value.id)).toEqual(['agent365-active'])
  })

  it('retains a legacy Agent 365 retry source as an explicit inactive runtime binding', async () => {
    const runtime = await resolveAgent365Runtime(
      repository([migrationRequiredAgent365Source()]),
      estate,
    )

    expect(runtime.config).toBeUndefined()
    expect(runtime.bindings).toEqual([
      expect.objectContaining({
        sourceId: 'agent365-legacy-retry',
        sourceTenantId: estate.tenantId,
        sourceEnvironment: estate.environment,
        activation: { status: 'inactive', reason: 'migration-required' },
      }),
    ])
    expect(
      createAgent365RuntimeConnector(baseConnector(), runtime).getConnectorHealth?.(),
    ).toMatchObject({
      overall: 'degraded',
      partial: true,
      sources: [
        expect.objectContaining({
          id: 'base',
        }),
        expect.objectContaining({
          id: 'agent365:agent365-legacy-retry',
          enabled: false,
          configured: false,
          readiness: 'degraded',
          reason: 'migration-required',
        }),
      ],
    })
  })

  it('enforces estate checks before excluding legacy OTel sources', async () => {
    const otherEstate = { ...estate, id: 'estate-b' }
    await expect(
      resolveAgent365Runtime(
        repository([migrationRequiredOtelSource('legacy', otherEstate)]),
        estate,
      ),
    ).rejects.toThrow('does not match the requested estate boundary')
  })

  it('enforces duplicate identity checks before excluding legacy OTel sources', async () => {
    await expect(
      resolveAgent365Runtime(
        repository([migrationRequiredOtelSource('duplicate'), source('duplicate')]),
        estate,
      ),
    ).rejects.toThrow('Duplicate connector source identity: duplicate')
  })

  it.each([
    {
      name: 'an incomplete current definition',
      value: {
        ...source('agent365-malformed'),
        configuration: {
          type: 'agent365',
          graphBaseUrl: 'https://graph.microsoft.com',
          unexpected: true,
        },
      },
    },
    {
      name: 'a spoofed migration marker',
      value: {
        ...source('agent365-spoofed-migration'),
        migration: {
          status: 'migration-required',
          active: false,
          reason: 'missing-source-project-id',
          action: 'supply-exact-source-project-id',
        },
      },
    },
  ])('fails closed for malformed Agent 365 records: $name', async ({ value }) => {
    await expect(
      resolveAgent365Runtime(repository([value as unknown as ConnectorSourceReadModel]), estate),
    ).rejects.toThrow()
  })

  it('resolves only exact-estate Agent 365 sources with typed activation', async () => {
    const resolved = await resolveAgent365Runtime(
      repository([
        source('agent365-active'),
        source('agent365-disabled', { enabled: false }),
        source('agent365-default', { credential: { mode: 'default' } }),
        source('manifest-source', { connectorType: 'manifest' }),
      ]),
      estate,
      { pageSize: 2 },
    )

    expect(resolved.bindings).toMatchObject([
      {
        sourceId: 'agent365-active',
        sourceVersion: 2,
        sourceEtag: 'etag-agent365-active',
        activation: { status: 'active' },
      },
      {
        sourceId: 'agent365-default',
        activation: {
          status: 'inactive',
          reason: 'managed-identity-required',
        },
      },
      {
        sourceId: 'agent365-disabled',
        activation: { status: 'inactive', reason: 'source-disabled' },
      },
    ])
    expect(resolved.config?.sources).toHaveLength(1)
    expect(resolved.config?.sources[0]).toMatchObject({
      id: 'agent365-active',
      name: 'agent365-active display',
      tenantId: estate.tenantId,
      environment: estate.environment,
      graphBaseUrl: 'https://graph.microsoft.com',
      credential: {
        mode: 'managed-identity',
        managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
      },
    })

    expect(resolved.config?.sources[0]?.limits).toMatchObject({
      maxPages: 3,
      maxItems: 500,
    })
    expect(resolved.sourceSetFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each([
    {
      name: 'user-origin source',
      value: source('agent365-user', { origin: 'user' }),
      reason: 'deployment-origin-required',
    },
    {
      name: 'federated application',
      value: source('agent365-federated', {
        credential: {
          mode: 'federated-app',
          clientId: '00000000-0000-4000-8000-000000000003',
          managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
        },
      }),
      reason: 'managed-identity-required',
    },
    {
      name: 'Key Vault reference',
      value: source('agent365-key-vault', {
        credential: {
          mode: 'key-vault-secret-reference',
          vaultUri: 'https://safe.vault.azure.net',
          secretName: 'agent365',
        },
      }),
      reason: 'managed-identity-required',
    },
    {
      name: 'unapproved managed identity',
      value: source('agent365-unapproved', {
        credential: {
          mode: 'managed-identity',
          managedIdentityClientId: '00000000-0000-4000-8000-000000000004',
        },
      }),
      reason: 'managed-identity-client-id-not-approved',
    },
  ])('keeps persisted $name visible but inactive', async ({ value, reason }) => {
    const resolved = await resolveAgent365Runtime(repository([value]), estate)

    expect(resolved.config).toBeUndefined()
    expect(resolved.bindings).toMatchObject([
      {
        sourceId: value.sourceId,
        activation: { status: 'inactive', reason },
      },
    ])
  })

  it('resolves API-valid retry and projected aggregation limits without replacing them', async () => {
    const resolved = await resolveAgent365Runtime(
      repository([
        source('agent365-active', {
          maxRetryAfterMs: 60_000,
          aggregation: {
            maxConcurrency: 1,
            maxDurationMs: 5_000,
          },
        }),
      ]),
      estate,
    )

    expect(resolved.config).toMatchObject({
      limits: { maxRetryAfterMs: 60_000 },
      aggregation: {
        maxConcurrency: 1,
        maxDurationMs: 5_000,
      },
      sources: [{ limits: { maxRetryAfterMs: 60_000 } }],
    })
  })

  it('retains a cross-tenant provider boundary through deployment runtime and provenance', async () => {
    const providerTenantId = '22222222-2222-4222-8222-222222222222'
    const deployment = buildDeploymentConnectorSources(
      {
        AGENT_SENTINEL_TENANT_ID: estate.tenantId,
        AGENT_SENTINEL_ENVIRONMENT: estate.environment,
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_SOURCES_JSON: JSON.stringify([
          {
            id: 'provider',
            name: 'Provider Agent 365',
            tenantId: providerTenantId,
            environment: 'provider-production',
          },
        ]),
        AGENT365_MANAGED_IDENTITY_CLIENT_ID: '59dbea72-1e91-403a-89cf-e02cdb8da350',
      },
      { estates: [estate] },
      'live',
    )
    const resolved = await resolveAgent365Runtime(
      new DeploymentConnectorSourceRepository(repository([]), deployment),
      estate,
    )

    expect(resolved.bindings).toMatchObject([
      {
        tenantId: estate.tenantId,
        environment: estate.environment,
        sourceTenantId: providerTenantId,
        sourceEnvironment: 'provider-production',
      },
    ])
    expect(resolved.config?.sources).toMatchObject([
      {
        tenantId: providerTenantId,
        environment: 'provider-production',
      },
    ])
    expect(synthesizeAgent365UnmeasuredHealth(resolved)).toMatchObject({
      sources: [
        expect.objectContaining({
          id: 'agent365:provider',
          provenance: {
            estateTenantId: estate.tenantId,
            estateEnvironment: estate.environment,
            sourceConnectorId: 'provider',
            sourceTenantId: providerTenantId,
            sourceEnvironment: 'provider-production',
            provider: 'microsoft-graph-agent365-package-catalog',
            providerObjectId: '/v1.0/copilot/admin/catalog/packages',
          },
        }),
      ],
    })
  })

  it('keeps an immutable deployment source authoritative over a duplicate user source', async () => {
    const deployment = buildDeploymentConnectorSources(
      {
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_SOURCES_JSON: JSON.stringify([
          {
            id: 'deployment',
            name: 'Deployment Agent 365',
            tenantId: estate.tenantId,
            environment: estate.environment,
            credential: {
              mode: 'default',
              managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
            },
          },
        ]),
      },
      { estates: [estate] },
      'live',
    )
    const combined = new DeploymentConnectorSourceRepository(
      repository([source('agent365-user', { origin: 'user' })]),
      deployment,
    )

    const resolved = await resolveAgent365Runtime(combined, estate)

    expect(resolved.bindings.map((binding) => binding.sourceId)).toEqual([
      'agent365-deployment',
      'agent365-user',
    ])
    expect(resolved.bindings[0]).toMatchObject({
      bindingSourceId: 'deployment',
    })
    expect(resolved.bindings[1]?.activation).toEqual({
      status: 'inactive',
      reason: 'deployment-origin-required',
    })
    expect(resolved.config?.sources.map((value) => value.id)).toEqual(['deployment'])
  })

  it.each([
    {
      name: 'disabled',
      environment: {
        AGENT365_CONNECTOR_ENABLED: 'false',
        AGENT365_SOURCES_JSON: JSON.stringify([
          {
            id: 'deployment',
            name: 'Disabled deployment Agent 365',
            tenantId: estate.tenantId,
            environment: estate.environment,
            credential: {
              mode: 'managed-identity',
              managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
            },
          },
        ]),
      },
      expectedReason: 'source-disabled',
    },
    {
      name: 'invalid',
      environment: {
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_SOURCES_JSON: JSON.stringify([
          {
            id: 'deployment',
            name: 'Invalid deployment Agent 365',
            tenantId: estate.tenantId,
            environment: estate.environment,
            credential: { mode: 'default' },
          },
        ]),
      },
      expectedReason: 'managed-identity-required',
    },
  ])(
    'reserves a deployment-owned tenant boundary when the deployment source is $name',
    async ({ environment, expectedReason }) => {
      const deployment = buildDeploymentConnectorSources(environment, { estates: [estate] }, 'live')
      const combined = new DeploymentConnectorSourceRepository(
        repository([source('agent365-user', { origin: 'user' })]),
        deployment,
      )

      const resolved = await resolveAgent365Runtime(combined, estate)

      expect(resolved.bindings).toMatchObject([
        {
          sourceId: 'agent365-deployment',
          origin: 'deployment',
          activation: { status: 'inactive', reason: expectedReason },
        },
        {
          sourceId: 'agent365-user',
          origin: 'user',
          activation: { status: 'inactive', reason: 'deployment-origin-required' },
        },
      ])
      expect(resolved.config).toBeUndefined()
    },
  )

  it('rejects a source outside the requested estate boundary', async () => {
    const otherEstate = { ...estate, id: 'estate-b' }
    await expect(
      resolveAgent365Runtime(
        repository([source('agent365-other', { estate: otherEstate })]),
        estate,
      ),
    ).rejects.toThrow('does not match the requested estate boundary')
  })

  it('rejects non-advancing pagination and source-count overflow', async () => {
    const repeated = source('agent365-repeat')
    await expect(
      resolveAgent365Runtime(
        repository([], () => Promise.resolve([repeated])),
        estate,
        { pageSize: 1, maxSources: 2 },
      ),
    ).rejects.toThrow('pagination did not advance')

    await expect(
      resolveAgent365Runtime(
        repository([source('agent365-a'), source('agent365-b'), source('agent365-c')]),
        estate,
        { pageSize: 2, maxSources: 2 },
      ),
    ).rejects.toThrow('exceeds the runtime maximum')

    await expect(
      resolveAgent365Runtime(
        repository([
          migrationRequiredOtelSource('azure-monitor-a'),
          migrationRequiredOtelSource('azure-monitor-b'),
        ]),
        estate,
        { maxSources: 1 },
      ),
    ).rejects.toThrow('exceeds the runtime maximum')
  })

  it('keeps inactive persisted sources visible without executing them', async () => {
    const runtime = await resolveAgent365Runtime(
      repository([
        source('agent365-disabled', { enabled: false }),
        source('agent365-default', { credential: { mode: 'default' } }),
      ]),
      estate,
    )

    const connector = createAgent365RuntimeConnector(baseConnector(), runtime)

    const health = connector.getConnectorHealth?.()
    expect(health).toMatchObject({
      overall: 'degraded',
      partial: true,
    })
    expect(
      health?.sources.find((source) => source.id === 'agent365:agent365-disabled'),
    ).toMatchObject({
      enabled: false,
      readiness: 'disabled',
      dataState: 'unsupported',
      reason: 'source-disabled',
    })
    expect(
      health?.sources.find((source) => source.id === 'agent365:agent365-default'),
    ).toMatchObject({
      enabled: true,
      configured: false,
      readiness: 'authorization-required',
      dataState: 'unsupported',
      reason: 'managed-identity-required',
    })
    expect(health?.sourceSetFingerprint).toBe(runtime.sourceSetFingerprint)
    await expect(connector.testConnection()).resolves.toMatchObject({
      ok: false,
      message: 'One or more enabled Agent 365 sources are inactive or unavailable.',
    })
  })

  it('ignores only explicitly disabled persisted sources during connection tests', async () => {
    const runtime = await resolveAgent365Runtime(
      repository([source('agent365-disabled', { enabled: false })]),
      estate,
    )

    const connector = createAgent365RuntimeConnector(baseConnector(), runtime)

    await expect(connector.testConnection()).resolves.toEqual({
      ok: true,
      checkedAt: '2026-09-09T00:00:00.000Z',
      message: 'ready',
    })
    expect(connector.getConnectorHealth?.()).toMatchObject({
      overall: 'ready',
      partial: false,
    })
  })

  it('fails connection tests for inactive deployment sources', async () => {
    const deployment = buildDeploymentConnectorSources(
      {
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_SOURCES_JSON: JSON.stringify([
          {
            id: 'deployment',
            name: 'Deployment Agent 365',
            tenantId: estate.tenantId,
            environment: estate.environment,
            credential: { mode: 'default' },
          },
        ]),
      },
      { estates: [estate] },
      'live',
    )
    const runtime = await resolveAgent365Runtime(
      new DeploymentConnectorSourceRepository(repository([]), deployment),
      estate,
    )

    const connector = createAgent365RuntimeConnector(baseConnector(), runtime)

    await expect(connector.testConnection()).resolves.toMatchObject({
      ok: false,
      message: 'One or more enabled Agent 365 sources are inactive or unavailable.',
    })
    expect(connector.getConnectorHealth?.().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent365:deployment',
          enabled: true,
          configured: false,
          readiness: 'authorization-required',
          reason: 'managed-identity-required',
        }),
      ]),
    )
  })

  describe('Agent 365 retained snapshot health projection', () => {
    it('keeps package evidence live only for an exact ready and complete source', () => {
      const snapshot = retainedAgent365Snapshot()
      const projected = projectAgent365SnapshotHealth(snapshot, agent365Health('deployment'), {
        snapshotGeneratedAt: snapshot.generatedAt,
        evidenceDigest: computeSnapshotEvidenceDigest(snapshot),
      })

      expect(projected.evidence[0]).toMatchObject({
        freshness: 'live',
        confidence: 1,
        evidenceTypes: ['declared_configuration'],
        sourceStatus: {
          status: 'live',
          sourceId: 'agent365:deployment',
          readiness: 'ready',
          dataState: 'complete',
          checkedAt: '2026-09-09T00:05:00.000Z',
        },
      })
    })

    it('does not promote retained package evidence from legacy unbound ready health', () => {
      const projected = projectAgent365SnapshotHealth(
        retainedAgent365Snapshot(),
        agent365Health('deployment'),
      )

      expect(projected.evidence[0]).toMatchObject({
        freshness: 'stale',
        confidence: 0,
        evidenceTypes: ['declared_configuration', 'unknown'],
        sourceStatus: {
          status: 'unknown',
          sourceId: 'agent365:deployment',
          readiness: 'unavailable',
          reason: 'source-health-unbound',
        },
      })
    })

    it('does not promote retained package evidence from a different persisted snapshot', () => {
      const snapshot = retainedAgent365Snapshot()
      const projected = projectAgent365SnapshotHealth(snapshot, agent365Health('deployment'), {
        snapshotGeneratedAt: snapshot.generatedAt,
        evidenceDigest: 'f'.repeat(64),
      })

      expect(projected.evidence[0]).toMatchObject({
        freshness: 'stale',
        confidence: 0,
        sourceStatus: {
          status: 'unknown',
          reason: 'source-health-snapshot-mismatch',
        },
      })
    })

    it('marks exact retained package evidence stale when the latest source is not complete and ready', () => {
      const projected = projectAgent365SnapshotHealth(
        retainedAgent365Snapshot(),
        agent365Health('deployment', {
          readiness: 'authorization-required',
          dataState: 'failed',
          reason: 'authorization',
        }),
      )

      expect(projected.evidence[0]).toMatchObject({
        freshness: 'stale',
        confidence: 1,
        evidenceTypes: ['declared_configuration', 'unknown'],
        sourceStatus: {
          status: 'stale',
          sourceId: 'agent365:deployment',
          readiness: 'authorization-required',
          dataState: 'failed',
          reason: 'authorization',
        },
      })
    })

    it('marks retained package evidence unknown when no exact current source health exists', () => {
      const mismatched = agent365Health('other-source')
      const projected = projectAgent365SnapshotHealth(retainedAgent365Snapshot(), mismatched)

      expect(projected.evidence[0]).toMatchObject({
        freshness: 'stale',
        confidence: 0,
        evidenceTypes: ['declared_configuration', 'unknown'],
        sourceStatus: {
          status: 'unknown',
          sourceId: 'agent365:deployment',
          readiness: 'unavailable',
          reason: 'source-health-unavailable',
        },
      })
    })

    it('projects Agent 365 health through every snapshot repository read method', async () => {
      const snapshot = retainedAgent365Snapshot()
      const repository = new Agent365HealthAwareSnapshotRepository(
        {
          save: () => Promise.resolve(),
          findLatest: () => Promise.resolve(snapshot),
          findById: () => Promise.resolve(snapshot),
          list: () => Promise.resolve([snapshot]),
        },
        () =>
          Promise.resolve({
            health: agent365Health('deployment'),
            snapshotBinding: {
              snapshotGeneratedAt: snapshot.generatedAt,
              evidenceDigest: computeSnapshotEvidenceDigest(snapshot),
            },
          }),
      )

      const latest = await repository.findLatest(estate)
      const byId = await repository.findById('snapshot-id', estate)
      const listed = await repository.list(estate)

      for (const projected of [latest, byId, listed[0]]) {
        expect(projected?.evidence[0]).toMatchObject({
          freshness: 'live',
          sourceStatus: {
            status: 'live',
            dataState: 'complete',
          },
        })
      }
    })
  })

  it('marks an enabled legacy deployment without explicit UAMI as non-promotable', async () => {
    const deployment = buildDeploymentConnectorSources(
      {
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_TENANT_ID: estate.tenantId,
        AGENT365_ENVIRONMENT: estate.environment,
      },
      { estates: [estate] },
      'live',
    )
    const runtime = await resolveAgent365Runtime(
      new DeploymentConnectorSourceRepository(repository([]), deployment),
      estate,
    )
    const connector = createAgent365RuntimeConnector(baseConnector(), runtime)

    await expect(connector.testConnection()).resolves.toMatchObject({
      ok: false,
      message: 'One or more enabled Agent 365 sources are inactive or unavailable.',
    })
    expect(connector.getConnectorHealth?.()).toMatchObject({
      overall: 'degraded',
      partial: true,
    })
    expect(
      connector.getConnectorHealth?.().sources.find((source) => source.id === 'agent365:primary'),
    ).toMatchObject({
      enabled: true,
      configured: false,
      readiness: 'authorization-required',
      reason: 'managed-identity-required',
    })
  })

  it('reports duplicate deployment-owned tenant boundaries as degraded configuration', async () => {
    const deployment = buildDeploymentConnectorSources(
      {
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_SOURCES_JSON: JSON.stringify([
          {
            id: 'deployment',
            name: 'Deployment Agent 365',
            tenantId: estate.tenantId,
            environment: estate.environment,
            credential: {
              mode: 'managed-identity',
              managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
            },
          },
        ]),
      },
      { estates: [estate] },
      'live',
    )
    const runtime = await resolveAgent365Runtime(
      new DeploymentConnectorSourceRepository(
        repository([source('agent365-user', { origin: 'user' })]),
        deployment,
      ),
      estate,
    )

    const connector = createAgent365RuntimeConnector(baseConnector(), runtime)
    const duplicate = connector
      .getConnectorHealth?.()
      .sources.find((value) => value.id === 'agent365:agent365-user')
    expect(duplicate).toMatchObject({
      enabled: true,
      configured: false,
      readiness: 'authorization-required',
      dataState: 'unsupported',
      reason: 'deployment-origin-required',
    })
  })

  it('fails runtime connection tests when an enabled source is unauthorized', async () => {
    const runtime = await resolveAgent365Runtime(repository([source('agent365-live')]), estate)
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const token = `${encode({ alg: 'none' })}.${encode({ tid: estate.tenantId })}.signature`
    const connector = createAgent365RuntimeConnector(baseConnector(), runtime, {
      credentialFactory: () => ({
        getToken: () => Promise.resolve({ token, expiresOnTimestamp: Date.now() + 60_000 }),
      }),
      clientFactory: () => ({
        fetcher: () =>
          Promise.resolve(
            Response.json({ error: { code: 'Authorization_RequestDenied' } }, { status: 403 }),
          ),
      }),
    })

    await expect(connector.testConnection()).resolves.toMatchObject({
      ok: false,
      message: 'The base connector or one or more enabled Agent 365 sources are unavailable.',
    })
    expect(connector.getConnectorHealth?.().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent365:agent365-live',
          readiness: 'authorization-required',
          reason: 'authorization',
        }),
      ]),
    )
  })

  it('fails runtime connection tests when enabled source credential initialization fails', async () => {
    const runtime = await resolveAgent365Runtime(repository([source('agent365-live')]), estate)
    const connector = createAgent365RuntimeConnector(baseConnector(), runtime, {
      credentialFactory: () => {
        throw new Error('credential initialization failed')
      },
    })

    await expect(connector.testConnection()).resolves.toMatchObject({
      ok: false,
      message: 'The base connector or one or more enabled Agent 365 sources are unavailable.',
    })
    expect(connector.getConnectorHealth?.().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent365:agent365-live',
          readiness: 'unavailable',
          dataState: 'failed',
          reason: 'request-failed',
        }),
      ]),
    )
  })

  it('changes the source-set fingerprint for source version, ETag, addition, and deletion', () => {
    const first = source('agent365-a')
    const initial = agent365SourceSetFingerprint([
      {
        estateId: first.estateId,
        tenantId: first.tenantId,
        environment: first.environment,
        sourceId: first.sourceId,
        bindingSourceId: first.sourceId,
        displayName: first.displayName,
        origin: first.origin,
        sourceVersion: first.version,
        sourceEtag: first.etag,
        activation: { status: 'active' },
      },
    ])
    const updatedVersion = agent365SourceSetFingerprint([
      {
        estateId: first.estateId,
        tenantId: first.tenantId,
        environment: first.environment,
        sourceId: first.sourceId,
        bindingSourceId: first.sourceId,
        displayName: first.displayName,
        origin: first.origin,
        sourceVersion: first.version + 1,
        sourceEtag: 'etag-updated',
        activation: { status: 'active' },
      },
    ])
    const added = agent365SourceSetFingerprint([
      {
        estateId: first.estateId,
        tenantId: first.tenantId,
        environment: first.environment,
        sourceId: first.sourceId,
        bindingSourceId: first.sourceId,
        displayName: first.displayName,
        origin: first.origin,
        sourceVersion: first.version,
        sourceEtag: first.etag,
        activation: { status: 'active' },
      },
      {
        estateId: first.estateId,
        tenantId: first.tenantId,
        environment: first.environment,
        sourceId: 'agent365-b',
        bindingSourceId: 'agent365-b',
        displayName: 'Agent 365 B',
        origin: 'user',
        sourceVersion: 1,
        sourceEtag: 'etag-b',
        activation: { status: 'inactive', reason: 'duplicate-tenant-boundary' },
      },
    ])

    expect(new Set([initial, updatedVersion, added, agent365SourceSetFingerprint([])]).size).toBe(4)
  })

  it.each([
    {
      name: 'source generation changed',
      measuredAt: '2026-09-09T00:00:00.000Z',
      sourceSetFingerprint: '0'.repeat(64),
      now: new Date('2026-09-09T00:05:00.000Z'),
      reason: 'source-set-changed',
    },
    {
      name: 'measurement expired',
      measuredAt: '2026-09-07T00:00:00.000Z',
      sourceSetFingerprint: undefined,
      now: new Date('2026-09-09T00:00:00.001Z'),
      reason: 'measurement-expired',
    },
  ])(
    'renders persisted health stale when the $name',
    ({ measuredAt, sourceSetFingerprint, now, reason }) => {
      const bindings = [
        {
          estateId: estate.id,
          tenantId: estate.tenantId,
          environment: estate.environment,
          sourceId: 'agent365-current',
          bindingSourceId: 'agent365-current',
          displayName: 'Current Agent 365',
          origin: 'user' as const,
          sourceVersion: 3,
          sourceEtag: 'etag-current',
          activation: { status: 'active' as const },
        },
      ]
      const currentFingerprint = agent365SourceSetFingerprint(bindings)
      const measurement: ConnectorHealthMeasurement = {
        estateId: estate.id,
        tenantId: estate.tenantId,
        environment: estate.environment,
        connectorId: 'base',
        measuredAt,
        ...(sourceSetFingerprint === undefined
          ? { sourceSetFingerprint: currentFingerprint }
          : { sourceSetFingerprint }),
        health: {
          overall: 'ready',
          partial: false,
          sourceSetFingerprint:
            sourceSetFingerprint === undefined ? currentFingerprint : sourceSetFingerprint,
          sources: [
            {
              id: 'agent365:deleted-or-changed',
              name: 'Old Agent 365',
              role: 'discovery',
              enabled: true,
              configured: true,
              readiness: 'ready',
              dataState: 'complete',
              pages: 2,
              records: 25,
              checkedAt: measuredAt,
              provenance: {
                estateTenantId: estate.tenantId,
                estateEnvironment: estate.environment,
                sourceConnectorId: 'deleted-or-changed',
                sourceTenantId: estate.tenantId,
                sourceEnvironment: estate.environment,
                provider: 'microsoft-graph-agent365-package-catalog',
                providerObjectId: '/v1.0/copilot/admin/catalog/packages',
              },
            },
          ],
        },
      }

      const health = reconcileAgent365PersistedHealth(measurement, bindings, now)

      expect(health).toMatchObject({
        overall: 'degraded',
        partial: true,
      })
      expect(
        health.sources.find((source) => source.id === 'agent365:deleted-or-changed'),
      ).toMatchObject({
        readiness: 'degraded',
        dataState: 'stale',
        pages: 2,
        records: 25,
        checkedAt: measuredAt,
        reason,
        provenance: {
          sourceConnectorId: 'deleted-or-changed',
        },
      })
      expect(
        health.sources.find((source) => source.id === 'agent365:agent365-current'),
      ).toMatchObject({
        readiness: 'degraded',
        dataState: 'stale',
        reason,
      })
      expect(
        now.getTime() - Date.parse(measuredAt) > AGENT365_HEALTH_MAX_AGE_MS ||
          measurement.sourceSetFingerprint !== currentFingerprint,
      ).toBe(true)
    },
  )

  it('keeps deployment runtime provenance on bindingSourceId during health reconciliation', () => {
    const measuredAt = '2026-09-09T00:00:00.000Z'
    const binding = {
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      sourceId: 'agent365-primary',
      bindingSourceId: 'primary',
      displayName: 'Primary Agent 365',
      origin: 'deployment' as const,
      sourceVersion: 1,
      sourceEtag: 'deployment-etag',
      activation: { status: 'active' as const },
    }
    const measurement: ConnectorHealthMeasurement = {
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      connectorId: 'base',
      measuredAt,
      sourceSetFingerprint: '0'.repeat(64),
      health: {
        overall: 'ready',
        partial: false,
        sourceSetFingerprint: '0'.repeat(64),
        sources: [
          {
            id: 'agent365:primary',
            name: 'Old name',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
            dataState: 'complete',
            checkedAt: measuredAt,
            provenance: {
              estateTenantId: estate.tenantId,
              estateEnvironment: estate.environment,
              sourceConnectorId: 'primary',
              sourceTenantId: estate.tenantId,
              sourceEnvironment: estate.environment,
              provider: 'microsoft-graph-agent365-package-catalog',
              providerObjectId: '/v1.0/copilot/admin/catalog/packages',
            },
          },
        ],
      },
    }

    const health = reconcileAgent365PersistedHealth(
      measurement,
      [binding],
      new Date('2026-09-09T00:05:00.000Z'),
    )

    expect(health.sources[0]).toMatchObject({
      id: 'agent365:primary',
      name: 'Primary Agent 365',
      provenance: {
        sourceConnectorId: 'primary',
      },
    })
    expect(health.sources[0]?.provenance?.sourceConnectorId).not.toBe('agent365-primary')
  })

  it('normalizes changed deployment health from configuration sourceId to bindingSourceId', () => {
    const measuredAt = '2026-09-09T00:00:00.000Z'
    const binding = {
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      sourceId: 'agent365-primary',
      bindingSourceId: 'primary',
      displayName: 'Primary Agent 365',
      origin: 'deployment' as const,
      sourceVersion: 2,
      sourceEtag: 'deployment-etag-v2',
      activation: { status: 'active' as const },
    }
    const measurement: ConnectorHealthMeasurement = {
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      connectorId: 'base',
      measuredAt,
      sourceSetFingerprint: '0'.repeat(64),
      health: {
        overall: 'ready',
        partial: false,
        sourceSetFingerprint: '0'.repeat(64),
        sources: [
          {
            id: 'agent365:agent365-primary',
            name: 'Configuration source name',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
            dataState: 'complete',
            checkedAt: measuredAt,
            provenance: {
              estateTenantId: estate.tenantId,
              estateEnvironment: estate.environment,
              sourceConnectorId: 'agent365-primary',
              sourceTenantId: estate.tenantId,
              sourceEnvironment: estate.environment,
              provider: 'microsoft-graph-agent365-package-catalog',
              providerObjectId: '/v1.0/copilot/admin/catalog/packages',
            },
          },
        ],
      },
    }

    const health = reconcileAgent365PersistedHealth(
      measurement,
      [binding],
      new Date('2026-09-09T00:05:00.000Z'),
    )

    expect(health.sources.filter((source) => source.id.startsWith('agent365:'))).toMatchObject([
      {
        id: 'agent365:primary',
        name: 'Primary Agent 365',
        readiness: 'degraded',
        dataState: 'stale',
        reason: 'source-set-changed',
        provenance: {
          sourceConnectorId: 'primary',
        },
      },
    ])

    const currentFingerprint = agent365SourceSetFingerprint([binding])
    const expired = reconcileAgent365PersistedHealth(
      {
        ...measurement,
        measuredAt: '2026-09-07T00:00:00.000Z',
        sourceSetFingerprint: currentFingerprint,
        health: {
          ...measurement.health,
          sourceSetFingerprint: currentFingerprint,
        },
      },
      [binding],
      new Date('2026-09-09T00:00:00.001Z'),
    )

    expect(expired.sources.filter((source) => source.id.startsWith('agent365:'))).toMatchObject([
      {
        id: 'agent365:primary',
        reason: 'measurement-expired',
        provenance: {
          sourceConnectorId: 'primary',
        },
      },
    ])
  })

  it('expires every enabled source before applying Agent365 source-set mismatch', () => {
    const measuredAt = '2026-09-07T00:00:00.000Z'
    const binding = {
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      sourceId: 'agent365-current',
      bindingSourceId: 'agent365-current',
      displayName: 'Current Agent 365',
      origin: 'user' as const,
      sourceVersion: 3,
      sourceEtag: 'etag-current',
      activation: { status: 'active' as const },
    }
    const measurement: ConnectorHealthMeasurement = {
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      connectorId: 'base',
      measuredAt,
      sourceSetFingerprint: '0'.repeat(64),
      health: {
        overall: 'ready',
        partial: false,
        sourceSetFingerprint: '0'.repeat(64),
        sources: [
          {
            id: 'foundry:primary',
            name: 'Foundry',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
            dataState: 'complete',
            checkedAt: measuredAt,
          },
          {
            id: 'agent365:old',
            name: 'Old Agent 365',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
            dataState: 'complete',
            checkedAt: measuredAt,
          },
        ],
      },
    }

    const health = reconcileAgent365PersistedHealth(
      measurement,
      [binding],
      new Date('2026-09-09T00:00:00.001Z'),
    )

    expect(health.sources.find((source) => source.id === 'foundry:primary')).toMatchObject({
      readiness: 'degraded',
      dataState: 'stale',
      reason: 'measurement-expired',
    })
    expect(health.sources.find((source) => source.id === 'agent365:old')).toMatchObject({
      readiness: 'degraded',
      dataState: 'stale',
      reason: 'source-set-changed',
    })
    expect(
      health.sources.find((source) => source.id === 'agent365:agent365-current'),
    ).toMatchObject({
      readiness: 'degraded',
      dataState: 'stale',
      reason: 'source-set-changed',
    })
  })

  it.each([
    {
      name: 'enabled source becomes disabled',
      measured: {
        enabled: true,
        configured: true,
        readiness: 'ready' as const,
        dataState: 'complete' as const,
      },
      activation: { status: 'inactive' as const, reason: 'source-disabled' as const },
      expected: {
        enabled: false,
        configured: true,
        readiness: 'disabled',
        dataState: 'unsupported',
        reason: 'source-disabled',
      },
    },
    {
      name: 'disabled source becomes enabled',
      measured: {
        enabled: false,
        configured: true,
        readiness: 'disabled' as const,
        dataState: 'unsupported' as const,
        reason: 'source-disabled',
      },
      activation: { status: 'active' as const },
      expected: {
        enabled: true,
        configured: true,
        readiness: 'degraded',
        dataState: 'stale',
        reason: 'source-set-changed',
      },
    },
  ])('reconciles same-ID health when an $name', ({ measured, activation, expected }) => {
    const binding = {
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      sourceId: 'agent365-transition',
      bindingSourceId: 'agent365-transition',
      displayName: 'Current Agent 365',
      origin: 'user' as const,
      sourceVersion: 3,
      sourceEtag: 'etag-current',
      activation,
    }
    const measurement: ConnectorHealthMeasurement = {
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      connectorId: 'base',
      measuredAt: '2026-09-09T00:00:00.000Z',
      sourceSetFingerprint: '0'.repeat(64),
      health: {
        overall: 'ready',
        partial: false,
        sourceSetFingerprint: '0'.repeat(64),
        sources: [
          {
            id: 'agent365:agent365-transition',
            name: 'Prior Agent 365',
            role: 'discovery',
            ...measured,
            checkedAt: '2026-09-09T00:00:00.000Z',
          },
        ],
      },
    }

    const health = reconcileAgent365PersistedHealth(
      measurement,
      [binding],
      new Date('2026-09-09T00:05:00.000Z'),
    )

    expect(health.sources.filter((source) => source.id === 'agent365:agent365-transition')).toEqual(
      [
        expect.objectContaining({
          name: 'Current Agent 365',
          ...expected,
        }),
      ],
    )
  })
})
