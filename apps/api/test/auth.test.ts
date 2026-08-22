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
  audience: 'api://agent-sentinel',
  allowedScopes: {
    read: ['Sentinel.Read'],
    write: ['Sentinel.Write'],
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
})

describe('buildAuthConfig', () => {
  it('rejects missing or whitespace-only JWT tenant and audience values', () => {
    expect(() => buildAuthConfig({ AUTH_MODE: ' jwt ', AUTH_TENANT_ID: '   ' })).toThrow(
      'AUTH_TENANT_ID',
    )
    expect(() =>
      buildAuthConfig({ AUTH_MODE: 'jwt', AUTH_TENANT_ID: 'tenant-id', AUTH_AUDIENCE: '  ' }),
    ).toThrow('AUTH_AUDIENCE')
  })

  it('trims JWT mode, tenant, and audience values', () => {
    expect(
      buildAuthConfig({
        AUTH_MODE: ' jwt ',
        AUTH_TENANT_ID: ' tenant-id ',
        AUTH_AUDIENCE: ' api://agent-sentinel ',
      }),
    ).toMatchObject({
      mode: 'jwt',
      tenantId: 'tenant-id',
      audience: 'api://agent-sentinel',
    })
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
        audience: 'api://agent-sentinel',
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
