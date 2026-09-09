import { randomUUID } from 'node:crypto'
import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CosmosClient } from '@azure/cosmos'
import { DefaultAzureCredential } from '@azure/identity'
import { createAzureMonitorOtelConnector } from '@agent-sentinel/azure-monitor-otel-connector'
import { runtimeTelemetryRequestForAgent } from '@agent-sentinel/connector-sdk'
import type {
  BusinessOutcomeConnector,
  BusinessOutcomeRequest,
  ConnectorHealthRepository,
  ManifestIngestionRepository,
  RuntimeTelemetryRequest,
  RuntimeTelemetryConnector,
} from '@agent-sentinel/connector-sdk'

import type {
  ConnectorSourceDefinition,
  EstateContext,
  ConnectorSourceRepository,
  ExposureFindingRepository,
  GovernanceCaseRepository,
  SnapshotRepository,
} from '@agent-sentinel/domain'
import {
  CosmosConnectorHealthRepository,
  CosmosExposureFindingRepository,
  CosmosConnectorSourceRepository,
  CosmosGovernanceCaseRepository,
  CosmosManifestIngestionRepository,
  CosmosSnapshotRepository,
  InMemoryManifestIngestionRepository,
  InMemoryConnectorSourceRepository,
} from '@agent-sentinel/persistence'
import { MockBusinessOutcomeConnector } from '@agent-sentinel/mock-connector'
import {
  buildDeploymentConnectorSources,
  DeploymentConnectorSourceRepository,
  reconcileAgent365PersistedHealth,
  resolveAgent365Runtime,
  synthesizeAgent365UnmeasuredHealth,
} from '@agent-sentinel/connector-runtime'

import {
  buildAuthConfig,
  CAPABILITIES,
  createAuthMiddleware,
  requireCapability,
  type AuthConfig,
} from './auth.js'
import { createAdvisoryService, type AdvisoryService } from './advisory-service.js'
import {
  createConfiguredConnector,
  createConfiguredConnectorForEstate,
} from './connector-factory.js'
import {
  DemoService,
  NotFoundError,
  ReadModelUnavailableError,
  StateConflictError,
} from './demo-service.js'
import { registerExposureRoutes } from './exposure-routes.js'
import { registerGovernanceRoutes } from './governance-routes.js'
import {
  createSeededGovernanceCaseRepository,
  registerGovernanceQueueRoutes,
} from './governance-queue-routes.js'
import { buildConnectorsCollection } from './connectors-catalog.js'
import { registerBehaviorRoutes } from './behavior-routes.js'
import {
  registerTokenEconomicsRoutes,
  tokenEconomicsAttributionForAgent,
} from './token-economics-routes.js'
import { registerManifestIngestionRoutes } from './manifest-ingestion-routes.js'
import { registerBusinessValueRoutes } from './business-value-routes.js'
import { authorizedEstates, createEstateMiddleware } from './estate-auth.js'
import { requireEstateContext } from './estate-auth.js'
import { buildEstateRegistry, type EstateRegistry } from './estate-config.js'
import { registerConnectorSourceRoutes } from './connector-source-routes.js'

const localApprovalSchema = z.object({
  approvedBy: z.string().trim().min(2).max(100),
  reason: z.string().trim().min(10).max(500),
})

const authenticatedApprovalSchema = z.object({
  approvedBy: z.string().trim().min(2).max(100).optional(),
  reason: z.string().trim().min(10).max(500),
})

async function configuredService(
  estate: EstateContext,
  snapshotRepository?: SnapshotRepository,
  persistedReadModelRequired = false,
  runtimeTelemetryConnector?: RuntimeTelemetryConnector,
  manifestIngestionRepository?: ManifestIngestionRepository,
  connectorSourceRepository?: ConnectorSourceRepository,
): Promise<DemoService> {
  const configured =
    persistedReadModelRequired && connectorSourceRepository !== undefined
      ? await createConfiguredConnectorForEstate(estate, connectorSourceRepository)
      : createConfiguredConnector(process.env, { estate })
  if (
    (configured.tenantId !== undefined && configured.tenantId !== estate.tenantId) ||
    (configured.environment !== undefined && configured.environment !== estate.environment)
  ) {
    throw new Error('Configured connector boundary does not match the default estate.')
  }
  const persistedReadModel =
    snapshotRepository !== undefined &&
    configured.tenantId !== undefined &&
    configured.environment !== undefined
      ? {
          snapshotRepository,
        }
      : undefined
  return new DemoService(
    estate,
    configured.connector,
    configured.mode,
    configured.projectEndpoint,
    persistedReadModel,
    persistedReadModelRequired,
    runtimeTelemetryConnector,
    manifestIngestionRepository,
  )
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
    process.env['FOUNDRY_TENANT_ID']?.trim() ||
    process.env['AZURE_MONITOR_TENANT_ID']?.trim() ||
    'tenant-demo'
  )
}

function defaultEnvironment(): string {
  return (
    process.env['AGENT_SENTINEL_ENVIRONMENT']?.trim() ||
    process.env['FOUNDRY_ENVIRONMENT']?.trim() ||
    'validation'
  )
}

function telemetryRequestResolver(
  snapshotRepository: SnapshotRepository | undefined,
):
  | ((agentId: string, estate: EstateContext) => Promise<RuntimeTelemetryRequest | undefined>)
  | undefined {
  if (snapshotRepository === undefined) return undefined
  return async (agentId, estate) => {
    const snapshot = await snapshotRepository.findLatest(estate)
    if (snapshot === null) return undefined
    const agent = snapshot.nodes.find((node) => node.kind === 'agent' && node.id === agentId)
    return agent === undefined
      ? undefined
      : runtimeTelemetryRequestForAgent(snapshot, agent, estate)
  }
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

export function buildLiveRepositories(
  clientOverride?: CosmosClient,
  authoritativeSources: readonly ConnectorSourceDefinition[] = [],
): {
  connectorSourceRepository: ConnectorSourceRepository
  exposureRepository: ExposureFindingRepository
  snapshotRepository: SnapshotRepository
  governanceCaseRepository: GovernanceCaseRepository
  manifestIngestionRepository: ManifestIngestionRepository
  connectorHealthRepository: ConnectorHealthRepository
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
    connectorSourceRepository: new CosmosConnectorSourceRepository(client, {
      databaseId,
      containerId: process.env['COSMOS_CONNECTOR_SOURCES_CONTAINER']?.trim() || 'connector-sources',
      authoritativeSources,
    }),
    exposureRepository: new CosmosExposureFindingRepository(client, databaseId),
    snapshotRepository: new CosmosSnapshotRepository(client, databaseId),
    connectorHealthRepository: new CosmosConnectorHealthRepository(client, databaseId),
    governanceCaseRepository: new CosmosGovernanceCaseRepository(client, {
      tenantId: defaultTenantId(),
      databaseId,
      containerId: governanceContainerId,
    }),
    manifestIngestionRepository: new CosmosManifestIngestionRepository(client, {
      tenantId: defaultTenantId(),
      databaseId,
      containerId:
        process.env['COSMOS_MANIFEST_INGESTIONS_CONTAINER']?.trim() || 'manifest-ingestions',
    }),
  }
}

export interface CreateAppOptions {
  connectorSourceRepository?: ConnectorSourceRepository
  exposureRepository?: ExposureFindingRepository
  snapshotRepository?: SnapshotRepository
  governanceCaseRepository?: GovernanceCaseRepository
  manifestIngestionRepository?: ManifestIngestionRepository
  connectorHealthRepository?: ConnectorHealthRepository
  advisoryService?: AdvisoryService
  dataMode?: 'mock' | 'live'
  /** `null` explicitly keeps live telemetry unconfigured, including in tests. */
  runtimeTelemetryConnector?: RuntimeTelemetryConnector | null
  /** `null` explicitly keeps business outcomes unconfigured. */
  businessOutcomeConnector?: BusinessOutcomeConnector | null
  estateRegistry?: EstateRegistry
  connectorSourceClock?: () => Date
  connectorHealthClock?: () => Date
}

export async function createApp(
  service?: DemoService,
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
  const fallbackEstate: EstateContext = {
    id: process.env['AGENT_SENTINEL_ESTATE_ID']?.trim() || 'default',
    tenantId: defaultTenantId(),
    environment: defaultEnvironment(),
  }
  const estateRegistry =
    options.estateRegistry ??
    buildEstateRegistry(process.env, {
      ...fallbackEstate,
      ...(authConfig.mode === 'jwt' ? { authTenantId: authConfig.tenantId } : {}),
    })
  const defaultEstate: EstateContext = {
    id: estateRegistry.defaultEstate.id,
    tenantId: estateRegistry.defaultEstate.tenantId,
    environment: estateRegistry.defaultEstate.environment,
  }
  app.addHook('onRequest', createEstateMiddleware(authConfig, estateRegistry))

  const resolvedDataMode = options.dataMode ?? dataMode()
  const runtimeTelemetryConnector =
    resolvedDataMode !== 'live' || options.runtimeTelemetryConnector === null
      ? undefined
      : (options.runtimeTelemetryConnector ??
        createAzureMonitorOtelConnector(process.env, undefined, resolvedDataMode))
  const businessOutcomeConnector =
    options.businessOutcomeConnector === null
      ? undefined
      : (options.businessOutcomeConnector ??
        (resolvedDataMode === 'mock' ? new MockBusinessOutcomeConnector() : undefined))
  const exposureMode: 'mock' | 'foundry' = resolvedDataMode === 'live' ? 'foundry' : 'mock'
  const writeEnabled = defaultWriteEnabled(resolvedDataMode, authConfig)
  const deploymentConnectorSources = buildDeploymentConnectorSources(
    process.env,
    estateRegistry,
    resolvedDataMode,
  )
  const liveRepositories =
    resolvedDataMode === 'live' &&
    options.exposureRepository === undefined &&
    options.snapshotRepository === undefined
      ? buildLiveRepositories(undefined, deploymentConnectorSources)
      : undefined
  const exposureRepository = options.exposureRepository ?? liveRepositories?.exposureRepository
  const snapshotRepository = options.snapshotRepository ?? liveRepositories?.snapshotRepository
  const connectorHealthRepository =
    options.connectorHealthRepository ?? liveRepositories?.connectorHealthRepository
  const governanceCaseRepository =
    options.governanceCaseRepository ??
    (resolvedDataMode === 'mock'
      ? createSeededGovernanceCaseRepository(exposureMode, writeEnabled)
      : liveRepositories?.governanceCaseRepository)
  const manifestIngestionRepository =
    options.manifestIngestionRepository ??
    liveRepositories?.manifestIngestionRepository ??
    (resolvedDataMode === 'mock'
      ? new InMemoryManifestIngestionRepository(defaultTenantId())
      : undefined)
  const persistedConnectorSourceRepository =
    options.connectorSourceRepository ??
    liveRepositories?.connectorSourceRepository ??
    (resolvedDataMode === 'mock' ? new InMemoryConnectorSourceRepository() : undefined)
  const connectorSourceRepository =
    persistedConnectorSourceRepository === undefined || deploymentConnectorSources.length === 0
      ? persistedConnectorSourceRepository
      : new DeploymentConnectorSourceRepository(
          persistedConnectorSourceRepository,
          deploymentConnectorSources,
        )
  const defaultService =
    service === undefined
      ? await configuredService(
          defaultEstate,
          resolvedDataMode === 'live' ? snapshotRepository : undefined,
          resolvedDataMode === 'live',
          runtimeTelemetryConnector,
          manifestIngestionRepository,
          persistedConnectorSourceRepository,
        )
      : undefined
  const resolvedService = service ?? defaultService
  if (resolvedService === undefined) {
    throw new Error('Failed to initialize the application service.')
  }
  const stateService =
    resolvedDataMode === 'live'
      ? (defaultService ??
        (await configuredService(
          defaultEstate,
          snapshotRepository,
          true,
          runtimeTelemetryConnector,
          manifestIngestionRepository,
          persistedConnectorSourceRepository,
        )))
      : resolvedService

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

  app.get('/api/estates', (request) => {
    const estates = authorizedEstates(request, authConfig, estateRegistry)
    return {
      defaultEstateId: estateRegistry.defaultEstate.id,
      estates: estates.map(({ id, name, tenantId, environment, isDefault }) => ({
        id,
        name,
        tenantId,
        environment,
        isDefault,
      })),
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

  app.get('/api/demo/state', async () => stateService.getState())
  app.get('/api/connector/status', async () => resolvedService.getConnectorStatus())
  app.get('/api/connectors', async (request) => {
    const estate = requireEstateContext(request)
    const isDefaultEstate =
      estate.id === defaultEstate.id &&
      estate.tenantId === defaultEstate.tenantId &&
      estate.environment === defaultEstate.environment
    const status = await resolvedService.getConnectorStatus()
    const persistedHealth =
      resolvedDataMode === 'live'
        ? await connectorHealthRepository?.findLatest(estate, status.connectorId)
        : undefined
    const currentAgent365Runtime =
      resolvedDataMode === 'live' && connectorSourceRepository !== undefined
        ? await resolveAgent365Runtime(connectorSourceRepository, estate)
        : undefined
    const connectorHealth =
      resolvedDataMode === 'live'
        ? persistedHealth === undefined || persistedHealth === null
          ? currentAgent365Runtime !== undefined && currentAgent365Runtime.bindings.length > 0
            ? synthesizeAgent365UnmeasuredHealth(currentAgent365Runtime)
            : undefined
          : reconcileAgent365PersistedHealth(
              persistedHealth,
              currentAgent365Runtime?.bindings ?? [],
              options.connectorHealthClock?.() ?? new Date(),
            )
        : isDefaultEstate
          ? resolvedService.getConnectorHealth()
          : undefined
    const connectionOk =
      resolvedDataMode === 'live'
        ? connectorHealth !== undefined && connectorHealth.overall !== 'unavailable'
        : isDefaultEstate
          ? (await resolvedService.testConnectorConnection()).ok
          : false
    return buildConnectorsCollection(status.mode, {
      connectorId: status.connectorId,
      connectionOk,
      ...(status.writeEnabled !== undefined ? { writeEnabled: status.writeEnabled } : {}),
      ...(isDefaultEstate && status.projectEndpoint !== undefined
        ? { projectEndpoint: status.projectEndpoint }
        : {}),
      runtimeTelemetryConfigured: isDefaultEstate && runtimeTelemetryConnector !== undefined,
      businessOutcomeConfigured:
        resolvedDataMode === 'live' && isDefaultEstate && businessOutcomeConnector !== undefined,
      ...(connectorHealth ? { connectorHealth } : {}),
    })
  })
  app.post(
    '/api/demo/reset',
    {
      preHandler: requireCapability(authConfig, 'configure'),
    },
    async () => resolvedService.reset(),
  )

  app.post<{ Params: { findingId: string } }>(
    '/api/demo/findings/:findingId/validate',
    { preHandler: requireCapability(authConfig, 'validateFinding') },
    async (request) => resolvedService.validateFinding(request.params.findingId),
  )

  app.post<{ Params: { findingId: string } }>(
    '/api/demo/findings/:findingId/remediations',
    { preHandler: requireCapability(authConfig, 'proposeRemediation') },
    async (request) => resolvedService.proposeRemediation(request.params.findingId),
  )

  app.post<{ Params: { remediationId: string }; Body: unknown }>(
    '/api/demo/remediations/:remediationId/approve',
    { preHandler: requireCapability(authConfig, 'approveRemediation') },
    async (request) => {
      const principal = request.authPrincipal
      if (authConfig.mode === 'jwt' && principal !== undefined) {
        const approval = authenticatedApprovalSchema.parse(request.body)
        const approvedBy =
          principal.preferredUsername ??
          principal.displayName ??
          principal.objectId ??
          principal.subject
        return resolvedService.approveRemediation(
          request.params.remediationId,
          approvedBy,
          approval.reason,
        )
      }
      const approval = localApprovalSchema.parse(request.body)
      return resolvedService.approveRemediation(
        request.params.remediationId,
        approval.approvedBy,
        approval.reason,
      )
    },
  )

  app.post<{ Params: { remediationId: string } }>(
    '/api/demo/remediations/:remediationId/execute',
    { preHandler: requireCapability(authConfig, 'executeRemediation') },
    async (request) => resolvedService.executeRemediation(request.params.remediationId),
  )

  const advisoryService = options.advisoryService ?? createAdvisoryService()
  registerExposureRoutes(app, {
    mode: exposureMode,
    defaultEstate,
    ...(exposureRepository ? { repository: exposureRepository } : {}),
    ...(snapshotRepository ? { snapshotRepository } : {}),
    advisoryService,
    authConfig,
  })
  registerGovernanceRoutes(app, {
    mode: exposureMode,
    defaultEstate,
    ...(exposureRepository ? { repository: exposureRepository } : {}),
  })
  registerGovernanceQueueRoutes(app, {
    mode: exposureMode,
    authConfig,
    writeEnabled,
    ...(governanceCaseRepository ? { repository: governanceCaseRepository } : {}),
  })
  const resolveTelemetryRequest = telemetryRequestResolver(snapshotRepository)
  const resolveTokenEconomicsAttribution = async (agentId: string, estate: EstateContext) => {
    const snapshot =
      resolvedDataMode === 'live'
        ? await snapshotRepository?.findLatest(estate)
        : (await stateService.getState()).snapshot
    return tokenEconomicsAttributionForAgent(snapshot, agentId)
  }
  registerBehaviorRoutes(app, {
    mode: exposureMode,
    ...(runtimeTelemetryConnector !== undefined ? { runtimeTelemetryConnector } : {}),
    ...(resolveTelemetryRequest !== undefined ? { resolveTelemetryRequest } : {}),
  })
  registerTokenEconomicsRoutes(app, {
    mode: exposureMode,
    ...(runtimeTelemetryConnector !== undefined ? { runtimeTelemetryConnector } : {}),
    ...(resolveTelemetryRequest !== undefined ? { resolveTelemetryRequest } : {}),
    resolveAttribution: resolveTokenEconomicsAttribution,
  })
  const resolveBusinessOutcomeRequest = async (
    agentId: string,
  ): Promise<BusinessOutcomeRequest | undefined> => {
    const snapshot =
      resolvedDataMode === 'live'
        ? await snapshotRepository?.findLatest(defaultEstate)
        : (await stateService.getState()).snapshot
    if (snapshot === undefined || snapshot === null) return undefined
    const agent = snapshot.nodes.find((node) => node.kind === 'agent' && node.id === agentId)
    const agentVersion = agent?.metadata['version']
    return agent === undefined
      ? undefined
      : {
          tenantId: snapshot.tenantId,
          agentId: agent.id,
          environment: agent.environment,
          acceptedCorrelations:
            agentVersion === undefined
              ? []
              : [{ kind: 'agent-version' as const, value: agentVersion }],
        }
  }
  registerBusinessValueRoutes(app, {
    mode: exposureMode,
    defaultTenantId: defaultTenantId(),
    ...(businessOutcomeConnector !== undefined ? { connector: businessOutcomeConnector } : {}),
    resolveRequest: resolveBusinessOutcomeRequest,
  })
  const manifestEnvironmentId =
    process.env['AGENT_SENTINEL_ENVIRONMENT']?.trim() || process.env['FOUNDRY_ENVIRONMENT']?.trim()
  registerManifestIngestionRoutes(app, {
    authConfig,
    writeEnabled,
    ...(manifestIngestionRepository ? { repository: manifestIngestionRepository } : {}),
    tenantId: defaultTenantId(),
    ...(manifestEnvironmentId ? { environmentId: manifestEnvironmentId } : {}),
  })
  registerConnectorSourceRoutes(app, {
    authConfig,
    ...(connectorSourceRepository ? { repository: connectorSourceRepository } : {}),
    writeEnabled:
      writeEnabled && process.env['AGENT_SENTINEL_WRITE_ENABLED']?.trim().toLowerCase() === 'true',
    ...(options.connectorSourceClock ? { clock: options.connectorSourceClock } : {}),
  })

  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      error instanceof z.ZodError
        ? 400
        : error instanceof NotFoundError
          ? 404
          : error instanceof StateConflictError
            ? 409
            : error instanceof ReadModelUnavailableError
              ? 503
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
              : statusCode === 503
                ? 'read_model_unavailable'
                : 'internal_error',
      message,
    })
  })

  return app
}
