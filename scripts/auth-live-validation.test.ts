import { describe, expect, it, vi } from 'vitest'

import {
  AUTH_VALIDATION_CAPABILITIES,
  buildAuthLiveValidationConfig,
  runAuthLiveValidation,
  type AuthValidationRole,
} from './auth-live-validation.js'

const capabilities: Record<AuthValidationRole, string[]> = {
  Viewer: ['read'],
  Analyst: ['read', 'validateFinding', 'generateAdvisory', 'proposeRemediation'],
  Approver: [
    'read',
    'validateFinding',
    'generateAdvisory',
    'proposeRemediation',
    'approveRemediation',
  ],
  Administrator: [...AUTH_VALIDATION_CAPABILITIES],
}

const completeEnvironment = {
  AUTH_VALIDATION_BASE_URL: 'https://sentinel.example',
  AUTH_VALIDATION_VIEWER_TOKEN: 'viewer-token',
  AUTH_VALIDATION_ANALYST_TOKEN: 'analyst-token',
  AUTH_VALIDATION_APPROVER_TOKEN: 'approver-token',
  AUTH_VALIDATION_ADMINISTRATOR_TOKEN: 'administrator-token',
}

function response(status: number, body?: string): Promise<Response> {
  return Promise.resolve(
    new Response(body ?? null, {
      status,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' } }),
    }),
  )
}

function roleForToken(token: string): AuthValidationRole | undefined {
  const normalized = token.replace(/^Bearer /, '').replace(/-token$/, '')
  return normalized === 'viewer'
    ? 'Viewer'
    : normalized === 'analyst'
      ? 'Analyst'
      : normalized === 'approver'
        ? 'Approver'
        : normalized === 'administrator'
          ? 'Administrator'
          : undefined
}

describe('buildAuthLiveValidationConfig', () => {
  it('builds an HTTPS read-phase configuration without storing tokens elsewhere', () => {
    expect(buildAuthLiveValidationConfig(completeEnvironment)).toMatchObject({
      baseUrl: 'https://sentinel.example',
      phase: 'read',
      timeoutMs: 15_000,
      maxResponseBytes: 256 * 1024,
      tokens: {
        Viewer: 'viewer-token',
        Administrator: 'administrator-token',
      },
    })
  })

  it('requires explicit write details and rejects insecure remote endpoints', () => {
    expect(() =>
      buildAuthLiveValidationConfig({ ...completeEnvironment, AUTH_VALIDATION_PHASE: 'write' }),
    ).toThrow('AUTH_VALIDATION_WRITE_METHOD')
    expect(() =>
      buildAuthLiveValidationConfig({
        ...completeEnvironment,
        AUTH_VALIDATION_BASE_URL: 'http://sentinel.example',
      }),
    ).toThrow(/HTTPS origin/)
  })
})

describe('runAuthLiveValidation', () => {
  it('validates anonymous denial, four role boundaries, and an authorized write', async () => {
    const config = buildAuthLiveValidationConfig({
      ...completeEnvironment,
      AUTH_VALIDATION_PHASE: 'write',
      AUTH_VALIDATION_WRITE_METHOD: 'POST',
      AUTH_VALIDATION_WRITE_PATH: '/api/governance/queue/test/transitions',
      AUTH_VALIDATION_WRITE_BODY: '{"operation":"validate"}',
      AUTH_VALIDATION_WRITE_EXPECTED_STATUS: '204',
    })
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      const authorization = new Headers(init?.headers).get('Authorization') ?? ''
      const role = roleForToken(authorization)
      if (url.pathname === '/api/auth/me' && role === undefined) return response(401)
      if (url.pathname === '/api/auth/me' && role !== undefined)
        return response(200, JSON.stringify({ roles: [role], capabilities: capabilities[role] }))
      if (url.pathname.startsWith('/api/auth/capabilities/') && role !== undefined) {
        const capability = url.pathname.slice('/api/auth/capabilities/'.length)
        return response(capabilities[role].includes(capability) ? 200 : 403)
      }
      if (url.pathname === '/api/governance/queue/test/transitions' && role === undefined)
        return response(401)
      if (url.pathname === '/api/governance/queue/test/transitions' && role === 'Administrator')
        return response(204)
      return response(500)
    })

    await expect(runAuthLiveValidation(config, fetchMock)).resolves.toEqual({
      anonymousStatus: 401,
      insufficientRoleStatus: 403,
      rolesValidated: ['Viewer', 'Analyst', 'Approver', 'Administrator'],
      anonymousWriteStatus: 401,
      writeStatus: 204,
    })
    expect(fetchMock).toHaveBeenCalledTimes(35)
  })

  it('fails without echoing token values when a boundary has an unexpected status', async () => {
    const config = buildAuthLiveValidationConfig(completeEnvironment)
    const failingFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }))
    const validation = runAuthLiveValidation(config, failingFetch)
    await expect(validation).rejects.toThrow(/expected 401/)
    await expect(validation).rejects.not.toThrow(/viewer-token/)
  })

  it('validates immutable deployment metadata and exact redirects before token probes', async () => {
    const sha = 'a'.repeat(40)
    const apiDigest = `sha256:${'b'.repeat(64)}`
    const webDigest = `sha256:${'c'.repeat(64)}`
    const config = buildAuthLiveValidationConfig({
      ...completeEnvironment,
      AUTH_VALIDATION_EXPECTED_REDIRECT_ORIGIN: 'https://sentinel.example',
      AUTH_VALIDATION_EXPECTED_API_SHA: sha,
      AUTH_VALIDATION_EXPECTED_API_IMAGE_DIGEST: apiDigest,
      AUTH_VALIDATION_EXPECTED_WEB_SHA: sha,
      AUTH_VALIDATION_EXPECTED_WEB_IMAGE_DIGEST: webDigest,
    })
    const requestedPaths: string[] = []
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      requestedPaths.push(url.pathname)
      const authorization = new Headers(init?.headers).get('Authorization') ?? ''
      const role = roleForToken(authorization)
      if (url.pathname === '/api/status') {
        return response(
          200,
          JSON.stringify({
            status: 'ok',
            service: 'agent-sentinel-api',
            observedAt: '2026-09-13T00:00:00.000Z',
            components: {
              web: { sha, digest: webDigest },
              api: { sha, digest: apiDigest },
              jobs: {},
            },
          }),
        )
      }
      if (url.pathname === '/api/auth/config') {
        return response(
          200,
          JSON.stringify({
            enabled: true,
            tenantId: '11111111-1111-4111-8111-111111111111',
            clientId: '22222222-2222-4222-8222-222222222222',
            authority: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111',
            scopes: ['api://33333333-3333-4333-8333-333333333333/AgentSentinel.Read'],
            redirectUri: 'https://sentinel.example/auth-redirect.html',
            postLogoutRedirectUri: 'https://sentinel.example/',
          }),
        )
      }
      if (url.pathname === '/api/auth/me' && role === undefined) return response(401)
      if (url.pathname === '/api/auth/me' && role !== undefined) {
        return response(200, JSON.stringify({ roles: [role], capabilities: capabilities[role] }))
      }
      if (url.pathname.startsWith('/api/auth/capabilities/') && role !== undefined) {
        const capability = url.pathname.slice('/api/auth/capabilities/'.length)
        return response(capabilities[role].includes(capability) ? 200 : 403)
      }
      return response(500)
    })

    await expect(runAuthLiveValidation(config, fetchMock)).resolves.toMatchObject({
      deploymentStatusValidated: true,
      redirectConfigurationValidated: true,
    })
    expect(requestedPaths.slice(0, 3)).toEqual(['/api/status', '/api/auth/config', '/api/auth/me'])
  })

  it('blocks token probes when redirect configuration is not exact', async () => {
    const config = buildAuthLiveValidationConfig({
      ...completeEnvironment,
      AUTH_VALIDATION_EXPECTED_REDIRECT_ORIGIN: 'https://sentinel.example',
    })
    const fetchMock = vi.fn<typeof fetch>(() =>
      response(
        200,
        JSON.stringify({
          enabled: true,
          tenantId: '11111111-1111-4111-8111-111111111111',
          clientId: '22222222-2222-4222-8222-222222222222',
          authority: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111',
          scopes: ['api://33333333-3333-4333-8333-333333333333/AgentSentinel.Read'],
          redirectUri: 'https://sentinel.example/wrong',
          postLogoutRedirectUri: 'https://sentinel.example/',
        }),
      ),
    )

    await expect(runAuthLiveValidation(config, fetchMock)).rejects.toThrow(/exact origin paths/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('bounds optional deployment status responses before token probes', async () => {
    const config = buildAuthLiveValidationConfig({
      ...completeEnvironment,
      AUTH_VALIDATION_MAX_RESPONSE_BYTES: '1024',
      AUTH_VALIDATION_EXPECTED_API_SHA: 'a'.repeat(40),
    })
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('{}', {
          status: 200,
          headers: { 'Content-Length': '2048', 'Content-Type': 'application/json' },
        }),
      ),
    )

    await expect(runAuthLiveValidation(config, fetchMock)).rejects.toThrow(/size limit/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
