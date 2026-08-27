import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CosmosClient } from '@azure/cosmos'

const jose = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => ({ mocked: 'jwks' })),
  jwtVerify: vi.fn(),
}))

vi.mock('jose', () => jose)

import type {
  ExposureFindingRepository,
  GovernanceCase,
  GovernanceCaseDetail,
  GovernanceQueuePage,
  GovernanceQueueSummary,
  SnapshotRepository,
} from '@agent-sentinel/domain'
import {
  governanceCaseSchema,
  governanceCaseDetailSchema,
  governanceQueuePageSchema,
  governanceQueueSummarySchema,
} from '@agent-sentinel/domain'
import { CosmosGovernanceCaseRepository } from '@agent-sentinel/persistence'

import { buildLiveRepositories, createApp } from '../src/app.js'
import type { AuthConfig } from '../src/auth.js'
import { createSeededGovernanceCaseRepository } from '../src/governance-queue-routes.js'

const apps: Awaited<ReturnType<typeof createApp>>[] = []

const viewerJwtConfig: AuthConfig = {
  mode: 'jwt',
  tenantId: 'tenant-id',
  audience: 'api://agent-sentinel',
  issuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
  jwksUri: 'https://login.microsoftonline.com/tenant-id/discovery/v2.0/keys',
  allowedScopes: { read: ['AgentSentinel.Read'], write: ['AgentSentinel.Write'] },
  spaConfig: {
    tenantId: 'tenant-id',
    clientId: 'spa-client-id',
    authority: 'https://login.microsoftonline.com/tenant-id',
    scopes: ['api://agent-sentinel/AgentSentinel.Read'],
    redirectUri: 'https://sentinel.example/auth/callback',
    postLogoutRedirectUri: 'https://sentinel.example/',
  },
}

const mockAuthConfig: AuthConfig = { mode: 'mock' }

function liveExposureRepository(): ExposureFindingRepository {
  return {
    upsert: vi.fn(),
    findById: vi.fn().mockResolvedValue(null),
    listByTenant: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getFacets: vi.fn().mockResolvedValue({ severity: {}, status: {}, policyId: {} }),
    resolveAbsent: vi.fn().mockResolvedValue([]),
  }
}

function liveSnapshotRepository(): SnapshotRepository {
  return {
    save: vi.fn(),
    findLatest: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
  }
}

beforeEach(() => {
  process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
  delete process.env['AGENT_SENTINEL_DATA_MODE']
  delete process.env['AGENT_SENTINEL_WRITE_ENABLED']
  delete process.env['AGENT_SENTINEL_TENANT_ID']
  delete process.env['COSMOS_GOVERNANCE_CONTAINER']
  jose.createRemoteJWKSet.mockClear()
  jose.jwtVerify.mockReset()
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(apps.splice(0).map(async (app) => app.close()))
  delete process.env['AGENT_SENTINEL_CONNECTOR']
  delete process.env['AGENT_SENTINEL_DATA_MODE']
  delete process.env['AGENT_SENTINEL_WRITE_ENABLED']
  delete process.env['AGENT_SENTINEL_TENANT_ID']
  delete process.env['COSMOS_GOVERNANCE_CONTAINER']
})

describe('governance queue API', () => {
  it('lists deterministic mock fixtures', async () => {
    const app = await createApp(undefined, {
      mode: 'disabled',
      allowedScopes: { read: [], write: [] },
    })
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/governance/queue' })

    expect(response.statusCode).toBe(200)
    const page = governanceQueuePageSchema.parse(response.json())
    expect(page.total).toBe(5)
    expect(page.cases.map((caseRecord) => caseRecord.id)).toContain('gq-001')
    expect(page.cases.some((caseRecord) => caseRecord.title.includes('[Mock]'))).toBe(true)
    expect(page.summary.persistenceAvailable).toBe(true)
  })

  it('keeps filtered totals and summary counts correct when the result is paged', async () => {
    const app = await createApp(undefined, {
      mode: 'disabled',
      allowedScopes: { read: [], write: [] },
    })
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/api/governance/queue?page=1&pageSize=2',
    })

    expect(response.statusCode).toBe(200)
    const page = governanceQueuePageSchema.parse(response.json())
    expect(page.cases).toHaveLength(2)
    expect(page.total).toBe(5)
    expect(page.summary.total).toBe(5)
    expect(Object.values(page.summary.byStatus).reduce((sum, count) => sum + count, 0)).toBe(5)
  })

  it('returns summary counts for the seeded queue', async () => {
    const app = await createApp(undefined, {
      mode: 'disabled',
      allowedScopes: { read: [], write: [] },
    })
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/governance/queue/summary' })

    expect(response.statusCode).toBe(200)
    const summary: GovernanceQueueSummary = governanceQueueSummarySchema.parse(response.json())
    expect(summary.total).toBe(5)
    expect(summary.byStatus).toMatchObject({
      open: 1,
      'in-review': 1,
      'pending-approval': 1,
      approved: 1,
      expired: 1,
      rejected: 0,
      closed: 0,
    })
    expect(summary.byKind).toMatchObject({
      'finding-review': 2,
      'lifecycle-review': 1,
      'remediation-proposal': 1,
      'policy-exception': 1,
    })
    expect(summary.overdueCount).toBeGreaterThanOrEqual(2)
  })

  it('supports the full deterministic lifecycle', async () => {
    const app = await createApp(undefined, mockAuthConfig)

    apps.push(app)

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/governance/queue',
      payload: {
        kind: 'remediation-proposal',
        title: 'New containment review',
        description: 'Create a queue item for the new containment plan.',
        actorIdentity: 'Pat Analyst',
        actorRole: 'Analyst',
        findingId: 'finding-new',
        evidenceSnapshotIds: ['snap-new'],
        idempotencyKey: 'create-case-1',
      },
    })
    expect(createResponse.statusCode).toBe(200)
    const created: GovernanceCase = governanceCaseSchema.parse(createResponse.json())
    expect(created.status).toBe('open')

    const pickUp = await app.inject({
      method: 'POST',
      url: `/api/governance/queue/${created.id}/transitions`,
      payload: {
        operation: 'pick-up',
        actorIdentity: 'Pat Analyst',
        actorRole: 'Analyst',
        idempotencyKey: 'pick-up-1',
      },
    })
    expect(governanceCaseDetailSchema.parse(pickUp.json()).case.status).toBe('in-review')

    const propose = await app.inject({
      method: 'POST',
      url: `/api/governance/queue/${created.id}/transitions`,
      payload: {
        operation: 'propose',
        actorIdentity: 'Pat Analyst',
        actorRole: 'Analyst',
        idempotencyKey: 'propose-1',
      },
    })
    const proposed: GovernanceCaseDetail = governanceCaseDetailSchema.parse(propose.json())
    expect(proposed.case.status).toBe('pending-approval')
    expect(proposed.case.proposerIdentity).toBe('Pat Analyst')

    const approve = await app.inject({
      method: 'POST',
      url: `/api/governance/queue/${created.id}/transitions`,
      payload: {
        operation: 'approve',
        actorIdentity: 'Riley Approver',
        actorRole: 'Approver',
        idempotencyKey: 'approve-1',
      },
    })
    expect(governanceCaseDetailSchema.parse(approve.json()).case.status).toBe('approved')

    const close = await app.inject({
      method: 'POST',
      url: `/api/governance/queue/${created.id}/transitions`,
      payload: {
        operation: 'close',
        actorIdentity: 'Sam Admin',
        actorRole: 'Administrator',
        idempotencyKey: 'close-1',
      },
    })
    const closed: GovernanceCaseDetail = governanceCaseDetailSchema.parse(close.json())
    expect(closed.case.status).toBe('closed')
    expect(closed.transitions.map((transition) => transition.operation)).toEqual([
      'create',
      'pick-up',
      'propose',
      'approve',
      'close',
    ])
  })

  it('returns the original case when a create request reuses its idempotency key', async () => {
    const app = await createApp(undefined, {
      mode: 'disabled',
      allowedScopes: { read: [], write: [] },
    })
    apps.push(app)

    const payload = {
      kind: 'finding-review',
      title: 'Retry-safe case creation',
      description: 'The same request may be retried without creating another case.',
      actorIdentity: 'Pat Analyst',
      actorRole: 'Analyst',
      idempotencyKey: 'create-retry-key',
    }
    const first = await app.inject({
      method: 'POST',
      url: '/api/governance/queue',
      payload,
    })
    const retry = await app.inject({
      method: 'POST',
      url: '/api/governance/queue',
      payload,
    })

    const firstCase = governanceCaseSchema.parse(first.json())
    const retriedCase = governanceCaseSchema.parse(retry.json())
    expect(retriedCase.id).toBe(firstCase.id)

    const list = governanceQueuePageSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/governance/queue?search=Retry-safe%20case%20creation',
        })
      ).json(),
    )
    expect(list.total).toBe(1)
  })

  it('rejects invalid transitions with a 409', async () => {
    const app = await createApp(undefined, {
      mode: 'disabled',
      allowedScopes: { read: [], write: [] },
    })
    apps.push(app)

    const response = await app.inject({
      method: 'POST',
      url: '/api/governance/queue/gq-001/transitions',
      payload: {
        operation: 'reject',
        actorIdentity: 'Jordan Approver',
        actorRole: 'Approver',
        idempotencyKey: 'invalid-transition',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'invalid_transition' })
  })

  it('prevents self approval on pending cases', async () => {
    const app = await createApp(undefined, mockAuthConfig)
    apps.push(app)

    const response = await app.inject({
      method: 'POST',
      url: '/api/governance/queue/gq-003/transitions',
      payload: {
        operation: 'approve',
        actorIdentity: 'Avery Planner',
        actorRole: 'Approver',
        idempotencyKey: 'self-approve',
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ error: 'self_approval_prevented' })
  })

  it('rejects reused idempotency keys for a case', async () => {
    const app = await createApp(undefined, {
      mode: 'disabled',
      allowedScopes: { read: [], write: [] },
    })
    apps.push(app)

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/governance/queue',
      payload: {
        kind: 'finding-review',
        title: 'Idempotency check case',
        description: 'Exercise idempotency validation.',
        actorIdentity: 'Pat Analyst',
        actorRole: 'Analyst',
        idempotencyKey: 'create-idempotency-case',
      },
    })
    const created: GovernanceCase = governanceCaseSchema.parse(createResponse.json())

    const first = await app.inject({
      method: 'POST',
      url: `/api/governance/queue/${created.id}/transitions`,
      payload: {
        operation: 'pick-up',
        actorIdentity: 'Pat Analyst',
        actorRole: 'Analyst',
        idempotencyKey: 'duplicate-key',
      },
    })
    expect(first.statusCode).toBe(200)

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/governance/queue/${created.id}/transitions`,
      payload: {
        operation: 'propose',
        actorIdentity: 'Pat Analyst',
        actorRole: 'Analyst',
        idempotencyKey: 'duplicate-key',
      },
    })

    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json()).toMatchObject({ error: 'idempotency_conflict' })
  })

  it('atomically rejects concurrent transitions that reuse an idempotency key', async () => {
    const app = await createApp(undefined, {
      mode: 'disabled',
      allowedScopes: { read: [], write: [] },
    })
    apps.push(app)

    const requests = [
      app.inject({
        method: 'POST',
        url: '/api/governance/queue/gq-001/transitions',
        payload: {
          operation: 'pick-up',
          actorIdentity: 'Pat Analyst',
          actorRole: 'Analyst',
          idempotencyKey: 'concurrent-key',
        },
      }),
      app.inject({
        method: 'POST',
        url: '/api/governance/queue/gq-001/transitions',
        payload: {
          operation: 'pick-up',
          actorIdentity: 'Pat Analyst',
          actorRole: 'Analyst',
          idempotencyKey: 'concurrent-key',
        },
      }),
    ]
    const responses = await Promise.all(requests)

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409])
    expect(responses.find((response) => response.statusCode === 409)?.json()).toMatchObject({
      error: 'idempotency_conflict',
    })
  })

  it('enforces transition capabilities in jwt mode', async () => {
    jose.jwtVerify.mockResolvedValue({
      payload: { sub: 'viewer-sub', tid: 'tenant-id', scp: 'AgentSentinel.Read' },
    })
    const app = await createApp(undefined, viewerJwtConfig)
    apps.push(app)

    const response = await app.inject({
      method: 'POST',
      url: '/api/governance/queue/gq-003/transitions',
      headers: { authorization: 'Bearer viewer-token' },
      payload: {
        operation: 'approve',
        idempotencyKey: 'viewer-cannot-approve',
      },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: 'forbidden' })
  })

  it('re-evaluates expired cases back to open', async () => {
    const app = await createApp(undefined, {
      mode: 'disabled',
      allowedScopes: { read: [], write: [] },
    })
    apps.push(app)

    const response = await app.inject({
      method: 'POST',
      url: '/api/governance/queue/gq-005/transitions',
      payload: {
        operation: 're-evaluate',
        actorIdentity: 'Taylor Analyst',
        actorRole: 'Analyst',
        idempotencyKey: 're-evaluate-expired',
      },
    })

    expect(response.statusCode).toBe(200)
    const detail: GovernanceCaseDetail = governanceCaseDetailSchema.parse(response.json())
    expect(detail.case.status).toBe('open')
    expect(detail.transitions.map((transition) => transition.operation)).toEqual([
      'create',
      'pick-up',
      'expire',
      're-evaluate',
    ])
    expect(detail.transitions.at(-2)).toMatchObject({
      operation: 'expire',
      fromStatus: 'in-review',
      toStatus: 'expired',
    })
  })

  it('records an anonymous authorization context and cited source when auth is disabled', async () => {
    const app = await createApp(undefined, {
      mode: 'disabled',
      allowedScopes: { read: [], write: [] },
    })
    apps.push(app)

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/governance/queue',
      payload: {
        kind: 'finding-review',
        title: 'Anonymous authorization evidence',
        description: 'Client-supplied identities are ignored when authentication is disabled.',
        actorIdentity: 'Spoofed Operator',
        findingId: 'finding-anonymous',
        evidenceSnapshotIds: ['snapshot-anonymous'],
        idempotencyKey: 'anonymous-create',
      },
    })
    const created = governanceCaseSchema.parse(createResponse.json())
    expect(created.createdByIdentity).toBe('anonymous')

    const detail = governanceCaseDetailSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/governance/queue/${created.id}`,
        })
      ).json(),
    )
    expect(detail.transitions[0]).toMatchObject({
      actorIdentity: 'anonymous',
      authorizationContext: {
        mode: 'disabled',
        authenticated: false,
        subject: 'anonymous',
      },
      source: {
        type: 'governance-workflow',
        mode: 'mock',
      },
    })
    expect(detail.transitions[0]?.source.referenceIds).toEqual(
      expect.arrayContaining([created.id, 'finding-anonymous', 'snapshot-anonymous']),
    )
  })

  it('records explicit assignment on pick-up', async () => {
    const app = await createApp(undefined, mockAuthConfig)
    apps.push(app)

    const response = await app.inject({
      method: 'POST',
      url: '/api/governance/queue/gq-001/transitions',
      payload: {
        operation: 'pick-up',
        actorIdentity: 'Morgan Coordinator',
        actorRole: 'Analyst',
        assigneeIdentity: 'Dana Reviewer',
        evidenceSnapshotIds: ['assignment-snapshot'],
        idempotencyKey: 'assign-dana',
      },
    })
    const detail = governanceCaseDetailSchema.parse(response.json())
    expect(detail.case.assigneeIdentity).toBe('Dana Reviewer')
    expect(detail.transitions.at(-1)).toMatchObject({
      operation: 'pick-up',
      actorIdentity: 'Morgan Coordinator',
      assignedToIdentity: 'Dana Reviewer',
    })
  })

  it('supports policy exception approval, expiry, and evidence-backed re-evaluation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-26T01:00:00.000Z'))
    const app = await createApp(undefined, mockAuthConfig)
    apps.push(app)

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/governance/queue',
      payload: {
        kind: 'policy-exception',
        title: 'Temporary AS-POL-001 exception',
        description: 'Time-bounded exception with compensating-control evidence.',
        actorIdentity: 'Casey Owner',
        actorRole: 'Analyst',
        policyId: 'AS-POL-001',
        expiresAt: '2026-08-27T01:00:00.000Z',
        evidenceSnapshotIds: ['exception-request-evidence'],
        idempotencyKey: 'exception-request',
      },
    })
    const created = governanceCaseSchema.parse(createResponse.json())

    for (const [operation, actorIdentity, key] of [
      ['pick-up', 'Taylor Analyst', 'exception-pick-up'],
      ['propose', 'Casey Owner', 'exception-propose'],
      ['approve', 'Jordan Approver', 'exception-approve'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/governance/queue/${created.id}/transitions`,
        payload: {
          operation,
          actorIdentity,
          actorRole: operation === 'approve' ? 'Approver' : 'Analyst',
          idempotencyKey: key,
        },
      })
      expect(response.statusCode).toBe(200)
    }

    const earlyExpiry = await app.inject({
      method: 'POST',
      url: `/api/governance/queue/${created.id}/transitions`,
      payload: {
        operation: 'expire',
        actorIdentity: 'Governance Scheduler',
        actorRole: 'Administrator',
        idempotencyKey: 'exception-expire-early',
      },
    })
    expect(earlyExpiry.statusCode).toBe(409)
    expect(earlyExpiry.json()).toMatchObject({ error: 'exception_not_expired' })

    vi.setSystemTime(new Date('2026-08-27T02:00:00.000Z'))
    const expired = await app.inject({
      method: 'POST',
      url: `/api/governance/queue/${created.id}/transitions`,
      payload: {
        operation: 'expire',
        actorIdentity: 'Governance Scheduler',
        actorRole: 'Administrator',
        idempotencyKey: 'exception-expire',
      },
    })
    expect(governanceCaseDetailSchema.parse(expired.json()).case.status).toBe('expired')

    const reEvaluated = await app.inject({
      method: 'POST',
      url: `/api/governance/queue/${created.id}/transitions`,
      payload: {
        operation: 're-evaluate',
        actorIdentity: 'Taylor Analyst',
        actorRole: 'Analyst',
        expiresAt: '2026-09-03T02:00:00.000Z',
        evidenceSnapshotIds: ['exception-re-evaluation-evidence'],
        idempotencyKey: 'exception-re-evaluate',
      },
    })
    const detail = governanceCaseDetailSchema.parse(reEvaluated.json())
    expect(detail.case).toMatchObject({
      status: 'open',
      expiresAt: '2026-09-03T02:00:00.000Z',
    })
    expect(detail.transitions.map((transition) => transition.operation)).toEqual([
      'create',
      'pick-up',
      'propose',
      'approve',
      'expire',
      're-evaluate',
    ])
    expect(
      detail.transitions.every(
        (transition) =>
          transition.actorIdentity.length > 0 &&
          transition.timestamp.length > 0 &&
          transition.source.referenceIds.length > 0,
      ),
    ).toBe(true)
    vi.useRealTimers()
  })

  it('supports rejection and records an approved lifecycle action as evidence', async () => {
    const app = await createApp(undefined, mockAuthConfig)
    apps.push(app)

    const exception = governanceCaseSchema.parse(
      (
        await app.inject({
          method: 'POST',
          url: '/api/governance/queue',
          payload: {
            kind: 'policy-exception',
            title: 'Rejected AS-POL-002 exception',
            description: 'This request lacks sufficient compensating controls.',
            actorIdentity: 'Casey Owner',
            actorRole: 'Analyst',
            policyId: 'AS-POL-002',
            expiresAt: '2099-01-01T00:00:00.000Z',
            evidenceSnapshotIds: ['exception-reject-evidence'],
            idempotencyKey: 'rejected-exception-create',
          },
        })
      ).json(),
    )
    for (const [operation, actorIdentity, key] of [
      ['pick-up', 'Taylor Analyst', 'rejected-exception-pick-up'],
      ['propose', 'Casey Owner', 'rejected-exception-propose'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/governance/queue/${exception.id}/transitions`,
        payload: { operation, actorIdentity, actorRole: 'Analyst', idempotencyKey: key },
      })
      expect(response.statusCode).toBe(200)
    }
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/governance/queue/${exception.id}/transitions`,
      payload: {
        operation: 'reject',
        actorIdentity: 'Jordan Approver',
        actorRole: 'Approver',
        reason: 'Compensating controls are insufficient.',
        idempotencyKey: 'reject-proposal',
      },
    })
    expect(governanceCaseDetailSchema.parse(rejected.json()).case.status).toBe('rejected')

    for (const [operation, actorIdentity, key] of [
      ['propose', 'Taylor Analyst', 'lifecycle-propose'],
      ['approve', 'Jordan Approver', 'lifecycle-approve'],
      ['promote', 'Sam Administrator', 'lifecycle-promote'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/governance/queue/gq-002/transitions',
        payload: {
          operation,
          actorIdentity,
          actorRole: operation === 'approve' ? 'Approver' : 'Administrator',
          evidenceSnapshotIds: [`${key}-evidence`],
          idempotencyKey: key,
        },
      })
      expect(response.statusCode).toBe(200)
    }

    const detail = governanceCaseDetailSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/governance/queue/gq-002' })).json(),
    )
    expect(detail.case.status).toBe('closed')
    expect(detail.transitions.at(-1)).toMatchObject({
      operation: 'promote',
      fromStatus: 'approved',
      toStatus: 'closed',
    })
  })

  it('reports honest live unavailability for writes while keeping reads soft', async () => {
    const app = await createApp(
      undefined,
      { mode: 'disabled', allowedScopes: { read: [], write: [] } },
      {
        dataMode: 'live',
        exposureRepository: liveExposureRepository(),
        snapshotRepository: liveSnapshotRepository(),
      },
    )
    apps.push(app)

    const listResponse = await app.inject({ method: 'GET', url: '/api/governance/queue' })
    expect(listResponse.statusCode).toBe(200)
    const listPage: GovernanceQueuePage = governanceQueuePageSchema.parse(listResponse.json())
    expect(listPage.summary.persistenceAvailable).toBe(false)
    expect(listPage.summary.persistenceNote).toContain('dedicated Cosmos container')

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/governance/queue',
      payload: {
        kind: 'finding-review',
        title: 'Unavailable in live mode',
        description: 'Should not persist.',
        actorIdentity: 'Pat Analyst',
        actorRole: 'Analyst',
        idempotencyKey: 'live-create',
      },
    })
    expect(createResponse.statusCode).toBe(503)
    expect(createResponse.json()).toMatchObject({ error: 'persistence_unavailable' })

    const transitionResponse = await app.inject({
      method: 'POST',
      url: '/api/governance/queue/gq-001/transitions',
      payload: {
        operation: 'pick-up',
        actorIdentity: 'Pat Analyst',
        actorRole: 'Analyst',
        idempotencyKey: 'live-transition',
      },
    })
    expect(transitionResponse.statusCode).toBe(503)
    expect(transitionResponse.json()).toMatchObject({ error: 'persistence_unavailable' })
  })

  it('wires the tenant-bound Cosmos repository in the live repository factory', () => {
    process.env['AGENT_SENTINEL_TENANT_ID'] = 'tenant-live'
    process.env['COSMOS_GOVERNANCE_CONTAINER'] = 'governance-test'
    const container = {}
    const containerMock = vi.fn(() => container)
    const database = { container: containerMock }
    const databaseMock = vi.fn(() => database)
    const client = { database: databaseMock } as unknown as CosmosClient

    const repositories = buildLiveRepositories(client)

    expect(repositories.governanceCaseRepository).toBeInstanceOf(CosmosGovernanceCaseRepository)
    expect(databaseMock).toHaveBeenCalledWith('agent-sentinel-db')
    expect(containerMock).toHaveBeenCalledWith('governance-test')
  })

  it('fails closed when live governance container configuration is absent', () => {
    const client = {
      database: vi.fn(() => ({ container: vi.fn(() => ({})) })),
    } as unknown as CosmosClient

    expect(() => buildLiveRepositories(client)).toThrow('COSMOS_GOVERNANCE_CONTAINER is required')
  })

  it('keeps live governance mutations blocked when persistence is available but writes are off', async () => {
    process.env['AGENT_SENTINEL_WRITE_ENABLED'] = 'false'
    const governanceCaseRepository = createSeededGovernanceCaseRepository('foundry', false)
    const app = await createApp(
      undefined,
      { mode: 'disabled', allowedScopes: { read: [], write: [] } },
      {
        dataMode: 'live',
        exposureRepository: liveExposureRepository(),
        snapshotRepository: liveSnapshotRepository(),
        governanceCaseRepository,
        runtimeTelemetryConnector: null,
      },
    )
    apps.push(app)

    const listResponse = await app.inject({ method: 'GET', url: '/api/governance/queue' })
    expect(governanceQueuePageSchema.parse(listResponse.json()).summary.persistenceAvailable).toBe(
      true,
    )

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/governance/queue',
      payload: {
        kind: 'finding-review',
        title: 'Blocked live write',
        description: 'Persistence must not bypass the global write switch.',
        actorIdentity: 'Pat Analyst',
        actorRole: 'Analyst',
        idempotencyKey: 'blocked-live-create',
      },
    })
    expect(createResponse.statusCode).toBe(403)
    expect(createResponse.json()).toMatchObject({ error: 'read_only_mode' })

    const transitionResponse = await app.inject({
      method: 'POST',
      url: '/api/governance/queue/gq-001/transitions',
      payload: {
        operation: 'pick-up',
        actorIdentity: 'Pat Analyst',
        actorRole: 'Analyst',
        idempotencyKey: 'blocked-live-transition',
      },
    })
    expect(transitionResponse.statusCode).toBe(403)
    expect(transitionResponse.json()).toMatchObject({ error: 'read_only_mode' })
    expect((await governanceCaseRepository.findById('gq-001'))?.case.status).toBe('open')
  })
})
