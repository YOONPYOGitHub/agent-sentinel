import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ConnectorSourceDefinition,
  ConnectorSourceRepository,
  EstateContext,
} from '@agent-sentinel/domain'
import type { OperationAwareAgentConnector } from '@agent-sentinel/connector-sdk'
import {
  buildDeploymentConnectorSources,
  resolveAgent365Runtime,
} from '@agent-sentinel/connector-runtime'

import {
  createConfiguredConnector,
  createConfiguredConnectorForEstate,
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
    origin: 'user',
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
    createdBy: { type: 'service-principal', id: 'configuration-api' },
    updatedBy: { type: 'service-principal', id: 'configuration-api' },
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  }
}

function runtimeRepository(
  values: readonly ConnectorSourceDefinition[],
): ConnectorSourceRepository {
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

afterEach(() => vi.unstubAllGlobals())

describe('connector selection', () => {
  it('defaults to mock', () => {
    expect(createConfiguredConnector({}).mode).toBe('mock')
  })
  it('rejects incomplete foundry configuration', () => {
    expect(() => createConfiguredConnector({ AGENT_SENTINEL_CONNECTOR: 'foundry' })).toThrow(
      'FOUNDRY_PROJECT_ENDPOINT',
    )
  })
  it('selects foundry with complete configuration', () => {
    const result = createConfiguredConnector({
      AGENT_SENTINEL_CONNECTOR: 'foundry',
      FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
      FOUNDRY_TENANT_ID: 'tenant',
      FOUNDRY_ENVIRONMENT: 'validation',
    })
    expect(result.mode).toBe('foundry')
    expect(result.tenantId).toBe('tenant')
    expect(result.environment).toBe('validation')
  })

  it('wires Entra enrichment with an exact tenant and environment boundary', () => {
    const result = createConfiguredConnector(
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
        FOUNDRY_TENANT_ID: '11111111-1111-4111-8111-111111111111',
        FOUNDRY_ENVIRONMENT: 'validation',
        ENTRA_CONNECTOR_ENABLED: 'true',
        ENTRA_CONNECTOR_TENANT_ID: '22222222-2222-4222-8222-222222222222',
        ENTRA_CONNECTOR_ENVIRONMENT: 'validation',
      },
      {
        credential: { getToken: () => Promise.resolve(null) },
      },
    )

    expect(result.connector.getConnectorHealth?.()).toMatchObject({
      sources: [
        { id: 'foundry:primary' },
        {
          id: 'entra:primary',
          enabled: true,
          configured: true,
          readiness: 'degraded',
          reason: 'missing-explicit-source-binding',
        },
      ],
    })
  })

  it('builds multiple Foundry sources under one estate boundary', () => {
    const credential = { getToken: () => Promise.resolve(null) }
    const result = createConfiguredConnector(
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
        AGENT_SENTINEL_TENANT_ID: 'estate-tenant',
        AGENT_SENTINEL_ENVIRONMENT: 'portfolio',
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
      { credentialFactory: () => credential },
    )

    expect(result).toMatchObject({
      mode: 'foundry',
      tenantId: 'estate-tenant',
      environment: 'portfolio',
      sourceCount: 2,
    })
    expect(result.projectEndpoint).toBeUndefined()
    expect(result.connector.getConnectorHealth?.().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'foundry:project-a' }),
        expect.objectContaining({ id: 'foundry:project-b' }),
      ]),
    )
  })

  it('reports missing Entra authorization for every Foundry source boundary', () => {
    const result = createConfiguredConnector(
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
        AGENT_SENTINEL_TENANT_ID: 'estate-tenant',
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
            environment: 'production',
          },
        ]),
        ENTRA_CONNECTOR_ENABLED: 'true',
      },
      { credentialFactory: () => ({ getToken: () => Promise.resolve(null) }) },
    )
    expect(
      result.connector
        .getConnectorHealth?.()
        .sources.filter((source) => source.role === 'enrichment'),
    ).toMatchObject([
      { id: 'entra:project-a', readiness: 'authorization-required' },
      { id: 'entra:project-b', readiness: 'authorization-required' },
    ])
  })

  it('matches configured Entra sources to multiple Foundry boundaries', () => {
    const foundrySources = [
      {
        id: 'project-a',
        name: 'Project A',
        projectEndpoint: 'https://a.services.ai.azure.com/api/projects/a',
        tenantId: '11111111-1111-4111-8111-111111111111',
        environment: 'production',
      },
      {
        id: 'project-b',
        name: 'Project B',
        projectEndpoint: 'https://b.services.ai.azure.com/api/projects/b',
        tenantId: '22222222-2222-4222-8222-222222222222',
        environment: 'validation',
      },
    ]
    const result = createConfiguredConnector(
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
        AGENT_SENTINEL_TENANT_ID: 'estate',
        FOUNDRY_ENVIRONMENT: 'portfolio',
        FOUNDRY_SOURCES_JSON: JSON.stringify(foundrySources),
        ENTRA_CONNECTOR_ENABLED: 'true',
        ENTRA_SOURCES_JSON: JSON.stringify(
          foundrySources.map(({ id, name, tenantId, environment }) => ({
            id,
            name,
            tenantId,
            environment,
          })),
        ),
      },
      {
        credential: { getToken: () => Promise.resolve(null) },
        entraClient: {
          fetcher: () => Promise.resolve(Response.json({ value: [] })),
        },
      },
    )
    expect(
      result.connector
        .getConnectorHealth?.()
        .sources.filter((source) => source.role === 'enrichment'),
    ).toMatchObject([
      { id: 'entra:project-a', configured: true, readiness: 'degraded' },
      { id: 'entra:project-b', configured: true, readiness: 'degraded' },
    ])
  })

  it('reuses one explicitly bound Entra inventory across two Foundry projects', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111'
    const principalId = '22222222-2222-4222-8222-222222222222'
    const foundrySources = [
      {
        id: 'project-a',
        name: 'Project A',
        projectEndpoint: 'https://a.services.ai.azure.com/api/projects/project-a',
        tenantId,
        environment: 'production',
      },
      {
        id: 'project-b',
        name: 'Project B',
        projectEndpoint: 'https://b.services.ai.azure.com/api/projects/project-b',
        tenantId,
        environment: 'validation',
      },
    ]
    const foundryFetch = vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const projectId = url.hostname.startsWith('a.') ? 'project-a' : 'project-b'
      return Promise.resolve(
        Response.json({
          data: [
            {
              id: `agent-${projectId}`,
              name: `Agent ${projectId}`,
              metadata: { servicePrincipalId: principalId },
            },
          ],
          has_more: false,
        }),
      )
    })
    vi.stubGlobal('fetch', foundryFetch)
    const entraFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        value: [
          {
            id: principalId,
            appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            displayName: 'Shared principal',
            servicePrincipalType: 'Application',
            accountEnabled: true,
            appOwnerOrganizationId: tenantId,
            tags: [],
          },
        ],
      }),
    )
    const result = createConfiguredConnector(
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
        AGENT_SENTINEL_TENANT_ID: tenantId,
        AGENT_SENTINEL_ENVIRONMENT: 'portfolio',
        FOUNDRY_ENVIRONMENT: 'portfolio',
        FOUNDRY_SOURCES_JSON: JSON.stringify(foundrySources),
        ENTRA_CONNECTOR_ENABLED: 'true',
        ENTRA_SOURCES_JSON: JSON.stringify([
          {
            id: 'directory-a',
            name: 'Tenant directory',
            tenantId,
            environment: 'directory',
          },
        ]),
        ENTRA_RUNS_AS_BINDINGS_JSON: JSON.stringify(
          foundrySources.map((source) => ({
            estateId: 'estate-a',
            foundry: {
              sourceId: `foundry:${source.id}`,
              tenantId,
              environment: source.environment,
              provider: 'azure-ai-foundry-agent-service',
              sourceObjectId: new URL(source.projectEndpoint).pathname.split('/').at(-1),
            },
            entra: {
              sourceId: 'entra:directory-a',
              tenantId,
              environment: 'directory',
              provider: 'microsoft-entra',
              sourceObjectId: tenantId,
            },
          })),
        ),
      },
      {
        estate: { id: 'estate-a', tenantId, environment: 'portfolio' },
        credential: {
          getToken: () =>
            Promise.resolve({ token: 'test', expiresOnTimestamp: Date.now() + 60_000 }),
        },
        entraClient: { fetcher: entraFetch },
      },
    )

    const snapshot = await result.connector.discover()

    expect(foundryFetch).toHaveBeenCalledTimes(2)
    expect(entraFetch).toHaveBeenCalledTimes(1)
    expect(snapshot.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(2)
  })

  it('composes Power Platform after Entra without requiring matching source ids', () => {
    const result = createConfiguredConnector(
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
        FOUNDRY_TENANT_ID: '11111111-1111-4111-8111-111111111111',
        FOUNDRY_ENVIRONMENT: 'validation',
        ENTRA_CONNECTOR_ENABLED: 'true',
        ENTRA_CONNECTOR_TENANT_ID: '11111111-1111-4111-8111-111111111111',
        ENTRA_CONNECTOR_ENVIRONMENT: 'validation',
        POWER_PLATFORM_CONNECTOR_ENABLED: 'true',
        POWER_PLATFORM_SOURCES_JSON: JSON.stringify([
          {
            id: 'studio-environment',
            name: 'Studio environment',
            tenantId: '11111111-1111-4111-8111-111111111111',
            environment: 'environment-guid',
          },
        ]),
      },
      {
        credential: { getToken: () => Promise.resolve(null) },
        powerPlatformClient: {
          fetcher: () => Promise.resolve(Response.json({})),
        },
      },
    )

    expect(result.connector.getConnectorHealth?.().sources.map((source) => source.id)).toEqual([
      'foundry:primary',
      'entra:primary',
      'power-platform:studio-environment',
    ])
  })
  it('wires Agent 365 after Power Platform with injectable client options', () => {
    const result = createConfiguredConnector(
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
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
    expect(result.connector.getConnectorHealth?.().sources.map((source) => source.id)).toEqual([
      'foundry:primary',
      'entra:primary',
      'power-platform:primary',
      'agent365:primary',
    ])
  })

  it('activates persisted enabled Agent 365 sources for the exact API estate', async () => {
    const result = await createConfiguredConnectorForEstate(
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

    expect(result.connector.getConnectorHealth?.().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent365:agent365-live',
          configured: true,
          readiness: 'degraded',
        }),
      ]),
    )
  })

  it('rejects an enabled Agent 365 API deployment without a source boundary', async () => {
    await expect(
      createConfiguredConnectorForEstate(
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

  it('reports an enabled Agent 365 API deployment without explicit UAMI as inactive', async () => {
    const result = await createConfiguredConnectorForEstate(
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

    expect(result.connector.getConnectorHealth?.().partial).toBe(true)
    expect(
      result.connector
        .getConnectorHealth?.()
        .sources.find((source) => source.id === 'agent365:agent365-primary'),
    ).toMatchObject({
      enabled: true,
      configured: false,
      readiness: 'authorization-required',
      dataState: 'unsupported',
      reason: 'dedicated-workload-identity-required',
    })
  })

  it('passes the exact zero-binding Agent 365 runtime in the estate API factory', async () => {
    const fallbackRuntime = await resolveAgent365Runtime(
      runtimeRepository([agent365RuntimeSource()]),
      runtimeEstate,
    )
    const result = await createConfiguredConnectorForEstate(
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
      result.connector
        .getConnectorHealth?.()
        .sources.filter((source) => source.id.startsWith('agent365:')),
    ).toEqual([])
  })

  it('does not reactivate an out-of-estate Agent 365 deployment in the estate API factory', async () => {
    const result = await createConfiguredConnectorForEstate(
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
        AGENT365_SOURCES_JSON: JSON.stringify([
          {
            id: 'other-estate',
            name: 'Other estate Agent 365',
            tenantId: '22222222-2222-4222-8222-222222222222',
            environment: 'production',
            credential: {
              mode: 'managed-identity',
              managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
            },
          },
        ]),
      },
      {
        credentialFactory: () => ({ getToken: () => Promise.resolve(null) }),
      },
    )

    expect(
      result.connector
        .getConnectorHealth?.()
        .sources.filter((source) => source.id.startsWith('agent365:')),
    ).toEqual([])
  })

  it('preserves projected Agent 365 concurrency and duration through API runtime resolution', async () => {
    const environment = {
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
    }
    const projected = buildDeploymentConnectorSources(
      environment,
      { estates: [runtimeEstate] },
      'live',
    )
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
    const result = await createConfiguredConnectorForEstate(
      runtimeEstate,
      runtimeRepository(projected),
      environment,
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

    await (result.connector as OperationAwareAgentConnector).testConnection({
      signal: external.signal,
    })
    clearTimeout(fallback)

    expect(fetcher).not.toHaveBeenCalled()
    expect(
      result.connector
        .getConnectorHealth?.()
        .sources.find((source) => source.id === 'agent365:agent365-primary'),
    ).toMatchObject({
      readiness: 'unavailable',
      dataState: 'cancelled',
      reason: 'duration-exceeded',
    })
  })

  it('wraps Defender for Cloud Apps after Agent 365 with injectable OAuth client options', () => {
    const result = createConfiguredConnector(
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/test',
        FOUNDRY_TENANT_ID: '11111111-1111-4111-8111-111111111111',
        FOUNDRY_ENVIRONMENT: 'validation',
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_TENANT_ID: '22222222-2222-4222-8222-222222222222',
        AGENT365_ENVIRONMENT: 'agent365-global',
        DEFENDER_CLOUD_APPS_CONNECTOR_ENABLED: 'true',
        DEFENDER_CLOUD_APPS_TENANT_ID: '33333333-3333-4333-8333-333333333333',
        DEFENDER_CLOUD_APPS_ENVIRONMENT: 'security-evidence',
        DEFENDER_CLOUD_APPS_PORTAL_HOSTNAME: 'contoso.us2.portal.cloudappsecurity.com',
      },
      {
        credential: { getToken: () => Promise.resolve(null) },
        defenderCloudAppsClient: {
          fetcher: () => Promise.resolve(Response.json({ data: [], hasNext: false })),
        },
      },
    )
    expect(result.connector.getConnectorHealth?.().sources.map((source) => source.id)).toEqual([
      'foundry:primary',
      'entra:primary',
      'agent365:primary',
      'defender-cloud-apps:primary',
    ])
  })

  it('wraps Purview after Defender with injectable Graph client options', () => {
    const result = createConfiguredConnector(
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
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
    expect(result.connector.getConnectorHealth?.().sources.map((source) => source.id)).toEqual([
      'foundry:primary',
      'entra:primary',
      'defender-cloud-apps:primary',
      'purview:primary',
    ])
  })

  it('wraps Teams distribution after Purview with injectable Graph client options', () => {
    const result = createConfiguredConnector(
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
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
    expect(result.connector.getConnectorHealth?.().sources.map((source) => source.id)).toEqual([
      'foundry:primary',
      'entra:primary',
      'purview:primary',
      'teams-distribution:primary',
    ])
  })

  it('wraps Azure Resource Graph after Purview with exact subscription boundaries', () => {
    const tenantId = '11111111-1111-4111-8111-111111111111'
    const subscriptionId = '22222222-2222-4222-8222-222222222222'
    const result = createConfiguredConnector(
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
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
    expect(result.connector.getConnectorHealth?.().sources.map((source) => source.id)).toEqual([
      'foundry:primary',
      'entra:primary',
      'azure-resource-graph:primary',
    ])
  })
})
