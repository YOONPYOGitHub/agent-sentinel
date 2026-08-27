import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jose = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => ({ mocked: 'jwks' })),
  jwtVerify: vi.fn(),
}))

vi.mock('jose', () => jose)

import { buildAuthConfig } from '../src/auth.js'
import { createApp } from '../src/app.js'

const apps: Awaited<ReturnType<typeof createApp>>[] = []
const jwtConfig = {
  mode: 'jwt' as const,
  tenantId: 'tenant-id',
  audience: 'api://11111111-1111-4111-8111-111111111111',
  issuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
  jwksUri: 'https://login.microsoftonline.com/tenant-id/discovery/v2.0/keys',
  allowedScopes: {
    read: ['Sentinel.Read'],
    write: ['Sentinel.Write'],
  },
  spaConfig: {
    tenantId: 'tenant-id',
    clientId: 'spa-client-id',
    authority: 'https://login.microsoftonline.com/tenant-id',
    scopes: ['api://11111111-1111-4111-8111-111111111111/Sentinel.Read'],
    redirectUri: 'https://sentinel.example/auth/callback',
    postLogoutRedirectUri: 'https://sentinel.example/',
  },
}

beforeEach(() => {
  jose.createRemoteJWKSet.mockClear()
  jose.jwtVerify.mockReset()
  process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
})

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()))
  delete process.env['AGENT_SENTINEL_CONNECTOR']
  delete process.env['AGENT_SENTINEL_WRITE_ENABLED']
})

describe('buildAuthConfig', () => {
  const completeJwtEnv = {
    AUTH_MODE: 'jwt',
    AUTH_TENANT_ID: '11111111-1111-4111-8111-111111111111',
    AUTH_AUDIENCE: 'api://11111111-1111-4111-8111-111111111111',
    AUTH_SPA_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
    AUTH_SPA_REDIRECT_URI: 'https://sentinel.example/auth/callback',
    AUTH_SPA_POST_LOGOUT_REDIRECT_URI: 'https://sentinel.example/',
  }

  it('requires every JWT and SPA trust-boundary value', () => {
    for (const name of [
      'AUTH_TENANT_ID',
      'AUTH_AUDIENCE',
      'AUTH_SPA_CLIENT_ID',
      'AUTH_SPA_REDIRECT_URI',
      'AUTH_SPA_POST_LOGOUT_REDIRECT_URI',
    ]) {
      expect(() => buildAuthConfig({ ...completeJwtEnv, [name]: ' ' })).toThrow(name)
    }
  })

  it('builds explicit issuer, JWKS, scope, and redirect configuration', () => {
    expect(buildAuthConfig(completeJwtEnv)).toEqual({
      mode: 'jwt',
      tenantId: completeJwtEnv.AUTH_TENANT_ID,
      audience: completeJwtEnv.AUTH_AUDIENCE,
      issuer: `https://login.microsoftonline.com/${completeJwtEnv.AUTH_TENANT_ID}/v2.0`,
      jwksUri: `https://login.microsoftonline.com/${completeJwtEnv.AUTH_TENANT_ID}/discovery/v2.0/keys`,
      allowedScopes: {
        read: ['AgentSentinel.Read'],
        write: ['AgentSentinel.Write'],
      },
      spaConfig: {
        tenantId: completeJwtEnv.AUTH_TENANT_ID,
        clientId: completeJwtEnv.AUTH_SPA_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${completeJwtEnv.AUTH_TENANT_ID}`,
        scopes: [`${completeJwtEnv.AUTH_AUDIENCE}/AgentSentinel.Read`],
        redirectUri: completeJwtEnv.AUTH_SPA_REDIRECT_URI,
        postLogoutRedirectUri: completeJwtEnv.AUTH_SPA_POST_LOGOUT_REDIRECT_URI,
      },
    })
  })

  it('rejects malformed identifiers, endpoints, redirect origins, and scope lists', () => {
    expect(() => buildAuthConfig({ ...completeJwtEnv, AUTH_TENANT_ID: 'tenant-id' })).toThrow(
      /UUID/,
    )
    expect(() =>
      buildAuthConfig({ ...completeJwtEnv, AUTH_ISSUER: 'http://issuer.invalid' }),
    ).toThrow(/HTTPS/)
    expect(() =>
      buildAuthConfig({
        ...completeJwtEnv,
        AUTH_SPA_POST_LOGOUT_REDIRECT_URI: 'https://other.example/',
      }),
    ).toThrow(/share an origin/)
    expect(() =>
      buildAuthConfig({ ...completeJwtEnv, AUTH_SPA_SCOPES: 'api://other/AgentSentinel.Read' }),
    ).toThrow(/fully qualified/)
    expect(() =>
      buildAuthConfig({ ...completeJwtEnv, AUTH_READ_SCOPES: 'Same', AUTH_WRITE_SCOPES: 'Same' }),
    ).toThrow(/must not overlap/)
  })
})

describe('write configuration safety', () => {
  it('rejects live writes unless JWT authentication is active', async () => {
    process.env['AGENT_SENTINEL_WRITE_ENABLED'] = 'true'
    await expect(
      createApp(
        undefined,
        { mode: 'disabled' },
        { dataMode: 'live', runtimeTelemetryConnector: null },
      ),
    ).rejects.toThrow('Live writes require AUTH_MODE=jwt')
  })
})

describe('JWT middleware', () => {
  it('accepts a valid token using the tenant JWKS and read scope', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: { sub: 'subject-id', tid: 'tenant-id', scp: 'Sentinel.Read' },
    })
    const app = await createApp(undefined, jwtConfig)
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/api/demo/state',
      headers: { authorization: 'Bearer valid-token' },
    })

    expect(response.statusCode).toBe(200)
    expect(jose.createRemoteJWKSet).toHaveBeenCalledWith(
      new URL('https://login.microsoftonline.com/tenant-id/discovery/v2.0/keys'),
    )
    expect(jose.jwtVerify).toHaveBeenCalledWith(
      'valid-token',
      expect.anything(),
      expect.objectContaining({
        issuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
        audience: '11111111-1111-4111-8111-111111111111',
        algorithms: ['RS256'],
      }),
    )
  })

  it.each(['bad audience', 'expired'])('returns 401 for a %s token', async () => {
    jose.jwtVerify.mockRejectedValue(new Error('JWT verification failed'))
    const app = await createApp(undefined, jwtConfig)
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/api/demo/state',
      headers: { authorization: 'Bearer invalid-token' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: 'unauthorized' })
  })

  it('returns 401 for an anonymous write', async () => {
    const app = await createApp(undefined, jwtConfig)
    apps.push(app)
    const response = await app.inject({ method: 'POST', url: '/api/demo/reset' })
    expect(response.statusCode).toBe(401)
  })

  it('returns 403 when the token lacks the required scope', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: { sub: 'subject-id', tid: 'tenant-id', scp: 'Sentinel.Other' },
    })
    const app = await createApp(undefined, jwtConfig)
    apps.push(app)
    const response = await app.inject({
      method: 'GET',
      url: '/api/demo/state',
      headers: { authorization: 'Bearer valid-token' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('allows anonymous reads when authentication is disabled', async () => {
    const app = await createApp(undefined, { mode: 'disabled' })
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/demo/state' })
    expect(response.statusCode).toBe(200)
  })
})
