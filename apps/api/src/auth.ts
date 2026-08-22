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
  /** SPA application client ID */
  clientId: string
  /** Full authority URL e.g. https://login.microsoftonline.com/{tenantId} */
  authority: string
  /** OAuth2 scopes the SPA should request when acquiring API tokens */
  scopes: string[]
}

export interface AuthConfig {
  mode: 'disabled' | 'mock' | 'jwt'
  tenantId?: string
  audience?: string
  allowedScopes?: {
    read: string[]
    write: string[]
  }
  /**
   * SPA public config. Present only when mode === 'jwt' and AUTH_CLIENT_ID is set.
   * All fields are safe to expose in the public /api/auth/config response.
   */
  spaConfig?: SpaAuthConfig
}

const defaultScopes = {
  read: ['AgentSentinel.Read'],
  write: ['AgentSentinel.Write'],
}

function envList(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

export function buildAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const mode = (env['AUTH_MODE'] ?? 'disabled').trim()
  if (mode !== 'disabled' && mode !== 'mock' && mode !== 'jwt') {
    throw new Error('AUTH_MODE must be disabled, mock, or jwt.')
  }

  const tenantId = env['AUTH_TENANT_ID']?.trim()
  const audience = env['AUTH_AUDIENCE']?.trim()
  const clientId = env['AUTH_CLIENT_ID']?.trim()
  const rawScopes = env['AUTH_SCOPES']?.trim()

  if (mode === 'jwt' && (!tenantId || tenantId.length === 0)) {
    throw new Error('AUTH_TENANT_ID is required when AUTH_MODE is jwt.')
  }
  if (mode === 'jwt' && (!audience || audience.length === 0)) {
    throw new Error('AUTH_AUDIENCE is required when AUTH_MODE is jwt.')
  }

  let spaConfig: SpaAuthConfig | undefined
  if (mode === 'jwt' && tenantId && clientId && clientId.length > 0) {
    const authority = 'https://login.microsoftonline.com/' + tenantId
    const spaScopes = rawScopes
      ? rawScopes
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [audience + '/AgentSentinel.Read']
    spaConfig = { clientId, authority, scopes: spaScopes }
  }

  return {
    mode,
    ...(tenantId ? { tenantId } : {}),
    ...(audience ? { audience } : {}),
    allowedScopes: {
      read: envList(env['AUTH_READ_SCOPES'], defaultScopes.read),
      write: envList(env['AUTH_WRITE_SCOPES'], defaultScopes.write),
    },
    ...(spaConfig !== undefined ? { spaConfig } : {}),
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
 *    Plain role names (without prefix) are also accepted.
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

  for (const r of rawRoles) {
    const stripped = r.startsWith('AgentSentinel.') ? r.slice('AgentSentinel.'.length) : r
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

  const roles = resolveRoles(payload, allowedScopes)
  const capabilities = capabilitiesForRoles(roles)

  return {
    subject,
    ...(objectId !== undefined ? { objectId } : {}),
    tenantId,
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

const PUBLIC_PATHS = new Set(['/health', '/api/connector/status', '/api/auth/config'])

function isPublicRoute(request: FastifyRequest): boolean {
  const path = request.url.split('?', 1)[0]
  return path !== undefined && PUBLIC_PATHS.has(path)
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

export function createAuthMiddleware(config: AuthConfig) {
  const scopes = config.allowedScopes ?? defaultScopes
  const tenantId = config.tenantId
  const audience = config.audience

  if (config.mode === 'jwt' && (!tenantId || !audience)) {
    throw new Error('JWT auth requires tenantId and audience.')
  }

  const jwtTenantId = tenantId ?? ''
  const jwtAudience = audience ?? ''
  const jwks =
    config.mode === 'jwt'
      ? createRemoteJWKSet(
          new URL('https://login.microsoftonline.com/' + jwtTenantId + '/discovery/v2.0/keys'),
        )
      : undefined

  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (config.mode !== 'jwt' || isPublicRoute(request)) return

    const authorization = request.headers.authorization
    const match = authorization?.match(/^Bearer\s+(.+)$/i)
    if (match?.[1] === undefined || jwks === undefined) {
      await reply.status(401).send({ error: 'unauthorized', message: 'Bearer token required.' })
      return
    }

    try {
      const verified = await jwtVerify(match[1], jwks, {
        issuer: 'https://login.microsoftonline.com/' + jwtTenantId + '/v2.0',
        audience: jwtAudience,
        algorithms: ['RS256'],
      })
      const payload = verified.payload as Record<string, unknown>
      const principal = sanitizePrincipal(payload, scopes)
      if (principal.tenantId !== jwtTenantId) {
        throw new Error('The token tenant does not match the configured tenant.')
      }

      // Every authenticated non-public route requires at least read capability.
      if (!principal.capabilities.has('read')) {
        await reply.status(403).send({
          error: 'forbidden',
          message: 'The token does not grant the required permission.',
        })
        return
      }
      request.authPrincipal = principal
    } catch {
      await reply.status(401).send({ error: 'unauthorized', message: 'Bearer token is invalid.' })
    }
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
