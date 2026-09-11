import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { agentSentinelStateSchema } from '@agent-sentinel/domain'

import { createApp } from '../src/app.js'
import type { DemoService } from '../src/demo-service.js'

const apps: Awaited<ReturnType<typeof createApp>>[] = []

beforeEach(() => {
  process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
})

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()))
  delete process.env['AGENT_SENTINEL_CONNECTOR']
  delete process.env['AGENT_SENTINEL_WRITE_ENABLED']
  delete process.env['AGENT_SENTINEL_BUILD_SHA']
  delete process.env['AGENT_SENTINEL_API_IMAGE_DIGEST']
})

describe('demo API', () => {
  it('serves public API health and sanitized immutable deployment status', async () => {
    process.env['AGENT_SENTINEL_BUILD_SHA'] = 'a'.repeat(40)
    process.env['AGENT_SENTINEL_API_IMAGE_DIGEST'] = `sha256:${'b'.repeat(64)}`
    const app = await createApp()
    apps.push(app)

    const health = await app.inject({ method: 'GET', url: '/api/health' })
    expect(health.statusCode).toBe(200)
    expect(health.json()).toMatchObject({ status: 'ok', service: 'agent-sentinel-api' })

    const status = await app.inject({ method: 'GET', url: '/api/status' })
    expect(status.statusCode).toBe(200)
    expect(status.headers['x-agent-sentinel-api-sha']).toBe('a'.repeat(40))
    expect(status.headers['x-agent-sentinel-api-image-digest']).toBe(`sha256:${'b'.repeat(64)}`)
    expect(status.json()).toMatchObject({
      status: 'ok',
      components: {
        api: { sha: 'a'.repeat(40), digest: `sha256:${'b'.repeat(64)}` },
      },
    })
  })

  it('reports the connector source and mode via the status endpoint', async () => {
    process.env['AGENT_SENTINEL_WRITE_ENABLED'] = 'false'
    const app = await createApp()
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/connector/status' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      source: 'mock',
      connectorId: 'mock-agent-estate',
      mode: 'mock',
      writeEnabled: false,
    })
  })

  it('runs the evidence-to-remediation workflow', async () => {
    const app = await createApp()
    apps.push(app)

    const initialResponse = await app.inject({ method: 'GET', url: '/api/demo/state' })
    expect(initialResponse.statusCode).toBe(200)
    const initial = agentSentinelStateSchema.parse(initialResponse.json())
    expect(initial.snapshot.nodes.filter((node) => node.kind === 'agent')).toHaveLength(3)
    expect(initial.findings).toHaveLength(1)
    expect(initial.findings[0]?.path.status).toBe('theoretical')
    expect(initial.snapshot.edges.find((edge) => edge.id === 'edge-data-mcp')?.active).toBe(true)

    const findingId = initial.findings[0]?.id
    expect(findingId).toBeDefined()
    const validatedResponse = await app.inject({
      method: 'POST',
      url: `/api/demo/findings/${String(findingId)}/validate`,
    })
    expect(agentSentinelStateSchema.parse(validatedResponse.json()).findings[0]?.path.status).toBe(
      'validated',
    )

    const proposedResponse = await app.inject({
      method: 'POST',
      url: `/api/demo/findings/${String(findingId)}/remediations`,
    })
    const remediationId = agentSentinelStateSchema.parse(proposedResponse.json()).remediations[0]
      ?.id
    expect(remediationId).toBeDefined()

    const missingReasonResponse = await app.inject({
      method: 'POST',
      url: `/api/demo/remediations/${String(remediationId)}/approve`,
      payload: { approvedBy: 'Avery Morgan' },
    })
    expect(missingReasonResponse.statusCode).toBe(400)

    const approvedResponse = await app.inject({
      method: 'POST',
      url: `/api/demo/remediations/${String(remediationId)}/approve`,
      payload: {
        approvedBy: 'Avery Morgan',
        reason: 'Validated critical exposure with a reversible containment plan.',
      },
    })
    expect(agentSentinelStateSchema.parse(approvedResponse.json()).remediations[0]?.status).toBe(
      'approved',
    )
    expect(
      agentSentinelStateSchema.parse(approvedResponse.json()).remediations[0]?.approvalReason,
    ).toBe('Validated critical exposure with a reversible containment plan.')

    const completedResponse = await app.inject({
      method: 'POST',
      url: `/api/demo/remediations/${String(remediationId)}/execute`,
    })
    const completed = agentSentinelStateSchema.parse(completedResponse.json())
    expect(completed.remediations[0]?.status).toBe('completed')
    expect(completed.findings[0]?.path.status).toBe('mitigated')
    expect(completed.snapshot.edges.find((edge) => edge.id === 'edge-data-mcp')?.active).toBe(false)
  })

  it('rejects remediation before validation', async () => {
    const app = await createApp()
    apps.push(app)

    const initial = agentSentinelStateSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/demo/state' })).json(),
    )
    const response = await app.inject({
      method: 'POST',
      url: `/api/demo/findings/${String(initial.findings[0]?.id)}/remediations`,
    })

    expect(response.statusCode).toBe(409)
    const errorResponse: unknown = response.json()
    expect(errorResponse).toMatchObject({ error: 'operation_rejected' })
  })

  it('rejects duplicate validation without adding another run', async () => {
    const app = await createApp()
    apps.push(app)

    const initial = agentSentinelStateSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/demo/state' })).json(),
    )
    const findingId = initial.findings[0]?.id
    await app.inject({
      method: 'POST',
      url: `/api/demo/findings/${String(findingId)}/validate`,
    })

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/demo/findings/${String(findingId)}/validate`,
    })
    const finalState = agentSentinelStateSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/demo/state' })).json(),
    )

    expect(duplicate.statusCode).toBe(409)
    expect(finalState.validations).toHaveLength(1)
  })

  it('returns not found for unknown resources', async () => {
    const app = await createApp()
    apps.push(app)

    const response = await app.inject({
      method: 'POST',
      url: '/api/demo/findings/not-a-finding/validate',
    })
    const body: unknown = response.json()

    expect(response.statusCode).toBe(404)
    expect(body).toMatchObject({ error: 'not_found' })
  })

  it('returns 500 for unexpected errors, not 409', async () => {
    const brokenService = {
      getState: () => Promise.reject(new Error('Unexpected database failure')),
      getConnectorStatus: () => Promise.reject(new Error('Unexpected connector failure')),
      reset: () => Promise.reject(new Error('Unexpected reset failure')),
      validateFinding: () => Promise.reject(new Error('Unexpected database failure')),
      proposeRemediation: () => Promise.reject(new Error('Unexpected database failure')),
      approveRemediation: () => Promise.reject(new Error('Unexpected database failure')),
      executeRemediation: () => Promise.reject(new Error('Unexpected database failure')),
    }
    const app = await createApp(brokenService as unknown as DemoService)
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({ error: 'internal_error' })
  })

  it('maps StateConflictError to 409 and generic errors to 500', async () => {
    // Attempting remediation before validation raises StateConflictError → 409
    const app = await createApp()
    apps.push(app)
    const initial = agentSentinelStateSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/demo/state' })).json(),
    )
    const conflictResponse = await app.inject({
      method: 'POST',
      url: `/api/demo/findings/${String(initial.findings[0]?.id)}/remediations`,
    })
    expect(conflictResponse.statusCode).toBe(409)
    expect(conflictResponse.json()).toMatchObject({ error: 'operation_rejected' })
  })
})
