import { describe, expect, it } from 'vitest'
import { createConfiguredConnector } from '../src/connector-factory.js'
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
          configured: false,
          readiness: 'authorization-required',
          reason: 'boundary-mismatch',
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
