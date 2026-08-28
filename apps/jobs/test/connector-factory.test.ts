import { describe, expect, it } from 'vitest'

import { buildConnector } from '../src/connector-factory.js'

describe('jobs connector selection', () => {
  it('keeps mock mode independent of Entra configuration', () => {
    expect(buildConnector('mock', { ENTRA_CONNECTOR_ENABLED: 'true' }).descriptor.id).toBe(
      'mock-agent-estate',
    )
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
        credentialFactory: () => ({ getToken: () => Promise.resolve(null) }),
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
})
