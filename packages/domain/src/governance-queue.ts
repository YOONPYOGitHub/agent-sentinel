import { z } from 'zod'

export const governanceCaseKindSchema = z.enum([
  'finding-review',
  'remediation-proposal',
  'policy-exception',
  'lifecycle-review',
])
export type GovernanceCaseKind = z.infer<typeof governanceCaseKindSchema>

export const governanceCaseStatusSchema = z.enum([
  'open',
  'in-review',
  'pending-approval',
  'approved',
  'rejected',
  'expired',
  'closed',
])
export type GovernanceCaseStatus = z.infer<typeof governanceCaseStatusSchema>

export const governanceCaseTransitionOpSchema = z.enum([
  'create',
  'pick-up',
  'propose',
  'reject-finding',
  'withdraw',
  'approve',
  'reject',
  'close',
  'reopen',
  're-evaluate',
  'expire',
  'promote',
  'acknowledge-drift',
  'rollback',
  'retire',
])
export type GovernanceCaseTransitionOp = z.infer<typeof governanceCaseTransitionOpSchema>

export const governanceActorCapabilitySchema = z.enum([
  'read',
  'validateFinding',
  'generateAdvisory',
  'proposeRemediation',
  'approveRemediation',
  'executeRemediation',
  'configure',
])
export type GovernanceActorCapability = z.infer<typeof governanceActorCapabilitySchema>

export const governanceCaseSourceModeSchema = z.enum(['mock', 'foundry'])
export type GovernanceCaseSourceMode = z.infer<typeof governanceCaseSourceModeSchema>

export const governanceLifecycleActionSchema = z.enum([
  'promote',
  'acknowledge-drift',
  'rollback',
  'retire',
])
export type GovernanceLifecycleAction = z.infer<typeof governanceLifecycleActionSchema>

export const governanceAuthorizationContextSchema = z
  .object({
    mode: z.enum(['disabled', 'mock', 'jwt']),
    authenticated: z.boolean(),
    subject: z.string().trim().min(1),
  })
  .superRefine((authorization, context) => {
    if (
      authorization.mode === 'disabled' &&
      (authorization.authenticated || authorization.subject !== 'anonymous')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Disabled authorization must be recorded as anonymous and unauthenticated.',
      })
    }
    if (authorization.mode === 'jwt' && !authorization.authenticated) {
      context.addIssue({
        code: 'custom',
        message: 'JWT authorization must be recorded as authenticated.',
      })
    }
  })
export type GovernanceAuthorizationContext = z.infer<typeof governanceAuthorizationContextSchema>

export const governanceEvidenceSourceSchema = z.object({
  type: z.literal('governance-workflow'),
  mode: governanceCaseSourceModeSchema,
  referenceIds: z.array(z.string().trim().min(1)).min(1),
})
export type GovernanceEvidenceSource = z.infer<typeof governanceEvidenceSourceSchema>

export const VALID_TRANSITIONS: Record<
  GovernanceCaseStatus,
  readonly GovernanceCaseTransitionOp[]
> = {
  open: ['pick-up', 'expire'],
  'in-review': ['propose', 'reject-finding', 'withdraw', 'expire'],
  'pending-approval': ['approve', 'reject', 'withdraw', 'expire'],
  approved: ['close', 'expire', 'promote', 'acknowledge-drift', 'rollback', 'retire'],
  rejected: ['reopen'],
  expired: ['re-evaluate'],
  closed: [],
}

export const TRANSITION_RESULT: Record<GovernanceCaseTransitionOp, GovernanceCaseStatus> = {
  create: 'open',
  'pick-up': 'in-review',
  propose: 'pending-approval',
  'reject-finding': 'rejected',
  withdraw: 'closed',
  approve: 'approved',
  reject: 'rejected',
  close: 'closed',
  reopen: 'open',
  're-evaluate': 'open',
  expire: 'expired',
  promote: 'closed',
  'acknowledge-drift': 'closed',
  rollback: 'closed',
  retire: 'closed',
}

export const CASE_SLA_MS = 7 * 24 * 60 * 60 * 1000

const countByStatusSchema = z.object({
  open: z.number().int().min(0),
  'in-review': z.number().int().min(0),
  'pending-approval': z.number().int().min(0),
  approved: z.number().int().min(0),
  rejected: z.number().int().min(0),
  expired: z.number().int().min(0),
  closed: z.number().int().min(0),
})

const countByKindSchema = z.object({
  'finding-review': z.number().int().min(0),
  'remediation-proposal': z.number().int().min(0),
  'policy-exception': z.number().int().min(0),
  'lifecycle-review': z.number().int().min(0),
})

export const governanceCaseTransitionSchema = z
  .object({
    id: z.string().min(1),
    caseId: z.string().min(1),
    operation: governanceCaseTransitionOpSchema,
    fromStatus: governanceCaseStatusSchema.nullable(),
    toStatus: governanceCaseStatusSchema,
    actorIdentity: z.string().trim().min(1),
    actorRole: z.string().trim().min(1),
    actorCapability: governanceActorCapabilitySchema,
    timestamp: z.iso.datetime(),
    authorizationContext: governanceAuthorizationContextSchema,
    source: governanceEvidenceSourceSchema,
    assignedToIdentity: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
    evidenceSnapshotIds: z.array(z.string().min(1)),
    idempotencyKey: z.string().trim().min(1),
  })
  .superRefine((transition, context) => {
    if (TRANSITION_RESULT[transition.operation] !== transition.toStatus) {
      context.addIssue({
        code: 'custom',
        message: `Operation ${transition.operation} must result in ${TRANSITION_RESULT[transition.operation]}.`,
        path: ['toStatus'],
      })
    }

    if (transition.operation === 'create') {
      if (transition.fromStatus !== null) {
        context.addIssue({
          code: 'custom',
          message: 'A create transition cannot have a prior status.',
          path: ['fromStatus'],
        })
      }
    } else if (
      transition.fromStatus === null ||
      !VALID_TRANSITIONS[transition.fromStatus].includes(transition.operation)
    ) {
      context.addIssue({
        code: 'custom',
        message: `Operation ${transition.operation} is not valid from ${String(transition.fromStatus)}.`,
        path: ['operation'],
      })
    }

    if (
      transition.assignedToIdentity !== undefined &&
      transition.operation !== 'create' &&
      transition.operation !== 'pick-up'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only case creation and pick-up may record an assignment.',
        path: ['assignedToIdentity'],
      })
    }
  })
export type GovernanceCaseTransition = z.infer<typeof governanceCaseTransitionSchema>

export const governanceCaseSchema = z
  .object({
    id: z.string().min(1),
    kind: governanceCaseKindSchema,
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    status: governanceCaseStatusSchema,
    createdByIdentity: z.string().trim().min(1),
    createdByRole: z.string().trim().min(1),
    createdAt: z.iso.datetime(),
    assigneeIdentity: z.string().trim().min(1).optional(),
    proposerIdentity: z.string().trim().min(1).optional(),
    lastTransitionAt: z.iso.datetime(),
    findingId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    policyId: z.string().min(1).optional(),
    expiresAt: z.iso.datetime().optional(),
    lifecycleAction: governanceLifecycleActionSchema.optional(),
    evidenceSnapshotIds: z.array(z.string().min(1)),
    sourceMode: governanceCaseSourceModeSchema,
    writeEnabledAtCreation: z.boolean(),
  })
  .superRefine((caseRecord, context) => {
    if (caseRecord.kind === 'policy-exception') {
      if (caseRecord.policyId === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'A policy exception must identify its policy.',
          path: ['policyId'],
        })
      }
      if (caseRecord.expiresAt === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'A policy exception must have an expiry.',
          path: ['expiresAt'],
        })
      } else if (Date.parse(caseRecord.expiresAt) <= Date.parse(caseRecord.createdAt)) {
        context.addIssue({
          code: 'custom',
          message: 'A policy exception must expire after it is created.',
          path: ['expiresAt'],
        })
      }
    }

    if (caseRecord.kind === 'lifecycle-review') {
      if (caseRecord.agentId === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'A lifecycle review must identify its agent.',
          path: ['agentId'],
        })
      }
      if (caseRecord.lifecycleAction === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'A lifecycle review must identify its lifecycle action.',
          path: ['lifecycleAction'],
        })
      }
    }
  })
export type GovernanceCase = z.infer<typeof governanceCaseSchema>

export function validTransitionsForCase(
  caseRecord: GovernanceCase,
): readonly GovernanceCaseTransitionOp[] {
  const operations = VALID_TRANSITIONS[caseRecord.status]
  if (caseRecord.status !== 'approved') {
    return operations
  }

  if (caseRecord.kind !== 'lifecycle-review') {
    const lifecycleOperations: readonly GovernanceCaseTransitionOp[] =
      governanceLifecycleActionSchema.options
    return operations.filter((operation) => !lifecycleOperations.includes(operation))
  }

  return operations.filter(
    (operation) => operation === 'expire' || operation === caseRecord.lifecycleAction,
  )
}

export const governanceCaseDetailSchema = z.object({
  case: governanceCaseSchema,
  transitions: z.array(governanceCaseTransitionSchema),
  overdueForAction: z.boolean(),
  persistenceNote: z.string().min(1).optional(),
})
export type GovernanceCaseDetail = z.infer<typeof governanceCaseDetailSchema>

export const governanceQueueSummarySchema = z.object({
  total: z.number().int().min(0),
  byStatus: countByStatusSchema,
  byKind: countByKindSchema,
  overdueCount: z.number().int().min(0),
  sourceMode: governanceCaseSourceModeSchema,
  persistenceAvailable: z.boolean(),
  persistenceNote: z.string().min(1).optional(),
})
export type GovernanceQueueSummary = z.infer<typeof governanceQueueSummarySchema>

export const governanceQueuePageSchema = z.object({
  cases: z.array(governanceCaseSchema),
  total: z.number().int().min(0),
  summary: governanceQueueSummarySchema,
})
export type GovernanceQueuePage = z.infer<typeof governanceQueuePageSchema>

export function computeOverdue(status: GovernanceCaseStatus, lastTransitionAt: string): boolean {
  if (status === 'closed') {
    return false
  }

  const lastTransitionAtMs = Date.parse(lastTransitionAt)
  if (Number.isNaN(lastTransitionAtMs)) {
    return true
  }

  return Date.now() - lastTransitionAtMs > CASE_SLA_MS
}
