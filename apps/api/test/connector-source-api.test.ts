import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jose = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => ({ mocked: 'jwks' })),
  jwtVerify: vi.fn(),
}))

vi.mock('jose', () => jose)

import {
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
      items: [
        {
          sourceId: 'foundry-lab',
          estateId: 'lab',
          tenantId: 'tenant-lab',
          environment: 'validation',
          origin: 'deployment',
        },
      ],
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
