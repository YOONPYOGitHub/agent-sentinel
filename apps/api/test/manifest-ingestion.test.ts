import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { InMemoryManifestIngestionRepository } from '@agent-sentinel/persistence'

import { CAPABILITIES, type AuthConfig, type AuthPrincipal, type Capability } from '../src/auth.js'
import { registerManifestIngestionRoutes } from '../src/manifest-ingestion-routes.js'

const AUTH_TENANT = '11111111-1111-4111-8111-111111111111'
const ESTATE_TENANT = 'estate-tenant'
const ENVIRONMENT = 'validation'
const apps: FastifyInstance[] = []

const jwtConfig: AuthConfig = {
  mode: 'jwt',
  tenantId: AUTH_TENANT,
  audience: 'api://agent-sentinel',
  issuer: `https://login.microsoftonline.com/${AUTH_TENANT}/v2.0`,
  jwksUri: `https://login.microsoftonline.com/${AUTH_TENANT}/discovery/v2.0/keys`,
  allowedScopes: { read: ['AgentSentinel.Read'], write: ['AgentSentinel.Write'] },
  spaConfig: {
    tenantId: AUTH_TENANT,
    clientId: '22222222-2222-4222-8222-222222222222',
    authority: `https://login.microsoftonline.com/${AUTH_TENANT}`,
    scopes: ['api://agent-sentinel/AgentSentinel.Read'],
    redirectUri: 'https://sentinel.example/auth-redirect.html',
    postLogoutRedirectUri: 'https://sentinel.example/',
  },
}

function manifest(tenantId = ESTATE_TENANT) {
  return {
    schemaVersion: '1.0',
    manifestId: 'partner-agents',
    tenantId,
    environmentId: ENVIRONMENT,
    producedAt: '2026-08-28T00:00:00.000Z',
    producer: { name: 'Partner Registry', version: '1.0.0' },
    capabilities: {
      supportsDiscovery: true,
      evidenceDepth: 'deep',
      supportsRuntimeTelemetry: false,
      supportsActions: 'none',
    },
    agents: [
      {
        id: 'agent-a',
        displayName: 'Partner Agent A',
        owner: 'Partner Platform',
        approvalRequired: true,
      },
    ],
    tools: [],
    identities: [],
    dataSources: [],
    mcpDependencies: [],
    edges: [],
    evidence: [],
    metadata: {},
  }
}

function principal(role: 'Viewer' | 'Administrator'): AuthPrincipal {
  return {
    subject: `subject-${role.toLowerCase()}`,
    tenantId: AUTH_TENANT,
    actorType: 'user',
    roles: [role],
    capabilities: new Set<Capability>(role === 'Administrator' ? CAPABILITIES : ['read']),
  }
}

function createTestApp(
  authConfig: AuthConfig,
  authPrincipal?: AuthPrincipal,
  writeEnabled = true,
): {
  app: FastifyInstance
  repository: InMemoryManifestIngestionRepository
} {
  const app = Fastify()
  apps.push(app)
  if (authPrincipal !== undefined) {
    app.addHook('onRequest', (request, _reply, done) => {
      request.authPrincipal = authPrincipal
      done()
    })
  }
  const repository = new InMemoryManifestIngestionRepository(ESTATE_TENANT)
  registerManifestIngestionRoutes(app, {
    authConfig,
    repository,
    tenantId: ESTATE_TENANT,
    environmentId: ENVIRONMENT,
    writeEnabled,
    clock: () => new Date('2026-08-28T00:05:00.000Z'),
  })
  return { app, repository }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('authenticated manifest ingestion', () => {
  it('rejects ingestion when JWT authentication is disabled', async () => {
    const { app } = createTestApp({ mode: 'disabled' })
    const response = await app.inject({
      method: 'POST',
      url: '/api/manifests/ingestions',
      payload: { manifest: manifest() },
    })
    expect(response.statusCode).toBe(401)
  })

  it('requires the Administrator configure capability', async () => {
    const { app } = createTestApp(jwtConfig, principal('Viewer'))
    const response = await app.inject({
      method: 'POST',
      url: '/api/manifests/ingestions',
      payload: { manifest: manifest() },
    })
    expect(response.statusCode).toBe(403)
  })

  it('keeps ingestion blocked while deployment writes are disabled', async () => {
    const { app } = createTestApp(jwtConfig, principal('Administrator'), false)
    const response = await app.inject({
      method: 'POST',
      url: '/api/manifests/ingestions',
      payload: { manifest: manifest() },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: 'read_only_mode' })
  })

  it('stores an accepted manifest idempotently by content hash', async () => {
    const { app, repository } = createTestApp(jwtConfig, principal('Administrator'))
    const first = await app.inject({
      method: 'POST',
      url: '/api/manifests/ingestions',
      payload: { manifest: manifest() },
    })
    const second = await app.inject({
      method: 'POST',
      url: '/api/manifests/ingestions',
      payload: { manifest: manifest() },
    })

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(200)
    const firstBody = first.json<{ manifestHash: string }>()
    expect(firstBody).toMatchObject({
      created: true,
      manifestId: 'partner-agents',
      sourceOfTruth: false,
      nodeCount: 1,
    })
    expect(second.json()).toMatchObject({
      created: false,
      manifestHash: firstBody.manifestHash,
    })
    await expect(repository.listLatest(ENVIRONMENT)).resolves.toHaveLength(1)
  })

  it('rejects a manifest outside the authenticated tenant boundary', async () => {
    const { app, repository } = createTestApp(jwtConfig, principal('Administrator'))
    const response = await app.inject({
      method: 'POST',
      url: '/api/manifests/ingestions',
      payload: { manifest: manifest('other-estate-tenant') },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'manifest_rejected' })
    await expect(repository.listLatest(ENVIRONMENT)).resolves.toHaveLength(0)
  })
})
