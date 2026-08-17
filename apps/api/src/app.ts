import { randomUUID } from 'node:crypto'
import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CosmosClient } from '@azure/cosmos'
import { DefaultAzureCredential } from '@azure/identity'

import type { ExposureFindingRepository } from '@agent-sentinel/domain'
import { CosmosExposureFindingRepository } from '@agent-sentinel/persistence'

import { buildAuthConfig, createAuthMiddleware, type AuthConfig } from './auth.js'
import { createConfiguredConnector } from './connector-factory.js'
import { DemoService, NotFoundError, StateConflictError } from './demo-service.js'
import { registerExposureRoutes } from './exposure-routes.js'

const approvalSchema = z.object({
  approvedBy: z.string().trim().min(2).max(100),
})

function configuredService(): DemoService {
  const configured = createConfiguredConnector()
  return new DemoService(configured.connector, configured.mode, configured.projectEndpoint)
}

function corsOrigins(value = process.env['CORS_ORIGIN']): string[] {
  return (value ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
}

function dataMode(): 'mock' | 'live' {
  const value = process.env['AGENT_SENTINEL_DATA_MODE']?.trim().toLowerCase() || 'mock'
  if (value !== 'mock' && value !== 'live') {
    throw new Error(`AGENT_SENTINEL_DATA_MODE must be mock or live; received ${value}.`)
  }
  return value
}

function defaultTenantId(): string {
  return process.env['AGENT_SENTINEL_TENANT_ID']?.trim() || 'tenant-demo'
}

function buildLiveExposureRepository(): ExposureFindingRepository {
  const endpoint = process.env['COSMOS_ENDPOINT']?.trim()
  if (!endpoint) throw new Error('COSMOS_ENDPOINT is required when AGENT_SENTINEL_DATA_MODE=live.')
  const databaseId = process.env['COSMOS_DATABASE']?.trim() || process.env['COSMOS_DATABASE_ID']?.trim() || 'agent-sentinel-db'
  const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() })
  return new CosmosExposureFindingRepository(client, databaseId)
}

export interface CreateAppOptions {
  exposureRepository?: ExposureFindingRepository
  dataMode?: 'mock' | 'live'
}

export async function createApp(
  service = configuredService(),
  authConfig: AuthConfig = buildAuthConfig(),
  options: CreateAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  await app.register(cors, {
    origin: corsOrigins(),
  })

  app.addHook('onRequest', (request, reply, done) => {
    const header = request.headers['x-correlation-id']
    const correlationId = typeof header === 'string' && header.length > 0 ? header : randomUUID()
    const url = request.url.split('?', 1)[0] ?? request.url
    void reply.header('x-correlation-id', correlationId)
    console.log(JSON.stringify({ level: 'info', method: request.method, url, correlationId }))
    done()
  })
  app.addHook('onRequest', createAuthMiddleware(authConfig))

  const resolvedDataMode = options.dataMode ?? dataMode()

  // Live mode: forbid non-GET writes to /api/demo/* to keep production read-only.
  app.addHook('preHandler', (request, reply, done) => {
    if (
      resolvedDataMode === 'live' &&
      request.method !== 'GET' &&
      request.url.startsWith('/api/demo')
    ) {
      void reply.status(403).send({
        error: 'read_only_mode',
        message: 'Mutations against /api/demo are disabled in live mode.',
      })
      return
    }
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

  const exposureMode: 'mock' | 'foundry' = resolvedDataMode === 'live' ? 'foundry' : 'mock'
  const exposureRepository =
    options.exposureRepository ??
    (resolvedDataMode === 'live' ? buildLiveExposureRepository() : undefined)
  registerExposureRoutes(app, {
    mode: exposureMode,
    defaultTenantId: defaultTenantId(),
    ...(exposureRepository ? { repository: exposureRepository } : {}),
  })

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
