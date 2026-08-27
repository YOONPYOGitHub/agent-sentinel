import { describe, expect, it } from 'vitest'

import {
  governanceCaseSchema,
  governanceCaseTransitionSchema,
  type GovernanceCase,
  type GovernanceCaseStatus,
  type GovernanceCaseTransition,
  type GovernanceCaseTransitionOp,
} from '@agent-sentinel/domain'

import { CosmosGovernanceCaseRepository } from '../src/index.js'
import { FakeCosmosStore } from './fake-cosmos.js'

function caseRecord(id = 'case-1', createdAt = '2026-08-27T00:00:00.000Z'): GovernanceCase {
  return governanceCaseSchema.parse({
    id,
    kind: 'finding-review',
    title: `Review ${id}`,
    description: `Durable governance case ${id}.`,
    status: 'open',
    createdByIdentity: 'analyst@example.test',
    createdByRole: 'Analyst',
    createdAt,
    lastTransitionAt: createdAt,
    evidenceSnapshotIds: [`snapshot-${id}`],
    sourceMode: 'foundry',
    writeEnabledAtCreation: true,
  })
}

function createTransition(caseRecord: GovernanceCase, key = `create-${caseRecord.id}`) {
  return governanceCaseTransitionSchema.parse({
    id: `transition-create-${caseRecord.id}`,
    caseId: caseRecord.id,
    operation: 'create',
    fromStatus: null,
    toStatus: 'open',
    actorIdentity: caseRecord.createdByIdentity,
    actorRole: caseRecord.createdByRole,
    actorCapability: 'proposeRemediation',
    timestamp: caseRecord.createdAt,
    authorizationContext: {
      mode: 'jwt',
      authenticated: true,
      subject: 'analyst-subject',
    },
    source: {
      type: 'governance-workflow',
      mode: 'foundry',
      referenceIds: [caseRecord.id, ...caseRecord.evidenceSnapshotIds],
    },
    evidenceSnapshotIds: caseRecord.evidenceSnapshotIds,
    idempotencyKey: key,
  })
}

function nextTransition(
  current: GovernanceCase,
  operation: GovernanceCaseTransitionOp,
  toStatus: GovernanceCaseStatus,
  id: string,
  timestamp: string,
): { updated: GovernanceCase; transition: GovernanceCaseTransition } {
  const updated = governanceCaseSchema.parse({
    ...current,
    status: toStatus,
    lastTransitionAt: timestamp,
    ...(operation === 'pick-up' ? { assigneeIdentity: 'analyst@example.test' } : {}),
  })
  const transition = governanceCaseTransitionSchema.parse({
    id,
    caseId: current.id,
    operation,
    fromStatus: current.status,
    toStatus,
    actorIdentity: 'analyst@example.test',
    actorRole: 'Analyst',
    actorCapability: operation === 'expire' ? 'configure' : 'validateFinding',
    timestamp,
    authorizationContext: {
      mode: 'jwt',
      authenticated: true,
      subject: 'analyst-subject',
    },
    source: {
      type: 'governance-workflow',
      mode: 'foundry',
      referenceIds: [current.id, ...current.evidenceSnapshotIds],
    },
    ...(operation === 'pick-up' ? { assignedToIdentity: 'analyst@example.test' } : {}),
    evidenceSnapshotIds: current.evidenceSnapshotIds,
    idempotencyKey: `key-${id}`,
  })
  return { updated, transition }
}

describe('CosmosGovernanceCaseRepository', () => {
  it('persists retry-safe cases and immutable ordered transition history across instances', async () => {
    const store = new FakeCosmosStore()
    const firstRepository = new CosmosGovernanceCaseRepository(store.client, {
      tenantId: 'tenant-a',
    })
    const record = caseRecord()
    const initial = createTransition(record)

    await expect(firstRepository.create(record, initial)).resolves.toEqual({
      case: record,
      created: true,
    })
    await expect(
      firstRepository.create(
        { ...record, id: 'different-id' },
        {
          ...initial,
          id: 'different-transition',
          caseId: 'different-id',
        },
      ),
    ).resolves.toEqual({ case: record, created: false })

    const restartRepository = new CosmosGovernanceCaseRepository(store.client, {
      tenantId: 'tenant-a',
    })
    const { updated, transition } = nextTransition(
      record,
      'pick-up',
      'in-review',
      'transition-pick-up',
      '2026-08-27T00:01:00.000Z',
    )
    const result = await restartRepository.applyTransition(record.id, 'open', updated, transition)

    expect(result).toMatchObject({ applied: true, case: { status: 'in-review' } })
    await expect(
      restartRepository.applyTransition(record.id, 'open', updated, transition),
    ).resolves.toEqual({ applied: false, reason: 'idempotency_conflict' })
    const detail = await firstRepository.findById(record.id)
    expect(detail?.transitions.map((item) => item.operation)).toEqual(['create', 'pick-up'])
    detail!.transitions[0]!.actorIdentity = 'tampered'
    expect((await restartRepository.findById(record.id))?.transitions[0]?.actorIdentity).toBe(
      'analyst@example.test',
    )
  })

  it('isolates identical ids and idempotency keys by tenant partition', async () => {
    const store = new FakeCosmosStore()
    const tenantA = new CosmosGovernanceCaseRepository(store.client, {
      tenantId: 'tenant-a',
    })
    const tenantB = new CosmosGovernanceCaseRepository(store.client, {
      tenantId: 'tenant-b',
    })
    const record = caseRecord()

    await tenantA.create(record, createTransition(record, 'shared-key'))
    await tenantB.create(record, createTransition(record, 'shared-key'))

    expect((await tenantA.listAll()).items).toHaveLength(1)
    expect((await tenantB.listAll()).items).toHaveLength(1)
    const tenantBOnly = caseRecord('case-b-only', '2026-08-27T00:02:00.000Z')
    await tenantB.create(tenantBOnly, createTransition(tenantBOnly))
    expect((await tenantA.listAll()).items.map((item) => item.id)).toEqual(['case-1'])
    expect((await tenantB.listAll()).total).toBe(2)
  })

  it('uses ETags to allow only one concurrent transition from the same state', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosGovernanceCaseRepository(store.client, {
      tenantId: 'tenant-a',
    })
    const record = caseRecord()
    await repository.create(record, createTransition(record))
    const pickUp = nextTransition(
      record,
      'pick-up',
      'in-review',
      'transition-pick-up',
      '2026-08-27T00:01:00.000Z',
    )
    const expire = nextTransition(
      record,
      'expire',
      'expired',
      'transition-expire',
      '2026-08-27T00:01:01.000Z',
    )

    const results = await Promise.all([
      repository.applyTransition(record.id, 'open', pickUp.updated, pickUp.transition),
      repository.applyTransition(record.id, 'open', expire.updated, expire.transition),
    ])

    expect(results.filter((result) => result.applied)).toHaveLength(1)
    expect(results.filter((result) => !result.applied)).toEqual([
      { applied: false, reason: 'state_conflict' },
    ])
    expect((await repository.findById(record.id))?.transitions).toHaveLength(2)
  })

  it('reports missing records and rejects invalid transition evidence before writing', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosGovernanceCaseRepository(store.client, {
      tenantId: 'tenant-a',
    })
    const record = caseRecord()
    const valid = nextTransition(
      record,
      'pick-up',
      'in-review',
      'transition-pick-up',
      '2026-08-27T00:01:00.000Z',
    )

    await expect(repository.findById('missing')).resolves.toBeNull()
    await expect(
      repository.applyTransition(
        'missing',
        'open',
        { ...valid.updated, id: 'missing' },
        { ...valid.transition, caseId: 'missing' },
      ),
    ).resolves.toEqual({ applied: false, reason: 'not_found' })

    await repository.create(record, createTransition(record))
    await expect(
      repository.applyTransition(record.id, 'open', valid.updated, {
        ...valid.transition,
        operation: 'approve',
      }),
    ).rejects.toThrow()
    expect((await repository.findById(record.id))?.transitions).toHaveLength(1)
  })

  it('bounds pages at 200 and applies deterministic filters and ordering', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosGovernanceCaseRepository(store.client, {
      tenantId: 'tenant-a',
    })
    for (let index = 0; index < 201; index += 1) {
      const record = caseRecord(
        `case-${String(index).padStart(3, '0')}`,
        '2026-08-27T00:00:00.000Z',
      )
      await repository.create(record, createTransition(record))
    }

    const firstPage = await repository.listAll({ pageSize: Number.MAX_SAFE_INTEGER })
    const secondPage = await repository.listAll({ page: 2, pageSize: 200 })
    const searched = await repository.listAll({ search: 'case-200' })

    expect(firstPage.items).toHaveLength(200)
    expect(firstPage.items[0]?.id).toBe('case-000')
    expect(firstPage.total).toBe(201)
    expect(secondPage.items.map((item) => item.id)).toEqual(['case-200'])
    expect(searched.items.map((item) => item.id)).toEqual(['case-200'])
  })
})
