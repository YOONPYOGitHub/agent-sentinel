import { randomUUID } from 'node:crypto'

import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'

import { createConfiguredConnector } from './connector-factory.js'
import { DemoService, NotFoundError, StateConflictError } from './demo-service.js'

const approvalSchema = z.object({
  approvedBy: z.string().trim().min(2).max(100),
})

function configuredService(): DemoService {
  const configured = createConfiguredConnector()
  return new DemoService(configured.connector, configured.mode, configured.projectEndpoint)
}

export async function createApp(service = configuredService()): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  await app.register(cors, {
    origin: ['http://localhost:5173'],
  })

  app.addHook('onRequest', (request, reply, done) => {
    const header = request.headers['x-correlation-id']
    const correlationId = typeof header === 'string' && header.length > 0 ? header : randomUUID()
    const url = request.url.split('?', 1)[0] ?? request.url

    void reply.header('x-correlation-id', correlationId)
    console.log(JSON.stringify({ level: 'info', method: request.method, url, correlationId }))
    done()
  })

  app.get('/health', () => ({
    status: 'ok',
    service: 'agent-sentinel-api',
    timestamp: new Date().toISOString(),
  }))

  app.get('/api/demo/state', async () => service.getState())
  app.get('/api/connector/status', async () => service.getConnectorStatus())
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
      error instanceof z.ZodError
        ? 400
        : error instanceof NotFoundError
          ? 404
          : error instanceof StateConflictError
            ? 409
            : 500
    const message = error instanceof Error ? error.message : 'Unexpected operation failure.'
    void reply.status(statusCode).send({
      error:
        statusCode === 400
          ? 'invalid_request'
          : statusCode === 404
            ? 'not_found'
            : statusCode === 409
              ? 'operation_rejected'
              : 'internal_error',
      message,
    })
  })

  return app
}
