import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jose = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => ({ mocked: 'jwks' })),
  jwtVerify: vi.fn(),
}))

vi.mock('jose', () => jose)

import { buildAuthConfig, sanitizePrincipal, CAPABILITIES, type AuthConfig } from '../src/auth.js'
import { agentSentinelStateSchema } from '@agent-sentinel/domain'
import { createApp } from '../src/app.js'
import { buildEstateRegistry } from '../src/estate-config.js'

// Auth configuration

describe('buildAuthConfig SPA fields', () => {
  const env = {
    AUTH_MODE: 'jwt',
    AUTH_TENANT_ID: '11111111-1111-4111-8111-111111111111',
    AUTH_AUDIENCE: 'api://11111111-1111-4111-8111-111111111111',
    AUTH_SPA_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
    AUTH_SPA_REDIRECT_URI: 'https://sentinel.example/auth/callback',
    AUTH_SPA_POST_LOGOUT_REDIRECT_URI: 'https://sentinel.example/',
  }

  it('uses explicitly configured issuer, JWKS, and SPA scopes', () => {
    const config = buildAuthConfig({
      ...env,
      AUTH_ISSUER: 'https://issuer.example/v2.0',
      AUTH_JWKS_URI: 'https://issuer.example/keys',
      AUTH_SPA_SCOPES:
        'api://11111111-1111-4111-8111-111111111111/AgentSentinel.Read, api://11111111-1111-4111-8111-111111111111/AgentSentinel.Write',
    })
    expect(config.mode).toBe('jwt')
    if (config.mode !== 'jwt') return
    expect(config.issuer).toBe('https://issuer.example/v2.0')
    expect(config.jwksUri).toBe('https://issuer.example/keys')
    expect(config.spaConfig.scopes).toEqual([
      'api://11111111-1111-4111-8111-111111111111/AgentSentinel.Read',
      'api://11111111-1111-4111-8111-111111111111/AgentSentinel.Write',
    ])
  })
})

// Principal sanitization

const defaultScopes = { read: ['AgentSentinel.Read'], write: ['AgentSentinel.Write'] }

describe('sanitizePrincipal', () => {
  it('extracts subject, tenantId, displayName, preferredUsername, objectId', () => {
    const p = sanitizePrincipal(
      {
        sub: 'user-sub',
        oid: 'obj-id',
        tid: 'tenant-id',
        name: 'Alice Analyst',
        preferred_username: 'alice@contoso.com',
        roles: ['AgentSentinel.Analyst'],
      },
      defaultScopes,
    )
    expect(p.subject).toBe('user-sub')
    expect(p.objectId).toBe('obj-id')
    expect(p.tenantId).toBe('tenant-id')
    expect(p.actorType).toBe('user')
    expect(p.displayName).toBe('Alice Analyst')
    expect(p.preferredUsername).toBe('alice@contoso.com')
  })

  it('resolves Viewer from AgentSentinel.Read scp', () => {
    const p = sanitizePrincipal({ sub: 's', tid: 't', scp: 'AgentSentinel.Read' }, defaultScopes)
    expect(p.roles).toContain('Viewer')
    expect(p.capabilities.has('read')).toBe(true)
    expect(p.capabilities.has('validateFinding')).toBe(false)
  })

  it('maps AgentSentinel.Write to Analyst only, not Approver or Administrator', () => {
    const p = sanitizePrincipal({ sub: 's', tid: 't', scp: 'AgentSentinel.Write' }, defaultScopes)
    expect(p.roles).toContain('Analyst')
    expect(p.roles).not.toContain('Approver')
    expect(p.roles).not.toContain('Administrator')
    expect(p.capabilities.has('validateFinding')).toBe(true)
    expect(p.capabilities.has('approveRemediation')).toBe(false)
    expect(p.capabilities.has('executeRemediation')).toBe(false)
  })

  it('Administrator app role grants all capabilities', () => {
    const p = sanitizePrincipal(
      { sub: 's', tid: 't', roles: ['AgentSentinel.Administrator'] },
      defaultScopes,
    )
    expect(p.roles).toContain('Administrator')
    for (const cap of CAPABILITIES) {
      expect(p.capabilities.has(cap)).toBe(true)
    }
  })

  it('identifies only verified app-only claims as service-principal callers', () => {
    const application = sanitizePrincipal(
      {
        sub: 'application-subject',
        oid: 'service-principal-object-id',
        tid: 'tenant-id',
        idtyp: 'app',
        roles: ['AgentSentinel.Administrator'],
      },
      defaultScopes,
    )
    expect(application.actorType).toBe('service-principal')

    const delegated = sanitizePrincipal(
      {
        sub: 'user-subject',
        oid: 'user-object-id',
        tid: 'tenant-id',
        idtyp: 'user',
        scp: 'AgentSentinel.Write',
      },
      defaultScopes,
    )
    expect(delegated.actorType).toBe('user')
  })

  it('rejects contradictory or incomplete app-only identity claims', () => {
    expect(() =>
      sanitizePrincipal(
        {
          sub: 'application-subject',
          tid: 'tenant-id',
          idtyp: 'app',
          roles: ['AgentSentinel.Administrator'],
        },
        defaultScopes,
      ),
    ).toThrow(/service-principal object ID/)
    expect(() =>
      sanitizePrincipal(
        {
          sub: 'application-subject',
          oid: 'service-principal-object-id',
          tid: 'tenant-id',
          idtyp: 'app',
          scp: 'AgentSentinel.Write',
          roles: ['AgentSentinel.Administrator'],
        },
        defaultScopes,
      ),
    ).toThrow(/no scopes/)
  })

  it('rejects plain role names without the registered prefix', () => {
    const p = sanitizePrincipal({ sub: 's', tid: 't', roles: 'Approver' }, defaultScopes)
    expect(p.roles).toHaveLength(0)
    expect(p.capabilities.size).toBe(0)
  })

  it('unrecognized claims produce empty roles and capabilities', () => {
    const p = sanitizePrincipal(
      { sub: 's', tid: 't', scp: 'Unknown.Scope', roles: ['SomeOtherRole'] },
      defaultScopes,
    )
    expect(p.roles).toHaveLength(0)
    expect(p.capabilities.size).toBe(0)
  })

  it('rejects principals without required subject or tenant claims', () => {
    expect(() =>
      sanitizePrincipal({ tid: 'tenant-id', roles: ['AgentSentinel.Viewer'] }, defaultScopes),
    ).toThrow(/subject or tenant/)
    expect(() =>
      sanitizePrincipal({ sub: 'subject-id', roles: ['AgentSentinel.Viewer'] }, defaultScopes),
    ).toThrow(/subject or tenant/)
  })

  it('never escalates privilege from malformed token claims', () => {
    const p = sanitizePrincipal(
      {
        sub: 's',
        tid: 't',
        scp: 'AgentSentinel.Administrator AgentSentinel.EvilRole',
        roles: ['god-mode'],
      },
      defaultScopes,
    )
    expect(p.capabilities.has('executeRemediation')).toBe(false)
    expect(p.capabilities.has('configure')).toBe(false)
  })

  it('combines roles from both roles and scp claims', () => {
    const p = sanitizePrincipal(
      { sub: 's', tid: 't', roles: ['AgentSentinel.Approver'], scp: 'AgentSentinel.Read' },
      defaultScopes,
    )
    expect(p.roles).toContain('Approver')
    expect(p.roles).toContain('Viewer')
    expect(p.capabilities.has('approveRemediation')).toBe(true)
  })

  it('backward-compat: Sentinel.Read => Viewer', () => {
    const p = sanitizePrincipal(
      { sub: 's', tid: 't', scp: 'Sentinel.Read' },
      { read: ['Sentinel.Read'], write: ['Sentinel.Write'] },
    )
    expect(p.roles).toContain('Viewer')
  })

  it('backward-compat: Sentinel.Write => Analyst only', () => {
    const p = sanitizePrincipal(
      { sub: 's', tid: 't', scp: 'Sentinel.Write' },
      { read: ['Sentinel.Read'], write: ['Sentinel.Write'] },
    )
    expect(p.roles).toContain('Analyst')
    expect(p.roles).not.toContain('Approver')
  })

  it('configured allowedScopes.write => Analyst at most', () => {
    const p = sanitizePrincipal(
      { sub: 's', tid: 't', scp: 'Custom.Write' },
      { read: ['Custom.Read'], write: ['Custom.Write'] },
    )
    expect(p.roles).toContain('Analyst')
    expect(p.capabilities.has('approveRemediation')).toBe(false)
  })

  it('configured scope overrides can revoke default scope names', () => {
    const p = sanitizePrincipal(
      { sub: 's', tid: 't', scp: 'AgentSentinel.Write' },
      { read: ['Custom.Read'], write: ['Custom.Write'] },
    )
    expect(p.roles).toHaveLength(0)
    expect(p.capabilities.size).toBe(0)
  })
})

// Role hierarchy

describe('role hierarchy', () => {
  it('Viewer has only read capability', () => {
    const p = sanitizePrincipal(
      { sub: 's', tid: 't', roles: ['AgentSentinel.Viewer'] },
      defaultScopes,
    )
    expect([...p.capabilities]).toEqual(['read'])
  })

  it('Analyst capabilities are a strict superset of Viewer', () => {
    const viewer = sanitizePrincipal(
      { sub: 's', tid: 't', roles: ['AgentSentinel.Viewer'] },
      defaultScopes,
    )
    const analyst = sanitizePrincipal(
      { sub: 's', tid: 't', roles: ['AgentSentinel.Analyst'] },
      defaultScopes,
    )
    for (const cap of viewer.capabilities) {
      expect(analyst.capabilities.has(cap)).toBe(true)
    }
    expect(analyst.capabilities.size).toBeGreaterThan(viewer.capabilities.size)
  })

  it('Approver inherits Analyst and adds approveRemediation', () => {
    const p = sanitizePrincipal(
      { sub: 's', tid: 't', roles: ['AgentSentinel.Approver'] },
      defaultScopes,
    )
    expect(p.capabilities.has('approveRemediation')).toBe(true)
    expect(p.capabilities.has('executeRemediation')).toBe(false)
  })
})

// JWT integration

const jwtConfig: AuthConfig = {
  mode: 'jwt',
  tenantId: 'tenant-id',
  audience: 'api://agent-sentinel',
  issuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
  jwksUri: 'https://login.microsoftonline.com/tenant-id/discovery/v2.0/keys',
  allowedScopes: { read: ['AgentSentinel.Read'], write: ['AgentSentinel.Write'] },
  spaConfig: {
    tenantId: 'tenant-id',
    clientId: 'client-123',
    authority: 'https://login.microsoftonline.com/tenant-id',
    scopes: ['api://agent-sentinel/AgentSentinel.Read'],
    redirectUri: 'https://sentinel.example/auth/callback',
    postLogoutRedirectUri: 'https://sentinel.example/',
  },
}

const apps: Awaited<ReturnType<typeof createApp>>[] = []

beforeEach(() => {
  jose.createRemoteJWKSet.mockClear()
  jose.jwtVerify.mockReset()
  process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
})

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (a) => a.close()))
  delete process.env['AGENT_SENTINEL_CONNECTOR']
})

describe('GET /api/auth/config', () => {
  it('returns enabled=false in disabled mode without any fake identity', async () => {
    const app = await createApp(undefined, { mode: 'disabled' })
    apps.push(app)
    const r = await app.inject({ method: 'GET', url: '/api/auth/config' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ enabled: false })
  })

  it('returns enabled=true with public SPA fields when spaConfig present', async () => {
    const config: AuthConfig = {
      ...jwtConfig,
      spaConfig: {
        tenantId: 'tenant-id',
        clientId: 'client-123',
        authority: 'https://login.microsoftonline.com/tenant-id',
        scopes: ['api://agent-sentinel/AgentSentinel.Read'],
        redirectUri: 'https://sentinel.example/auth/callback',
        postLogoutRedirectUri: 'https://sentinel.example/',
      },
    }
    const app = await createApp(undefined, config)
    apps.push(app)
    const r = await app.inject({ method: 'GET', url: '/api/auth/config' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ enabled: true, clientId: 'client-123' })
    expect(JSON.stringify(r.json())).not.toMatch(/secret|password/i)
  })

  it('is publicly accessible without a Bearer token in jwt mode', async () => {
    const config: AuthConfig = {
      ...jwtConfig,
      spaConfig: {
        tenantId: 'tenant-id',
        clientId: 'client-123',
        authority: 'https://login.microsoftonline.com/tenant-id',
        scopes: ['api://agent-sentinel/AgentSentinel.Read'],
        redirectUri: 'https://sentinel.example/auth/callback',
        postLogoutRedirectUri: 'https://sentinel.example/',
      },
    }
    const app = await createApp(undefined, config)
    apps.push(app)
    // No authorization header; public route should not be blocked.
    const r = await app.inject({ method: 'GET', url: '/api/auth/config' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ enabled: true })
  })

  it('returns the exact configured redirect behavior', async () => {
    const app = await createApp(undefined, jwtConfig)
    apps.push(app)
    const r = await app.inject({ method: 'GET', url: '/api/auth/config' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({
      tenantId: 'tenant-id',
      redirectUri: 'https://sentinel.example/auth/callback',
      postLogoutRedirectUri: 'https://sentinel.example/',
    })
  })
})

describe('public operational endpoints', () => {
  it.each(['/health', '/api/health', '/api/status'])(
    'allows anonymous GET %s in jwt mode',
    async (url) => {
      const app = await createApp(undefined, jwtConfig)
      apps.push(app)
      const response = await app.inject({ method: 'GET', url })
      expect(response.statusCode).toBe(200)
    },
  )
})

describe('GET /api/auth/me', () => {
  it('returns 401 when auth mode is disabled', async () => {
    const app = await createApp(undefined, { mode: 'disabled' })
    apps.push(app)
    const r = await app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(r.statusCode).toBe(401)
    expect(r.json()).toMatchObject({ error: 'unauthorized' })
  })

  describe('estate authorization', () => {
    const estateRegistry = buildEstateRegistry(
      {
        AGENT_SENTINEL_ESTATES_JSON: JSON.stringify([
          {
            id: 'default',
            name: 'Default',
            tenantId: 'data-default',
            environment: 'production',
            isDefault: true,
            allowedAuthTenantIds: ['tenant-id'],
          },
          {
            id: 'lab',
            name: 'Lab',
            tenantId: 'data-lab',
            environment: 'validation',
            isDefault: false,
            allowedAuthTenantIds: ['tenant-id'],
          },
        ]),
      },
      {
        id: 'default',
        tenantId: 'unused',
        environment: 'unused',
        authTenantId: 'tenant-id',
      },
    )

    it('lists only estates authorized for the authenticated tenant', async () => {
      jose.jwtVerify.mockResolvedValue({
        payload: {
          sub: 'viewer',
          tid: 'tenant-id',
          roles: ['AgentSentinel.Viewer'],
        },
      })
      const app = await createApp(undefined, jwtConfig, { estateRegistry })
      apps.push(app)
      const response = await app.inject({
        method: 'GET',
        url: '/api/estates',
        headers: { authorization: 'Bearer valid-token' },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        defaultEstateId: 'default',
        estates: [{ id: 'default' }, { id: 'lab' }],
      })
    })

    it('selects an authorized estate by opaque header and rejects unknown estates', async () => {
      jose.jwtVerify.mockResolvedValue({
        payload: {
          sub: 'viewer',
          tid: 'tenant-id',
          roles: ['AgentSentinel.Viewer'],
        },
      })
      const app = await createApp(undefined, jwtConfig, { estateRegistry })
      apps.push(app)
      const selected = await app.inject({
        method: 'GET',
        url: '/api/exposures/status',
        headers: {
          authorization: 'Bearer valid-token',
          'x-agent-sentinel-estate-id': 'lab',
        },
      })
      expect(selected.statusCode).toBe(200)
      expect(selected.json()).toMatchObject({
        id: 'lab',
        tenantId: 'data-lab',
        environment: 'validation',
      })

      const rejected = await app.inject({
        method: 'GET',
        url: '/api/exposures/status',
        headers: {
          authorization: 'Bearer valid-token',
          'x-agent-sentinel-estate-id': 'unknown',
        },
      })
      expect(rejected.statusCode).toBe(403)
    })

    it('blocks non-default estates on APIs that are not yet estate-aware', async () => {
      jose.jwtVerify.mockResolvedValue({
        payload: {
          sub: 'viewer',
          tid: 'tenant-id',
          roles: ['AgentSentinel.Viewer'],
        },
      })
      const app = await createApp(undefined, jwtConfig, { estateRegistry })
      apps.push(app)
      const response = await app.inject({
        method: 'GET',
        url: '/api/demo/state',
        headers: {
          authorization: 'Bearer valid-token',
          'x-agent-sentinel-estate-id': 'lab',
        },
      })
      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({
        error: 'forbidden',
        message: 'This API is not yet enabled for non-default estates.',
      })
    })
  })

  it('returns sanitized principal in jwt mode with valid token', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: {
        sub: 'user-123',
        oid: 'obj-456',
        tid: 'tenant-id',
        name: 'Alice Analyst',
        preferred_username: 'alice@contoso.com',
        roles: ['AgentSentinel.Analyst'],
      },
    })
    const app = await createApp(undefined, jwtConfig)
    apps.push(app)
    const r = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer valid-token' },
    })
    expect(r.statusCode).toBe(200)
    const body: Record<string, unknown> = r.json()
    expect(body['subject']).toBe('user-123')
    expect(body['tenantId']).toBe('tenant-id')
    expect(body['displayName']).toBe('Alice Analyst')
    expect(body['roles']).toContain('Analyst')
    expect(body['capabilities']).toContain('validateFinding')
    // Must not expose raw token
    expect(JSON.stringify(body)).not.toContain('valid-token')
  })

  it('rejects a verified token whose tenant claim does not match configuration', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: {
        sub: 'user-123',
        tid: 'different-tenant',
        roles: ['AgentSentinel.Viewer'],
      },
    })
    const app = await createApp(undefined, jwtConfig)
    apps.push(app)
    const r = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer valid-token' },
    })
    expect(r.statusCode).toBe(401)
    expect(r.json()).toMatchObject({ error: 'unauthorized' })
  })
})

describe('capability boundaries', () => {
  it('exposes read-only probes for the exact four app-role boundaries', async () => {
    const expected: Record<string, string[]> = {
      Viewer: ['read'],
      Analyst: ['read', 'validateFinding', 'generateAdvisory', 'proposeRemediation'],
      Approver: [
        'read',
        'validateFinding',
        'generateAdvisory',
        'proposeRemediation',
        'approveRemediation',
      ],
      Administrator: [...CAPABILITIES],
    }
    const app = await createApp(undefined, jwtConfig)
    apps.push(app)

    for (const [role, allowed] of Object.entries(expected)) {
      jose.jwtVerify.mockResolvedValue({
        payload: { sub: role.toLowerCase(), tid: 'tenant-id', roles: [`AgentSentinel.${role}`] },
      })
      for (const capability of CAPABILITIES) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/auth/capabilities/${capability}`,
          headers: { authorization: ['Bearer', 'valid-token'].join(' ') },
        })
        expect(response.statusCode, `${role}/${capability}: ${response.body}`).toBe(
          allowed.includes(capability) ? 200 : 403,
        )
      }
    }
  })

  it('requires authentication for connector catalog metadata', async () => {
    const app = await createApp(undefined, jwtConfig)
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/connectors' })
    expect(response.statusCode).toBe(401)
  })

  it('requires authentication for connector status metadata', async () => {
    const app = await createApp(undefined, jwtConfig)
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/connector/status' })
    expect(response.statusCode).toBe(401)
  })

  it('requires Analyst capability for narrative generation over GET and POST', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: { sub: 'viewer', tid: 'tenant-id', roles: ['AgentSentinel.Viewer'] },
    })
    const app = await createApp(undefined, jwtConfig)
    apps.push(app)
    const exposurePage = (
      await app.inject({
        method: 'GET',
        url: '/api/exposures',
        headers: { authorization: 'Bearer viewer-token' },
      })
    ).json<{ findings: Array<{ id: string }> }>()
    const findingId = exposurePage.findings[0]?.id ?? 'unknown'

    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({
        method,
        url: `/api/exposures/${findingId}/narrative`,
        headers: { authorization: 'Bearer viewer-token' },
      })
      expect(response.statusCode).toBe(403)
    }

    jose.jwtVerify.mockResolvedValue({
      payload: { sub: 'analyst', tid: 'tenant-id', roles: ['AgentSentinel.Analyst'] },
    })
    const allowed = await app.inject({
      method: 'GET',
      url: `/api/exposures/${findingId}/narrative`,
      headers: { authorization: 'Bearer analyst-token' },
    })
    expect(allowed.statusCode).toBe(200)
  })

  it('Viewer token (read scope) gets 403 on validateFinding', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: { sub: 's', tid: 'tenant-id', scp: 'AgentSentinel.Read' },
    })
    const app = await createApp(undefined, jwtConfig)
    apps.push(app)
    const state = agentSentinelStateSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/demo/state',
          headers: { authorization: 'Bearer tok' },
        })
      ).json(),
    )
    const findingId = state.findings[0]?.id ?? 'unknown'
    const r = await app.inject({
      method: 'POST',
      url: `/api/demo/findings/${findingId}/validate`,
      headers: { authorization: 'Bearer tok' },
    })
    expect(r.statusCode).toBe(403)
    expect(r.json()).toMatchObject({ error: 'forbidden' })
  })

  it('Analyst (write scope) can validateFinding and proposeRemediation but not approve', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: { sub: 's', tid: 'tenant-id', scp: 'AgentSentinel.Write' },
    })
    const app = await createApp(undefined, jwtConfig)
    apps.push(app)
    const state = agentSentinelStateSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/demo/state',
          headers: { authorization: 'Bearer tok' },
        })
      ).json(),
    )
    const findingId = state.findings[0]?.id ?? 'unknown'
    const validateR = await app.inject({
      method: 'POST',
      url: `/api/demo/findings/${findingId}/validate`,
      headers: { authorization: 'Bearer tok' },
    })
    expect(validateR.statusCode).toBe(200)
    const proposeR = await app.inject({
      method: 'POST',
      url: `/api/demo/findings/${findingId}/remediations`,
      headers: { authorization: 'Bearer tok' },
    })
    expect(proposeR.statusCode).toBe(200)
    const remId = agentSentinelStateSchema.parse(proposeR.json()).remediations[0]?.id ?? 'x'
    const approveR = await app.inject({
      method: 'POST',
      url: `/api/demo/remediations/${remId}/approve`,
      headers: { authorization: 'Bearer tok' },
      payload: { approvedBy: 'User', reason: 'Approval reason supplied by the caller.' },
    })
    expect(approveR.statusCode).toBe(403)
  })

  it('Approver can approve but not execute', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: {
        sub: 's',
        tid: 'tenant-id',
        preferred_username: 'approver@contoso.com',
        roles: ['AgentSentinel.Approver'],
      },
    })
    const app = await createApp(undefined, jwtConfig)
    apps.push(app)
    const state = agentSentinelStateSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/demo/state',
          headers: { authorization: 'Bearer tok' },
        })
      ).json(),
    )
    const findingId = state.findings[0]?.id ?? 'unknown'
    await app.inject({
      method: 'POST',
      url: `/api/demo/findings/${findingId}/validate`,
      headers: { authorization: 'Bearer tok' },
    })
    await app.inject({
      method: 'POST',
      url: `/api/demo/findings/${findingId}/remediations`,
      headers: { authorization: 'Bearer tok' },
    })
    const state2 = agentSentinelStateSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/demo/state',
          headers: { authorization: 'Bearer tok' },
        })
      ).json(),
    )
    const remId = state2.remediations[0]?.id ?? 'x'
    const approveR = await app.inject({
      method: 'POST',
      url: `/api/demo/remediations/${remId}/approve`,
      headers: { authorization: 'Bearer tok' },
      payload: {
        approvedBy: 'forged@contoso.com',
        reason: 'Reviewed the validated finding and reversible response plan.',
      },
    })
    expect(approveR.statusCode).toBe(200)
    expect(agentSentinelStateSchema.parse(approveR.json()).remediations[0]?.approvedBy).toBe(
      'approver@contoso.com',
    )
    expect(agentSentinelStateSchema.parse(approveR.json()).remediations[0]?.approvalReason).toBe(
      'Reviewed the validated finding and reversible response plan.',
    )
    const executeR = await app.inject({
      method: 'POST',
      url: `/api/demo/remediations/${remId}/execute`,
      headers: { authorization: 'Bearer tok' },
    })
    expect(executeR.statusCode).toBe(403)
  })

  it('Administrator can execute remediation', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: { sub: 's', tid: 'tenant-id', roles: ['AgentSentinel.Administrator'] },
    })
    const app = await createApp(undefined, jwtConfig)
    apps.push(app)
    const state = agentSentinelStateSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/demo/state',
          headers: { authorization: 'Bearer tok' },
        })
      ).json(),
    )
    const findingId = state.findings[0]?.id ?? 'unknown'
    await app.inject({
      method: 'POST',
      url: `/api/demo/findings/${findingId}/validate`,
      headers: { authorization: 'Bearer tok' },
    })
    await app.inject({
      method: 'POST',
      url: `/api/demo/findings/${findingId}/remediations`,
      headers: { authorization: 'Bearer tok' },
    })
    const state2 = agentSentinelStateSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/demo/state',
          headers: { authorization: 'Bearer tok' },
        })
      ).json(),
    )
    const remId = state2.remediations[0]?.id ?? 'x'
    await app.inject({
      method: 'POST',
      url: `/api/demo/remediations/${remId}/approve`,
      payload: { reason: 'Administrator approved the reversible containment plan.' },
      headers: { authorization: 'Bearer tok' },
    })
    const executeR = await app.inject({
      method: 'POST',
      url: `/api/demo/remediations/${remId}/execute`,
      headers: { authorization: 'Bearer tok' },
    })
    expect(executeR.statusCode).toBe(200)
  })

  it('returns 401 for a missing token and 403 for an insufficient token', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: { sub: 's', tid: 'tenant-id', scp: 'AgentSentinel.Read' },
    })
    const app = await createApp(undefined, jwtConfig)
    apps.push(app)
    const state = agentSentinelStateSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/demo/state',
          headers: { authorization: 'Bearer tok' },
        })
      ).json(),
    )
    const findingId = state.findings[0]?.id ?? 'unknown'
    const r401 = await app.inject({
      method: 'POST',
      url: `/api/demo/findings/${findingId}/validate`,
    })
    expect(r401.statusCode).toBe(401)
    const r403 = await app.inject({
      method: 'POST',
      url: `/api/demo/findings/${findingId}/validate`,
      headers: { authorization: 'Bearer tok' },
    })
    expect(r403.statusCode).toBe(403)
  })

  it('disabled mode preserves anonymous access to all routes', async () => {
    const app = await createApp(undefined, { mode: 'disabled' })
    apps.push(app)
    const state = agentSentinelStateSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/demo/state' })).json(),
    )
    const findingId = state.findings[0]?.id ?? 'unknown'
    const r = await app.inject({ method: 'POST', url: `/api/demo/findings/${findingId}/validate` })
    expect(r.statusCode).toBe(200)
  })
})
