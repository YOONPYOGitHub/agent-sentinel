import { describe, expect, it } from 'vitest'

import type {
  ConnectorSourceCreateInput,
  ConnectorSourceDefinition,
  ConnectorSourceMutationContext,
  ConnectorSourceRepository,
  ConnectorSourceWriteResult,
  EstateContext,
} from '@agent-sentinel/domain'

import { CosmosConnectorSourceRepository, InMemoryConnectorSourceRepository } from '../src/index.js'
import { FakeCosmosStore } from './fake-cosmos.js'

const ESTATE_A: EstateContext = {
  id: 'estate-a',
  tenantId: '00000000-0000-0000-0000-000000000001',
  environment: 'production',
}
const ESTATE_A_OTHER_ID: EstateContext = {
  id: 'estate-b',
  tenantId: ESTATE_A.tenantId,
  environment: ESTATE_A.environment,
}
const ESTATE_A_WRONG_TENANT: EstateContext = {
  id: ESTATE_A.id,
  tenantId: '00000000-0000-0000-0000-000000000002',
  environment: ESTATE_A.environment,
}
const ESTATE_A_WRONG_ENVIRONMENT: EstateContext = {
  id: ESTATE_A.id,
  tenantId: ESTATE_A.tenantId,
  environment: 'staging',
}

function source(
  estate: EstateContext,
  overrides: Partial<ConnectorSourceCreateInput> = {},
): ConnectorSourceCreateInput {
  return {
    estateId: estate.id,
    tenantId: estate.tenantId,
    environment: estate.environment,
    sourceId: 'shared-source',
    connectorType: 'foundry',
    displayName: 'Foundry source',
    enabled: true,
    origin: 'user',
    configuration: {
      type: 'foundry',
      projectEndpoint: 'https://example.services.ai.azure.com/api/projects/project-a',
    },
    credential: {
      mode: 'managed-identity',
      managedIdentityClientId: '00000000-0000-0000-0000-000000000010',
    },
    testStatus: { status: 'not-tested' },
    ...overrides,
  }
}

function mutation(
  id: string,
  occurredAt = '2026-09-04T00:00:00.000Z',
): ConnectorSourceMutationContext {
  return {
    auditId: `audit-${id}`,
    idempotencyKey: `key-${id}`,
    actor: { type: 'user', id: 'administrator@example.test' },
    occurredAt,
  }
}

function requireSource(result: ConnectorSourceWriteResult): ConnectorSourceDefinition {
  if (result.status !== 'applied' || result.source === null) {
    throw new Error('Expected an applied connector source result.')
  }
  return result.source
}

const factories: Array<[string, () => ConnectorSourceRepository]> = [
  ['in-memory', () => new InMemoryConnectorSourceRepository()],
  ['fake Cosmos', () => new CosmosConnectorSourceRepository(new FakeCosmosStore().client)],
]

describe.each(factories)('%s connector source repository', (_name, createRepository) => {
  it('isolates identical IDs and idempotency keys by exact estate ID', async () => {
    const repository = createRepository()
    const operation = mutation('create')
    await expect(repository.create(ESTATE_A, source(ESTATE_A), operation)).resolves.toMatchObject({
      status: 'applied',
    })
    await expect(repository.findById(ESTATE_A_OTHER_ID, 'shared-source')).resolves.toBeNull()
    await expect(repository.list(ESTATE_A_OTHER_ID)).resolves.toEqual([])
    await expect(repository.listAudit(ESTATE_A_OTHER_ID, 'shared-source')).resolves.toEqual([])
    await expect(
      repository.update(
        ESTATE_A_OTHER_ID,
        'shared-source',
        'unknown-etag',
        { enabled: false },
        mutation('missing-update'),
      ),
    ).resolves.toEqual({ status: 'not_found' })
    await expect(
      repository.delete(
        ESTATE_A_OTHER_ID,
        'shared-source',
        'unknown-etag',
        mutation('missing-delete'),
      ),
    ).resolves.toEqual({ status: 'not_found' })
    await expect(
      repository.create(ESTATE_A_OTHER_ID, source(ESTATE_A_OTHER_ID), operation),
    ).resolves.toMatchObject({ status: 'applied' })
    expect((await repository.findById(ESTATE_A, 'shared-source'))?.tenantId).toBe(ESTATE_A.tenantId)
    expect((await repository.findById(ESTATE_A_OTHER_ID, 'shared-source'))?.estateId).toBe(
      ESTATE_A_OTHER_ID.id,
    )
    await expect(repository.list(ESTATE_A)).resolves.toHaveLength(1)
    await expect(repository.list(ESTATE_A_OTHER_ID)).resolves.toHaveLength(1)
  })

  it.each([
    ['estate ID', { estateId: ESTATE_A_OTHER_ID.id }],
    ['tenant ID', { tenantId: ESTATE_A_WRONG_TENANT.tenantId }],
    ['environment ID', { environment: ESTATE_A_WRONG_ENVIRONMENT.environment }],
  ])('rejects a mismatched create %s boundary', async (_boundary, overrides) => {
    const repository = createRepository()
    await expect(
      Promise.resolve().then(() =>
        repository.create(ESTATE_A, source(ESTATE_A, overrides), mutation('wrong-boundary')),
      ),
    ).rejects.toThrow('boundary')
  })

  it('reports duplicate IDs', async () => {
    const repository = createRepository()
    await repository.create(ESTATE_A, source(ESTATE_A), mutation('create'))
    await expect(
      repository.create(ESTATE_A, source(ESTATE_A), mutation('duplicate')),
    ).resolves.toEqual({ status: 'conflict', reason: 'already_exists' })
  })

  it.each([
    ['tenant ID', ESTATE_A_WRONG_TENANT],
    ['environment ID', ESTATE_A_WRONG_ENVIRONMENT],
  ])('fails closed on a mismatched %s for every method and replay path', async (_label, estate) => {
    const repository = createRepository()
    const createMutation = mutation('boundary-create')
    const created = requireSource(
      await repository.create(ESTATE_A, source(ESTATE_A), createMutation),
    )

    await expect(
      Promise.resolve().then(() => repository.create(estate, source(estate), createMutation)),
    ).rejects.toThrow(/connector source/i)
    await expect(
      Promise.resolve().then(() =>
        repository.create(estate, source(estate), mutation('boundary-create-distinct')),
      ),
    ).rejects.toThrow(/connector source/i)
    await expect(
      Promise.resolve().then(() =>
        repository.create(estate, source(estate, { sourceId: 'audit-boundary-source' }), {
          ...mutation('boundary-audit-reuse'),
          auditId: createMutation.auditId,
        }),
      ),
    ).rejects.toThrow(/connector source/i)
    await expect(
      Promise.resolve().then(() => repository.findById(estate, created.sourceId)),
    ).rejects.toThrow(/connector source/i)
    await expect(Promise.resolve().then(() => repository.list(estate))).rejects.toThrow(
      /connector source/i,
    )
    await expect(
      Promise.resolve().then(() => repository.listAudit(estate, created.sourceId)),
    ).rejects.toThrow(/connector source/i)
    await expect(
      Promise.resolve().then(() =>
        repository.update(
          estate,
          created.sourceId,
          created.etag,
          { enabled: false },
          mutation('boundary-update-source'),
        ),
      ),
    ).rejects.toThrow(/connector source/i)
    await expect(
      Promise.resolve().then(() =>
        repository.delete(
          estate,
          created.sourceId,
          created.etag,
          mutation('boundary-delete-source'),
        ),
      ),
    ).rejects.toThrow(/connector source/i)

    const updateMutation = mutation('boundary-update', '2026-09-04T00:01:00.000Z')
    const updated = requireSource(
      await repository.update(
        ESTATE_A,
        created.sourceId,
        created.etag,
        { displayName: 'Updated source' },
        updateMutation,
      ),
    )
    await expect(
      Promise.resolve().then(() =>
        repository.update(
          estate,
          created.sourceId,
          created.etag,
          { displayName: 'Updated source' },
          updateMutation,
        ),
      ),
    ).rejects.toThrow(/connector source/i)

    const deleteMutation = mutation('boundary-delete', '2026-09-04T00:02:00.000Z')
    await repository.delete(ESTATE_A, updated.sourceId, updated.etag, deleteMutation)
    await expect(
      Promise.resolve().then(() =>
        repository.delete(estate, updated.sourceId, updated.etag, deleteMutation),
      ),
    ).rejects.toThrow(/connector source/i)
  })

  it('uses ETags and permits only one concurrent update', async () => {
    const repository = createRepository()
    const created = requireSource(
      await repository.create(ESTATE_A, source(ESTATE_A), mutation('create')),
    )
    await expect(
      repository.update(
        ESTATE_A,
        created.sourceId,
        'stale-etag',
        { displayName: 'Stale' },
        mutation('stale'),
      ),
    ).resolves.toEqual({ status: 'conflict', reason: 'etag_mismatch' })
    const results = await Promise.all([
      repository.update(
        ESTATE_A,
        created.sourceId,
        created.etag,
        { displayName: 'First update' },
        mutation('first', '2026-09-04T00:01:00.000Z'),
      ),
      repository.update(
        ESTATE_A,
        created.sourceId,
        created.etag,
        { displayName: 'Second update' },
        mutation('second', '2026-09-04T00:01:01.000Z'),
      ),
    ])
    expect(results.filter((result) => result.status === 'applied')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'conflict')).toEqual([
      { status: 'conflict', reason: 'etag_mismatch' },
    ])
    await expect(repository.listAudit(ESTATE_A, created.sourceId)).resolves.toHaveLength(2)
  })

  it('keeps deployment-origin records immutable', async () => {
    const repository = createRepository()
    const created = requireSource(
      await repository.create(ESTATE_A, source(ESTATE_A, { origin: 'deployment' }), {
        ...mutation('deployment'),
        actor: { type: 'deployment', id: 'bicep' },
      }),
    )
    await expect(
      repository.update(
        ESTATE_A,
        created.sourceId,
        created.etag,
        { enabled: false },
        mutation('update-deployment'),
      ),
    ).resolves.toEqual({ status: 'immutable' })
    await expect(
      repository.delete(ESTATE_A, created.sourceId, created.etag, mutation('delete-deployment')),
    ).resolves.toEqual({ status: 'immutable' })
  })

  it('replays idempotent writes and rejects key reuse', async () => {
    const repository = createRepository()
    const operation = mutation('create')
    const first = await repository.create(ESTATE_A, source(ESTATE_A), operation)
    await expect(repository.create(ESTATE_A, source(ESTATE_A), operation)).resolves.toMatchObject({
      status: 'idempotent',
      source: { etag: requireSource(first).etag },
    })
    await expect(
      repository.create(ESTATE_A, source(ESTATE_A, { sourceId: 'different-source' }), operation),
    ).resolves.toEqual({ status: 'conflict', reason: 'idempotency_key_reuse' })
    await expect(repository.listAudit(ESTATE_A, 'shared-source')).resolves.toHaveLength(1)
  })

  it('retains immutable audit after deletion', async () => {
    const repository = createRepository()
    const created = requireSource(
      await repository.create(ESTATE_A, source(ESTATE_A), mutation('create')),
    )
    const operation = mutation('delete', '2026-09-04T00:02:00.000Z')
    await expect(
      repository.delete(ESTATE_A, created.sourceId, created.etag, operation),
    ).resolves.toMatchObject({ status: 'applied', source: null, audit: { operation: 'delete' } })
    await expect(repository.findById(ESTATE_A, created.sourceId)).resolves.toBeNull()
    await expect(
      repository.delete(ESTATE_A, created.sourceId, created.etag, operation),
    ).resolves.toMatchObject({ status: 'idempotent', source: null })
    await expect(
      repository.delete(
        ESTATE_A,
        created.sourceId,
        created.etag,
        mutation('stale-delete', '2026-09-04T00:03:00.000Z'),
      ),
    ).resolves.toEqual({ status: 'not_found' })
    await expect(
      repository.create(
        ESTATE_A,
        source(ESTATE_A),
        mutation('recreate', '2026-09-04T00:04:00.000Z'),
      ),
    ).resolves.toEqual({ status: 'conflict', reason: 'already_exists' })
    const audit = await repository.listAudit(ESTATE_A, created.sourceId)
    expect(audit.map((item) => item.operation)).toEqual(['create', 'delete'])
    audit[0]!.after!.displayName = 'tampered'
    expect((await repository.listAudit(ESTATE_A, created.sourceId))[0]?.after?.displayName).toBe(
      'Foundry source',
    )
  })

  it('rejects updates that occur before the current source version', async () => {
    const repository = createRepository()
    const created = requireSource(
      await repository.create(ESTATE_A, source(ESTATE_A), mutation('create')),
    )
    const updated = requireSource(
      await repository.update(
        ESTATE_A,
        created.sourceId,
        created.etag,
        { displayName: 'Current source' },
        mutation('current-update', '2026-09-04T00:02:00.000Z'),
      ),
    )
    await expect(
      Promise.resolve().then(() =>
        repository.update(
          ESTATE_A,
          updated.sourceId,
          updated.etag,
          { displayName: 'Regressed source' },
          mutation('regressed-update', '2026-09-04T00:01:00.000Z'),
        ),
      ),
    ).rejects.toThrow('cannot precede the current source version')
    await expect(repository.findById(ESTATE_A, updated.sourceId)).resolves.toEqual(updated)
    await expect(repository.listAudit(ESTATE_A, updated.sourceId)).resolves.toHaveLength(2)
  })

  it('rejects secret-shaped input and bounds reads', async () => {
    const repository = createRepository()
    await expect(
      Promise.resolve().then(() =>
        repository.create(
          ESTATE_A,
          {
            ...source(ESTATE_A),
            credential: { mode: 'default', clientSecret: 'must-not-persist' },
          } as ConnectorSourceCreateInput,
          mutation('secret'),
        ),
      ),
    ).rejects.toThrow()
    expect(JSON.stringify(await repository.list(ESTATE_A))).not.toContain('must-not-persist')
    await expect(Promise.resolve().then(() => repository.list(ESTATE_A, 0))).rejects.toThrow(
      'positive integer',
    )
    await expect(
      Promise.resolve().then(() => repository.listAudit(ESTATE_A, 'shared-source', 0)),
    ).rejects.toThrow('positive integer')
  })
})

describe('Cosmos connector source documents', () => {
  it('uses estate-scoped hashed physical IDs without secret fields', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosConnectorSourceRepository(store.client)
    await repository.create(ESTATE_A, source(ESTATE_A), mutation('create'))
    const documents = store.snapshot()
    expect(documents).toHaveLength(3)
    expect(documents.every((document) => document.estateId === ESTATE_A.id)).toBe(true)
    expect(documents.every((document) => document.tenantId === ESTATE_A.tenantId)).toBe(true)
    expect(documents.every((document) => document.environment === ESTATE_A.environment)).toBe(true)
    expect(documents.every((document) => !document.id.includes('shared-source'))).toBe(true)
    expect(JSON.stringify(documents)).not.toMatch(
      /password|clientSecret|accessToken|rawCredentials/i,
    )
  })
})
