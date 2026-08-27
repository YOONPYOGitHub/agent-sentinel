import { randomUUID } from 'node:crypto'
import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CosmosClient } from '@azure/cosmos'
import { DefaultAzureCredential } from '@azure/identity'
import { createAzureMonitorOtelConnector } from '@agent-sentinel/azure-monitor-otel-connector'
import type { RuntimeTelemetryConnector } from '@agent-sentinel/connector-sdk'

import type {
  ExposureFindingRepository,
  GovernanceCaseRepository,
  SnapshotRepository,
} from '@agent-sentinel/domain'
import {
  CosmosExposureFindingRepository,
  CosmosGovernanceCaseRepository,
  CosmosSnapshotRepository,
} from '@agent-sentinel/persistence'

import {
  buildAuthConfig,
  CAPABILITIES,
  createAuthMiddleware,
  requireCapability,
  type AuthConfig,
} from './auth.js'
import { createAdvisoryService, type AdvisoryService } from './advisory-service.js'
import { createConfiguredConnector } from './connector-factory.js'
import { DemoService, NotFoundError, StateConflictError } from './demo-service.js'
import { registerExposureRoutes } from './exposure-routes.js'
import { registerGovernanceRoutes } from './governance-routes.js'
import {
  createSeededGovernanceCaseRepository,
  registerGovernanceQueueRoutes,
} from './governance-queue-routes.js'
import { buildConnectorsCollection } from './connectors-catalog.js'
import { registerBehaviorRoutes } from './behavior-routes.js'
import { registerTokenEconomicsRoutes } from './token-economics-routes.js'

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
  return (
    process.env['AGENT_SENTINEL_TENANT_ID']?.trim() ||
    process.env['AZURE_MONITOR_TENANT_ID']?.trim() ||
    'tenant-demo'
  )
}

function defaultWriteEnabled(mode: 'mock' | 'live', authConfig: AuthConfig): boolean {
  const configured = process.env['AGENT_SENTINEL_WRITE_ENABLED']?.trim().toLowerCase()
  if (configured !== undefined && configured !== 'true' && configured !== 'false')
    throw new Error('AGENT_SENTINEL_WRITE_ENABLED must be true or false.')
  const enabled = configured === 'true' || (configured === undefined && mode === 'mock')
  if (enabled && mode === 'live' && authConfig.mode !== 'jwt')
    throw new Error('Live writes require AUTH_MODE=jwt.')
  return enabled
}

export function buildLiveRepositories(clientOverride?: CosmosClient): {
  exposureRepository: ExposureFindingRepository
  snapshotRepository: SnapshotRepository
  governanceCaseRepository: GovernanceCaseRepository
} {
  const endpoint = process.env['COSMOS_ENDPOINT']?.trim()
  if (!clientOverride && !endpoint)
    throw new Error('COSMOS_ENDPOINT is required when AGENT_SENTINEL_DATA_MODE=live.')
  const databaseId =
    process.env['COSMOS_DATABASE']?.trim() ||
    process.env['COSMOS_DATABASE_ID']?.trim() ||
    'agent-sentinel-db'
  const governanceContainerId = process.env['COSMOS_GOVERNANCE_CONTAINER']?.trim()
  if (!governanceContainerId)
    throw new Error('COSMOS_GOVERNANCE_CONTAINER is required when AGENT_SENTINEL_DATA_MODE=live.')
  const client =
    clientOverride ??
    new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() })
  return {
    exposureRepository: new CosmosExposureFindingRepository(client, databaseId),
    snapshotRepository: new CosmosSnapshotRepository(client, databaseId),
    governanceCaseRepository: new CosmosGovernanceCaseRepository(client, {
      tenantId: defaultTenantId(),
      databaseId,
      containerId: governanceContainerId,
    }),
  }
}

export interface CreateAppOptions {
  exposureRepository?: ExposureFindingRepository
  snapshotRepository?: SnapshotRepository
  governanceCaseRepository?: GovernanceCaseRepository
  advisoryService?: AdvisoryService
  dataMode?: 'mock' | 'live'
  /** `null` explicitly keeps live telemetry unconfigured, including in tests. */
  runtimeTelemetryConnector?: RuntimeTelemetryConnector | null
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
  const runtimeTelemetryConnector =
    resolvedDataMode === 'live'
      ? options.runtimeTelemetryConnector === null
        ? undefined
        : (options.runtimeTelemetryConnector ?? createAzureMonitorOtelConnector())
      : undefined

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

  // Public SPA authentication configuration.
  app.get('/api/auth/config', () => {
    if (authConfig.mode !== 'jwt') {
      return { enabled: false }
    }
    return {
      enabled: true,
      tenantId: authConfig.spaConfig.tenantId,
      clientId: authConfig.spaConfig.clientId,
      authority: authConfig.spaConfig.authority,
      scopes: authConfig.spaConfig.scopes,
      redirectUri: authConfig.spaConfig.redirectUri,
      postLogoutRedirectUri: authConfig.spaConfig.postLogoutRedirectUri,
    }
  })

  // Sanitized current principal.
  app.get('/api/auth/me', async (request, reply) => {
    if (authConfig.mode !== 'jwt') {
      await reply
        .status(401)
        .send({ error: 'unauthorized', message: 'Authentication is not configured.' })
      return
    }
    const principal = request.authPrincipal
    if (principal === undefined) {
      await reply.status(401).send({ error: 'unauthorized', message: 'Bearer token required.' })
      return
    }
    return {
      subject: principal.subject,
      ...(principal.objectId !== undefined ? { objectId: principal.objectId } : {}),
      tenantId: principal.tenantId,
      ...(principal.displayName !== undefined ? { displayName: principal.displayName } : {}),
      ...(principal.preferredUsername !== undefined
        ? { preferredUsername: principal.preferredUsername }
        : {}),
      roles: principal.roles,
      capabilities: [...principal.capabilities],
    }
  })

  if (authConfig.mode === 'jwt') {
    for (const capability of CAPABILITIES) {
      app.get(
        `/api/auth/capabilities/${capability}`,
        { preHandler: requireCapability(authConfig, capability) },
        () => ({ capability, allowed: true }),
      )
    }
  }

  app.get('/health', () => ({
    status: 'ok',
    service: 'agent-sentinel-api',
    timestamp: new Date().toISOString(),
  }))

  app.get('/api/demo/state', async () => service.getState())
  app.get('/api/connector/status', async () => service.getConnectorStatus())
  app.get('/api/connectors', async () => {
    const [status, connection] = await Promise.all([
      service.getConnectorStatus(),
      service.testConnectorConnection(),
    ])
    return buildConnectorsCollection(status.mode, {
      connectorId: status.connectorId,
      connectionOk: connection.ok,
      ...(status.writeEnabled !== undefined ? { writeEnabled: status.writeEnabled } : {}),
      ...(status.projectEndpoint !== undefined ? { projectEndpoint: status.projectEndpoint } : {}),
      runtimeTelemetryConfigured: runtimeTelemetryConnector !== undefined,
    })
  })
  app.post(
    '/api/demo/reset',
    {
      preHandler: requireCapability(authConfig, 'configure'),
    },
    async () => service.reset(),
  )

  app.post<{ Params: { findingId: string } }>(
    '/api/demo/findings/:findingId/validate',
    { preHandler: requireCapability(authConfig, 'validateFinding') },
    async (request) => service.validateFinding(request.params.findingId),
  )

  app.post<{ Params: { findingId: string } }>(
    '/api/demo/findings/:findingId/remediations',
    { preHandler: requireCapability(authConfig, 'proposeRemediation') },
    async (request) => service.proposeRemediation(request.params.findingId),
  )

  app.post<{ Params: { remediationId: string }; Body: unknown }>(
    '/api/demo/remediations/:remediationId/approve',
    { preHandler: requireCapability(authConfig, 'approveRemediation') },
    async (request) => {
      const principal = request.authPrincipal
      const approvedBy =
        authConfig.mode === 'jwt' && principal !== undefined
          ? (principal.preferredUsername ??
            principal.displayName ??
            principal.objectId ??
            principal.subject)
          : approvalSchema.parse(request.body).approvedBy
      return service.approveRemediation(request.params.remediationId, approvedBy)
    },
  )

  app.post<{ Params: { remediationId: string } }>(
    '/api/demo/remediations/:remediationId/execute',
    { preHandler: requireCapability(authConfig, 'executeRemediation') },
    async (request) => service.executeRemediation(request.params.remediationId),
  )

  const exposureMode: 'mock' | 'foundry' = resolvedDataMode === 'live' ? 'foundry' : 'mock'
  const writeEnabled = defaultWriteEnabled(resolvedDataMode, authConfig)
  const liveRepositories =
    resolvedDataMode === 'live' &&
    options.exposureRepository === undefined &&
    options.snapshotRepository === undefined
      ? buildLiveRepositories()
      : undefined
  const exposureRepository = options.exposureRepository ?? liveRepositories?.exposureRepository
  const snapshotRepository = options.snapshotRepository ?? liveRepositories?.snapshotRepository
  const governanceCaseRepository =
    options.governanceCaseRepository ??
    (resolvedDataMode === 'mock'
      ? createSeededGovernanceCaseRepository(exposureMode, writeEnabled)
      : liveRepositories?.governanceCaseRepository)
  const advisoryService = options.advisoryService ?? createAdvisoryService()
  registerExposureRoutes(app, {
    mode: exposureMode,
    defaultTenantId: defaultTenantId(),
    ...(exposureRepository ? { repository: exposureRepository } : {}),
    ...(snapshotRepository ? { snapshotRepository } : {}),
    advisoryService,
    authConfig,
  })
  registerGovernanceRoutes(app, {
    mode: exposureMode,
    defaultTenantId: defaultTenantId(),
    ...(exposureRepository ? { repository: exposureRepository } : {}),
  })
  registerGovernanceQueueRoutes(app, {
    mode: exposureMode,
    authConfig,
    writeEnabled,
    ...(governanceCaseRepository ? { repository: governanceCaseRepository } : {}),
  })
  registerBehaviorRoutes(app, {
    mode: exposureMode,
    defaultTenantId: defaultTenantId(),
    ...(runtimeTelemetryConnector !== undefined ? { runtimeTelemetryConnector } : {}),
  })
  registerTokenEconomicsRoutes(app, {
    mode: exposureMode,
    defaultTenantId: defaultTenantId(),
    ...(runtimeTelemetryConnector !== undefined ? { runtimeTelemetryConnector } : {}),
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
