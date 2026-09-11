import { describe, expect, it, vi } from 'vitest'

import type {
  ConnectorSourceDefinition,
  ConnectorSourceReadModel,
  ConnectorSourceRepository,
  EstateContext,
} from '@agent-sentinel/domain'
import { hydratePersistedConnectorSourceDefinition } from '@agent-sentinel/domain'
import type { OperationAwareAgentConnector } from '@agent-sentinel/connector-sdk'
import { resolveAgent365Runtime } from '@agent-sentinel/connector-runtime'

import {
  buildConnector,
  buildConnectorForEstate,
  buildRuntimeTelemetryConnector,
  validateJobsStartupConfiguration,
} from '../src/connector-factory.js'

const runtimeEstate: EstateContext = {
  id: 'estate-a',
  tenantId: '11111111-1111-4111-8111-111111111111',
  environment: 'validation',
}

function agent365RuntimeSource(): ConnectorSourceDefinition {
  return {
    estateId: runtimeEstate.id,
    tenantId: runtimeEstate.tenantId,
    environment: runtimeEstate.environment,
    sourceId: 'agent365-live',
    connectorType: 'agent365',
    displayName: 'Live Agent 365',
    enabled: true,
    origin: 'deployment',
    configuration: {
      type: 'agent365',
      graphBaseUrl: 'https://graph.microsoft.com',
      limits: {
        maxPages: 3,
        maxItems: 500,
        requestTimeoutMs: 5_000,
        maxRetries: 1,
        maxRetryAfterMs: 1_000,
        maxResponseBytes: 50_000,
      },
    },
    credential: {
      mode: 'managed-identity',
      managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
    },
    testStatus: { status: 'not-tested' },
    version: 1,
    etag: 'etag-agent365-live',
    createdBy: { type: 'deployment', id: 'deployment-json' },
    updatedBy: { type: 'deployment', id: 'deployment-json' },
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  }
}

function migrationRequiredOtelSource(): ConnectorSourceReadModel {
  return hydratePersistedConnectorSourceDefinition({
    estateId: runtimeEstate.id,
    tenantId: runtimeEstate.tenantId,
    environment: runtimeEstate.environment,
    sourceId: 'azure-monitor-legacy',
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
    etag: 'etag-azure-monitor-legacy',
    createdBy: { type: 'service-principal', id: 'configuration-api' },
    updatedBy: { type: 'service-principal', id: 'configuration-api' },
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  })
}

function runtimeRepository(values: readonly ConnectorSourceReadModel[]): ConnectorSourceRepository {
  return {
    create: () => Promise.reject(new Error('not used')),
    findById: () => Promise.resolve(null),
    list: (_estate, limit = 100, cursor) =>
      Promise.resolve(
        values
          .filter((value) => cursor === undefined || value.sourceId > cursor)
          .toSorted((left, right) => left.sourceId.localeCompare(right.sourceId))
          .slice(0, limit),
      ),
    update: () => Promise.reject(new Error('not used')),
    delete: () => Promise.reject(new Error('not used')),
    listAudit: () => Promise.resolve([]),
  }
}

describe('jobs connector selection', () => {
  it('fails startup validation for invalid enabled Agent 365 deployment configuration', () => {
    expect(() =>
      validateJobsStartupConfiguration('foundry', runtimeEstate, {
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_SOURCES_JSON: ' ',
        AGENT365_TENANT_ID: ' ',
        AGENT365_ENVIRONMENT: ' ',
      }),
    ).toThrow(
      'AGENT365_TENANT_ID and AGENT365_ENVIRONMENT are required when no source JSON is supplied.',
    )
  })

  it('does not validate inactive Agent 365 deployment configuration in mock startup mode', () => {
    expect(() =>
      validateJobsStartupConfiguration('mock', runtimeEstate, {
        AGENT365_CONNECTOR_ENABLED: 'true',
      }),
    ).not.toThrow()
  })

  it('keeps mock mode independent of Entra configuration', () => {
    expect(buildConnector('mock', { ENTRA_CONNECTOR_ENABLED: 'true' }).descriptor.id).toBe(
      'mock-agent-estate',
    )
    expect(buildRuntimeTelemetryConnector('mock', {})).toBeUndefined()
  })

  it('wires Azure Monitor runtime evidence for the jobs ingestion path', () => {
    const connector = buildRuntimeTelemetryConnector(
      'foundry',
      {
        AZURE_MONITOR_WORKSPACE_ID: '11111111-1111-4111-8111-111111111111',
        AZURE_MONITOR_TENANT_ID: '22222222-2222-4222-8222-222222222222',
        AZURE_MONITOR_ENVIRONMENT: 'production',
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/project-a',
      },
      { getToken: () => Promise.resolve(null) },
    )

    expect(connector?.id).toBe('azure-monitor-otel')
  })

  it('rejects an overlong Foundry project before constructing connector credentials', () => {
    const credentialFactory = vi.fn(() => ({ getToken: () => Promise.resolve(null) }))

    expect(() =>
      buildConnector(
        'foundry',
        {
          FOUNDRY_PROJECT_ENDPOINT: `https://example.services.ai.azure.com/api/projects/${'p'.repeat(
            201,
          )}`,
          FOUNDRY_TENANT_ID: '11111111-1111-4111-8111-111111111111',
          FOUNDRY_ENVIRONMENT: 'validation',
        },
        { credentialFactory },
      ),
    ).toThrow()
    expect(credentialFactory).not.toHaveBeenCalled()
  })

  it('wires optional Entra enrichment around Foundry discovery', () => {
    const connector = buildConnector(
      'foundry',
      {
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
        FOUNDRY_TENANT_ID: '11111111-1111-4111-8111-111111111111',
        FOUNDRY_ENVIRONMENT: 'validation',
        ENTRA_CONNECTOR_ENABLED: 'true',
        ENTRA_CONNECTOR_TENANT_ID: '11111111-1111-4111-8111-111111111111',
        ENTRA_CONNECTOR_ENVIRONMENT: 'validation',
      },
      {
        credential: { getToken: () => Promise.resolve(null) },
      },
    )

    expect(connector.descriptor.id).toBe('azure-ai-foundry-agent-service')
    expect(connector.getConnectorHealth?.()).toMatchObject({
      sources: [
        { id: 'foundry:primary' },
        {
          id: 'entra:primary',
          enabled: true,
          configured: true,
          readiness: 'degraded',
        },
      ],
    })
  })

  it('exposes health for every configured Foundry source', () => {
    const connector = buildConnector(
      'foundry',
      {
        AGENT_SENTINEL_TENANT_ID: 'estate',
        FOUNDRY_ENVIRONMENT: 'portfolio',
        FOUNDRY_SOURCES_JSON: JSON.stringify([
          {
            id: 'project-a',
            name: 'Project A',
            projectEndpoint: 'https://a.services.ai.azure.com/api/projects/a',
            tenantId: 'tenant-a',
            environment: 'production',
          },
          {
            id: 'project-b',
            name: 'Project B',
            projectEndpoint: 'https://b.services.ai.azure.com/api/projects/b',
            tenantId: 'tenant-b',
            environment: 'validation',
          },
        ]),
      },
      {
        credentialFactory: () => ({
          getToken: (_scopes, options) =>
            new Promise((_resolve, reject) => {
              options?.abortSignal?.addEventListener(
                'abort',
                () => reject(new DOMException('aborted', 'AbortError')),
                { once: true },
              )
            }),
        }),
      },
    )

    expect(connector.getConnectorHealth?.().sources.map((source) => source.id)).toEqual([
      'foundry:project-a',
      'foundry:project-b',
      'entra:project-a',
      'entra:project-b',
    ])
  })

  it('wires an independent Power Platform discovery family after Entra', () => {
    const connector = buildConnector(
      'foundry',
      {
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
        FOUNDRY_TENANT_ID: '11111111-1111-4111-8111-111111111111',
        FOUNDRY_ENVIRONMENT: 'validation',
        POWER_PLATFORM_CONNECTOR_ENABLED: 'true',
        POWER_PLATFORM_TENANT_ID: '11111111-1111-4111-8111-111111111111',
        POWER_PLATFORM_ENVIRONMENT: 'studio-environment',
      },
      {
        credential: { getToken: () => Promise.resolve(null) },
        powerPlatformClient: {
          fetcher: () => Promise.resolve(Response.json({})),
        },
      },
    )

    expect(connector.getConnectorHealth?.().sources.map((source) => source.id)).toEqual([
      'foundry:primary',
      'entra:primary',
      'power-platform:primary',
    ])
  })
  it('wires Agent 365 after Power Platform with injectable client options', () => {
    const connector = buildConnector(
      'foundry',
      {
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
        FOUNDRY_TENANT_ID: '11111111-1111-4111-8111-111111111111',
        FOUNDRY_ENVIRONMENT: 'validation',
        POWER_PLATFORM_CONNECTOR_ENABLED: 'true',
        POWER_PLATFORM_TENANT_ID: '11111111-1111-4111-8111-111111111111',
        POWER_PLATFORM_ENVIRONMENT: 'studio-environment',
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_TENANT_ID: '22222222-2222-4222-8222-222222222222',
        AGENT365_ENVIRONMENT: 'agent365-global',
      },
      {
        credential: { getToken: () => Promise.resolve(null) },
        agent365Client: { fetcher: () => Promise.resolve(Response.json({ value: [] })) },
      },
    )
    expect(connector.getConnectorHealth?.().sources.map((source) => source.id)).toEqual([
      'foundry:primary',
      'entra:primary',
      'power-platform:primary',
      'agent365:primary',
    ])
  })

  it('activates an approved persisted deployment Agent 365 source for the exact jobs estate', async () => {
    const connector = await buildConnectorForEstate(
      runtimeEstate,
      runtimeRepository([agent365RuntimeSource()]),
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
        AGENT_SENTINEL_TENANT_ID: runtimeEstate.tenantId,
        AGENT_SENTINEL_ENVIRONMENT: runtimeEstate.environment,
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
        FOUNDRY_TENANT_ID: runtimeEstate.tenantId,
        FOUNDRY_ENVIRONMENT: runtimeEstate.environment,
        AGENT365_CONNECTOR_ENABLED: 'false',
      },
      {
        credentialFactory: () => ({ getToken: () => Promise.resolve(null) }),
        agent365CredentialFactory: () => ({ getToken: () => Promise.resolve(null) }),
        agent365Client: {
          fetcher: () => Promise.resolve(Response.json({ value: [] })),
        },
      },
    )

    expect(connector.getConnectorHealth?.().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent365:agent365-live',
          configured: true,
          readiness: 'degraded',
        }),
      ]),
    )
  })

  it('keeps a cross-tenant Agent 365 provider source in the portfolio jobs runtime', async () => {
    const providerTenantId = '22222222-2222-4222-8222-222222222222'
    const connector = await buildConnectorForEstate(runtimeEstate, runtimeRepository([]), {
      AGENT_SENTINEL_CONNECTOR: 'foundry',
      AGENT_SENTINEL_TENANT_ID: runtimeEstate.tenantId,
      AGENT_SENTINEL_ENVIRONMENT: runtimeEstate.environment,
      FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
      FOUNDRY_TENANT_ID: runtimeEstate.tenantId,
      FOUNDRY_ENVIRONMENT: runtimeEstate.environment,
      AGENT365_CONNECTOR_ENABLED: 'true',
      AGENT365_MANAGED_IDENTITY_CLIENT_ID: '59dbea72-1e91-403a-89cf-e02cdb8da350',
      AGENT365_SOURCES_JSON: JSON.stringify([
        {
          id: 'provider',
          name: 'Provider Agent 365',
          tenantId: providerTenantId,
          environment: 'provider-production',
        },
      ]),
    })

    expect(
      connector.getConnectorHealth?.().sources.find((source) => source.id === 'agent365:provider'),
    ).toMatchObject({
      provenance: {
        estateTenantId: runtimeEstate.tenantId,
        estateEnvironment: runtimeEstate.environment,
        sourceConnectorId: 'provider',
        sourceTenantId: providerTenantId,
        sourceEnvironment: 'provider-production',
      },
    })
  })

  it('activates Agent 365 when a migration-required legacy OTel source coexists in the jobs repository', async () => {
    const connector = await buildConnectorForEstate(
      runtimeEstate,
      runtimeRepository([migrationRequiredOtelSource(), agent365RuntimeSource()]),
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
        AGENT_SENTINEL_TENANT_ID: runtimeEstate.tenantId,
        AGENT_SENTINEL_ENVIRONMENT: runtimeEstate.environment,
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
        FOUNDRY_TENANT_ID: runtimeEstate.tenantId,
        FOUNDRY_ENVIRONMENT: runtimeEstate.environment,
        AGENT365_CONNECTOR_ENABLED: 'false',
      },
      {
        credentialFactory: () => ({ getToken: () => Promise.resolve(null) }),
        agent365CredentialFactory: () => ({ getToken: () => Promise.resolve(null) }),
        agent365Client: {
          fetcher: () => Promise.resolve(Response.json({ value: [] })),
        },
      },
    )

    expect(
      connector
        .getConnectorHealth?.()
        .sources.some((source) => source.id === 'agent365:agent365-live'),
    ).toBe(true)
  })

  it('fails the jobs factory closed for a malformed Agent 365 repository record', async () => {
    const malformed = {
      ...agent365RuntimeSource(),
      migration: {
        status: 'migration-required',
        active: false,
        reason: 'missing-source-project-id',
        action: 'supply-exact-source-project-id',
      },
    } as unknown as ConnectorSourceReadModel

    await expect(
      buildConnectorForEstate(runtimeEstate, runtimeRepository([malformed]), {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
        AGENT_SENTINEL_TENANT_ID: runtimeEstate.tenantId,
        AGENT_SENTINEL_ENVIRONMENT: runtimeEstate.environment,
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
        FOUNDRY_TENANT_ID: runtimeEstate.tenantId,
        FOUNDRY_ENVIRONMENT: runtimeEstate.environment,
      }),
    ).rejects.toThrow()
  })

  it('rejects an enabled Agent 365 jobs deployment without a source boundary', async () => {
    await expect(
      buildConnectorForEstate(
        runtimeEstate,
        runtimeRepository([]),
        {
          AGENT_SENTINEL_CONNECTOR: 'foundry',
          FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
          FOUNDRY_TENANT_ID: runtimeEstate.tenantId,
          FOUNDRY_ENVIRONMENT: runtimeEstate.environment,
          AGENT365_CONNECTOR_ENABLED: 'true',
          AGENT365_SOURCES_JSON: ' ',
          AGENT365_TENANT_ID: ' ',
          AGENT365_ENVIRONMENT: ' ',
        },
        {
          credentialFactory: () => ({ getToken: () => Promise.resolve(null) }),
        },
      ),
    ).rejects.toThrow(
      'AGENT365_TENANT_ID and AGENT365_ENVIRONMENT are required when no source JSON is supplied.',
    )
  })

  it('reports an enabled Agent 365 jobs deployment without explicit UAMI as inactive', async () => {
    const connector = await buildConnectorForEstate(
      runtimeEstate,
      runtimeRepository([]),
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
        FOUNDRY_TENANT_ID: runtimeEstate.tenantId,
        FOUNDRY_ENVIRONMENT: runtimeEstate.environment,
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_TENANT_ID: runtimeEstate.tenantId,
        AGENT365_ENVIRONMENT: runtimeEstate.environment,
      },
      {
        credentialFactory: () => ({ getToken: () => Promise.resolve(null) }),
      },
    )

    expect(connector.getConnectorHealth?.().partial).toBe(true)
    expect(
      connector.getConnectorHealth?.().sources.find((source) => source.id === 'agent365:primary'),
    ).toMatchObject({
      enabled: true,
      configured: false,
      readiness: 'authorization-required',
      dataState: 'unsupported',
      reason: 'managed-identity-required',
    })
  })

  it('passes the exact zero-binding Agent 365 runtime in the estate jobs factory', async () => {
    const fallbackRuntime = await resolveAgent365Runtime(
      runtimeRepository([agent365RuntimeSource()]),
      runtimeEstate,
    )
    const connector = await buildConnectorForEstate(
      runtimeEstate,
      runtimeRepository([]),
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
        AGENT_SENTINEL_TENANT_ID: runtimeEstate.tenantId,
        AGENT_SENTINEL_ENVIRONMENT: runtimeEstate.environment,
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
        FOUNDRY_TENANT_ID: runtimeEstate.tenantId,
        FOUNDRY_ENVIRONMENT: runtimeEstate.environment,
      },
      {
        credentialFactory: () => ({ getToken: () => Promise.resolve(null) }),
        agent365Runtime: fallbackRuntime,
      },
    )

    expect(
      connector
        .getConnectorHealth?.()
        .sources.filter((source) => source.id.startsWith('agent365:')),
    ).toEqual([])
  })

  it('preserves deployment Agent 365 duration through jobs runtime resolution', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          )
        }),
    )
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const token = `${encode({ alg: 'none' })}.${encode({ tid: runtimeEstate.tenantId })}.signature`
    const connector = await buildConnectorForEstate(
      runtimeEstate,
      runtimeRepository([]),
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
        AGENT_SENTINEL_TENANT_ID: runtimeEstate.tenantId,
        AGENT_SENTINEL_ENVIRONMENT: runtimeEstate.environment,
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
        FOUNDRY_TENANT_ID: runtimeEstate.tenantId,
        FOUNDRY_ENVIRONMENT: runtimeEstate.environment,
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_TENANT_ID: runtimeEstate.tenantId,
        AGENT365_ENVIRONMENT: runtimeEstate.environment,
        AGENT365_MANAGED_IDENTITY_CLIENT_ID: '59dbea72-1e91-403a-89cf-e02cdb8da350',
        AGENT365_MAX_CONCURRENCY: '1',
        AGENT365_MAX_DURATION_MS: '100',
      },
      {
        credentialFactory: () => ({ getToken: () => Promise.resolve(null) }),
        agent365CredentialFactory: () => ({
          getToken: () =>
            Promise.resolve({
              token,
              expiresOnTimestamp: Date.now() + 60_000,
            }),
        }),
        agent365Client: { fetcher },
      },
    )
    const external = new AbortController()
    const fallback = setTimeout(() => external.abort(), 500)

    await (connector as OperationAwareAgentConnector).testConnection({
      signal: external.signal,
    })
    clearTimeout(fallback)

    expect(fetcher).toHaveBeenCalledOnce()
    expect(
      connector.getConnectorHealth?.().sources.find((source) => source.id === 'agent365:primary'),
    ).toMatchObject({
      readiness: 'unavailable',
      dataState: 'cancelled',
      reason: 'duration-exceeded',
    })
  })

  it('wires Defender for Cloud Apps after optional Agent 365', () => {
    const connector = buildConnector(
      'foundry',
      {
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
        FOUNDRY_TENANT_ID: '11111111-1111-4111-8111-111111111111',
        FOUNDRY_ENVIRONMENT: 'validation',
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_TENANT_ID: '22222222-2222-4222-8222-222222222222',
        AGENT365_ENVIRONMENT: 'agent365-global',
        DEFENDER_CLOUD_APPS_CONNECTOR_ENABLED: 'true',
        DEFENDER_CLOUD_APPS_TENANT_ID: '33333333-3333-4333-8333-333333333333',
        DEFENDER_CLOUD_APPS_ENVIRONMENT: 'security-evidence',
        DEFENDER_CLOUD_APPS_API_BASE_URL: 'https://contoso.us2.portal.cloudappsecurity.com',
      },
      {
        credential: { getToken: () => Promise.resolve(null) },
        defenderCloudAppsClient: {
          fetcher: () => Promise.resolve(Response.json({ data: [], hasNext: false })),
        },
      },
    )
    expect(connector.getConnectorHealth?.().sources.map((source) => source.id)).toEqual([
      'foundry:primary',
      'entra:primary',
      'agent365:primary',
      'defender-cloud-apps:primary',
    ])
  })

  it('wires Purview after Defender for Cloud Apps', () => {
    const connector = buildConnector(
      'foundry',
      {
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
        FOUNDRY_TENANT_ID: '11111111-1111-4111-8111-111111111111',
        FOUNDRY_ENVIRONMENT: 'validation',
        DEFENDER_CLOUD_APPS_CONNECTOR_ENABLED: 'true',
        DEFENDER_CLOUD_APPS_TENANT_ID: '22222222-2222-4222-8222-222222222222',
        DEFENDER_CLOUD_APPS_ENVIRONMENT: 'security',
        DEFENDER_CLOUD_APPS_PORTAL_HOSTNAME: 'contoso.us2.portal.cloudappsecurity.com',
        PURVIEW_CONNECTOR_ENABLED: 'true',
        PURVIEW_TENANT_ID: '33333333-3333-4333-8333-333333333333',
        PURVIEW_ENVIRONMENT: 'governance',
      },
      {
        credential: { getToken: () => Promise.resolve(null) },
        defenderCloudAppsClient: {
          fetcher: () => Promise.resolve(Response.json({ data: [], hasNext: false })),
        },
        purviewClient: { fetcher: () => Promise.resolve(Response.json({ value: [] })) },
      },
    )
    expect(connector.getConnectorHealth?.().sources.map((source) => source.id)).toEqual([
      'foundry:primary',
      'entra:primary',
      'defender-cloud-apps:primary',
      'purview:primary',
    ])
  })

  it('wires Teams distribution after Purview', () => {
    const connector = buildConnector(
      'foundry',
      {
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
        FOUNDRY_TENANT_ID: '11111111-1111-1111-1111-111111111111',
        FOUNDRY_ENVIRONMENT: 'validation',
        PURVIEW_CONNECTOR_ENABLED: 'true',
        PURVIEW_TENANT_ID: '22222222-2222-2222-2222-222222222222',
        PURVIEW_ENVIRONMENT: 'governance',
        TEAMS_DISTRIBUTION_CONNECTOR_ENABLED: 'true',
        TEAMS_DISTRIBUTION_TENANT_ID: '33333333-3333-3333-3333-333333333333',
        TEAMS_DISTRIBUTION_ENVIRONMENT: 'catalog',
      },
      {
        credential: { getToken: () => Promise.resolve(null) },
        purviewClient: { fetcher: () => Promise.resolve(Response.json({ value: [] })) },
        teamsDistributionClient: {
          fetcher: () => Promise.resolve(Response.json({ value: [] })),
        },
      },
    )
    expect(connector.getConnectorHealth?.().sources.map((source) => source.id)).toEqual([
      'foundry:primary',
      'entra:primary',
      'purview:primary',
      'teams-distribution:primary',
    ])
  })

  it('wires Azure Resource Graph after Purview', () => {
    const tenantId = '11111111-1111-4111-8111-111111111111'
    const subscriptionId = '22222222-2222-4222-8222-222222222222'
    const connector = buildConnector(
      'foundry',
      {
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
        FOUNDRY_TENANT_ID: tenantId,
        FOUNDRY_ENVIRONMENT: 'validation',
        AZURE_RESOURCE_GRAPH_CONNECTOR_ENABLED: 'true',
        AZURE_RESOURCE_GRAPH_SOURCES_JSON: JSON.stringify([
          {
            id: 'primary',
            name: 'Primary Azure subscription',
            tenantId,
            environment: 'validation',
            subscriptions: [subscriptionId],
          },
        ]),
      },
      {
        credential: { getToken: () => Promise.resolve(null) },
        azureResourceGraphClient: {
          fetcher: () =>
            Promise.resolve(
              Response.json({
                totalRecords: 0,
                count: 0,
                resultTruncated: 'false',
                data: [],
              }),
            ),
        },
      },
    )
    expect(connector.getConnectorHealth?.().sources.map((source) => source.id)).toEqual([
      'foundry:primary',
      'entra:primary',
      'azure-resource-graph:primary',
    ])
  })
})
