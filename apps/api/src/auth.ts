import type { FastifyReply, FastifyRequest } from 'fastify'
import { createRemoteJWKSet, jwtVerify } from 'jose'

export interface AuthConfig {
  mode: 'disabled' | 'mock' | 'jwt'
  tenantId?: string
  audience?: string
  allowedScopes?: {
    read: string[]
    write: string[]
  }
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
  if (mode === 'jwt' && !tenantId) {
    throw new Error('AUTH_TENANT_ID is required when AUTH_MODE is jwt.')
  }
  if (mode === 'jwt' && !audience) {
    throw new Error('AUTH_AUDIENCE is required when AUTH_MODE is jwt.')
  }

  return {
    mode,
    ...(tenantId ? { tenantId } : {}),
    ...(audience ? { audience } : {}),
    allowedScopes: {
      read: envList(env['AUTH_READ_SCOPES'], defaultScopes.read),
      write: envList(env['AUTH_WRITE_SCOPES'], defaultScopes.write),
    },
  }
}

function tokenPermissions(payload: Record<string, unknown>): Set<string> {
  const scopes = typeof payload['scp'] === 'string' ? payload['scp'].split(' ') : []
  const roles = Array.isArray(payload['roles'])
    ? payload['roles'].filter((role): role is string => typeof role === 'string')
    : typeof payload['roles'] === 'string'
      ? [payload['roles']]
      : []
  return new Set([...scopes, ...roles])
}

function isPublicRoute(request: FastifyRequest): boolean {
  const path = request.url.split('?', 1)[0]
  return path === '/health' || path === '/api/connector/status'
}

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
      const readMethod = ['GET', 'HEAD', 'OPTIONS'].includes(request.method)
      const required = readMethod ? scopes.read : scopes.write
      const permissions = tokenPermissions(verified.payload)
      if (!required.some((permission) => permissions.has(permission))) {
        await reply.status(403).send({
          error: 'forbidden',
          message: 'The token does not grant the required permission.',
        })
      }
    } catch {
      await reply.status(401).send({ error: 'unauthorized', message: 'Bearer token is invalid.' })
    }
  }
}
