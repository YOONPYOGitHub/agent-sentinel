import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jose = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => ({ mocked: 'jwks' })),
  jwtVerify: vi.fn(),
}))

vi.mock('jose', () => jose)

import {
  type ConnectorSourceAuditRecord,
  type ConnectorSourceCreateInput,
  type ConnectorSourceDefinition,
  type ConnectorSourceMutationContext,
  type EstateContext,
} from '@agent-sentinel/domain'
import { InMemoryConnectorSourceRepository } from '@agent-sentinel/persistence'

import { createApp } from '../src/app.js'
import type { AuthConfig } from '../src/auth.js'
import { buildEstateRegistry } from '../src/estate-config.js'

const jwtConfig: AuthConfig = {
  mode: 'jwt',
  tenantId: 'auth-tenant',
  audience: 'api://agent-sentinel',
  issuer: 'https://login.microsoftonline.com/auth-tenant/v2.0',
  jwksUri: 'https://login.microsoftonline.com/auth-tenant/discovery/v2.0/keys',
  allowedScopes: { read: ['AgentSentinel.Read'], write: ['AgentSentinel.Write'] },
  spaConfig: {
    tenantId: 'auth-tenant',
    clientId: 'client-id',
    authority: 'https://login.microsoftonline.com/auth-tenant',
    scopes: ['api://agent-sentinel/AgentSentinel.Read'],
    redirectUri: 'https://sentinel.example/auth/callback',
    postLogoutRedirectUri: 'https://sentinel.example/',
  },
}

const defaultEstate: EstateContext = {
  id: 'default',
  tenantId: 'tenant-default',
  environment: 'production',
}

const registry = buildEstateRegistry(
  {
    AGENT_SENTINEL_ESTATES_JSON: JSON.stringify([
      {
        ...defaultEstate,
        name: 'Default',
        isDefault: true,
        allowedAuthTenantIds: ['auth-tenant'],
      },
      {
        id: 'lab',
        name: 'Lab',
        tenantId: 'tenant-lab',
        environment: 'validation',
        isDefault: false,
        allowedAuthTenantIds: ['auth-tenant'],
      },
    ]),
  },
  { ...defaultEstate, authTenantId: 'auth-tenant' },
)

const createBody = {
  sourceId: 'foundry-primary',
  connectorType: 'foundry',
  displayName: 'Primary Foundry',
  enabled: true,
  configuration: {
    type: 'foundry',
    projectEndpoint: 'https://safe.services.ai.azure.com/api/projects/project-one',
  },
  credential: { mode: 'default' },
} as const

const agent365CreateBody = {
  sourceId: 'agent365-user',
  connectorType: 'agent365',
  displayName: 'User Agent 365',
  enabled: true,
  configuration: {
    type: 'agent365',
    graphBaseUrl: 'https://graph.microsoft.com',
    limits: {
      maxPages: 20,
      maxItems: 5_000,
      requestTimeoutMs: 15_000,
      maxRetries: 2,
      maxRetryAfterMs: 30_000,
      maxResponseBytes: 2_000_000,
    },
  },
  credential: {
    mode: 'managed-identity',
    managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
  },
} as const

const apps: Awaited<ReturnType<typeof createApp>>[] = []

function authenticate(role: 'Viewer' | 'Analyst' | 'Administrator'): void {
  jose.jwtVerify.mockResolvedValue({
    payload: {
      sub: `${role.toLowerCase()}-subject`,
      oid: `${role.toLowerCase()}-object`,
      tid: 'auth-tenant',
      idtyp: 'user',
      roles: [`AgentSentinel.${role}`],
    },
  })
}

async function makeApp(
  repository = new InMemoryConnectorSourceRepository(),
  writeEnabled = true,
  clock: () => Date = () => new Date('2026-09-06T04:00:00.000Z'),
): Promise<Awaited<ReturnType<typeof createApp>>> {
  process.env['AGENT_SENTINEL_WRITE_ENABLED'] = writeEnabled ? 'true' : 'false'
  process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
  const app = await createApp(undefined, jwtConfig, {
    dataMode: 'mock',
    connectorSourceRepository: repository,
    estateRegistry: registry,
    connectorSourceClock: clock,
  })
  apps.push(app)
  return app
}

function headers(
  extras: Record<string, string> = {},
  estateId = 'default',
): Record<string, string> {
  return {
    authorization: 'Bearer valid-token',
    'x-agent-sentinel-estate-id': estateId,
    ...extras,
  }
}

function sourceInput(
  estate: EstateContext,
  sourceId: string,
  overrides: Partial<ConnectorSourceCreateInput> = {},
): ConnectorSourceCreateInput {
  return {
    estateId: estate.id,
    tenantId: estate.tenantId,
    environment: estate.environment,
    sourceId,
    connectorType: 'manifest',
    displayName: `${estate.id} source`,
    enabled: true,
    origin: 'deployment',
    configuration: { type: 'manifest', manifestId: `${estate.id}-manifest` },
    credential: { mode: 'default' },
    testStatus: { status: 'not-tested' },
    ...overrides,
  }
}

function mutation(
  id: string,
  occurredAt = '2026-09-06T03:00:00.000Z',
): ConnectorSourceMutationContext {
  return {
    auditId: `audit-${id}`,
    idempotencyKey: `idem-${id}`,
    actor: { type: 'deployment', id: 'deployment-pipeline' },
    occurredAt,
  }
}

async function seed(
  repository: InMemoryConnectorSourceRepository,
  estate: EstateContext,
  sourceId: string,
  overrides: Partial<ConnectorSourceCreateInput> = {},
): Promise<ConnectorSourceDefinition> {
  const result = await repository.create(
    estate,
    sourceInput(estate, sourceId, overrides),
    mutation(`${estate.id}-${sourceId}`),
  )
  if (result.status !== 'applied' || result.source === null) {
    throw new Error('Failed to seed connector source.')
  }
  return result.source
}

function legacyAzureMonitorSource(sourceId = 'azure-monitor-primary'): unknown {
  return {
    estateId: defaultEstate.id,
    tenantId: defaultEstate.tenantId,
    environment: defaultEstate.environment,
    sourceId,
    connectorType: 'azure-monitor-otel',
    displayName: 'Legacy runtime telemetry',
    enabled: true,
    origin: 'user',
    configuration: {
      type: 'azure-monitor-otel',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      logsBaseUrl: 'https://api.loganalytics.io',
      baselineWindowHours: 168,
      observedWindowHours: 24,
      requestTimeoutMs: 15_000,
      maxResponseBytes: 4_194_304,
    },
    credential: { mode: 'default' },
    testStatus: {
      status: 'passed',
      evidenceBasis: 'provider-response',
      evidenceIds: ['legacy-evidence'],
      checkedAt: '2026-09-04T00:00:00.000Z',
      checkedBy: { type: 'user', id: 'administrator-object-id' },
      summary: 'Legacy provider response.',
    },
    version: 1,
    etag: 'legacy-etag',
    createdBy: { type: 'user', id: 'administrator-object-id' },
    updatedBy: { type: 'user', id: 'administrator-object-id' },
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
  }
}

function legacyAzureMonitorAudit(sourceId = 'azure-monitor-primary'): unknown {
  const after = legacyAzureMonitorSource(sourceId) as ConnectorSourceDefinition
  return {
    id: 'legacy-audit-create',
    estateId: defaultEstate.id,
    tenantId: defaultEstate.tenantId,
    environment: defaultEstate.environment,
    sourceId: after.sourceId,
    operation: 'create',
    actor: after.createdBy,
    occurredAt: after.createdAt,
    idempotencyKey: 'legacy-create',
    before: null,
    after,
  } satisfies ConnectorSourceAuditRecord
}

beforeEach(() => {
  jose.createRemoteJWKSet.mockClear()
  jose.jwtVerify.mockReset()
})

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()))
  delete process.env['AGENT_SENTINEL_WRITE_ENABLED']
  delete process.env['AGENT_SENTINEL_CONNECTOR']
  delete process.env['AGENT_SENTINEL_TENANT_ID']
  delete process.env['AGENT_SENTINEL_ENVIRONMENT']
  delete process.env['FOUNDRY_ENVIRONMENT']
  delete process.env['FOUNDRY_SOURCES_JSON']
})

describe('connector source API authorization and boundaries', () => {
  it('lists legacy Azure Monitor sources as inactive migration-required records', async () => {
    const repository = new InMemoryConnectorSourceRepository({
      persistedSources: [legacyAzureMonitorSource()],
    })
    authenticate('Administrator')
    const app = await makeApp(repository)

    const listed = await app.inject({
      method: 'GET',
      url: '/api/connector-sources',
      headers: headers(),
    })
    const status = await app.inject({
      method: 'GET',
      url: '/api/connector-sources/azure-monitor-primary/connection-test-status',
      headers: headers(),
    })
    const update = await app.inject({
      method: 'PATCH',
      url: '/api/connector-sources/azure-monitor-primary',
      headers: headers({
        'idempotency-key': 'legacy-update',
        'if-match': '"legacy-etag"',
      }),
      payload: { enabled: true },
    })

    expect(listed.statusCode, listed.body).toBe(200)
    expect(listed.json()).toMatchObject({
      items: [
        {
          sourceId: 'azure-monitor-primary',
          enabled: false,
          testStatus: { status: 'not-tested' },
          migration: {
            status: 'migration-required',
            active: false,
            reason: 'missing-source-project-id',
          },
        },
      ],
    })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({
      status: 'unknown',
      evidenceAvailability: 'unavailable',
      summary: 'An exact source project ID is required before this source can be activated.',
    })
    expect(update.statusCode).toBe(409)
    expect(update.json()).toMatchObject({ error: 'connector_source_migration_required' })
  })

  it('returns legacy Azure Monitor audit snapshots as migration-required without losing metadata', async () => {
    const sourceId = 'legacy-azure-monitor-audit'
    const repository = new InMemoryConnectorSourceRepository({
      persistedSources: [legacyAzureMonitorSource(sourceId)],
      persistedAudits: [legacyAzureMonitorAudit(sourceId)],
    })
    authenticate('Administrator')
    const app = await makeApp(repository)

    const response = await app.inject({
      method: 'GET',
      url: `/api/connector-sources/${sourceId}/audit`,
      headers: headers(),
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toMatchObject({
      items: [
        {
          id: 'legacy-audit-create',
          actor: { type: 'user', id: 'administrator-object-id' },
          occurredAt: '2026-09-04T00:00:00.000Z',
          before: null,
          after: {
            sourceId,
            version: 1,
            etag: 'legacy-etag',
            enabled: false,
            migration: {
              status: 'migration-required',
              active: false,
              reason: 'missing-source-project-id',
            },
          },
        },
      ],
    })
  })

  it('requires JWT authentication, exact Administrator RBAC, and the explicit write gate', async () => {
    const repository = new InMemoryConnectorSourceRepository()
    const app = await makeApp(repository)

    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/connector-sources',
      headers: { 'idempotency-key': 'create-unauthenticated' },
      payload: createBody,
    })
    expect(unauthenticated.statusCode).toBe(401)

    for (const role of ['Viewer', 'Analyst'] as const) {
      authenticate(role)
      const denied = await app.inject({
        method: 'POST',
        url: '/api/connector-sources',
        headers: headers({ 'idempotency-key': `create-${role.toLowerCase()}` }),
        payload: createBody,
      })
      expect(denied.statusCode).toBe(403)
      expect(denied.json()).toMatchObject({ error: 'forbidden' })
    }

    const disabledApp = await makeApp(new InMemoryConnectorSourceRepository(), false)
    authenticate('Administrator')
    const writeDisabled = await disabledApp.inject({
      method: 'POST',
      url: '/api/connector-sources',
      headers: headers({ 'idempotency-key': 'create-disabled' }),
      payload: createBody,
    })
    expect(writeDisabled.statusCode).toBe(403)
    expect(writeDisabled.json()).toMatchObject({ error: 'read_only_mode' })
    const disabledList = await disabledApp.inject({
      method: 'GET',
      url: '/api/connector-sources',
      headers: headers(),
    })
    expect(disabledList.json()).toMatchObject({
      mutationPolicy: {
        enabled: false,
        requiresAuthentication: true,
        requiredCapability: 'configure',
      },
    })

    const localApp = await createApp(
      undefined,
      { mode: 'disabled' },
      {
        dataMode: 'mock',
        connectorSourceRepository: new InMemoryConnectorSourceRepository(),
      },
    )
    apps.push(localApp)
    const localWrite = await localApp.inject({
      method: 'POST',
      url: '/api/connector-sources',
      headers: { 'idempotency-key': 'create-local' },
      payload: createBody,
    })
    expect(localWrite.statusCode).toBe(401)
  })

  it('isolates the same source ID by authorized estate and rejects unauthorized selection', async () => {
    const repository = new InMemoryConnectorSourceRepository()
    await seed(repository, defaultEstate, 'shared-source')
    await seed(
      repository,
      { id: 'lab', tenantId: 'tenant-lab', environment: 'validation' },
      'shared-source',
    )
    authenticate('Viewer')
    const app = await makeApp(repository)

    const production = await app.inject({
      method: 'GET',
      url: '/api/connector-sources/shared-source',
      headers: headers(),
    })
    const lab = await app.inject({
      method: 'GET',
      url: '/api/connector-sources/shared-source',
      headers: headers({}, 'lab'),
    })
    expect(production.json()).toMatchObject({
      estateId: 'default',
      tenantId: 'tenant-default',
      environment: 'production',
    })
    expect(lab.json()).toMatchObject({
      estateId: 'lab',
      tenantId: 'tenant-lab',
      environment: 'validation',
    })

    const unauthorized = await app.inject({
      method: 'GET',
      url: '/api/connector-sources/shared-source',
      headers: headers({}, 'outside'),
    })
    expect(unauthorized.statusCode).toBe(403)
  })
})

describe('connector source API contracts', () => {
  it('keeps Agent 365 visible but rejects every user-origin mutation without audit writes', async () => {
    const repository = new InMemoryConnectorSourceRepository()
    const enabledSource = await seed(repository, defaultEstate, 'agent365-enabled', {
      connectorType: 'agent365',
      displayName: 'Legacy enabled Agent 365',
      enabled: true,
      origin: 'user',
      configuration: agent365CreateBody.configuration,
      credential: agent365CreateBody.credential,
    })
    const disabledSource = await seed(repository, defaultEstate, 'agent365-disabled', {
      connectorType: 'agent365',
      displayName: 'Legacy disabled Agent 365',
      enabled: false,
      origin: 'user',
      configuration: agent365CreateBody.configuration,
      credential: agent365CreateBody.credential,
    })
    authenticate('Administrator')
    const app = await makeApp(repository)

    const create = await app.inject({
      method: 'POST',
      url: '/api/connector-sources',
      headers: headers({ 'idempotency-key': 'reject-agent365-create' }),
      payload: agent365CreateBody,
    })
    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/connector-sources/${enabledSource.sourceId}`,
      headers: headers({
        'idempotency-key': 'reject-agent365-disable',
        'if-match': `"${enabledSource.etag}"`,
      }),
      payload: { enabled: false },
    })
    const enable = await app.inject({
      method: 'PATCH',
      url: `/api/connector-sources/${disabledSource.sourceId}`,
      headers: headers({
        'idempotency-key': 'reject-agent365-enable',
        'if-match': `"${disabledSource.etag}"`,
      }),
      payload: { enabled: true },
    })
    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/connector-sources/${enabledSource.sourceId}`,
      headers: headers({
        'idempotency-key': 'reject-agent365-delete',
        'if-match': `"${enabledSource.etag}"`,
      }),
    })

    for (const response of [create, disable, enable, remove]) {
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({
        error: 'agent365_deployment_managed_only',
      })
    }
    const listed = await app.inject({
      method: 'GET',
      url: '/api/connector-sources',
      headers: headers(),
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toMatchObject({
      items: [
        { sourceId: 'agent365-disabled', enabled: false, origin: 'user' },
        { sourceId: 'agent365-enabled', enabled: true, origin: 'user' },
      ],
    })
    await expect(repository.findById(defaultEstate, 'agent365-user')).resolves.toBeNull()
    await expect(repository.listAudit(defaultEstate, enabledSource.sourceId)).resolves.toHaveLength(
      1,
    )
    await expect(
      repository.listAudit(defaultEstate, disabledSource.sourceId),
    ).resolves.toHaveLength(1)
  })

  it('lists, gets, updates, replays, deletes, and retains ordered immutable audit', async () => {
    authenticate('Administrator')
    const app = await makeApp()

    const created = await app.inject({
      method: 'POST',
      url: '/api/connector-sources',
      headers: headers({ 'idempotency-key': 'create-primary' }),
      payload: createBody,
    })
    expect(created.statusCode).toBe(201)
    const createdBody = created.json<{
      replayed: boolean
      source: ConnectorSourceDefinition
      audit: Record<string, unknown>
    }>()
    expect(createdBody.replayed).toBe(false)
    expect(createdBody.source).toMatchObject({
      estateId: 'default',
      tenantId: 'tenant-default',
      environment: 'production',
      origin: 'user',
      testStatus: { status: 'not-tested' },
      createdBy: { type: 'user', id: 'administrator-object' },
    })
    expect(createdBody.audit).not.toHaveProperty('idempotencyKey')
    expect(created.headers.etag).toBe(`"${createdBody.source.etag}"`)

    const replay = await app.inject({
      method: 'POST',
      url: '/api/connector-sources',
      headers: headers({ 'idempotency-key': 'create-primary' }),
      payload: createBody,
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({ replayed: true, source: { version: 1 } })

    const listed = await app.inject({
      method: 'GET',
      url: '/api/connector-sources?limit=1',
      headers: headers(),
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toMatchObject({
      items: [{ sourceId: 'foundry-primary' }],
      page: { limit: 1, nextCursor: null },
    })

    const stale = await app.inject({
      method: 'PATCH',
      url: '/api/connector-sources/foundry-primary',
      headers: headers({
        'idempotency-key': 'update-stale',
        'if-match': '"stale-etag"',
      }),
      payload: { enabled: false },
    })
    expect(stale.statusCode).toBe(412)
    expect(stale.json()).toMatchObject({ error: 'etag_mismatch' })

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/connector-sources/foundry-primary',
      headers: headers({
        'idempotency-key': 'update-primary',
        'if-match': `"${createdBody.source.etag}"`,
      }),
      payload: { displayName: 'Updated Foundry', enabled: false },
    })
    expect(updated.statusCode).toBe(200)
    const updatedSource = updated.json<{ source: ConnectorSourceDefinition }>().source
    expect(updatedSource).toMatchObject({
      displayName: 'Updated Foundry',
      enabled: false,
      version: 2,
    })

    const updateReplay = await app.inject({
      method: 'PATCH',
      url: '/api/connector-sources/foundry-primary',
      headers: headers({
        'idempotency-key': 'update-primary',
        'if-match': `"${createdBody.source.etag}"`,
      }),
      payload: { displayName: 'Updated Foundry', enabled: false },
    })
    expect(updateReplay.statusCode).toBe(200)
    expect(updateReplay.json()).toMatchObject({ replayed: true, source: { version: 2 } })

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/connector-sources/foundry-primary',
      headers: headers({
        'idempotency-key': 'delete-primary',
        'if-match': `"${updatedSource.etag}"`,
      }),
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({ replayed: false, source: null })

    const missing = await app.inject({
      method: 'GET',
      url: '/api/connector-sources/foundry-primary',
      headers: headers(),
    })
    expect(missing.statusCode).toBe(404)

    const audit = await app.inject({
      method: 'GET',
      url: '/api/connector-sources/foundry-primary/audit',
      headers: headers(),
    })
    expect(audit.statusCode).toBe(200)
    const auditItems = audit.json<{
      items: Array<{ operation: string; occurredAt: string; idempotencyKey?: string }>
    }>().items
    expect(auditItems.map((item) => item.operation)).toEqual(['create', 'update', 'delete'])
    expect(auditItems.map((item) => item.occurredAt)).toEqual(
      auditItems.map((item) => item.occurredAt).toSorted(),
    )
    expect(auditItems.every((item) => item.idempotencyKey === undefined)).toBe(true)
  })

  it('rejects caller-controlled boundaries, test outcomes, unknown secret fields, and URLs', async () => {
    authenticate('Administrator')
    const app = await makeApp()

    const rejectedPayloads = [
      { ...createBody, tenantId: 'other-tenant' },
      { ...createBody, environment: 'other-environment' },
      { ...createBody, origin: 'deployment' },
      { ...createBody, runtimeBinding: { bindingSourceId: 'caller-controlled' } },
      {
        ...createBody,
        testStatus: {
          status: 'passed',
          evidenceBasis: 'provider-response',
          evidenceIds: ['caller-claim'],
          checkedAt: '2026-09-06T00:00:00.000Z',
          checkedBy: { type: 'user', id: 'caller' },
          summary: 'Caller says healthy.',
        },
      },
      {
        ...createBody,
        credential: { mode: 'default', clientSecret: 'must-not-be-accepted' },
      },
      {
        ...createBody,
        configuration: {
          type: 'foundry',
          projectEndpoint: 'https://attacker.example/api/projects/project-one',
        },
      },
      {
        ...createBody,
        displayName: 'Bearer raw-access-token',
      },
    ]
    for (const [index, payload] of rejectedPayloads.entries()) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/connector-sources',
        headers: headers({ 'idempotency-key': `reject-${index}` }),
        payload,
      })
      expect(response.statusCode).toBe(400)
      expect(response.body).not.toContain('must-not-be-accepted')
    }
  })

  it('rejects overlong Foundry project segments before create or update persistence', async () => {
    const repository = new InMemoryConnectorSourceRepository()
    authenticate('Administrator')
    const app = await makeApp(repository)
    const overlongEndpoint = 'https://safe.services.ai.azure.com/api/projects/' + 'p'.repeat(201)

    const rejectedCreate = await app.inject({
      method: 'POST',
      url: '/api/connector-sources',
      headers: headers({ 'idempotency-key': 'reject-overlong-create' }),
      payload: {
        ...createBody,
        configuration: {
          type: 'foundry',
          projectEndpoint: overlongEndpoint,
        },
      },
    })

    expect(rejectedCreate.statusCode).toBe(400)
    expect(await repository.findById(defaultEstate, createBody.sourceId)).toBeNull()

    const created = await app.inject({
      method: 'POST',
      url: '/api/connector-sources',
      headers: headers({ 'idempotency-key': 'create-for-overlong-update' }),
      payload: createBody,
    })
    const source = created.json<{ source: ConnectorSourceDefinition }>().source
    const rejectedUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/connector-sources/${createBody.sourceId}`,
      headers: headers({
        'idempotency-key': 'reject-overlong-update',
        'if-match': `"${source.etag}"`,
      }),
      payload: {
        configuration: {
          type: 'foundry',
          projectEndpoint: overlongEndpoint,
        },
      },
    })

    expect(rejectedUpdate.statusCode).toBe(400)
    expect(await repository.findById(defaultEstate, createBody.sourceId)).toMatchObject({
      version: 1,
      configuration: createBody.configuration,
    })
  })

  it('requires strong ETags and does not allow a reused key to change a mutation', async () => {
    authenticate('Administrator')
    const app = await makeApp()
    const created = await app.inject({
      method: 'POST',
      url: '/api/connector-sources',
      headers: headers({ 'idempotency-key': 'create-etag' }),
      payload: createBody,
    })
    const source = created.json<{ source: ConnectorSourceDefinition }>().source

    for (const ifMatch of [undefined, '*', source.etag, `W/"${source.etag}"`]) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/connector-sources/foundry-primary',
        headers: headers({
          'idempotency-key': `bad-etag-${ifMatch ?? 'missing'}`,
          ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
        }),
        payload: { enabled: false },
      })
      expect(response.statusCode).toBe(400)
    }

    const first = await app.inject({
      method: 'PATCH',
      url: '/api/connector-sources/foundry-primary',
      headers: headers({
        'idempotency-key': 'same-update-key',
        'if-match': `"${source.etag}"`,
      }),
      payload: { enabled: false },
    })
    expect(first.statusCode).toBe(200)

    const changedReplay = await app.inject({
      method: 'PATCH',
      url: '/api/connector-sources/foundry-primary',
      headers: headers({
        'idempotency-key': 'same-update-key',
        'if-match': `"${source.etag}"`,
      }),
      payload: { enabled: true },
    })
    expect(changedReplay.statusCode).toBe(409)
    expect(changedReplay.json()).toMatchObject({ error: 'idempotency_conflict' })
  })

  it('replays the winner for concurrent identical POST, PATCH, and DELETE requests', async () => {
    authenticate('Administrator')
    let tick = Date.parse('2026-09-06T04:00:00.000Z')
    const app = await makeApp(new InMemoryConnectorSourceRepository(), true, () => {
      tick += 1
      return new Date(tick)
    })

    const creates = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/connector-sources',
        headers: headers({ 'idempotency-key': 'concurrent-create' }),
        payload: createBody,
      }),
      app.inject({
        method: 'POST',
        url: '/api/connector-sources',
        headers: headers({ 'idempotency-key': 'concurrent-create' }),
        payload: createBody,
      }),
    ])
    expect(creates.map((response) => response.statusCode).sort()).toEqual([200, 201])
    type MutationResponse = {
      replayed: boolean
      source: ConnectorSourceDefinition | null
      audit: { id: string; occurredAt: string }
    }
    const createBodies = creates.map((response) => response.json<MutationResponse>())
    const created = createBodies.find((body) => !body.replayed)
    const createReplay = createBodies.find((body) => body.replayed)
    if (created?.source === null || created === undefined || createReplay === undefined) {
      throw new Error('Expected one applied create and one replay.')
    }
    expect(createReplay).toMatchObject({
      replayed: true,
      source: { etag: created.source.etag },
      audit: created.audit,
    })

    const updateRequest = {
      method: 'PATCH' as const,
      url: '/api/connector-sources/foundry-primary',
      headers: headers({
        'idempotency-key': 'concurrent-update',
        'if-match': `"${created.source.etag}"`,
      }),
      payload: { enabled: false },
    }
    const updates = await Promise.all([app.inject(updateRequest), app.inject(updateRequest)])
    expect(updates.map((response) => response.statusCode)).toEqual([200, 200])
    const updateBodies = updates.map((response) => response.json<MutationResponse>())
    expect(updateBodies.map((body) => body.replayed).sort()).toEqual([false, true])
    const appliedUpdate = updateBodies.find((body) => !body.replayed)
    const updateReplay = updateBodies.find((body) => body.replayed)
    if (
      appliedUpdate?.source === null ||
      appliedUpdate === undefined ||
      updateReplay === undefined
    ) {
      throw new Error('Expected one applied update and one replay.')
    }
    const updated = appliedUpdate.source
    expect(updateReplay).toMatchObject({
      source: { etag: updated.etag, updatedAt: updated.updatedAt },
    })

    const deleteRequest = {
      method: 'DELETE' as const,
      url: '/api/connector-sources/foundry-primary',
      headers: headers({
        'idempotency-key': 'concurrent-delete',
        'if-match': `"${updated.etag}"`,
      }),
    }
    const deletes = await Promise.all([app.inject(deleteRequest), app.inject(deleteRequest)])
    expect(deletes.map((response) => response.statusCode)).toEqual([200, 200])
    const deleteBodies = deletes.map((response) => response.json<MutationResponse>())
    expect(deleteBodies.map((body) => body.replayed).sort()).toEqual([false, true])
    expect(deleteBodies[0]!.audit).toEqual(deleteBodies[1]!.audit)

    const differingCreates = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/connector-sources',
        headers: headers({ 'idempotency-key': 'concurrent-different-create' }),
        payload: { ...createBody, sourceId: 'concurrent-winner-a' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/connector-sources',
        headers: headers({ 'idempotency-key': 'concurrent-different-create' }),
        payload: { ...createBody, sourceId: 'concurrent-winner-b' },
      }),
    ])
    expect(differingCreates.map((response) => response.statusCode).sort()).toEqual([201, 409])
    expect(differingCreates.find((response) => response.statusCode === 409)!.json()).toMatchObject({
      error: 'idempotency_conflict',
    })
  })

  it('paginates more than 200 sources and audits and replays an early retry', async () => {
    const repository = new InMemoryConnectorSourceRepository()
    for (let index = 0; index < 225; index += 1) {
      const id = `bulk-${String(index).padStart(3, '0')}`
      await seed(repository, defaultEstate, id)
    }
    authenticate('Administrator')
    let tick = Date.parse('2026-09-06T04:00:00.000Z')
    const app = await makeApp(repository, true, () => {
      tick += 1
      return new Date(tick)
    })

    const sourceIds: string[] = []
    let sourceCursor: string | null = null
    do {
      const response = (await app.inject({
        method: 'GET',
        url: `/api/connector-sources?limit=47${sourceCursor === null ? '' : `&cursor=${sourceCursor}`}`,
        headers: headers(),
      })) as { statusCode: number; json(): unknown }
      expect(response.statusCode).toBe(200)
      const body = response.json() as {
        items: ConnectorSourceDefinition[]
        page: { nextCursor: string | null }
      }
      sourceIds.push(...body.items.map((source) => source.sourceId))
      sourceCursor = body.page.nextCursor
    } while (sourceCursor !== null)
    expect(sourceIds).toHaveLength(225)
    expect(new Set(sourceIds)).toHaveLength(225)

    const created = await app.inject({
      method: 'POST',
      url: '/api/connector-sources',
      headers: headers({ 'idempotency-key': 'long-audit-create' }),
      payload: createBody,
    })
    let current = created.json<{ source: ConnectorSourceDefinition }>().source
    let firstUpdate: Record<string, unknown> | undefined
    for (let index = 0; index < 205; index += 1) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/connector-sources/foundry-primary',
        headers: headers({
          'idempotency-key': `long-audit-update-${index}`,
          'if-match': `"${current.etag}"`,
        }),
        payload: { displayName: `Version ${index}` },
      })
      expect(response.statusCode).toBe(200)
      const body = response.json<{ source: ConnectorSourceDefinition }>()
      if (index === 0) firstUpdate = body
      current = body.source
    }

    const retry = await app.inject({
      method: 'PATCH',
      url: '/api/connector-sources/foundry-primary',
      headers: headers({
        'idempotency-key': 'long-audit-update-0',
        'if-match': `"${created.json<{ source: ConnectorSourceDefinition }>().source.etag}"`,
      }),
      payload: { displayName: 'Version 0' },
    })
    expect(retry.statusCode).toBe(200)
    expect(retry.json()).toEqual({ ...firstUpdate, replayed: true })

    const auditIds: string[] = []
    let auditCursor: string | null = null
    do {
      const response = (await app.inject({
        method: 'GET',
        url: `/api/connector-sources/foundry-primary/audit?limit=43${
          auditCursor === null ? '' : `&cursor=${encodeURIComponent(auditCursor)}`
        }`,
        headers: headers(),
      })) as { statusCode: number; json(): unknown }
      expect(response.statusCode).toBe(200)
      const body = response.json() as {
        items: Array<{ id: string }>
        page: { nextCursor: string | null }
      }
      auditIds.push(...body.items.map((audit) => audit.id))
      auditCursor = body.page.nextCursor
    } while (auditCursor !== null)
    expect(auditIds).toHaveLength(206)
    expect(new Set(auditIds)).toHaveLength(206)
  })

  it('audits app-only JWT callers as service principals', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: {
        sub: 'application-subject',
        oid: 'service-principal-object',
        tid: 'auth-tenant',
        idtyp: 'app',
        roles: ['AgentSentinel.Administrator'],
      },
    })
    const app = await makeApp()
    const response = await app.inject({
      method: 'POST',
      url: '/api/connector-sources',
      headers: headers({ 'idempotency-key': 'application-create' }),
      payload: createBody,
    })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      source: {
        createdBy: { type: 'service-principal', id: 'service-principal-object' },
      },
      audit: {
        actor: { type: 'service-principal', id: 'service-principal-object' },
      },
    })
  })

  it('projects deployment JSON sources without persisting or activating them', async () => {
    process.env['AGENT_SENTINEL_TENANT_ID'] = defaultEstate.tenantId
    process.env['AGENT_SENTINEL_ENVIRONMENT'] = defaultEstate.environment
    process.env['FOUNDRY_ENVIRONMENT'] = defaultEstate.environment
    process.env['FOUNDRY_SOURCES_JSON'] = JSON.stringify([
      {
        id: 'primary',
        name: 'Deployment Foundry',
        tenantId: defaultEstate.tenantId,
        environment: defaultEstate.environment,
        projectEndpoint: 'https://safe.services.ai.azure.com/api/projects/deployment',
      },
      {
        id: 'lab',
        name: 'Lab Deployment Foundry',
        tenantId: 'tenant-lab',
        environment: 'validation',
        projectEndpoint: 'https://safe.services.ai.azure.com/api/projects/lab-deployment',
      },
    ])
    const repository = new InMemoryConnectorSourceRepository()
    authenticate('Administrator')
    const app = await makeApp(repository)

    const listed = await app.inject({
      method: 'GET',
      url: '/api/connector-sources',
      headers: headers(),
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toMatchObject({
      items: [
        {
          sourceId: 'foundry-lab',
          origin: 'deployment',
          enabled: false,
          testStatus: { status: 'not-tested' },
        },
        {
          sourceId: 'foundry-primary',
          origin: 'deployment',
          enabled: false,
          testStatus: { status: 'not-tested' },
        },
      ],
    })
    await expect(repository.list(defaultEstate)).resolves.toEqual([])
    const lab = await app.inject({
      method: 'GET',
      url: '/api/connector-sources',
      headers: headers({}, 'lab'),
    })
    expect(lab.statusCode).toBe(200)
    expect(lab.json()).toMatchObject({
      items: [],
    })

    const projected = listed.json<{ items: ConnectorSourceDefinition[] }>().items[0]!
    for (const request of [
      {
        method: 'POST' as const,
        url: '/api/connector-sources',
        headers: headers({ 'idempotency-key': 'projected-create' }),
        payload: { ...createBody, sourceId: projected.sourceId },
      },
      {
        method: 'PATCH' as const,
        url: `/api/connector-sources/${projected.sourceId}`,
        headers: headers({
          'idempotency-key': 'projected-update',
          'if-match': `"${projected.etag}"`,
        }),
        payload: { enabled: true },
      },
      {
        method: 'DELETE' as const,
        url: `/api/connector-sources/${projected.sourceId}`,
        headers: headers({
          'idempotency-key': 'projected-delete',
          'if-match': `"${projected.etag}"`,
        }),
      },
    ]) {
      const response = await app.inject(request)
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ error: 'immutable_source' })
    }
    await expect(repository.list(defaultEstate)).resolves.toEqual([])
  })

  it('keeps deployment-origin definitions immutable and non-deletable', async () => {
    const repository = new InMemoryConnectorSourceRepository()
    const deployment = await seed(repository, defaultEstate, 'deployment-source')
    authenticate('Administrator')
    const app = await makeApp(repository)

    for (const method of ['PATCH', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: '/api/connector-sources/deployment-source',
        headers: headers({
          'idempotency-key': `deployment-${method.toLowerCase()}`,
          'if-match': `"${deployment.etag}"`,
        }),
        ...(method === 'PATCH' ? { payload: { enabled: false } } : {}),
      })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ error: 'immutable_source' })
    }
  })

  it('reports connection-test evidence read-only and preserves unknown when unavailable', async () => {
    const repository = new InMemoryConnectorSourceRepository()
    await seed(repository, defaultEstate, 'untested-source')
    await seed(repository, defaultEstate, 'failed-source', {
      testStatus: {
        status: 'authorization-required',
        evidenceBasis: 'provider-response',
        evidenceIds: ['provider-response-401'],
        checkedAt: '2026-09-06T02:00:00.000Z',
        checkedBy: { type: 'service-principal', id: 'connector-test-worker' },
        summary: 'Provider returned an authorization failure.',
      },
    })
    authenticate('Viewer')
    const app = await makeApp(repository, false)

    const unknown = await app.inject({
      method: 'GET',
      url: '/api/connector-sources/untested-source/connection-test-status',
      headers: headers(),
    })
    expect(unknown.statusCode).toBe(200)
    expect(unknown.json()).toMatchObject({
      readOnly: true,
      status: 'unknown',
      evidenceAvailability: 'unavailable',
      evidenceBasis: null,
      evidenceIds: [],
      checkedAt: null,
    })

    const unavailable = await app.inject({
      method: 'GET',
      url: '/api/connector-sources/failed-source/connection-test-status',
      headers: headers(),
    })
    expect(unavailable.statusCode).toBe(200)
    expect(unavailable.json()).toMatchObject({
      readOnly: true,
      status: 'authorization-required',
      evidenceAvailability: 'available',
      evidenceBasis: 'provider-response',
      evidenceIds: ['provider-response-401'],
    })
  })

  it('redacts secret-shaped text from trusted persisted records', async () => {
    const repository = new InMemoryConnectorSourceRepository()
    await seed(repository, defaultEstate, 'legacy-source', {
      displayName: 'Bearer raw-access-token',
      configuration: { type: 'manifest', manifestId: 'eyJabc.def.ghi' },
      testStatus: {
        status: 'failed',
        evidenceBasis: 'synthetic',
        evidenceIds: ['ghp_123456789012345678901234567890'],
        checkedAt: '2026-09-06T02:00:00.000Z',
        checkedBy: { type: 'deployment', id: 'deployment-pipeline' },
        summary: 'password=raw-password',
      },
    })
    authenticate('Viewer')
    const app = await makeApp(repository, false)

    const response = await app.inject({
      method: 'GET',
      url: '/api/connector-sources/legacy-source',
      headers: headers(),
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).not.toMatch(
      /raw-access-token|eyJabc\.def\.ghi|ghp_123456789012345678901234567890|raw-password/,
    )
    expect(response.body).toContain('REDACTED')
  })
})
