import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import {
  TRANSITION_RESULT,
  computeOverdue,
  governanceLifecycleActionSchema,
  governanceCaseDetailSchema,
  governanceCaseKindSchema,
  governanceCaseSchema,
  governanceCaseStatusSchema,
  governanceCaseTransitionOpSchema,
  governanceCaseTransitionSchema,
  governanceQueuePageSchema,
  governanceQueueSummarySchema,
  validTransitionsForCase,
  type GovernanceActorCapability,
  type GovernanceAuthorizationContext,
  type GovernanceCase,
  type GovernanceCaseKind,
  type GovernanceCaseListFilters,
  type GovernanceCaseRepository,
  type GovernanceCaseStatus,
  type GovernanceCaseTransition,
  type GovernanceCaseTransitionOp,
  type GovernanceLifecycleAction,
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
  promote: 'executeRemediation',
  'acknowledge-drift': 'validateFinding',
  rollback: 'executeRemediation',
  retire: 'executeRemediation',
}

const persistenceUnavailableReason =
  'Live persistence unavailable – workflow state requires a dedicated Cosmos container. Cases shown are synthetic.'
const writeDisabledReason = 'Governance mutations are disabled by AGENT_SENTINEL_WRITE_ENABLED.'
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
  expiresAt: z.iso.datetime().optional(),
  lifecycleAction: governanceLifecycleActionSchema.optional(),
  evidenceSnapshotIds: z.array(z.string().min(1)).default([]),
  idempotencyKey: z.string().trim().min(1),
})

const transitionBodySchema = z.object({
  operation: governanceCaseTransitionOpSchema,
  actorIdentity: z.string().trim().min(1).optional(),
  actorRole: z.string().trim().min(1).optional(),
  assigneeIdentity: z.string().trim().min(1).optional(),
  expiresAt: z.iso.datetime().optional(),
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
  authorizationContext: GovernanceAuthorizationContext
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

async function listMatchingCases(
  repository: GovernanceCaseRepository,
  filters: GovernanceCaseListFilters = {},
): Promise<GovernanceCase[]> {
  const pageSize = 200
  const first = await repository.listAll({ ...filters, page: 1, pageSize })
  const items = [...first.items]
  for (let page = 2; items.length < first.total; page += 1) {
    const next = await repository.listAll({ ...filters, page, pageSize })
    if (next.items.length === 0) break
    items.push(...next.items)
  }
  return items
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
      authorizationContext: {
        mode: 'jwt',
        authenticated: true,
        subject: principal.subject,
      },
      principal,
    }
  }

  if (authConfig.mode === 'disabled') {
    return {
      identity: 'anonymous',
      role: 'Anonymous',
      authorizationContext: {
        mode: 'disabled',
        authenticated: false,
        subject: 'anonymous',
      },
    }
  }

  const identity = sanitizeIdentity(body.actorIdentity ?? 'Demo operator')
  return {
    identity,
    role: body.actorRole ?? 'Demo',
    authorizationContext: {
      mode: 'mock',
      authenticated: false,
      subject: identity,
    },
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
  actor: ResolvedActor,
  capability: GovernanceActorCapability,
  idempotencyKey: string,
): GovernanceCaseTransition {
  return governanceCaseTransitionSchema.parse({
    id: randomUUID(),
    caseId: caseRecord.id,
    operation: 'create',
    fromStatus: null,
    toStatus: 'open',
    actorIdentity: actor.identity,
    actorRole: actor.role,
    actorCapability: capability,
    timestamp: caseRecord.createdAt,
    authorizationContext: actor.authorizationContext,
    source: {
      type: 'governance-workflow',
      mode: caseRecord.sourceMode,
      referenceIds: mergeIds(
        [caseRecord.id],
        caseRecord.evidenceSnapshotIds,
        caseRecord.findingId ? [caseRecord.findingId] : [],
        caseRecord.agentId ? [caseRecord.agentId] : [],
        caseRecord.policyId ? [caseRecord.policyId] : [],
      ),
    },
    ...(caseRecord.assigneeIdentity !== undefined
      ? { assignedToIdentity: caseRecord.assigneeIdentity }
      : {}),
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
    expiresAt?: string
    lifecycleAction?: GovernanceLifecycleAction
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

function buildSeedTransition(
  input: Omit<GovernanceCaseTransition, 'id' | 'authorizationContext' | 'source'>,
  sourceMode: 'mock' | 'foundry',
): GovernanceCaseTransition {
  return governanceCaseTransitionSchema.parse({
    ...input,
    id: randomUUID(),
    authorizationContext: {
      mode: 'mock',
      authenticated: false,
      subject: input.actorIdentity,
    },
    source: {
      type: 'governance-workflow',
      mode: sourceMode,
      referenceIds: mergeIds([input.caseId], input.evidenceSnapshotIds),
    },
  })
}

export function createSeededGovernanceCaseRepository(
  sourceMode: 'mock' | 'foundry',
  writeEnabled: boolean,
): InMemoryGovernanceCaseRepository {
  const createSeedTransition = (
    input: Omit<GovernanceCaseTransition, 'id' | 'authorizationContext' | 'source'>,
  ) => buildSeedTransition(input, sourceMode)
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
        lifecycleAction: 'promote',
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
        expiresAt: '2026-08-25T07:15:00.000Z',
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
        listMatchingCases(readRepository, filters),
      ])
      return buildPage(
        result.items,
        result.total,
        summaryResult,
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
      const cases = await listMatchingCases(readRepository)
      return buildSummary(cases, options.mode, persistenceAvailable, persistenceNote)
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
      if (!options.writeEnabled) {
        await reply.status(403).send({
          error: 'read_only_mode',
          message: writeDisabledReason,
        })
        return
      }

      const body = createCaseBodySchema.parse(request.body)
      const actor = resolveActor(options.authConfig, request.authPrincipal, body)
      const createdAt = new Date().toISOString()
      if (
        body.kind === 'policy-exception' &&
        (body.expiresAt === undefined || Date.parse(body.expiresAt) <= Date.parse(createdAt))
      ) {
        await reply.status(422).send({
          error: 'invalid_exception_expiry',
          message: 'A policy exception requires an expiry later than its creation time.',
        })
        return
      }
      if (
        (body.kind === 'policy-exception' || body.kind === 'lifecycle-review') &&
        body.evidenceSnapshotIds.length === 0
      ) {
        await reply.status(422).send({
          error: 'evidence_required',
          message: `${body.kind} cases require at least one evidence snapshot.`,
        })
        return
      }
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
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        ...(body.lifecycleAction !== undefined ? { lifecycleAction: body.lifecycleAction } : {}),
        evidenceSnapshotIds: body.evidenceSnapshotIds,
        sourceMode: options.mode,
        writeEnabledAtCreation: options.writeEnabled,
      })
      const firstTransition = createInitialTransition(
        caseRecord,
        actor,
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
      if (!options.writeEnabled) {
        await reply.status(403).send({
          error: 'read_only_mode',
          message: writeDisabledReason,
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

      const allowedOperations = validTransitionsForCase(found.case)
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
      if (
        found.case.kind === 'policy-exception' &&
        body.operation === 'approve' &&
        (found.case.expiresAt === undefined ||
          Date.parse(found.case.expiresAt) <= Date.parse(timestamp))
      ) {
        await reply.status(422).send({
          error: 'invalid_exception_expiry',
          message: 'A policy exception cannot be approved after its expiry.',
        })
        return
      }
      if (
        found.case.kind === 'policy-exception' &&
        body.operation === 'expire' &&
        found.case.expiresAt !== undefined &&
        Date.parse(found.case.expiresAt) > Date.parse(timestamp)
      ) {
        await reply.status(409).send({
          error: 'exception_not_expired',
          message: `The policy exception remains valid until ${found.case.expiresAt}.`,
        })
        return
      }
      if (
        found.case.kind === 'policy-exception' &&
        body.operation === 're-evaluate' &&
        (body.expiresAt === undefined ||
          Date.parse(body.expiresAt) <= Date.parse(timestamp) ||
          body.evidenceSnapshotIds.length === 0)
      ) {
        await reply.status(422).send({
          error: 're_evaluation_evidence_required',
          message:
            'Re-evaluating a policy exception requires fresh evidence and a new future expiry.',
        })
        return
      }
      const nextStatus = TRANSITION_RESULT[body.operation]
      const transitionEvidenceIds = mergeIds(
        found.case.evidenceSnapshotIds,
        body.evidenceSnapshotIds,
      )
      const assignedToIdentity =
        body.operation === 'pick-up'
          ? sanitizeIdentity(body.assigneeIdentity ?? actor.identity)
          : undefined
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
        authorizationContext: actor.authorizationContext,
        source: {
          type: 'governance-workflow',
          mode: found.case.sourceMode,
          referenceIds: mergeIds(
            [found.case.id],
            transitionEvidenceIds,
            found.case.findingId ? [found.case.findingId] : [],
            found.case.agentId ? [found.case.agentId] : [],
            found.case.policyId ? [found.case.policyId] : [],
          ),
        },
        ...(assignedToIdentity !== undefined ? { assignedToIdentity } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        evidenceSnapshotIds: transitionEvidenceIds,
        idempotencyKey: body.idempotencyKey,
      })

      const updatedCase = governanceCaseSchema.parse({
        ...found.case,
        status: nextStatus,
        lastTransitionAt: timestamp,
        evidenceSnapshotIds: transitionEvidenceIds,
        ...(body.operation === 'pick-up' ? { assigneeIdentity: assignedToIdentity } : {}),
        ...(body.operation === 'propose' ? { proposerIdentity: actor.identity } : {}),
        ...(body.operation === 're-evaluate' && body.expiresAt !== undefined
          ? { expiresAt: body.expiresAt }
          : {}),
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
      return buildDetail(applied.case, applied.transitions)
    },
  )
}
