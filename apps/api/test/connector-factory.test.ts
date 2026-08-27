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
})
