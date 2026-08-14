import { afterEach, describe, expect, it } from 'vitest'

import { agentSentinelStateSchema } from '@agent-sentinel/domain'

import { createApp } from '../src/app.js'

const apps: Awaited<ReturnType<typeof createApp>>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()))
})

describe('demo API', () => {
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

    const approvedResponse = await app.inject({
      method: 'POST',
      url: `/api/demo/remediations/${String(remediationId)}/approve`,
      payload: { approvedBy: 'Avery Morgan' },
    })
    expect(agentSentinelStateSchema.parse(approvedResponse.json()).remediations[0]?.status).toBe(
      'approved',
    )

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
})
