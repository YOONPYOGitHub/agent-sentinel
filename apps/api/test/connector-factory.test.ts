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
})
