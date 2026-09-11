import { describe, expect, it } from 'vitest'

import { syntheticSpanAttributes } from './validate-live.js'

describe('synthetic validation telemetry', () => {
  it('adds the exact sanitized Foundry project ID without retaining the endpoint', () => {
    const attributes = syntheticSpanAttributes({
      endpoint: ' https://safe.services.ai.azure.com/api/projects/project-a/ ',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      environment: 'production',
      observationId: 'observation-a',
    })

    expect(attributes).toEqual({
      'agent.sentinel.tenant_id': 'tenant-a',
      'gen_ai.agent.id': 'agent-a',
      'deployment.environment.name': 'production',
      'agent.sentinel.source_project_id': 'project-a',
      'agent.sentinel.observation_id': 'observation-a',
      'agent.sentinel.synthetic': true,
    })
    expect(JSON.stringify(attributes)).not.toContain('safe.services.ai.azure.com')
  })
})
