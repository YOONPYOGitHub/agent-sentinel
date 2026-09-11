import { describe, expect, it } from 'vitest'

import type {
  ConnectorSourceAuditRecord,
  ConnectorSourceCreateInput,
  ConnectorSourceDefinition,
  ConnectorSourceMutationContext,
  ConnectorSourceRepository,
  ConnectorSourceWriteResult,
  EstateContext,
} from '@agent-sentinel/domain'
import { connectorSourceReadModelSchema } from '@agent-sentinel/domain'

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

function azureMonitorSource(
  estate: EstateContext,
  overrides: Partial<ConnectorSourceCreateInput> = {},
): ConnectorSourceCreateInput {
  return source(estate, {
    sourceId: 'azure-monitor-primary',
    connectorType: 'azure-monitor-otel',
    displayName: 'Azure Monitor runtime telemetry',
    configuration: {
      type: 'azure-monitor-otel',
      workspaceId: '00000000-0000-0000-0000-000000000020',
      sourceProjectId: 'project-a',
      logsBaseUrl: 'https://api.loganalytics.io',
      baselineWindowHours: 168,
      observedWindowHours: 24,
      requestTimeoutMs: 15_000,
      maxResponseBytes: 4_194_304,
    },
    ...overrides,
  })
}

function withoutSourceProjectId(sourceValue: ConnectorSourceDefinition): unknown {
  const value = structuredClone(sourceValue)
  if (value.configuration.type !== 'azure-monitor-otel') {
    throw new Error('Expected an Azure Monitor source fixture.')
  }
  delete (value.configuration as Partial<typeof value.configuration>).sourceProjectId
  return value
}

function withoutAuditSourceProjectIds(auditValue: ConnectorSourceAuditRecord): unknown {
  const value = structuredClone(auditValue)
  if (value.before !== null) value.before = withoutSourceProjectId(value.before) as never
  if (value.after !== null) value.after = withoutSourceProjectId(value.after) as never
  return value
}

function agent365Source(
  estate: EstateContext,
  maxRetryAfterMs = 60_000,
): ConnectorSourceCreateInput {
  return source(estate, {
    sourceId: 'agent365-primary',
    connectorType: 'agent365',
    displayName: 'Agent 365 source',
    configuration: {
      type: 'agent365',
      graphBaseUrl: 'https://graph.microsoft.com',
      limits: {
        maxPages: 20,
        maxItems: 5_000,
        requestTimeoutMs: 15_000,
        maxRetries: 2,
        maxRetryAfterMs,
        maxResponseBytes: 2_000_000,
      },
    },
  })
}

function withLegacyAgent365Retry(sourceValue: ConnectorSourceDefinition): unknown {
  const value = structuredClone(sourceValue)
  if (value.configuration.type !== 'agent365') {
    throw new Error('Expected an Agent 365 source fixture.')
  }
  value.configuration.limits.maxRetryAfterMs = 120_000
  return value
}

function rejectedError(result: PromiseSettledResult<ConnectorSourceWriteResult>): Error {
  if (result.status !== 'rejected') {
    throw new Error('Expected a rejected connector source operation.')
  }
  const reason = result.reason as unknown
  if (!(reason instanceof Error)) {
    throw new Error('Expected the connector source rejection to contain an error.')
  }
  return reason
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

  it.each([
    ['tenant ID', ESTATE_A_WRONG_TENANT],
    ['environment ID', ESTATE_A_WRONG_ENVIRONMENT],
  ])(
    'rejects a fresh-ID create after the estate is bound to a different %s',
    async (_label, mismatchedEstate) => {
      const repository = createRepository()
      await repository.create(ESTATE_A, source(ESTATE_A), mutation('bind-estate'))

      await expect(
        Promise.resolve().then(() =>
          repository.create(
            mismatchedEstate,
            source(mismatchedEstate, { sourceId: 'fresh-boundary-source' }),
            mutation('fresh-boundary'),
          ),
        ),
      ).rejects.toThrow(/estate boundary/i)
    },
  )

  it('allows a corrected retry with the same fresh IDs after a boundary failure', async () => {
    const repository = createRepository()
    await repository.create(ESTATE_A, source(ESTATE_A), mutation('bind-retry-estate'))
    const operation = mutation('failed-retry')

    await expect(
      Promise.resolve().then(() =>
        repository.create(
          ESTATE_A_WRONG_TENANT,
          source(ESTATE_A_WRONG_TENANT, { sourceId: 'retry-source' }),
          operation,
        ),
      ),
    ).rejects.toThrow(/estate boundary/i)
    await expect(
      repository.create(ESTATE_A, source(ESTATE_A, { sourceId: 'retry-source' }), operation),
    ).resolves.toMatchObject({
      status: 'applied',
      source: {
        sourceId: 'retry-source',
        tenantId: ESTATE_A.tenantId,
        environment: ESTATE_A.environment,
      },
    })
    await expect(repository.listAudit(ESTATE_A, 'retry-source')).resolves.toHaveLength(1)
  })

  it('allows exactly one boundary to win a concurrent first-create race', async () => {
    const repository = createRepository()
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        repository.create(
          ESTATE_A,
          source(ESTATE_A, { sourceId: 'race-winner-source' }),
          mutation('race-winner'),
        ),
      ),
      Promise.resolve().then(() =>
        repository.create(
          ESTATE_A_WRONG_TENANT,
          source(ESTATE_A_WRONG_TENANT, { sourceId: 'race-loser-source' }),
          mutation('race-loser'),
        ),
      ),
    ])

    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { status: 'applied' } })
    expect(rejectedError(results[1]).message).toMatch(/estate boundary/i)
    await expect(repository.list(ESTATE_A)).resolves.toHaveLength(1)
    await expect(repository.findById(ESTATE_A, 'race-loser-source')).resolves.toBeNull()
    await expect(repository.listAudit(ESTATE_A, 'race-loser-source')).resolves.toEqual([])
    await expect(
      repository.create(
        ESTATE_A,
        source(ESTATE_A, { sourceId: 'race-loser-source' }),
        mutation('race-loser'),
      ),
    ).resolves.toMatchObject({ status: 'applied' })
  })

  it('leaves no source, audit, retry marker, or partial boundary after a losing create', async () => {
    const repository = createRepository()
    await repository.create(ESTATE_A, source(ESTATE_A), mutation('bind-no-partial-estate'))
    const operation = mutation('no-partial')

    await expect(
      Promise.resolve().then(() =>
        repository.create(
          ESTATE_A_WRONG_ENVIRONMENT,
          source(ESTATE_A_WRONG_ENVIRONMENT, { sourceId: 'no-partial-source' }),
          operation,
        ),
      ),
    ).rejects.toThrow(/estate boundary/i)
    await expect(repository.findById(ESTATE_A, 'no-partial-source')).resolves.toBeNull()
    await expect(repository.listAudit(ESTATE_A, 'no-partial-source')).resolves.toEqual([])
    await expect(
      repository.create(ESTATE_A, source(ESTATE_A, { sourceId: 'no-partial-source' }), operation),
    ).resolves.toMatchObject({ status: 'applied' })
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

  it('preserves causal audit order and rejects equal-timestamp writes atomically', async () => {
    const repository = createRepository()
    const createMutation = {
      ...mutation('chronology-create', '2026-09-04T00:00:00.000Z'),
      auditId: 'audit-z-create',
    }
    const created = requireSource(
      await repository.create(ESTATE_A, source(ESTATE_A), createMutation),
    )
    await expect(
      repository.create(ESTATE_A, source(ESTATE_A), createMutation),
    ).resolves.toMatchObject({
      status: 'idempotent',
      source: created,
      audit: { id: 'audit-z-create' },
    })

    const updateMutation = {
      ...mutation('chronology-update', created.updatedAt),
      auditId: 'audit-y-update',
    }
    await expect(
      Promise.resolve().then(() =>
        repository.update(
          ESTATE_A,
          created.sourceId,
          created.etag,
          { displayName: 'Updated source' },
          updateMutation,
        ),
      ),
    ).rejects.toThrow('occurredAt must be strictly greater than the current source updatedAt')
    await expect(repository.findById(ESTATE_A, created.sourceId)).resolves.toEqual(created)
    await expect(repository.listAudit(ESTATE_A, created.sourceId)).resolves.toEqual([
      expect.objectContaining({ id: 'audit-z-create', operation: 'create' }),
    ])

    const correctedUpdateMutation = {
      ...updateMutation,
      occurredAt: '2026-09-04T00:01:00.000Z',
    }
    const updated = requireSource(
      await repository.update(
        ESTATE_A,
        created.sourceId,
        created.etag,
        { displayName: 'Updated source' },
        correctedUpdateMutation,
      ),
    )
    await expect(
      repository.update(
        ESTATE_A,
        created.sourceId,
        created.etag,
        { displayName: 'Updated source' },
        correctedUpdateMutation,
      ),
    ).resolves.toMatchObject({
      status: 'idempotent',
      source: updated,
      audit: { id: 'audit-y-update' },
    })

    const deleteMutation = {
      ...mutation('chronology-delete', updated.updatedAt),
      auditId: 'audit-x-delete',
    }
    await expect(
      Promise.resolve().then(() =>
        repository.delete(ESTATE_A, updated.sourceId, updated.etag, deleteMutation),
      ),
    ).rejects.toThrow('occurredAt must be strictly greater than the current source updatedAt')
    await expect(repository.findById(ESTATE_A, updated.sourceId)).resolves.toEqual(updated)
    await expect(repository.listAudit(ESTATE_A, updated.sourceId)).resolves.toEqual([
      expect.objectContaining({ id: 'audit-z-create', operation: 'create' }),
      expect.objectContaining({ id: 'audit-y-update', operation: 'update' }),
    ])

    const correctedDeleteMutation = {
      ...deleteMutation,
      occurredAt: '2026-09-04T00:02:00.000Z',
    }
    await expect(
      repository.delete(ESTATE_A, updated.sourceId, updated.etag, correctedDeleteMutation),
    ).resolves.toMatchObject({
      status: 'applied',
      source: null,
      audit: { id: 'audit-x-delete' },
    })
    await expect(
      repository.delete(ESTATE_A, updated.sourceId, updated.etag, correctedDeleteMutation),
    ).resolves.toMatchObject({
      status: 'idempotent',
      source: null,
      audit: { id: 'audit-x-delete' },
    })
    await expect(repository.findById(ESTATE_A, updated.sourceId)).resolves.toBeNull()

    const audit = await repository.listAudit(ESTATE_A, updated.sourceId)
    expect(audit.map((item) => item.id)).toEqual([
      'audit-z-create',
      'audit-y-update',
      'audit-x-delete',
    ])
    expect(audit.map((item) => item.operation)).toEqual(['create', 'update', 'delete'])
    expect(audit.map((item) => item.occurredAt)).toEqual([
      '2026-09-04T00:00:00.000Z',
      '2026-09-04T00:01:00.000Z',
      '2026-09-04T00:02:00.000Z',
    ])
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

describe('legacy Azure Monitor connector source hydration', () => {
  it('hydrates in-memory legacy audit snapshots without changing audit metadata', async () => {
    const before = {
      ...azureMonitorSource(ESTATE_A),
      displayName: 'Legacy Azure Monitor source',
      version: 1,
      etag: 'legacy-etag-1',
      createdBy: { type: 'user', id: 'creator@example.test' } as const,
      updatedBy: { type: 'user', id: 'creator@example.test' } as const,
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
    } satisfies ConnectorSourceDefinition
    const after = {
      ...before,
      displayName: 'Renamed legacy Azure Monitor source',
      version: 2,
      etag: 'legacy-etag-2',
      updatedBy: { type: 'service-principal', id: 'migration-worker' } as const,
      updatedAt: '2026-09-04T00:01:00.000Z',
    } satisfies ConnectorSourceDefinition
    const audit = {
      id: 'legacy-audit-update',
      estateId: ESTATE_A.id,
      tenantId: ESTATE_A.tenantId,
      environment: ESTATE_A.environment,
      sourceId: after.sourceId,
      operation: 'update',
      actor: after.updatedBy,
      occurredAt: after.updatedAt,
      idempotencyKey: 'legacy-update',
      before,
      after,
    } satisfies ConnectorSourceAuditRecord
    const repository = new InMemoryConnectorSourceRepository({
      persistedSources: [withoutSourceProjectId(after)],
      persistedAudits: [withoutAuditSourceProjectIds(audit)],
    })

    describe('legacy Agent 365 retry hydration', () => {
      it('keeps in-memory records visible, inactive, and mutation-blocked without clamping', async () => {
        const current = {
          ...agent365Source(ESTATE_A),
          version: 1,
          etag: 'legacy-agent365-etag',
          createdBy: { type: 'user', id: 'administrator@example.test' } as const,
          updatedBy: { type: 'user', id: 'administrator@example.test' } as const,
          createdAt: '2026-09-04T00:00:00.000Z',
          updatedAt: '2026-09-04T00:00:00.000Z',
        } satisfies ConnectorSourceDefinition
        const repository = new InMemoryConnectorSourceRepository({
          persistedSources: [withLegacyAgent365Retry(current)],
        })

        const [listed] = await repository.list(ESTATE_A)

        expect(listed).toMatchObject({
          sourceId: 'agent365-primary',
          enabled: false,
          configuration: { limits: { maxRetryAfterMs: 120_000 } },
          migration: {
            status: 'migration-required',
            reason: 'legacy-agent365-retry-after-limit',
          },
        })
        await expect(
          repository.update(
            ESTATE_A,
            'agent365-primary',
            'legacy-agent365-etag',
            { enabled: true },
            mutation('legacy-agent365-update', '2026-09-04T00:01:00.000Z'),
          ),
        ).resolves.toEqual({ status: 'migration_required' })
        await expect(
          repository.delete(
            ESTATE_A,
            'agent365-primary',
            'legacy-agent365-etag',
            mutation('legacy-agent365-delete', '2026-09-04T00:01:00.000Z'),
          ),
        ).resolves.toEqual({ status: 'migration_required' })
      })

      it('keeps Cosmos records visible, inactive, and mutation-blocked without clamping', async () => {
        const store = new FakeCosmosStore()
        const repository = new CosmosConnectorSourceRepository(store.client)
        const created = requireSource(
          await repository.create(ESTATE_A, agent365Source(ESTATE_A), mutation('agent365-cosmos')),
        )
        store.mutate(
          (document) => document.documentType === 'connector-source',
          (document) => {
            document.source = withLegacyAgent365Retry(document.source as ConnectorSourceDefinition)
          },
        )

        const [listed] = await repository.list(ESTATE_A)

        expect(listed).toMatchObject({
          sourceId: 'agent365-primary',
          enabled: false,
          configuration: { limits: { maxRetryAfterMs: 120_000 } },
          migration: {
            status: 'migration-required',
            reason: 'legacy-agent365-retry-after-limit',
          },
        })
        await expect(
          repository.update(
            ESTATE_A,
            created.sourceId,
            created.etag,
            { enabled: true },
            mutation('legacy-agent365-cosmos-update', '2026-09-04T00:01:00.000Z'),
          ),
        ).resolves.toEqual({ status: 'migration_required' })
        await expect(
          repository.delete(
            ESTATE_A,
            created.sourceId,
            created.etag,
            mutation('legacy-agent365-cosmos-delete', '2026-09-04T00:01:00.000Z'),
          ),
        ).resolves.toEqual({ status: 'migration_required' })
      })
    })

    const [listed] = await repository.listAudit(ESTATE_A, after.sourceId)

    expect(listed).toMatchObject({
      id: audit.id,
      actor: audit.actor,
      occurredAt: audit.occurredAt,
      idempotencyKey: audit.idempotencyKey,
      before: {
        displayName: before.displayName,
        version: before.version,
        etag: before.etag,
        migration: { status: 'migration-required' },
      },
      after: {
        displayName: after.displayName,
        version: after.version,
        etag: after.etag,
        migration: { status: 'migration-required' },
      },
    })
    expect(listed?.before?.configuration).not.toHaveProperty('sourceProjectId')
    expect(listed?.after?.configuration).not.toHaveProperty('sourceProjectId')
  })

  it('keeps in-memory listing safe and migration-required without an exact binding', async () => {
    const current = {
      ...azureMonitorSource(ESTATE_A),
      version: 1,
      etag: 'legacy-etag',
      createdBy: { type: 'user', id: 'administrator@example.test' } as const,
      updatedBy: { type: 'user', id: 'administrator@example.test' } as const,
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
    } satisfies ConnectorSourceDefinition
    const repository = new InMemoryConnectorSourceRepository({
      persistedSources: [withoutSourceProjectId(current)],
    })

    const listed = await repository.list(ESTATE_A)

    expect(listed).toHaveLength(1)
    expect(connectorSourceReadModelSchema.parse(listed[0])).toMatchObject({
      sourceId: 'azure-monitor-primary',
      enabled: false,
      migration: {
        status: 'migration-required',
        active: false,
        reason: 'missing-source-project-id',
      },
    })
  })

  it('keeps Cosmos listing safe and migration-required without an exact binding', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosConnectorSourceRepository(store.client)
    await repository.create(ESTATE_A, azureMonitorSource(ESTATE_A), mutation('legacy-cosmos'))
    store.mutate(
      (document) => document.documentType === 'connector-source',
      (document) => {
        const sourceValue = document.source as ConnectorSourceDefinition
        document.source = withoutSourceProjectId(sourceValue)
      },
    )

    const listed = await repository.list(ESTATE_A)

    expect(listed).toHaveLength(1)
    expect(connectorSourceReadModelSchema.parse(listed[0])).toMatchObject({
      sourceId: 'azure-monitor-primary',
      enabled: false,
      migration: { status: 'migration-required' },
    })
  })

  it('hydrates Cosmos legacy audit listing and idempotent replay without mutating history', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosConnectorSourceRepository(store.client)
    const operation = mutation('legacy-audit-cosmos')
    const created = await repository.create(ESTATE_A, azureMonitorSource(ESTATE_A), operation)
    expect(created.status).toBe('applied')
    store.mutate(
      (document) => document.documentType === 'connector-source-audit',
      (document) => {
        document.audit = withoutAuditSourceProjectIds(document.audit as ConnectorSourceAuditRecord)
      },
    )
    const persistedBeforeRead = store.snapshot()

    const [listed] = await repository.listAudit(ESTATE_A, 'azure-monitor-primary')
    const replayed = await repository.create(ESTATE_A, azureMonitorSource(ESTATE_A), operation)

    expect(listed).toMatchObject({
      id: operation.auditId,
      actor: operation.actor,
      occurredAt: operation.occurredAt,
      idempotencyKey: operation.idempotencyKey,
      before: null,
      after: {
        version: 1,
        etag: requireSource(created).etag,
        migration: { status: 'migration-required' },
      },
    })
    expect(replayed).toMatchObject({
      status: 'idempotent',
      source: { migration: { status: 'migration-required' } },
      audit: {
        id: operation.auditId,
        actor: operation.actor,
        occurredAt: operation.occurredAt,
        after: { migration: { status: 'migration-required' } },
      },
    })
    expect(store.snapshot()).toEqual(persistedBeforeRead)
  })

  it.each(['in-memory', 'Cosmos'] as const)(
    'hydrates %s legacy records only from the exact authoritative deployment source',
    async (kind) => {
      const authoritativeInput = azureMonitorSource(ESTATE_A, {
        origin: 'deployment',
        enabled: true,
      })
      const authoritative = {
        ...authoritativeInput,
        version: 1,
        etag: 'deployment-etag',
        createdBy: { type: 'deployment', id: 'deployment-json' } as const,
        updatedBy: { type: 'deployment', id: 'deployment-json' } as const,
        createdAt: '1970-01-01T00:00:00.000Z',
        updatedAt: '1970-01-01T00:00:00.000Z',
      } satisfies ConnectorSourceDefinition
      const legacyCurrent = {
        ...azureMonitorSource(ESTATE_A),
        version: 1,
        etag: 'legacy-etag',
        createdBy: { type: 'user', id: 'administrator@example.test' } as const,
        updatedBy: { type: 'user', id: 'administrator@example.test' } as const,
        createdAt: '2026-09-04T00:00:00.000Z',
        updatedAt: '2026-09-04T00:00:00.000Z',
      } satisfies ConnectorSourceDefinition
      const legacyAudit = {
        id: 'legacy-authoritative-audit',
        estateId: ESTATE_A.id,
        tenantId: ESTATE_A.tenantId,
        environment: ESTATE_A.environment,
        sourceId: legacyCurrent.sourceId,
        operation: 'create',
        actor: legacyCurrent.createdBy,
        occurredAt: legacyCurrent.createdAt,
        idempotencyKey: 'legacy-authoritative-create',
        before: null,
        after: legacyCurrent,
      } satisfies ConnectorSourceAuditRecord
      if (kind === 'in-memory') {
        const repository = new InMemoryConnectorSourceRepository({
          persistedSources: [withoutSourceProjectId(legacyCurrent)],
          persistedAudits: [withoutAuditSourceProjectIds(legacyAudit)],
          authoritativeSources: [authoritative],
        })
        await expect(repository.list(ESTATE_A)).resolves.toMatchObject([
          { configuration: { sourceProjectId: 'project-a' } },
        ])
        await expect(repository.listAudit(ESTATE_A, legacyCurrent.sourceId)).resolves.toMatchObject(
          [{ after: { configuration: { sourceProjectId: 'project-a' } } }],
        )
        return
      }

      const store = new FakeCosmosStore()
      const repository = new CosmosConnectorSourceRepository(store.client, {
        authoritativeSources: [authoritative],
      })
      await repository.create(
        ESTATE_A,
        azureMonitorSource(ESTATE_A),
        mutation('bound-legacy-cosmos'),
      )
      store.mutate(
        (document) =>
          document.documentType === 'connector-source' ||
          document.documentType === 'connector-source-audit',
        (document) => {
          if (document.documentType === 'connector-source') {
            const sourceValue = document.source as ConnectorSourceDefinition
            document.source = withoutSourceProjectId(sourceValue)
          } else {
            document.audit = withoutAuditSourceProjectIds(
              document.audit as ConnectorSourceAuditRecord,
            )
          }
        },
      )
      await expect(repository.list(ESTATE_A)).resolves.toMatchObject([
        { configuration: { sourceProjectId: 'project-a' } },
      ])
      await expect(repository.listAudit(ESTATE_A, legacyCurrent.sourceId)).resolves.toMatchObject([
        { after: { configuration: { sourceProjectId: 'project-a' } } },
      ])
    },
  )
})

describe('Cosmos connector source documents', () => {
  it('uses estate-scoped hashed physical IDs without secret fields', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosConnectorSourceRepository(store.client)
    await repository.create(ESTATE_A, source(ESTATE_A), mutation('create'))
    const documents = store.snapshot()
    expect(documents).toHaveLength(4)
    expect(
      documents.filter((document) => document.documentType === 'connector-source-estate-boundary'),
    ).toHaveLength(1)
    expect(documents.every((document) => document.estateId === ESTATE_A.id)).toBe(true)
    expect(documents.every((document) => document.tenantId === ESTATE_A.tenantId)).toBe(true)
    expect(documents.every((document) => document.environment === ESTATE_A.environment)).toBe(true)
    expect(documents.every((document) => !document.id.includes('shared-source'))).toBe(true)
    expect(JSON.stringify(documents)).not.toMatch(
      /password|clientSecret|accessToken|rawCredentials/i,
    )
  })

  it('returns the exact idempotent result for concurrent identical updates after natural 412', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosConnectorSourceRepository(store.client)
    const created = requireSource(
      await repository.create(ESTATE_A, source(ESTATE_A), mutation('race-update-create')),
    )
    const operation = mutation('race-update', '2026-09-04T00:01:00.000Z')
    const patch = { displayName: 'Concurrently updated source' }

    store.barrierNextBatches()
    const results = await Promise.all([
      repository.update(ESTATE_A, created.sourceId, created.etag, patch, operation),
      repository.update(ESTATE_A, created.sourceId, created.etag, patch, operation),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['applied', 'idempotent'])
    const applied = results.find((result) => result.status === 'applied')
    const idempotent = results.find((result) => result.status === 'idempotent')
    if (applied?.status !== 'applied' || idempotent?.status !== 'idempotent') {
      throw new Error('Expected one applied and one idempotent update result.')
    }
    expect(idempotent.source).toEqual(applied.source)
    expect(idempotent.audit).toEqual(applied.audit)
    expect(applied.source).toMatchObject({
      displayName: patch.displayName,
      version: 2,
      updatedAt: operation.occurredAt,
    })
    expect(applied.source?.etag).not.toBe(created.etag)

    const documents = store.snapshot()
    expect(
      documents.filter((document) => document.documentType === 'connector-source'),
    ).toHaveLength(1)
    expect(
      documents.filter((document) => document.documentType === 'connector-source-audit'),
    ).toHaveLength(2)
    expect(
      documents.filter((document) => document.documentType === 'connector-source-idempotency'),
    ).toHaveLength(2)
    expect(documents).toHaveLength(6)
    expect(documents.every((document) => document.estateId === ESTATE_A.id)).toBe(true)
    expect(documents.every((document) => document.tenantId === ESTATE_A.tenantId)).toBe(true)
    expect(documents.every((document) => document.environment === ESTATE_A.environment)).toBe(true)
    await expect(repository.findById(ESTATE_A, created.sourceId)).resolves.toEqual(applied.source)
    await expect(repository.listAudit(ESTATE_A, created.sourceId)).resolves.toEqual([
      expect.objectContaining({ operation: 'create' }),
      applied.audit,
    ])
    await expect(
      repository.update(
        ESTATE_A,
        created.sourceId,
        created.etag,
        { displayName: 'Different update' },
        operation,
      ),
    ).resolves.toEqual({ status: 'conflict', reason: 'idempotency_key_reuse' })
    await expect(
      Promise.resolve().then(() =>
        repository.update(ESTATE_A_WRONG_TENANT, created.sourceId, created.etag, patch, operation),
      ),
    ).rejects.toThrow(/estate boundary/i)
    expect(store.snapshot()).toEqual(documents)
  })

  it('returns the exact idempotent result for concurrent identical updates after forced 412', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosConnectorSourceRepository(store.client)
    const created = requireSource(
      await repository.create(ESTATE_A, source(ESTATE_A), mutation('forced-update-create')),
    )
    const operation = mutation('forced-update', '2026-09-04T00:01:00.000Z')
    const patch = { displayName: 'Forced-conflict update' }

    store.barrierNextBatches(2, 412)
    const results = await Promise.all([
      repository.update(ESTATE_A, created.sourceId, created.etag, patch, operation),
      repository.update(ESTATE_A, created.sourceId, created.etag, patch, operation),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['applied', 'idempotent'])
    const applied = results.find((result) => result.status === 'applied')
    const idempotent = results.find((result) => result.status === 'idempotent')
    if (applied?.status !== 'applied' || idempotent?.status !== 'idempotent') {
      throw new Error('Expected one applied and one idempotent forced-412 update result.')
    }
    expect(idempotent.source).toEqual(applied.source)
    expect(idempotent.audit).toEqual(applied.audit)
    const documents = store.snapshot()
    expect(
      documents.filter((document) => document.documentType === 'connector-source'),
    ).toHaveLength(1)
    expect(
      documents.filter((document) => document.documentType === 'connector-source-audit'),
    ).toHaveLength(2)
    expect(
      documents.filter((document) => document.documentType === 'connector-source-idempotency'),
    ).toHaveLength(2)
    expect(documents).toHaveLength(6)
  })

  it('returns the exact idempotent result for concurrent identical deletes after forced 404', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosConnectorSourceRepository(store.client)
    const created = requireSource(
      await repository.create(ESTATE_A, source(ESTATE_A), mutation('race-delete-create')),
    )
    const operation = mutation('race-delete', '2026-09-04T00:01:00.000Z')

    store.barrierNextBatches(2, 404)
    const results = await Promise.all([
      repository.delete(ESTATE_A, created.sourceId, created.etag, operation),
      repository.delete(ESTATE_A, created.sourceId, created.etag, operation),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['applied', 'idempotent'])
    const applied = results.find((result) => result.status === 'applied')
    const idempotent = results.find((result) => result.status === 'idempotent')
    if (applied?.status !== 'applied' || idempotent?.status !== 'idempotent') {
      throw new Error('Expected one applied and one idempotent delete result.')
    }
    expect(applied.source).toBeNull()
    expect(idempotent.source).toBeNull()
    expect(idempotent.audit).toEqual(applied.audit)
    expect(applied.audit).toMatchObject({
      operation: 'delete',
      occurredAt: operation.occurredAt,
      before: { etag: created.etag, updatedAt: created.updatedAt },
      after: null,
    })

    const documents = store.snapshot()
    const sourceDocuments = documents.filter(
      (document) => document.documentType === 'connector-source',
    )
    expect(sourceDocuments).toHaveLength(1)
    expect(sourceDocuments[0]).toMatchObject({
      deleted: true,
      source: { etag: created.etag, updatedAt: created.updatedAt },
    })
    expect(
      documents.filter((document) => document.documentType === 'connector-source-audit'),
    ).toHaveLength(2)
    expect(
      documents.filter((document) => document.documentType === 'connector-source-idempotency'),
    ).toHaveLength(2)
    expect(documents).toHaveLength(6)
    expect(documents.every((document) => document.estateId === ESTATE_A.id)).toBe(true)
    expect(documents.every((document) => document.tenantId === ESTATE_A.tenantId)).toBe(true)
    expect(documents.every((document) => document.environment === ESTATE_A.environment)).toBe(true)
    await expect(repository.findById(ESTATE_A, created.sourceId)).resolves.toBeNull()
    await expect(repository.listAudit(ESTATE_A, created.sourceId)).resolves.toEqual([
      expect.objectContaining({ operation: 'create' }),
      applied.audit,
    ])
    await expect(
      repository.delete(ESTATE_A, created.sourceId, 'different-etag', operation),
    ).resolves.toEqual({ status: 'conflict', reason: 'idempotency_key_reuse' })
    await expect(
      Promise.resolve().then(() =>
        repository.delete(ESTATE_A_WRONG_ENVIRONMENT, created.sourceId, created.etag, operation),
      ),
    ).rejects.toThrow(/estate boundary/i)
    expect(store.snapshot()).toEqual(documents)
  })

  it('rejects a forced-409 concurrent loser with the same key and a different fingerprint without partial documents', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosConnectorSourceRepository(store.client)
    const created = requireSource(
      await repository.create(ESTATE_A, source(ESTATE_A), mutation('race-reuse-create')),
    )
    const operation = mutation('race-reuse', '2026-09-04T00:01:00.000Z')
    const winnerPatch = { displayName: 'Winning update' }
    const loserPatch = { displayName: 'Losing update' }
    const documentsBeforeRace = store.snapshot()

    store.barrierNextBatches(2, 409)
    const [winner, loser] = await Promise.all([
      repository.update(ESTATE_A, created.sourceId, created.etag, winnerPatch, operation),
      repository.update(ESTATE_A, created.sourceId, created.etag, loserPatch, operation),
    ])

    expect(winner).toMatchObject({
      status: 'applied',
      source: { displayName: winnerPatch.displayName, version: 2 },
    })
    expect(loser).toEqual({ status: 'conflict', reason: 'idempotency_key_reuse' })

    const documents = store.snapshot()
    const sourceDocuments = documents.filter(
      (document) => document.documentType === 'connector-source',
    )
    expect(sourceDocuments).toHaveLength(
      documentsBeforeRace.filter((document) => document.documentType === 'connector-source').length,
    )
    expect(sourceDocuments[0]).toMatchObject({
      source: { displayName: winnerPatch.displayName, version: 2 },
    })
    expect(sourceDocuments[0]?.deleted).not.toBe(true)
    expect(
      documents.filter((document) => document.documentType === 'connector-source-audit'),
    ).toHaveLength(
      documentsBeforeRace.filter((document) => document.documentType === 'connector-source-audit')
        .length + 1,
    )
    expect(
      documents.filter((document) => document.documentType === 'connector-source-idempotency'),
    ).toHaveLength(
      documentsBeforeRace.filter(
        (document) => document.documentType === 'connector-source-idempotency',
      ).length + 1,
    )
    expect(sourceDocuments.filter((document) => document.deleted === true)).toHaveLength(
      documentsBeforeRace.filter(
        (document) => document.documentType === 'connector-source' && document.deleted === true,
      ).length,
    )
    expect(documents).toHaveLength(6)
    await expect(repository.findById(ESTATE_A, created.sourceId)).resolves.toMatchObject({
      displayName: winnerPatch.displayName,
      version: 2,
    })
    await expect(repository.listAudit(ESTATE_A, created.sourceId)).resolves.toHaveLength(2)
    expect(store.snapshot()).toEqual(documents)
  })
})
