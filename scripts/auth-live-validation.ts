import { z } from 'zod'

export const AUTH_VALIDATION_ROLES = ['Viewer', 'Analyst', 'Approver', 'Administrator'] as const
export type AuthValidationRole = (typeof AUTH_VALIDATION_ROLES)[number]

export const AUTH_VALIDATION_CAPABILITIES = [
  'read',
  'validateFinding',
  'generateAdvisory',
  'proposeRemediation',
  'approveRemediation',
  'executeRemediation',
  'configure',
] as const
export type AuthValidationCapability = (typeof AUTH_VALIDATION_CAPABILITIES)[number]

const EXPECTED_CAPABILITIES: Record<AuthValidationRole, readonly AuthValidationCapability[]> = {
  Viewer: ['read'],
  Analyst: ['read', 'validateFinding', 'generateAdvisory', 'proposeRemediation'],
  Approver: [
    'read',
    'validateFinding',
    'generateAdvisory',
    'proposeRemediation',
    'approveRemediation',
  ],
  Administrator: AUTH_VALIDATION_CAPABILITIES,
}

const TOKEN_ENV: Record<AuthValidationRole, string> = {
  Viewer: 'AUTH_VALIDATION_VIEWER_TOKEN',
  Analyst: 'AUTH_VALIDATION_ANALYST_TOKEN',
  Approver: 'AUTH_VALIDATION_APPROVER_TOKEN',
  Administrator: 'AUTH_VALIDATION_ADMINISTRATOR_TOKEN',
}

const principalSchema = z.object({
  roles: z.array(z.string()),
  capabilities: z.array(z.enum(AUTH_VALIDATION_CAPABILITIES)),
})

export interface AuthLiveValidationConfig {
  baseUrl: string
  phase: 'read' | 'write'
  tokens: Record<AuthValidationRole, string>
  timeoutMs: number
  write?: {
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path: string
    body?: unknown
    expectedStatus: number
  }
}

export interface AuthLiveValidationResult {
  anonymousStatus: 401
  insufficientRoleStatus: 403
  rolesValidated: readonly AuthValidationRole[]
  anonymousWriteStatus?: 401
  writeStatus?: number
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (value === undefined || value.length === 0)
    throw new Error(`Required environment variable is missing: ${name}`)
  return value
}

function parseBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('AUTH_VALIDATION_BASE_URL must be an absolute URL.')
  }
  const localHttp = url.protocol === 'http:' && url.hostname === 'localhost'
  if (
    (url.protocol !== 'https:' && !localHttp) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new Error(
      'AUTH_VALIDATION_BASE_URL must be an HTTPS origin (or http://localhost) without credentials, path, query, or fragment.',
    )
  }
  return url.origin
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${name} must be an integer from ${String(minimum)} to ${String(maximum)}.`)
  return parsed
}

function parseWritePath(value: string): string {
  if (!value.startsWith('/api/') || value.startsWith('//') || value.includes('..'))
    throw new Error('AUTH_VALIDATION_WRITE_PATH must be a normalized absolute /api/ path.')
  return value
}

export function buildAuthLiveValidationConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuthLiveValidationConfig {
  const phase = (env['AUTH_VALIDATION_PHASE'] ?? 'read').trim()
  if (phase !== 'read' && phase !== 'write')
    throw new Error('AUTH_VALIDATION_PHASE must be read or write.')

  const tokens = Object.fromEntries(
    AUTH_VALIDATION_ROLES.map((role) => [role, requiredEnvironment(env, TOKEN_ENV[role])]),
  ) as Record<AuthValidationRole, string>
  const timeoutMs = parseInteger(
    env['AUTH_VALIDATION_TIMEOUT_MS'],
    15_000,
    'AUTH_VALIDATION_TIMEOUT_MS',
    1_000,
    60_000,
  )

  if (phase === 'read') {
    return {
      baseUrl: parseBaseUrl(requiredEnvironment(env, 'AUTH_VALIDATION_BASE_URL')),
      phase,
      tokens,
      timeoutMs,
    }
  }

  const method = requiredEnvironment(env, 'AUTH_VALIDATION_WRITE_METHOD').toUpperCase()
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE')
    throw new Error('AUTH_VALIDATION_WRITE_METHOD must be POST, PUT, PATCH, or DELETE.')
  const rawBody = env['AUTH_VALIDATION_WRITE_BODY']?.trim()
  let body: unknown
  if (rawBody !== undefined && rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody) as unknown
    } catch {
      throw new Error('AUTH_VALIDATION_WRITE_BODY must be valid JSON.')
    }
  }

  return {
    baseUrl: parseBaseUrl(requiredEnvironment(env, 'AUTH_VALIDATION_BASE_URL')),
    phase,
    tokens,
    timeoutMs,
    write: {
      method,
      path: parseWritePath(requiredEnvironment(env, 'AUTH_VALIDATION_WRITE_PATH')),
      ...(body === undefined ? {} : { body }),
      expectedStatus: parseInteger(
        env['AUTH_VALIDATION_WRITE_EXPECTED_STATUS'],
        200,
        'AUTH_VALIDATION_WRITE_EXPECTED_STATUS',
        200,
        299,
      ),
    },
  }
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((item) => actual.includes(item))
}

async function request(
  config: AuthLiveValidationConfig,
  fetchImplementation: typeof fetch,
  path: string,
  token?: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (token !== undefined) headers.set('Authorization', `Bearer ${token}`)
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  return fetchImplementation(`${config.baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(config.timeoutMs),
  })
}

function assertStatus(path: string, actual: number, expected: number): void {
  if (actual !== expected)
    throw new Error(`${path} returned status ${String(actual)}; expected ${String(expected)}.`)
}

export async function runAuthLiveValidation(
  config: AuthLiveValidationConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<AuthLiveValidationResult> {
  const anonymous = await request(config, fetchImplementation, '/api/auth/me')
  assertStatus('/api/auth/me (anonymous)', anonymous.status, 401)

  let insufficientRoleStatus: 403 | undefined
  for (const role of AUTH_VALIDATION_ROLES) {
    const token = config.tokens[role]
    const principalResponse = await request(config, fetchImplementation, '/api/auth/me', token)
    assertStatus(`/api/auth/me (${role})`, principalResponse.status, 200)
    const principal = principalSchema.parse(await principalResponse.json())
    if (!principal.roles.includes(role))
      throw new Error(`/api/auth/me (${role}) did not contain the expected app role.`)
    if (!sameMembers(principal.capabilities, EXPECTED_CAPABILITIES[role]))
      throw new Error(`/api/auth/me (${role}) did not match the expected capability boundary.`)

    for (const capability of AUTH_VALIDATION_CAPABILITIES) {
      const expected = EXPECTED_CAPABILITIES[role].includes(capability) ? 200 : 403
      const path = `/api/auth/capabilities/${capability}`
      const response = await request(config, fetchImplementation, path, token)
      assertStatus(`${path} (${role})`, response.status, expected)
      if (role === 'Viewer' && capability === 'validateFinding' && response.status === 403)
        insufficientRoleStatus = 403
    }
  }
  if (insufficientRoleStatus === undefined)
    throw new Error('The Viewer insufficient-role probe did not return 403.')

  if (config.phase === 'read') {
    return {
      anonymousStatus: 401,
      insufficientRoleStatus,
      rolesValidated: AUTH_VALIDATION_ROLES,
    }
  }

  const write = config.write
  if (write === undefined) throw new Error('Write-phase validation configuration is incomplete.')
  const anonymousWrite = await request(config, fetchImplementation, write.path, undefined, {
    method: write.method,
    ...(write.body === undefined ? {} : { body: JSON.stringify(write.body) }),
  })
  assertStatus(`${write.path} (anonymous write)`, anonymousWrite.status, 401)

  const writeResponse = await request(
    config,
    fetchImplementation,
    write.path,
    config.tokens.Administrator,
    {
      method: write.method,
      ...(write.body === undefined ? {} : { body: JSON.stringify(write.body) }),
    },
  )
  assertStatus(`${write.path} (authorized write)`, writeResponse.status, write.expectedStatus)
  return {
    anonymousStatus: 401,
    insufficientRoleStatus,
    rolesValidated: AUTH_VALIDATION_ROLES,
    anonymousWriteStatus: 401,
    writeStatus: writeResponse.status,
  }
}
