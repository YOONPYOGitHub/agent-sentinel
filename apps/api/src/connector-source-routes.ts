import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import {
  connectorCredentialMetadataSchema,
  connectorSourceAuditRecordSchema,
  connectorSourceConfigurationSchema,
  connectorSourceDefinitionSchema,
  connectorSourceIdSchema,
  connectorTypeSchema,
  type ConnectorSourceActor,
  type ConnectorSourceAuditCursor,
  type ConnectorSourceAuditRecord,
  type ConnectorSourceDefinition,
  type ConnectorSourceMutationContext,
  type ConnectorSourceRepository,
  type ConnectorSourceTestStatus,
  type ConnectorSourceWriteResult,
} from '@agent-sentinel/domain'

import { redactSensitiveText } from './advisory-service.js'
import { requireCapability, type AuthConfig, type AuthPrincipal } from './auth.js'
import { requireEstateContext } from './estate-auth.js'

const ROUTE_BODY_LIMIT = 64 * 1024

const createBodySchema = z
  .strictObject({
    sourceId: connectorSourceIdSchema,
    connectorType: connectorTypeSchema,
    displayName: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    configuration: connectorSourceConfigurationSchema,
    credential: connectorCredentialMetadataSchema,
  })
  .superRefine((source, context) => {
    if (source.configuration.type !== source.connectorType) {
      context.addIssue({
        code: 'custom',
        path: ['configuration', 'type'],
        message: 'Connector configuration must match connectorType.',
      })
    }
  })

const updateBodySchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
    configuration: connectorSourceConfigurationSchema.optional(),
    credential: connectorCredentialMetadataSchema.optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: 'At least one connector source field must be updated.',
  })

const sourceParamsSchema = z.strictObject({
  sourceId: connectorSourceIdSchema,
})

const pageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: connectorSourceIdSchema.optional(),
})

const auditCursorValueSchema = z.tuple([
  z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
  z.string().trim().min(1).max(256),
])

const auditCursorSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .transform((value, context): ConnectorSourceAuditCursor => {
    try {
      const [occurredAt, id] = auditCursorValueSchema.parse(
        JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
      )
      return { occurredAt, id }
    } catch {
      context.addIssue({ code: 'custom', message: 'Cursor is not valid.' })
      return z.NEVER
    }
  })

const auditPageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: auditCursorSchema.optional(),
})

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Idempotency-Key contains unsupported characters.')
  .refine((value) => redactSensitiveText(value) === value, {
    message: 'Idempotency-Key must not contain credential material.',
  })

const noSensitiveTextSchema = z.unknown().superRefine((value, context) => {
  const visit = (candidate: unknown): void => {
    if (typeof candidate === 'string' && redactSensitiveText(candidate) !== candidate) {
      context.addIssue({
        code: 'custom',
        message: 'Connector source input must not contain credential material.',
      })
      return
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    if (typeof candidate === 'object' && candidate !== null) {
      Object.values(candidate).forEach(visit)
    }
  }
  visit(value)
})

const connectionTestStatusResponseSchema = z.strictObject({
  estateId: z.string(),
  tenantId: z.string(),
  environment: z.string(),
  sourceId: connectorSourceIdSchema,
  connectorType: connectorTypeSchema,
  readOnly: z.literal(true),
  status: z.enum([
    'passed',
    'failed',
    'degraded',
    'authorization-required',
    'insufficient-data',
    'unknown',
  ]),
  evidenceAvailability: z.enum(['available', 'unavailable']),
  evidenceBasis: z.enum(['provider-response', 'synthetic']).nullable(),
  evidenceIds: z.array(z.string()),
  checkedAt: z.string().nullable(),
  checkedBy: z
    .strictObject({
      type: z.enum(['user', 'service-principal', 'deployment']),
      id: z.string(),
    })
    .nullable(),
  summary: z.string(),
})

export interface ConnectorSourceRoutesOptions {
  authConfig: AuthConfig
  repository?: ConnectorSourceRepository
  writeEnabled: boolean
  clock?: () => Date
}

function sourceActor(principal: AuthPrincipal): ConnectorSourceActor {
  return {
    type: principal.actorType,
    id: principal.objectId ?? principal.subject,
  }
}

function idempotencyKey(request: FastifyRequest): string {
  return idempotencyKeySchema.parse(request.headers['idempotency-key'])
}

function expectedEtag(request: FastifyRequest): string {
  return z
    .string()
    .regex(/^"[^"]{1,256}"$/, 'If-Match must contain exactly one strong quoted ETag.')
    .transform((value) => value.slice(1, -1))
    .parse(request.headers['if-match'])
}

function setEtag(reply: FastifyReply, source: ConnectorSourceDefinition): void {
  void reply.header('etag', `"${source.etag}"`)
}

function actorResponse(actor: ConnectorSourceActor): ConnectorSourceActor {
  return { ...actor, id: redactSensitiveText(actor.id) }
}

function testStatusResponse(status: ConnectorSourceTestStatus): ConnectorSourceTestStatus {
  if (status.status === 'not-tested') return status
  return {
    ...status,
    evidenceIds: status.evidenceIds.map(redactSensitiveText),
    checkedBy: actorResponse(status.checkedBy),
    summary: redactSensitiveText(status.summary),
  }
}

function sourceResponse(source: ConnectorSourceDefinition): ConnectorSourceDefinition {
  const parsed = connectorSourceDefinitionSchema.parse(source)
  const configuration =
    parsed.configuration.type === 'manifest'
      ? {
          ...parsed.configuration,
          manifestId: redactSensitiveText(parsed.configuration.manifestId),
        }
      : parsed.configuration.type === 'power-platform'
        ? {
            ...parsed.configuration,
            environmentId: redactSensitiveText(parsed.configuration.environmentId),
          }
        : parsed.configuration
  return {
    ...parsed,
    displayName: redactSensitiveText(parsed.displayName),
    configuration,
    testStatus: testStatusResponse(parsed.testStatus),
    createdBy: actorResponse(parsed.createdBy),
    updatedBy: actorResponse(parsed.updatedBy),
  }
}

function auditResponse(auditValue: ConnectorSourceAuditRecord) {
  const audit = connectorSourceAuditRecordSchema.parse(auditValue)
  return {
    id: audit.id,
    estateId: audit.estateId,
    tenantId: audit.tenantId,
    environment: audit.environment,
    sourceId: audit.sourceId,
    operation: audit.operation,
    actor: actorResponse(audit.actor),
    occurredAt: audit.occurredAt,
    before: audit.before === null ? null : sourceResponse(audit.before),
    after: audit.after === null ? null : sourceResponse(audit.after),
  }
}

function nextTimestamp(clock: () => Date, source: ConnectorSourceDefinition | null): string {
  const now = clock()
  if (Number.isNaN(now.getTime()))
    throw new Error('Connector source clock returned an invalid date.')
  if (source === null || now.toISOString() > source.updatedAt) return now.toISOString()
  return new Date(Date.parse(source.updatedAt) + 1).toISOString()
}

function mutationContext(
  key: string,
  actor: ConnectorSourceActor,
  clock: () => Date,
  source: ConnectorSourceDefinition | null,
): ConnectorSourceMutationContext {
  return {
    auditId: randomUUID(),
    idempotencyKey: key,
    actor,
    occurredAt: nextTimestamp(clock, source),
  }
}

async function requireAuthenticatedAdministrator(
  options: ConnectorSourceRoutesOptions,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (options.authConfig.mode !== 'jwt' || request.authPrincipal === undefined) {
    await reply.status(401).send({
      error: 'unauthorized',
      message: 'Connector source mutations require authenticated Microsoft Entra JWT mode.',
    })
  }
}

async function availableRepository(
  repository: ConnectorSourceRepository | undefined,
  reply: FastifyReply,
): Promise<ConnectorSourceRepository | undefined> {
  if (repository !== undefined) return repository
  await reply.status(503).send({
    error: 'persistence_unavailable',
    message: 'Connector source persistence is not configured.',
  })
  return undefined
}

async function requireWritable(
  options: ConnectorSourceRoutesOptions,
  reply: FastifyReply,
): Promise<boolean> {
  if (options.writeEnabled) return true
  await reply.status(403).send({
    error: 'read_only_mode',
    message: 'Connector source mutations are disabled by AGENT_SENTINEL_WRITE_ENABLED.',
  })
  return false
}

async function sendWriteResult(
  reply: FastifyReply,
  result: ConnectorSourceWriteResult,
  appliedStatusCode: number,
): Promise<void> {
  if (result.status === 'applied' || result.status === 'idempotent') {
    if (result.source !== null) setEtag(reply, result.source)
    await reply.status(result.status === 'idempotent' ? 200 : appliedStatusCode).send({
      replayed: result.status === 'idempotent',
      source: result.source === null ? null : sourceResponse(result.source),
      audit: auditResponse(result.audit),
    })
    return
  }
  if (result.status === 'not_found') {
    await reply.status(404).send({
      error: 'not_found',
      message: 'Connector source was not found in the authorized estate.',
    })
    return
  }
  if (result.status === 'immutable') {
    await reply.status(409).send({
      error: 'immutable_source',
      message: 'Deployment-origin connector sources are immutable and non-deletable.',
    })
    return
  }
  if (result.status !== 'conflict') {
    throw new Error('Unexpected connector source write status.')
  }
  const statusCode = result.reason === 'etag_mismatch' ? 412 : 409
  const error =
    result.reason === 'etag_mismatch'
      ? 'etag_mismatch'
      : result.reason === 'already_exists'
        ? 'source_already_exists'
        : result.reason === 'idempotency_key_reuse'
          ? 'idempotency_conflict'
          : 'audit_conflict'
  await reply.status(statusCode).send({
    error,
    message:
      result.reason === 'etag_mismatch'
        ? 'The connector source changed. Refresh its ETag and retry.'
        : result.reason === 'already_exists'
          ? 'A connector source with this ID already exists in the authorized estate.'
          : result.reason === 'idempotency_key_reuse'
            ? 'The Idempotency-Key has already been used for a different mutation.'
            : 'The generated connector source audit identity conflicts with an existing record.',
  })
}

function encodeAuditCursor(audit: ConnectorSourceAuditRecord): string {
  return Buffer.from(JSON.stringify([audit.occurredAt, audit.id]), 'utf8').toString('base64url')
}

export function registerConnectorSourceRoutes(
  app: FastifyInstance,
  options: ConnectorSourceRoutesOptions,
): void {
  const repository = options.repository
  const clock = options.clock ?? (() => new Date())
  const mutationPreHandlers = [
    (request: FastifyRequest, reply: FastifyReply): Promise<void> =>
      requireAuthenticatedAdministrator(options, request, reply),
    requireCapability(options.authConfig, 'configure'),
  ]

  app.get('/api/connector-sources', async (request, reply) => {
    const available = await availableRepository(repository, reply)
    if (available === undefined) return
    const estate = requireEstateContext(request)
    const query = pageQuerySchema.parse(request.query)
    const sources = await available.list(estate, query.limit + 1, query.cursor)
    const hasMore = sources.length > query.limit
    const page = sources.slice(0, query.limit)
    return {
      items: page.map(sourceResponse),
      page: {
        limit: query.limit,
        nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.sourceId : null,
      },
      mutationPolicy: {
        enabled: options.authConfig.mode === 'jwt' && options.writeEnabled,
        requiresAuthentication: true,
        requiredCapability: 'configure' as const,
      },
    }
  })

  app.get<{ Params: unknown }>('/api/connector-sources/:sourceId', async (request, reply) => {
    const available = await availableRepository(repository, reply)
    if (available === undefined) return
    const estate = requireEstateContext(request)
    const { sourceId } = sourceParamsSchema.parse(request.params)
    const source = await available.findById(estate, sourceId)
    if (source === null) {
      await reply.status(404).send({
        error: 'not_found',
        message: 'Connector source was not found in the authorized estate.',
      })
      return
    }
    setEtag(reply, source)
    return sourceResponse(source)
  })

  app.get<{ Params: unknown }>('/api/connector-sources/:sourceId/audit', async (request, reply) => {
    const available = await availableRepository(repository, reply)
    if (available === undefined) return
    const estate = requireEstateContext(request)
    const { sourceId } = sourceParamsSchema.parse(request.params)
    const query = auditPageQuerySchema.parse(request.query)
    const audits = await available.listAudit(estate, sourceId, query.limit + 1, query.cursor)
    const hasMore = audits.length > query.limit
    const page = audits.slice(0, query.limit)
    return {
      items: page.map(auditResponse),
      page: {
        limit: query.limit,
        nextCursor: hasMore && page.length > 0 ? encodeAuditCursor(page[page.length - 1]!) : null,
      },
    }
  })

  app.get<{ Params: unknown }>(
    '/api/connector-sources/:sourceId/connection-test-status',
    async (request, reply) => {
      const available = await availableRepository(repository, reply)
      if (available === undefined) return
      const estate = requireEstateContext(request)
      const { sourceId } = sourceParamsSchema.parse(request.params)
      const source = await available.findById(estate, sourceId)
      if (source === null) {
        await reply.status(404).send({
          error: 'not_found',
          message: 'Connector source was not found in the authorized estate.',
        })
        return
      }
      const common = {
        estateId: source.estateId,
        tenantId: source.tenantId,
        environment: source.environment,
        sourceId: source.sourceId,
        connectorType: source.connectorType,
        readOnly: true as const,
      }
      if (source.testStatus.status === 'not-tested') {
        return connectionTestStatusResponseSchema.parse({
          ...common,
          status: 'unknown',
          evidenceAvailability: 'unavailable',
          evidenceBasis: null,
          evidenceIds: [],
          checkedAt: null,
          checkedBy: null,
          summary: 'No evidence-backed connection test has been recorded.',
        })
      }
      return connectionTestStatusResponseSchema.parse({
        ...common,
        status: source.testStatus.status,
        evidenceAvailability: 'available',
        evidenceBasis: source.testStatus.evidenceBasis,
        evidenceIds: source.testStatus.evidenceIds.map(redactSensitiveText),
        checkedAt: source.testStatus.checkedAt,
        checkedBy: actorResponse(source.testStatus.checkedBy),
        summary: redactSensitiveText(source.testStatus.summary),
      })
    },
  )

  app.post<{ Body: unknown }>(
    '/api/connector-sources',
    { bodyLimit: ROUTE_BODY_LIMIT, preHandler: mutationPreHandlers },
    async (request, reply) => {
      if (!(await requireWritable(options, reply))) return
      const available = await availableRepository(repository, reply)
      if (available === undefined) return
      const estate = requireEstateContext(request)
      const principal = request.authPrincipal
      if (principal === undefined) return
      const body = createBodySchema.parse(request.body)
      noSensitiveTextSchema.parse(body)
      const key = idempotencyKey(request)
      const actor = sourceActor(principal)
      const mutation = mutationContext(key, actor, clock, null)
      const result = await available.create(
        estate,
        {
          ...body,
          estateId: estate.id,
          tenantId: estate.tenantId,
          environment: estate.environment,
          origin: 'user',
          testStatus: { status: 'not-tested' },
        },
        mutation,
      )
      await sendWriteResult(reply, result, 201)
    },
  )

  app.patch<{ Params: unknown; Body: unknown }>(
    '/api/connector-sources/:sourceId',
    { bodyLimit: ROUTE_BODY_LIMIT, preHandler: mutationPreHandlers },
    async (request, reply) => {
      if (!(await requireWritable(options, reply))) return
      const available = await availableRepository(repository, reply)
      if (available === undefined) return
      const estate = requireEstateContext(request)
      const principal = request.authPrincipal
      if (principal === undefined) return
      const { sourceId } = sourceParamsSchema.parse(request.params)
      const body = updateBodySchema.parse(request.body)
      noSensitiveTextSchema.parse(body)
      const etag = expectedEtag(request)
      const key = idempotencyKey(request)
      const actor = sourceActor(principal)
      const source = await available.findById(estate, sourceId)
      if (
        source !== null &&
        body.configuration !== undefined &&
        body.configuration.type !== source.connectorType
      ) {
        z.literal(source.connectorType).parse(body.configuration.type)
      }
      const mutation = mutationContext(key, actor, clock, source)
      const result = await available.update(estate, sourceId, etag, body, mutation)
      await sendWriteResult(reply, result, 200)
    },
  )

  app.delete<{ Params: unknown }>(
    '/api/connector-sources/:sourceId',
    { preHandler: mutationPreHandlers },
    async (request, reply) => {
      if (!(await requireWritable(options, reply))) return
      const available = await availableRepository(repository, reply)
      if (available === undefined) return
      const estate = requireEstateContext(request)
      const principal = request.authPrincipal
      if (principal === undefined) return
      const { sourceId } = sourceParamsSchema.parse(request.params)
      const etag = expectedEtag(request)
      const key = idempotencyKey(request)
      const actor = sourceActor(principal)
      const source = await available.findById(estate, sourceId)
      const mutation = mutationContext(key, actor, clock, source)
      const result = await available.delete(estate, sourceId, etag, mutation)
      await sendWriteResult(reply, result, 200)
    },
  )
}
