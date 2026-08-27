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
        { id: 'azure-ai-foundry-agent-service' },
        {
          id: 'microsoft-entra-service-principals',
          enabled: true,
          readiness: 'degraded',
          reason: 'tenant-mismatch',
        },
      ],
    })
  })
})
