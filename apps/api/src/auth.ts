import type { FastifyReply, FastifyRequest } from 'fastify'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// ─── Role & Capability model ──────────────────────────────────────────────────

export const SENTINEL_ROLES = ['Viewer', 'Analyst', 'Approver', 'Administrator'] as const
export type SentinelRole = (typeof SENTINEL_ROLES)[number]

export const CAPABILITIES = [
  'read',
  'validateFinding',
  'generateAdvisory',
  'proposeRemediation',
  'approveRemediation',
  'executeRemediation',
  'configure',
] as const
export type Capability = (typeof CAPABILITIES)[number]

/**
 * Explicit capability sets per role. Higher roles inherit lower capabilities.
 * AgentSentinel.Write delegated scope maps to Analyst at most — it does NOT
 * silently grant Approver or Administrator.
 */
const ROLE_CAPABILITIES: Record<SentinelRole, ReadonlySet<Capability>> = {
  Viewer: new Set<Capability>(['read']),
  Analyst: new Set<Capability>([
    'read',
    'validateFinding',
    'generateAdvisory',
    'proposeRemediation',
  ]),
  Approver: new Set<Capability>([
    'read',
    'validateFinding',
    'generateAdvisory',
    'proposeRemediation',
    'approveRemediation',
  ]),
  Administrator: new Set<Capability>([
    'read',
    'validateFinding',
    'generateAdvisory',
    'proposeRemediation',
    'approveRemediation',
    'executeRemediation',
    'configure',
  ]),
}

// ─── Principal ────────────────────────────────────────────────────────────────

/**
 * Sanitized principal attached to authenticated Fastify requests.
 * Never contains the raw token, all claims, or any secret material.
 */
export interface AuthPrincipal {
  /** Subject claim (sub) */
  subject: string
  /** Object ID claim (oid) if present */
  objectId?: string
  /** Tenant ID (tid) */
  tenantId: string
  /** Caller kind derived only from verified token-type claims. */
  actorType: 'user' | 'service-principal'
  /** Display name (name claim) if present */
  displayName?: string
  /** Preferred username / UPN (preferred_username) if present */
  preferredUsername?: string
  /** Roles resolved from token claims */
  roles: SentinelRole[]
  /** Union of capabilities from all granted roles */
  capabilities: Set<Capability>
}

// ─── Auth config ──────────────────────────────────────────────────────────────

/** Public SPA configuration — safe to expose to the browser; contains no secrets. */
export interface SpaAuthConfig {
  /** Entra tenant configured for this single-tenant SPA. */
  tenantId: string
  /** SPA application client ID. */
  clientId: string
  /** Full authority URL, e.g. https://login.microsoftonline.com/{tenantId}. */
  authority: string
  /** OAuth2 scopes the SPA requests when acquiring API tokens. */
  scopes: string[]
  /** Exact registered SPA redirect URI. */
  redirectUri: string
  /** Exact post-logout destination; must share the redirect URI origin. */
  postLogoutRedirectUri: string
}

interface InactiveAuthConfig {
  mode: 'disabled' | 'mock'
  allowedScopes?: { read: string[]; write: string[] }
}

export interface JwtAuthConfig {
  mode: 'jwt'
  tenantId: string
  audience: string
  issuer: string
  jwksUri: string
  allowedScopes: {
    read: string[]
    write: string[]
  }
  /** Public SPA settings. All fields are safe to expose through /api/auth/config. */
  spaConfig: SpaAuthConfig
}

export type AuthConfig = InactiveAuthConfig | JwtAuthConfig

const defaultScopes = {
  read: ['AgentSentinel.Read'],
  write: ['AgentSentinel.Write'],
}

function optionalEnvironment(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = optionalEnvironment(env, name)
  if (value === undefined) throw new Error(`${name} is required when AUTH_MODE is jwt.`)
  return value
}

function envList(value: string | undefined, fallback: readonly string[]): string[] {
  const items = (value === undefined ? fallback : value.split(','))
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  if (items.length === 0)
    throw new Error('Configured authentication scope lists must not be empty.')
  if (new Set(items).size !== items.length)
    throw new Error('Configured authentication scope lists must not contain duplicates.')
  return items
}

function validateIdentifier(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new Error(`${name} must be a UUID.`)
  return value
}

function validateAudience(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('AUTH_AUDIENCE must be an absolute application ID URI.')
  }
  if (
    (parsed.protocol !== 'api:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    value.endsWith('/')
  ) {
    throw new Error(
      'AUTH_AUDIENCE must be an absolute api:// or https:// application ID URI without query, fragment, or trailing slash.',
    )
  }
  return value
}

function tokenAudience(applicationIdUri: string): string {
  const apiClientId = applicationIdUri.match(
    /^api:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  )?.[1]

  // Entra v2 access tokens identify APIs by client ID even when scopes use api://{client-id}.
  return apiClientId ?? applicationIdUri
}

function validateRedirectUri(value: string, name: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute URL.`)
  }
  const localHttp = parsed.protocol === 'http:' && parsed.hostname === 'localhost'
  if (
    (parsed.protocol !== 'https:' && !localHttp) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      `${name} must use HTTPS (or http://localhost for local development) and contain no credentials, query, or fragment.`,
    )
  }
  return parsed.toString()
}

function qualifiedSpaScopes(
  value: string | undefined,
  audience: string,
  allowed: { read: string[]; write: string[] },
): string[] {
  const scopes = envList(value, [`${audience}/${allowed.read[0] ?? ''}`])
  const allowedQualified = new Set(
    [...allowed.read, ...allowed.write].map((scope) => `${audience}/${scope}`),
  )
  if (scopes.some((scope) => !allowedQualified.has(scope)))
    throw new Error(
      'AUTH_SPA_SCOPES may contain only fully qualified configured API read/write scopes.',
    )
  return scopes
}

function configuredEndpoint(value: string | undefined, fallback: string, name: string): string {
  const candidate = value ?? fallback
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL.`)
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw new Error(
      `${name} must be an absolute HTTPS URL without credentials, query, or fragment.`,
    )
  return candidate
}

export function buildAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const mode = (env['AUTH_MODE'] ?? 'disabled').trim()
  if (mode !== 'disabled' && mode !== 'mock' && mode !== 'jwt')
    throw new Error('AUTH_MODE must be disabled, mock, or jwt.')
  if (mode !== 'jwt') return { mode }

  const tenantId = validateIdentifier(requiredEnvironment(env, 'AUTH_TENANT_ID'), 'AUTH_TENANT_ID')
  const audience = validateAudience(requiredEnvironment(env, 'AUTH_AUDIENCE'))
  const clientId = validateIdentifier(
    requiredEnvironment(env, 'AUTH_SPA_CLIENT_ID'),
    'AUTH_SPA_CLIENT_ID',
  )
  const authority = `https://login.microsoftonline.com/${tenantId}`
  const issuer = configuredEndpoint(
    optionalEnvironment(env, 'AUTH_ISSUER'),
    `${authority}/v2.0`,
    'AUTH_ISSUER',
  )
  const jwksUri = configuredEndpoint(
    optionalEnvironment(env, 'AUTH_JWKS_URI'),
    `${authority}/discovery/v2.0/keys`,
    'AUTH_JWKS_URI',
  )
  const allowedScopes = {
    read: envList(env['AUTH_READ_SCOPES'], defaultScopes.read),
    write: envList(env['AUTH_WRITE_SCOPES'], defaultScopes.write),
  }
  if (allowedScopes.read.some((scope) => allowedScopes.write.includes(scope)))
    throw new Error('AUTH_READ_SCOPES and AUTH_WRITE_SCOPES must not overlap.')
  const redirectUri = validateRedirectUri(
    requiredEnvironment(env, 'AUTH_SPA_REDIRECT_URI'),
    'AUTH_SPA_REDIRECT_URI',
  )
  const postLogoutRedirectUri = validateRedirectUri(
    requiredEnvironment(env, 'AUTH_SPA_POST_LOGOUT_REDIRECT_URI'),
    'AUTH_SPA_POST_LOGOUT_REDIRECT_URI',
  )
  if (new URL(redirectUri).origin !== new URL(postLogoutRedirectUri).origin)
    throw new Error(
      'AUTH_SPA_REDIRECT_URI and AUTH_SPA_POST_LOGOUT_REDIRECT_URI must share an origin.',
    )

  return {
    mode,
    tenantId,
    audience,
    issuer,
    jwksUri,
    allowedScopes,
    spaConfig: {
      tenantId,
      clientId,
      authority,
      scopes: qualifiedSpaScopes(
        optionalEnvironment(env, 'AUTH_SPA_SCOPES'),
        audience,
        allowedScopes,
      ),
      redirectUri,
      postLogoutRedirectUri,
    },
  }
}

// ─── Role resolution ──────────────────────────────────────────────────────────

function isSentinelRole(value: unknown): value is SentinelRole {
  return typeof value === 'string' && (SENTINEL_ROLES as readonly string[]).includes(value)
}

/**
 * Resolve SentinelRoles from token payload.
 *
 * Sources (in order):
 * 1. `roles` claim: AgentSentinel.Viewer/Analyst/Approver/Administrator app-role strings.
 *    Only exact prefixed app-role values are accepted.
 * 2. `scp` claim: only explicitly configured read/write scopes.
 *    Defaults preserve AgentSentinel.Read/Write compatibility, while environment
 *    overrides can revoke those defaults.
 *
 * Roles are never inferred from display names, groups, or any other claim.
 */
function resolveRoles(
  payload: Record<string, unknown>,
  allowedScopes: { read: string[]; write: string[] },
): SentinelRole[] {
  const granted = new Set<SentinelRole>()

  // App roles from 'roles' claim
  const rawRoles = Array.isArray(payload['roles'])
    ? payload['roles'].filter((r): r is string => typeof r === 'string')
    : typeof payload['roles'] === 'string'
      ? [payload['roles']]
      : []

  for (const role of rawRoles) {
    if (!role.startsWith('AgentSentinel.')) continue
    const stripped = role.slice('AgentSentinel.'.length)
    if (isSentinelRole(stripped)) granted.add(stripped)
  }

  // Delegated scopes from 'scp' claim
  const scopes =
    typeof payload['scp'] === 'string' ? payload['scp'].split(' ').filter((s) => s.length > 0) : []

  for (const scope of scopes) {
    if (allowedScopes.read.includes(scope)) granted.add('Viewer')
    // Configured write scope → Analyst at most; never higher. Documented here.
    if (allowedScopes.write.includes(scope)) granted.add('Analyst')
  }

  return [...granted]
}

function capabilitiesForRoles(roles: SentinelRole[]): Set<Capability> {
  const caps = new Set<Capability>()
  for (const role of roles) {
    for (const cap of ROLE_CAPABILITIES[role]) {
      caps.add(cap)
    }
  }
  return caps
}

/**
 * Build a sanitized AuthPrincipal from a verified JWT payload.
 * Never returns the raw token, all claims, or any credential material.
 */
export function sanitizePrincipal(
  payload: Record<string, unknown>,
  allowedScopes: { read: string[]; write: string[] },
): AuthPrincipal {
  const subject = typeof payload['sub'] === 'string' ? payload['sub'] : ''
  const objectId = typeof payload['oid'] === 'string' ? payload['oid'] : undefined
  const tenantId = typeof payload['tid'] === 'string' ? payload['tid'] : ''
  if (subject.length === 0 || tenantId.length === 0) {
    throw new Error('The token is missing required subject or tenant claims.')
  }
  const displayName = typeof payload['name'] === 'string' ? payload['name'] : undefined
  const preferredUsername =
    typeof payload['preferred_username'] === 'string' ? payload['preferred_username'] : undefined
  const idtyp = payload['idtyp']
  if (idtyp !== undefined && idtyp !== 'app' && idtyp !== 'user') {
    throw new Error('The token contains an unsupported token type.')
  }
  const hasDelegatedScopes = typeof payload['scp'] === 'string' && payload['scp'].trim().length > 0
  if (idtyp === 'app' && (objectId === undefined || hasDelegatedScopes)) {
    throw new Error('An app-only token requires a service-principal object ID and no scopes.')
  }
  const actorType = idtyp === 'app' ? 'service-principal' : 'user'

  const roles = resolveRoles(payload, allowedScopes)
  const capabilities = capabilitiesForRoles(roles)

  return {
    subject,
    ...(objectId !== undefined ? { objectId } : {}),
    tenantId,
    actorType,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(preferredUsername !== undefined ? { preferredUsername } : {}),
    roles,
    capabilities,
  }
}

// ─── Fastify type augmentation ────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    authPrincipal?: AuthPrincipal
  }
}

// ─── Public route list ────────────────────────────────────────────────────────

const PUBLIC_PATHS = new Set(['/health', '/api/auth/config'])

function isPublicRoute(request: FastifyRequest): boolean {
  const path = request.url.split('?', 1)[0]
  return path !== undefined && PUBLIC_PATHS.has(path)
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

export function createAuthMiddleware(config: AuthConfig) {
  const jwks = config.mode === 'jwt' ? createRemoteJWKSet(new URL(config.jwksUri)) : undefined

  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (config.mode !== 'jwt' || isPublicRoute(request)) return

    const authorization = request.headers.authorization
    const match = authorization?.match(/^Bearer\s+(.+)$/i)
    if (match?.[1] === undefined || jwks === undefined) {
      await reply.status(401).send({ error: 'unauthorized', message: 'Bearer token required.' })
      return
    }

    let payload: Record<string, unknown>
    try {
      const verified = await jwtVerify(match[1], jwks, {
        issuer: config.issuer,
        audience: tokenAudience(config.audience),
        algorithms: ['RS256'],
      })
      payload = verified.payload
    } catch {
      await reply.status(401).send({ error: 'unauthorized', message: 'Access token is invalid.' })
      return
    }

    let principal: AuthPrincipal
    try {
      principal = sanitizePrincipal(payload, config.allowedScopes)
    } catch {
      await reply
        .status(401)
        .send({ error: 'unauthorized', message: 'Access token claims are invalid.' })
      return
    }
    if (principal.tenantId !== config.tenantId) {
      await reply
        .status(401)
        .send({ error: 'unauthorized', message: 'Access token tenant is invalid.' })
      return
    }

    if (!principal.capabilities.has('read')) {
      await reply.status(403).send({
        error: 'forbidden',
        message: 'The token does not grant the required permission.',
      })
      return
    }
    request.authPrincipal = principal
  }
}

// ─── Per-route capability guard ───────────────────────────────────────────────

/**
 * Returns a Fastify preHandler that enforces a specific capability in JWT mode.
 * In disabled/mock mode this is a no-op so existing demo behavior is preserved.
 *
 * Design note: AgentSentinel.Write delegated scope grants Analyst capabilities at
 * most (validateFinding, generateAdvisory, proposeRemediation). It does NOT grant
 * approveRemediation or executeRemediation. Those require an explicit app role of
 * Approver or Administrator respectively.
 */
export function requireCapability(config: AuthConfig, capability: Capability) {
  return async function capabilityGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (config.mode !== 'jwt') return

    const principal = request.authPrincipal
    if (principal === undefined) {
      await reply.status(401).send({ error: 'unauthorized', message: 'Bearer token required.' })
      return
    }
    if (!principal.capabilities.has(capability)) {
      await reply.status(403).send({
        error: 'forbidden',
        message:
          "The operation requires the '" +
          capability +
          "' capability. Assigned roles: " +
          (principal.roles.join(', ') || 'none') +
          '.',
      })
    }
  }
}
