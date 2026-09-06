import type { FastifyReply, FastifyRequest } from 'fastify'

import type { EstateContext } from '@agent-sentinel/domain'

import type { AuthConfig } from './auth.js'
import type { EstateDefinition, EstateRegistry } from './estate-config.js'

const ESTATE_HEADER = 'x-agent-sentinel-estate-id'
const selectionFreePaths = new Set(['/health', '/api/auth/config', '/api/estates'])
const estateAwarePrefixes = ['/api/exposures', '/api/connector-sources']
const estateAwarePaths = new Set(['/api/connectors', '/api/governance/posture'])

declare module 'fastify' {
  interface FastifyRequest {
    estateContext?: EstateContext
  }
}

function requestPath(request: FastifyRequest): string {
  return request.url.split('?', 1)[0] ?? request.url
}

function selectedEstateId(request: FastifyRequest): string | undefined {
  const value = request.headers[ESTATE_HEADER]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function permittedEstates(
  request: FastifyRequest,
  authConfig: AuthConfig,
  registry: EstateRegistry,
): EstateDefinition[] {
  if (authConfig.mode !== 'jwt') return [registry.defaultEstate]
  return request.authPrincipal === undefined
    ? []
    : registry.authorizedFor(request.authPrincipal.tenantId)
}

export function authorizedEstates(
  request: FastifyRequest,
  authConfig: AuthConfig,
  registry: EstateRegistry,
): EstateDefinition[] {
  return permittedEstates(request, authConfig, registry)
}

export function createEstateMiddleware(authConfig: AuthConfig, registry: EstateRegistry) {
  return async function resolveEstate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (selectionFreePaths.has(requestPath(request))) return
    const permitted = permittedEstates(request, authConfig, registry)
    if (permitted.length === 0) {
      if (!reply.sent) {
        await reply.status(403).send({
          error: 'forbidden',
          message: 'The authenticated tenant is not authorized for an Agent Sentinel estate.',
        })
      }
      return
    }
    const requestedId = selectedEstateId(request) ?? registry.defaultEstate.id
    const selected = permitted.find((estate) => estate.id === requestedId)
    if (selected === undefined) {
      await reply.status(403).send({
        error: 'forbidden',
        message: 'The requested Agent Sentinel estate is unknown or unauthorized.',
      })
      return
    }
    if (
      selected.id !== registry.defaultEstate.id &&
      !estateAwarePaths.has(requestPath(request)) &&
      !estateAwarePrefixes.some((prefix) => requestPath(request).startsWith(prefix))
    ) {
      await reply.status(403).send({
        error: 'forbidden',
        message: 'This API is not yet enabled for non-default estates.',
      })
      return
    }
    request.estateContext = {
      id: selected.id,
      tenantId: selected.tenantId,
      environment: selected.environment,
    }
  }
}

export function requireEstateContext(request: FastifyRequest): EstateContext {
  const context = request.estateContext
  if (context === undefined) {
    throw new Error('The request does not have an authorized estate context.')
  }
  return context
}
