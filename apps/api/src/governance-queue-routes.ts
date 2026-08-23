import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import {
  TRANSITION_RESULT,
  VALID_TRANSITIONS,
  computeOverdue,
  governanceCaseDetailSchema,
  governanceCaseKindSchema,
  governanceCaseSchema,
  governanceCaseStatusSchema,
  governanceCaseTransitionOpSchema,
  governanceCaseTransitionSchema,
  governanceQueuePageSchema,
  governanceQueueSummarySchema,
  type GovernanceActorCapability,
  type GovernanceCase,
  type GovernanceCaseKind,
  type GovernanceCaseRepository,
  type GovernanceCaseStatus,
  type GovernanceCaseTransition,
  type GovernanceCaseTransitionOp,
  type GovernanceQueuePage,
  type GovernanceQueueSummary,
} from '@agent-sentinel/domain'
import { InMemoryGovernanceCaseRepository } from '@agent-sentinel/persistence'

import { requireCapability, type AuthConfig, type AuthPrincipal } from './auth.js'

const transitionCapabilityMap: Record<GovernanceCaseTransitionOp, GovernanceActorCapability> = {
  create: 'proposeRemediation',
  'pick-up': 'validateFinding',
  propose: 'proposeRemediation',
  'reject-finding': 'validateFinding',
  withdraw: 'configure',
  approve: 'approveRemediation',
  reject: 'approveRemediation',
  close: 'executeRemediation',
  reopen: 'proposeRemediation',
  're-evaluate': 'validateFinding',
  expire: 'configure',
}

const persistenceUnavailableReason =
  'Live persistence unavailable – workflow state requires a dedicated Cosmos container. Cases shown are synthetic.'
const closeWriteDisabledNote =
  'Execution is disabled. The case can be closed with a record note; no platform changes are made.'
const listQuerySchema = z.object({
  status: governanceCaseStatusSchema.optional(),
  kind: governanceCaseKindSchema.optional(),
  assignee: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
})

const createCaseBodySchema = z.object({
  kind: governanceCaseKindSchema,
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  actorIdentity: z.string().trim().min(1).optional(),
  actorRole: z.string().trim().min(1).optional(),
  assigneeIdentity: z.string().trim().min(1).optional(),
  findingId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  policyId: z.string().trim().min(1).optional(),
  evidenceSnapshotIds: z.array(z.string().min(1)).default([]),
  idempotencyKey: z.string().trim().min(1),
})

const transitionBodySchema = z.object({
  operation: governanceCaseTransitionOpSchema,
  actorIdentity: z.string().trim().min(1).optional(),
  actorRole: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).optional(),
  evidenceSnapshotIds: z.array(z.string().min(1)).default([]),
  idempotencyKey: z.string().trim().min(1),
})

export interface GovernanceQueueRoutesOptions {
  mode: 'mock' | 'foundry'
  authConfig: AuthConfig
  writeEnabled: boolean
  repository?: GovernanceCaseRepository
}

interface ResolvedActor {
  identity: string
  role: string
  principal?: AuthPrincipal
}

interface ActorBody {
  actorIdentity?: string | undefined
  actorRole?: string | undefined
}

function sanitizeIdentity(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function mergeIds(...groups: readonly string[][]): string[] {
  return [...new Set(groups.flatMap((group) => group))]
}

function emptyStatusCounts(): GovernanceQueueSummary['byStatus'] {
  return {
    open: 0,
    'in-review': 0,
    'pending-approval': 0,
    approved: 0,
    rejected: 0,
    expired: 0,
    closed: 0,
  }
}

function emptyKindCounts(): GovernanceQueueSummary['byKind'] {
  return {
    'finding-review': 0,
    'remediation-proposal': 0,
    'policy-exception': 0,
    'lifecycle-review': 0,
  }
}

function parseFilters(request: FastifyRequest) {
  const parsed = listQuerySchema.parse(request.query)
  return {
    ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
    ...(parsed.assignee !== undefined ? { assignee: parsed.assignee } : {}),
    ...(parsed.search !== undefined ? { search: parsed.search } : {}),
    ...(parsed.page !== undefined ? { page: parsed.page } : {}),
    ...(parsed.pageSize !== undefined ? { pageSize: parsed.pageSize } : {}),
  }
}

function buildSummary(
  cases: readonly GovernanceCase[],
  sourceMode: 'mock' | 'foundry',
  persistenceAvailable: boolean,
  persistenceNote?: string,
): GovernanceQueueSummary {
  const byStatus = emptyStatusCounts()
  const byKind = emptyKindCounts()
  let overdueCount = 0

  for (const caseRecord of cases) {
    byStatus[caseRecord.status] += 1
    byKind[caseRecord.kind] += 1
    if (computeOverdue(caseRecord.status, caseRecord.lastTransitionAt)) {
      overdueCount += 1
    }
  }

  return governanceQueueSummarySchema.parse({
    total: cases.length,
    byStatus,
    byKind,
    overdueCount,
    sourceMode,
    persistenceAvailable,
    ...(persistenceNote !== undefined ? { persistenceNote } : {}),
  })
}

function buildPage(
  cases: readonly GovernanceCase[],
  total: number,
  summaryCases: readonly GovernanceCase[],
  sourceMode: 'mock' | 'foundry',
  persistenceAvailable: boolean,
  persistenceNote?: string,
): GovernanceQueuePage {
  return governanceQueuePageSchema.parse({
    cases,
    total,
    summary: buildSummary(summaryCases, sourceMode, persistenceAvailable, persistenceNote),
  })
}

function buildDetail(
  caseRecord: GovernanceCase,
  transitions: readonly GovernanceCaseTransition[],
  persistenceNote?: string,
) {
  return governanceCaseDetailSchema.parse({
    case: caseRecord,
    transitions,
    overdueForAction: computeOverdue(caseRecord.status, caseRecord.lastTransitionAt),
    ...(persistenceNote !== undefined ? { persistenceNote } : {}),
  })
}

function resolveActor(
  authConfig: AuthConfig,
  principal: AuthPrincipal | undefined,
  body: ActorBody,
): ResolvedActor {
  if (authConfig.mode === 'jwt' && principal) {
    return {
      identity: sanitizeIdentity(
        principal.preferredUsername ??
          principal.displayName ??
          principal.objectId ??
          principal.subject,
      ),
      role: principal.roles[0] ?? 'Unknown',
      principal,
    }
  }

  return {
    identity: sanitizeIdentity(body.actorIdentity ?? 'Demo operator'),
    role: body.actorRole ?? 'Demo',
  }
}

async function requireTransitionCapability(
  authConfig: AuthConfig,
  request: FastifyRequest,
  reply: FastifyReply,
  capability: GovernanceActorCapability,
): Promise<boolean> {
  if (authConfig.mode !== 'jwt') {
    return true
  }

  const principal = request.authPrincipal
  if (principal === undefined) {
    await reply.status(401).send({ error: 'unauthorized', message: 'Authentication is required.' })
    return false
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
    return false
  }

  return true
}

function createInitialTransition(
  caseRecord: GovernanceCase,
  actorIdentity: string,
  actorRole: string,
  capability: GovernanceActorCapability,
  idempotencyKey: string,
): GovernanceCaseTransition {
  return governanceCaseTransitionSchema.parse({
    id: randomUUID(),
    caseId: caseRecord.id,
    operation: 'create',
    fromStatus: null,
    toStatus: 'open',
    actorIdentity,
    actorRole,
    actorCapability: capability,
    timestamp: caseRecord.createdAt,
    reason: 'Case created.',
    evidenceSnapshotIds: caseRecord.evidenceSnapshotIds,
    idempotencyKey,
  })
}

function createSeedCase(
  input: {
    id: string
    kind: GovernanceCaseKind
    title: string
    description: string
    status: GovernanceCaseStatus
    createdByIdentity: string
    createdByRole: string
    createdAt: string
    lastTransitionAt: string
    assigneeIdentity?: string
    proposerIdentity?: string
    findingId?: string
    agentId?: string
    policyId?: string
    evidenceSnapshotIds?: string[]
  },
  sourceMode: 'mock' | 'foundry',
  writeEnabled: boolean,
): GovernanceCase {
  return governanceCaseSchema.parse({
    ...input,
    evidenceSnapshotIds: input.evidenceSnapshotIds ?? [],
    sourceMode,
    writeEnabledAtCreation: writeEnabled,
  })
}

function createSeedTransition(
  input: Omit<GovernanceCaseTransition, 'id'>,
): GovernanceCaseTransition {
  return governanceCaseTransitionSchema.parse({
    ...input,
    id: randomUUID(),
  })
}

export function createSeededGovernanceCaseRepository(
  sourceMode: 'mock' | 'foundry',
  writeEnabled: boolean,
): InMemoryGovernanceCaseRepository {
  const cases: GovernanceCase[] = [
    createSeedCase(
      {
        id: 'gq-001',
        kind: 'finding-review',
        title: '[Mock] Review uncontrolled data egress finding',
        description:
          'Validate the declared external transfer route before proposing any remediation.',
        status: 'open',
        createdByIdentity: 'Morgan Reviewer',
        createdByRole: 'Analyst',
        createdAt: '2026-08-10T09:00:00.000Z',
        lastTransitionAt: '2026-08-10T09:00:00.000Z',
        findingId: 'exposure-as-pol-001-agent-1',
        agentId: 'sales-research-agent',
        policyId: 'AS-POL-001',
        evidenceSnapshotIds: ['mock-snap-001'],
      },
      sourceMode,
      writeEnabled,
    ),
    createSeedCase(
      {
        id: 'gq-002',
        kind: 'lifecycle-review',
        title: '[Mock] Confirm HR assistant release controls',
        description:
          'Review the production release gates before the next scheduled lifecycle checkpoint.',
        status: 'in-review',
        createdByIdentity: 'Avery Planner',
        createdByRole: 'Analyst',
        createdAt: '2026-08-19T08:30:00.000Z',
        lastTransitionAt: '2026-08-20T11:00:00.000Z',
        assigneeIdentity: 'Taylor Analyst',
        agentId: 'hr-policy-agent',
        evidenceSnapshotIds: ['mock-snap-002'],
      },
      sourceMode,
      writeEnabled,
    ),
    createSeedCase(
      {
        id: 'gq-003',
        kind: 'remediation-proposal',
        title: '[Mock] Approve MCP route containment plan',
        description: 'Approve the containment proposal for the external enrichment route.',
        status: 'pending-approval',
        createdByIdentity: 'Avery Planner',
        createdByRole: 'Analyst',
        createdAt: '2026-08-20T08:00:00.000Z',
        lastTransitionAt: '2026-08-21T09:30:00.000Z',
        assigneeIdentity: 'Jordan Approver',
        proposerIdentity: 'Avery Planner',
        findingId: 'exposure-as-pol-001-agent-1',
        agentId: 'sales-research-agent',
        policyId: 'AS-POL-001',
        evidenceSnapshotIds: ['mock-snap-003'],
      },
      sourceMode,
      writeEnabled,
    ),
    createSeedCase(
      {
        id: 'gq-004',
        kind: 'policy-exception',
        title: '[Mock] Close documented exception after control update',
        description:
          'An approved exception can now be closed because the replacement control is documented.',
        status: 'approved',
        createdByIdentity: 'Jordan Approver',
        createdByRole: 'Approver',
        createdAt: '2026-08-18T07:45:00.000Z',
        lastTransitionAt: '2026-08-22T07:15:00.000Z',
        proposerIdentity: 'Casey Owner',
        policyId: 'AS-POL-002',
        evidenceSnapshotIds: ['mock-snap-004'],
      },
      sourceMode,
      writeEnabled,
    ),
    createSeedCase(
      {
        id: 'gq-005',
        kind: 'finding-review',
        title: '[Mock] Re-evaluate expired validation case',
        description: 'The queue item exceeded its SLA and requires a fresh analyst review.',
        status: 'expired',
        createdByIdentity: 'Morgan Reviewer',
        createdByRole: 'Analyst',
        createdAt: '2026-08-11T06:15:00.000Z',
        lastTransitionAt: '2026-08-12T10:00:00.000Z',
        assigneeIdentity: 'Taylor Analyst',
        findingId: 'exposure-as-pol-002-agent-2',
        agentId: 'hr-policy-agent',
        policyId: 'AS-POL-002',
        evidenceSnapshotIds: ['mock-snap-005'],
      },
      sourceMode,
      writeEnabled,
    ),
  ]

  const transitions: GovernanceCaseTransition[] = [
    createSeedTransition({
      caseId: 'gq-001',
      operation: 'create',
      fromStatus: null,
      toStatus: 'open',
      actorIdentity: 'Morgan Reviewer',
      actorRole: 'Analyst',
      actorCapability: 'proposeRemediation',
      timestamp: '2026-08-10T09:00:00.000Z',
      reason: 'Case created in the governance queue.',
      evidenceSnapshotIds: ['mock-snap-001'],
      idempotencyKey: 'seed-gq-001-create',
    }),
    createSeedTransition({
      caseId: 'gq-002',
      operation: 'create',
      fromStatus: null,
      toStatus: 'open',
      actorIdentity: 'Avery Planner',
      actorRole: 'Analyst',
      actorCapability: 'proposeRemediation',
      timestamp: '2026-08-19T08:30:00.000Z',
      reason: 'Case created in the governance queue.',
      evidenceSnapshotIds: ['mock-snap-002'],
      idempotencyKey: 'seed-gq-002-create',
    }),
    createSeedTransition({
      caseId: 'gq-002',
      operation: 'pick-up',
      fromStatus: 'open',
      toStatus: 'in-review',
      actorIdentity: 'Taylor Analyst',
      actorRole: 'Analyst',
      actorCapability: 'validateFinding',
      timestamp: '2026-08-20T11:00:00.000Z',
      reason: 'Assigned for lifecycle evidence review.',
      evidenceSnapshotIds: ['mock-snap-002'],
      idempotencyKey: 'seed-gq-002-pick-up',
    }),
    createSeedTransition({
      caseId: 'gq-003',
      operation: 'create',
      fromStatus: null,
      toStatus: 'open',
      actorIdentity: 'Avery Planner',
      actorRole: 'Analyst',
      actorCapability: 'proposeRemediation',
      timestamp: '2026-08-20T08:00:00.000Z',
      reason: 'Case created in the governance queue.',
      evidenceSnapshotIds: ['mock-snap-003'],
      idempotencyKey: 'seed-gq-003-create',
    }),
    createSeedTransition({
      caseId: 'gq-003',
      operation: 'pick-up',
      fromStatus: 'open',
      toStatus: 'in-review',
      actorIdentity: 'Taylor Analyst',
      actorRole: 'Analyst',
      actorCapability: 'validateFinding',
      timestamp: '2026-08-20T13:00:00.000Z',
      reason: 'Analyst review started.',
      evidenceSnapshotIds: ['mock-snap-003'],
      idempotencyKey: 'seed-gq-003-pick-up',
    }),
    createSeedTransition({
      caseId: 'gq-003',
      operation: 'propose',
      fromStatus: 'in-review',
      toStatus: 'pending-approval',
      actorIdentity: 'Avery Planner',
      actorRole: 'Analyst',
      actorCapability: 'proposeRemediation',
      timestamp: '2026-08-21T09:30:00.000Z',
      reason: 'Containment plan submitted for approval.',
      evidenceSnapshotIds: ['mock-snap-003'],
      idempotencyKey: 'seed-gq-003-propose',
    }),
    createSeedTransition({
      caseId: 'gq-004',
      operation: 'create',
      fromStatus: null,
      toStatus: 'open',
      actorIdentity: 'Jordan Approver',
      actorRole: 'Approver',
      actorCapability: 'approveRemediation',
      timestamp: '2026-08-18T07:45:00.000Z',
      reason: 'Case created in the governance queue.',
      evidenceSnapshotIds: ['mock-snap-004'],
      idempotencyKey: 'seed-gq-004-create',
    }),
    createSeedTransition({
      caseId: 'gq-004',
      operation: 'pick-up',
      fromStatus: 'open',
      toStatus: 'in-review',
      actorIdentity: 'Casey Owner',
      actorRole: 'Analyst',
      actorCapability: 'validateFinding',
      timestamp: '2026-08-18T09:00:00.000Z',
      reason: 'Exception review started.',
      evidenceSnapshotIds: ['mock-snap-004'],
      idempotencyKey: 'seed-gq-004-pick-up',
    }),
    createSeedTransition({
      caseId: 'gq-004',
      operation: 'propose',
      fromStatus: 'in-review',
      toStatus: 'pending-approval',
      actorIdentity: 'Casey Owner',
      actorRole: 'Analyst',
      actorCapability: 'proposeRemediation',
      timestamp: '2026-08-19T10:15:00.000Z',
      reason: 'Exception documentation submitted.',
      evidenceSnapshotIds: ['mock-snap-004'],
      idempotencyKey: 'seed-gq-004-propose',
    }),
    createSeedTransition({
      caseId: 'gq-004',
      operation: 'approve',
      fromStatus: 'pending-approval',
      toStatus: 'approved',
      actorIdentity: 'Jordan Approver',
      actorRole: 'Approver',
      actorCapability: 'approveRemediation',
      timestamp: '2026-08-22T07:15:00.000Z',
      reason: 'Replacement control evidence accepted.',
      evidenceSnapshotIds: ['mock-snap-004'],
      idempotencyKey: 'seed-gq-004-approve',
    }),
    createSeedTransition({
      caseId: 'gq-005',
      operation: 'create',
      fromStatus: null,
      toStatus: 'open',
      actorIdentity: 'Morgan Reviewer',
      actorRole: 'Analyst',
      actorCapability: 'proposeRemediation',
      timestamp: '2026-08-11T06:15:00.000Z',
      reason: 'Case created in the governance queue.',
      evidenceSnapshotIds: ['mock-snap-005'],
      idempotencyKey: 'seed-gq-005-create',
    }),
    createSeedTransition({
      caseId: 'gq-005',
      operation: 'pick-up',
      fromStatus: 'open',
      toStatus: 'in-review',
      actorIdentity: 'Taylor Analyst',
      actorRole: 'Analyst',
      actorCapability: 'validateFinding',
      timestamp: '2026-08-11T08:00:00.000Z',
      reason: 'Analyst review started.',
      evidenceSnapshotIds: ['mock-snap-005'],
      idempotencyKey: 'seed-gq-005-pick-up',
    }),
    createSeedTransition({
      caseId: 'gq-005',
      operation: 'expire',
      fromStatus: 'in-review',
      toStatus: 'expired',
      actorIdentity: 'Morgan Reviewer',
      actorRole: 'Analyst',
      actorCapability: 'validateFinding',
      timestamp: '2026-08-12T10:00:00.000Z',
      reason: 'Case aged out without evidence refresh and is marked expired.',
      evidenceSnapshotIds: ['mock-snap-005'],
      idempotencyKey: 'seed-gq-005-expired',
    }),
  ]

  return InMemoryGovernanceCaseRepository.seed(cases, transitions)
}

export function registerGovernanceQueueRoutes(
  app: FastifyInstance,
  options: GovernanceQueueRoutesOptions,
): void {
  const readRepository =
    options.repository ?? createSeededGovernanceCaseRepository(options.mode, options.writeEnabled)
  const writableRepository = options.repository
  const persistenceAvailable = writableRepository !== undefined || options.mode === 'mock'
  const persistenceNote = persistenceAvailable ? undefined : persistenceUnavailableReason

  app.get(
    '/api/governance/queue',
    { preHandler: requireCapability(options.authConfig, 'read') },
    async (request) => {
      const filters = parseFilters(request)
      const [result, summaryResult] = await Promise.all([
        readRepository.listAll(filters),
        readRepository.listAll({
          ...filters,
          page: 1,
          pageSize: Number.MAX_SAFE_INTEGER,
        }),
      ])
      return buildPage(
        result.items,
        result.total,
        summaryResult.items,
        options.mode,
        persistenceAvailable,
        persistenceNote,
      )
    },
  )

  app.get(
    '/api/governance/queue/summary',
    { preHandler: requireCapability(options.authConfig, 'read') },
    async () => {
      const result = await readRepository.listAll({ page: 1, pageSize: Number.MAX_SAFE_INTEGER })
      return buildSummary(result.items, options.mode, persistenceAvailable, persistenceNote)
    },
  )

  app.get<{ Params: { caseId: string } }>(
    '/api/governance/queue/:caseId',
    { preHandler: requireCapability(options.authConfig, 'read') },
    async (request, reply) => {
      const found = await readRepository.findById(request.params.caseId)
      if (!found) {
        await reply.status(404).send({
          error: 'not_found',
          message: `Governance case not found: ${request.params.caseId}`,
        })
        return
      }
      return buildDetail(found.case, found.transitions, persistenceNote)
    },
  )

  app.post<{ Body: unknown }>(
    '/api/governance/queue',
    { preHandler: requireCapability(options.authConfig, 'proposeRemediation') },
    async (request, reply) => {
      if (!persistenceAvailable) {
        await reply.status(503).send({
          error: 'persistence_unavailable',
          message: persistenceUnavailableReason,
        })
        return
      }

      if (writableRepository === undefined) {
        await reply.status(503).send({
          error: 'persistence_unavailable',
          message: persistenceUnavailableReason,
        })
        return
      }

      const body = createCaseBodySchema.parse(request.body)
      const actor = resolveActor(options.authConfig, request.authPrincipal, body)
      const createdAt = new Date().toISOString()
      const caseRecord = governanceCaseSchema.parse({
        id: randomUUID(),
        kind: body.kind,
        title: body.title,
        description: body.description,
        status: 'open',
        createdByIdentity: actor.identity,
        createdByRole: actor.role,
        createdAt,
        ...(body.assigneeIdentity !== undefined
          ? { assigneeIdentity: sanitizeIdentity(body.assigneeIdentity) }
          : {}),
        lastTransitionAt: createdAt,
        ...(body.findingId !== undefined ? { findingId: body.findingId } : {}),
        ...(body.agentId !== undefined ? { agentId: body.agentId } : {}),
        ...(body.policyId !== undefined ? { policyId: body.policyId } : {}),
        evidenceSnapshotIds: body.evidenceSnapshotIds,
        sourceMode: options.mode,
        writeEnabledAtCreation: options.writeEnabled,
      })
      const firstTransition = createInitialTransition(
        caseRecord,
        actor.identity,
        actor.role,
        'proposeRemediation',
        body.idempotencyKey,
      )
      const created = await writableRepository.create(caseRecord, firstTransition)
      return created.case
    },
  )

  app.post<{ Params: { caseId: string }; Body: unknown }>(
    '/api/governance/queue/:caseId/transitions',
    { preHandler: requireCapability(options.authConfig, 'proposeRemediation') },
    async (request, reply) => {
      if (!persistenceAvailable) {
        await reply.status(503).send({
          error: 'persistence_unavailable',
          message: persistenceUnavailableReason,
        })
        return
      }

      if (writableRepository === undefined) {
        await reply.status(503).send({
          error: 'persistence_unavailable',
          message: persistenceUnavailableReason,
        })
        return
      }

      const body = transitionBodySchema.parse(request.body)
      const found = await writableRepository.findById(request.params.caseId)
      if (!found) {
        await reply.status(404).send({
          error: 'not_found',
          message: `Governance case not found: ${request.params.caseId}`,
        })
        return
      }

      if (
        found.transitions.some((transition) => transition.idempotencyKey === body.idempotencyKey)
      ) {
        await reply.status(409).send({
          error: 'idempotency_conflict',
          message: 'The supplied idempotency key has already been used for this case.',
        })
        return
      }

      const allowedOperations = VALID_TRANSITIONS[found.case.status]
      if (!allowedOperations.includes(body.operation)) {
        await reply.status(409).send({
          error: 'invalid_transition',
          message: `Operation ${body.operation} is not allowed from ${found.case.status}.`,
        })
        return
      }

      const requiredCapability = transitionCapabilityMap[body.operation]
      if (
        !(await requireTransitionCapability(options.authConfig, request, reply, requiredCapability))
      ) {
        return
      }

      const actor = resolveActor(options.authConfig, request.authPrincipal, body)
      if (
        body.operation === 'approve' &&
        found.case.proposerIdentity !== undefined &&
        actor.identity === found.case.proposerIdentity
      ) {
        await reply.status(422).send({
          error: 'self_approval_prevented',
          message: 'The proposer cannot approve their own governance case.',
        })
        return
      }

      const timestamp = new Date().toISOString()
      const nextStatus = TRANSITION_RESULT[body.operation]
      const transitionReason =
        body.operation === 'close' && options.writeEnabled === false
          ? body.reason === undefined
            ? closeWriteDisabledNote
            : `${body.reason} ${closeWriteDisabledNote}`
          : body.reason
      const transition = governanceCaseTransitionSchema.parse({
        id: randomUUID(),
        caseId: found.case.id,
        operation: body.operation,
        fromStatus: found.case.status,
        toStatus: nextStatus,
        actorIdentity: actor.identity,
        actorRole: actor.role,
        actorCapability: requiredCapability,
        timestamp,
        ...(transitionReason !== undefined ? { reason: transitionReason } : {}),
        evidenceSnapshotIds: body.evidenceSnapshotIds,
        idempotencyKey: body.idempotencyKey,
      })

      const updatedCase = governanceCaseSchema.parse({
        ...found.case,
        status: nextStatus,
        lastTransitionAt: timestamp,
        evidenceSnapshotIds: mergeIds(found.case.evidenceSnapshotIds, body.evidenceSnapshotIds),
        ...(body.operation === 'pick-up' ? { assigneeIdentity: actor.identity } : {}),
        ...(body.operation === 'propose' ? { proposerIdentity: actor.identity } : {}),
        ...(body.operation === 'reopen' || body.operation === 're-evaluate'
          ? { assigneeIdentity: undefined }
          : {}),
      })

      const applied = await writableRepository.applyTransition(
        found.case.id,
        found.case.status,
        updatedCase,
        transition,
      )
      if (!applied.applied) {
        const statusCode = applied.reason === 'not_found' ? 404 : 409
        await reply.status(statusCode).send({
          error: applied.reason,
          message:
            applied.reason === 'idempotency_conflict'
              ? 'The supplied idempotency key has already been used for this case.'
              : applied.reason === 'state_conflict'
                ? 'The case changed before this transition could be applied. Refresh and retry.'
                : `Governance case not found: ${request.params.caseId}`,
        })
        return
      }
      return buildDetail(
        applied.case,
        applied.transitions,
        body.operation === 'close' && options.writeEnabled === false
          ? closeWriteDisabledNote
          : undefined,
      )
    },
  )
}
