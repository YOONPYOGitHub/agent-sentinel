import { z } from 'zod'

import {
  governanceCaseDetailSchema,
  governanceCaseKindSchema,
  governanceCaseSchema,
  governanceCaseTransitionOpSchema,
  governanceQueuePageSchema,
  governanceQueueSummarySchema,
  type GovernanceCase,
  type GovernanceCaseDetail,
  type GovernanceCaseKind,
  type GovernanceCaseStatus,
  type GovernanceCaseTransitionOp,
  type GovernanceQueuePage,
  type GovernanceQueueSummary,
} from '@agent-sentinel/domain'

import { apiFetch } from './auth-fetch'

function responseMessage(value: unknown): string | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string'
  ) {
    return value.message
  }
  return undefined
}

export interface GovernanceQueueListParams {
  status?: GovernanceCaseStatus
  kind?: GovernanceCaseKind
  assignee?: string
  search?: string
  page?: number
  pageSize?: number
}

export interface GovernanceQueueCreateBody {
  kind: GovernanceCaseKind
  title: string
  description: string
  actorIdentity?: string
  actorRole?: string
  assigneeIdentity?: string
  findingId?: string
  agentId?: string
  policyId?: string
  evidenceSnapshotIds?: string[]
  idempotencyKey: string
}

export interface GovernanceQueueTransitionBody {
  operation: GovernanceCaseTransitionOp
  actorIdentity?: string
  actorRole?: string
  reason?: string
  evidenceSnapshotIds?: string[]
  idempotencyKey: string
}

const createBodySchema = z.object({
  kind: governanceCaseKindSchema,
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  actorIdentity: z.string().trim().min(1).optional(),
  actorRole: z.string().trim().min(1).optional(),
  assigneeIdentity: z.string().trim().min(1).optional(),
  findingId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  policyId: z.string().trim().min(1).optional(),
  evidenceSnapshotIds: z.array(z.string().min(1)).optional(),
  idempotencyKey: z.string().trim().min(1),
})

const transitionBodySchema = z.object({
  operation: governanceCaseTransitionOpSchema,
  actorIdentity: z.string().trim().min(1).optional(),
  actorRole: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).optional(),
  evidenceSnapshotIds: z.array(z.string().min(1)).optional(),
  idempotencyKey: z.string().trim().min(1),
})

function buildQuery(params: GovernanceQueueListParams = {}): string {
  const query = new URLSearchParams()
  if (params.status) query.set('status', params.status)
  if (params.kind) query.set('kind', params.kind)
  if (params.assignee) query.set('assignee', params.assignee)
  if (params.search) query.set('search', params.search)
  if (params.page) query.set('page', String(params.page))
  if (params.pageSize) query.set('pageSize', String(params.pageSize))
  const encoded = query.toString()
  return encoded.length > 0 ? `?${encoded}` : ''
}

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const requestInit: RequestInit = { ...init }
  if (init?.body !== undefined) {
    const headers = new Headers(init.headers)
    headers.set('Content-Type', 'application/json')
    requestInit.headers = headers
  }

  const response = await apiFetch(path, requestInit)
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new Error(responseMessage(body) ?? `Request failed with status ${response.status}.`)
  }
  return schema.parse(body)
}

export const governanceQueueApi = {
  list(params: GovernanceQueueListParams = {}): Promise<GovernanceQueuePage> {
    return request(`/api/governance/queue${buildQuery(params)}`, governanceQueuePageSchema)
  },
  summary(): Promise<GovernanceQueueSummary> {
    return request('/api/governance/queue/summary', governanceQueueSummarySchema)
  },
  get(caseId: string): Promise<GovernanceCaseDetail> {
    return request(
      `/api/governance/queue/${encodeURIComponent(caseId)}`,
      governanceCaseDetailSchema,
    )
  },
  create(body: GovernanceQueueCreateBody): Promise<GovernanceCase> {
    return request('/api/governance/queue', governanceCaseSchema, {
      method: 'POST',
      body: JSON.stringify(createBodySchema.parse(body)),
    })
  },
  transition(caseId: string, body: GovernanceQueueTransitionBody): Promise<GovernanceCaseDetail> {
    return request(
      `/api/governance/queue/${encodeURIComponent(caseId)}/transitions`,
      governanceCaseDetailSchema,
      {
        method: 'POST',
        body: JSON.stringify(transitionBodySchema.parse(body)),
      },
    )
  },
}
