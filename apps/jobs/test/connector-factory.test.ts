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
        { id: 'azure-ai-foundry-agent-service' },
        {
          id: 'microsoft-entra-service-principals',
          enabled: true,
          configured: true,
          readiness: 'degraded',
        },
      ],
    })
  })
})
