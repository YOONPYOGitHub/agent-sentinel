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
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/i)
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/i)
const deploymentStatusSchema = z.strictObject({
  status: z.literal('ok'),
  service: z.literal('agent-sentinel-api'),
  observedAt: z.iso.datetime(),
  revision: z.string().optional(),
  components: z.strictObject({
    web: z.strictObject({ sha: shaSchema.optional(), digest: digestSchema.optional() }),
    api: z.strictObject({ sha: shaSchema.optional(), digest: digestSchema.optional() }),
    jobs: z.strictObject({ sha: shaSchema.optional(), digest: digestSchema.optional() }),
  }),
})
const publicAuthConfigSchema = z.strictObject({
  enabled: z.literal(true),
  tenantId: z.string().uuid(),
  clientId: z.string().uuid(),
  authority: z.url(),
  scopes: z.array(z.string().min(1)).min(1),
  redirectUri: z.url(),
  postLogoutRedirectUri: z.url(),
})

type DeploymentComponent = 'web' | 'api' | 'jobs'
type ExpectedDeploymentComponent = {
  readonly sha?: string
  readonly digest?: string
}

export interface AuthLiveValidationConfig {
  baseUrl: string
  phase: 'read' | 'write'
  tokens: Record<AuthValidationRole, string>
  timeoutMs: number
  maxResponseBytes: number
  expected?: {
    redirectOrigin?: string
    deployment?: Partial<Record<DeploymentComponent, ExpectedDeploymentComponent>>
  }
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
  redirectConfigurationValidated?: true
  deploymentStatusValidated?: true
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

function optionalExpectedValue(
  env: NodeJS.ProcessEnv,
  name: string,
  pattern: RegExp,
): string | undefined {
  const value = env[name]?.trim()
  if (value === undefined || value.length === 0) return undefined
  if (!pattern.test(value)) throw new Error(`${name} is malformed.`)
  return value.toLowerCase()
}

function expectedDeployment(
  env: NodeJS.ProcessEnv,
): Partial<Record<DeploymentComponent, ExpectedDeploymentComponent>> | undefined {
  const expected = Object.fromEntries(
    (['web', 'api', 'jobs'] as const).flatMap((component) => {
      const prefix = `AUTH_VALIDATION_EXPECTED_${component.toUpperCase()}`
      const sha = optionalExpectedValue(env, `${prefix}_SHA`, /^[0-9a-f]{40}$/i)
      const digest = optionalExpectedValue(env, `${prefix}_IMAGE_DIGEST`, /^sha256:[0-9a-f]{64}$/i)
      return sha === undefined && digest === undefined
        ? []
        : [
            [
              component,
              {
                ...(sha === undefined ? {} : { sha }),
                ...(digest === undefined ? {} : { digest }),
              },
            ],
          ]
    }),
  ) as Partial<Record<DeploymentComponent, ExpectedDeploymentComponent>>
  return Object.keys(expected).length === 0 ? undefined : expected
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
  const maxResponseBytes = parseInteger(
    env['AUTH_VALIDATION_MAX_RESPONSE_BYTES'],
    256 * 1024,
    'AUTH_VALIDATION_MAX_RESPONSE_BYTES',
    1_024,
    1024 * 1024,
  )
  const redirectOriginValue = env['AUTH_VALIDATION_EXPECTED_REDIRECT_ORIGIN']?.trim()
  const redirectOrigin =
    redirectOriginValue === undefined || redirectOriginValue.length === 0
      ? undefined
      : parseBaseUrl(redirectOriginValue)
  const deployment = expectedDeployment(env)
  const expected =
    redirectOrigin === undefined && deployment === undefined
      ? undefined
      : {
          ...(redirectOrigin === undefined ? {} : { redirectOrigin }),
          ...(deployment === undefined ? {} : { deployment }),
        }

  if (phase === 'read') {
    return {
      baseUrl: parseBaseUrl(requiredEnvironment(env, 'AUTH_VALIDATION_BASE_URL')),
      phase,
      tokens,
      timeoutMs,
      maxResponseBytes,
      ...(expected === undefined ? {} : { expected }),
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
    maxResponseBytes,
    ...(expected === undefined ? {} : { expected }),
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

async function validateDeploymentStatus(
  config: AuthLiveValidationConfig,
  fetchImplementation: typeof fetch,
): Promise<true | undefined> {
  const expected = config.expected?.deployment
  if (expected === undefined) return undefined
  const response = await request(config, fetchImplementation, '/api/status')
  assertStatus('/api/status', response.status, 200)
  const status = deploymentStatusSchema.parse(await responseJson(config, response, '/api/status'))
  for (const component of ['web', 'api', 'jobs'] as const) {
    const componentExpected = expected[component]
    if (componentExpected === undefined) continue
    const actual = status.components[component]
    if (
      componentExpected.sha !== undefined &&
      actual.sha?.toLowerCase() !== componentExpected.sha
    ) {
      throw new Error(`/api/status ${component} SHA did not match the expected immutable SHA.`)
    }
    if (
      componentExpected.digest !== undefined &&
      actual.digest?.toLowerCase() !== componentExpected.digest
    ) {
      throw new Error(
        `/api/status ${component} digest did not match the expected immutable digest.`,
      )
    }
  }
  return true
}

async function validateRedirectConfiguration(
  config: AuthLiveValidationConfig,
  fetchImplementation: typeof fetch,
): Promise<true | undefined> {
  const origin = config.expected?.redirectOrigin
  if (origin === undefined) return undefined
  if (config.baseUrl !== origin) {
    throw new Error('Expected redirect origin must exactly match AUTH_VALIDATION_BASE_URL.')
  }
  const response = await request(config, fetchImplementation, '/api/auth/config')
  assertStatus('/api/auth/config', response.status, 200)
  const auth = publicAuthConfigSchema.parse(
    await responseJson(config, response, '/api/auth/config'),
  )
  const expectedRedirect = `${origin}/auth-redirect.html`
  const expectedLogout = `${origin}/`
  if (auth.redirectUri !== expectedRedirect || auth.postLogoutRedirectUri !== expectedLogout) {
    throw new Error(
      'Public auth redirect/logout configuration does not match the exact origin paths.',
    )
  }
  if (
    new URL(auth.redirectUri).origin !== origin ||
    new URL(auth.postLogoutRedirectUri).origin !== origin
  ) {
    throw new Error('Public auth redirect/logout configuration is not same-origin.')
  }
  return true
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

async function responseJson(
  config: AuthLiveValidationConfig,
  response: Response,
  path: string,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > config.maxResponseBytes) {
    throw new Error(`${path} response exceeded the configured size limit.`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > config.maxResponseBytes) {
    throw new Error(`${path} response exceeded the configured size limit.`)
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new Error(`${path} returned invalid JSON.`)
  }
}

export async function runAuthLiveValidation(
  config: AuthLiveValidationConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<AuthLiveValidationResult> {
  const deploymentStatusValidated = await validateDeploymentStatus(config, fetchImplementation)
  const redirectConfigurationValidated = await validateRedirectConfiguration(
    config,
    fetchImplementation,
  )
  const anonymous = await request(config, fetchImplementation, '/api/auth/me')
  assertStatus('/api/auth/me (anonymous)', anonymous.status, 401)

  let insufficientRoleStatus: 403 | undefined
  for (const role of AUTH_VALIDATION_ROLES) {
    const token = config.tokens[role]
    const principalResponse = await request(config, fetchImplementation, '/api/auth/me', token)
    assertStatus(`/api/auth/me (${role})`, principalResponse.status, 200)
    const principal = principalSchema.parse(
      await responseJson(config, principalResponse, `/api/auth/me (${role})`),
    )
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
      ...(redirectConfigurationValidated === undefined ? {} : { redirectConfigurationValidated }),
      ...(deploymentStatusValidated === undefined ? {} : { deploymentStatusValidated }),
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
    ...(redirectConfigurationValidated === undefined ? {} : { redirectConfigurationValidated }),
    ...(deploymentStatusValidated === undefined ? {} : { deploymentStatusValidated }),
    anonymousWriteStatus: 401,
    writeStatus: writeResponse.status,
  }
}
