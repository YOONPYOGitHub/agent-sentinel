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
})
