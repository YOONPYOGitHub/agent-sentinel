import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'

import { DemoService, NotFoundError } from './demo-service.js'

const approvalSchema = z.object({
  approvedBy: z.string().trim().min(2).max(100),
})

export async function createApp(service = new DemoService()): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  await app.register(cors, {
    origin: ['http://localhost:5173'],
  })

  app.get('/health', () => ({
    status: 'ok',
    service: 'agent-sentinel-api',
    timestamp: new Date().toISOString(),
  }))

  app.get('/api/demo/state', async () => service.getState())
  app.post('/api/demo/reset', async () => service.reset())

  app.post<{ Params: { findingId: string } }>(
    '/api/demo/findings/:findingId/validate',
    async (request) => service.validateFinding(request.params.findingId),
  )

  app.post<{ Params: { findingId: string } }>(
    '/api/demo/findings/:findingId/remediations',
    async (request) => service.proposeRemediation(request.params.findingId),
  )

  app.post<{ Params: { remediationId: string }; Body: unknown }>(
    '/api/demo/remediations/:remediationId/approve',
    async (request) => {
      const body = approvalSchema.parse(request.body)
      return service.approveRemediation(request.params.remediationId, body.approvedBy)
    },
  )

  app.post<{ Params: { remediationId: string } }>(
    '/api/demo/remediations/:remediationId/execute',
    async (request) => service.executeRemediation(request.params.remediationId),
  )

  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      error instanceof z.ZodError ? 400 : error instanceof NotFoundError ? 404 : 409
    const message = error instanceof Error ? error.message : 'Unexpected operation failure.'
    void reply.status(statusCode).send({
      error:
        statusCode === 400
          ? 'invalid_request'
          : statusCode === 404
            ? 'not_found'
            : 'operation_rejected',
      message,
    })
  })

  return app
}
