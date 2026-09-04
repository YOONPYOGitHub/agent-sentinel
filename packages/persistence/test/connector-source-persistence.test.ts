import { describe, expect, it } from 'vitest'

import type { ConnectorSourceDefinition, EstateContext } from '@agent-sentinel/domain'
import { connectorSourceDefinitionSchema } from '@agent-sentinel/domain'

import {
  CosmosConnectorSourceRepository,
  InMemoryConnectorSourceRepository,
} from '../src/index.js'
import { FakeCosmosStore } from './fake-cosmos.js'

const estateA: EstateContext = { id: 'default', tenantId: 'tenant-a', environment: 'prod' }
const estateB: EstateContext = { id: 'secondary', tenantId: 'tenant-a', environment: 'staging' }

function makeSource(
  id = 'source-1',
  estate: EstateContext = estateA,
  origin: 'deployment' | 'user' = 'user',
  enabled = true,
): ConnectorSourceDefinition {
  return connectorSourceDefinitionSchema.parse({
    id,
    estateId: estate.id,
    tenantId: estate.tenantId,
    environment: estate.environment,
    connectorType: 'azure-resource-graph',
    displayName: `Connector ${id}`,
    enabled,
    origin,
    config: { kind: 'azure-resource-graph', subscriptionId: 'sub-123', resourceGroup: 'rg-demo' },
    credential: { mode: 'managed-identity', identityName: 'source-identity' },
    version: 1,
    etag: 'etag-1',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    actor: { type: origin === 'deployment' ? 'deployment' : 'user', id: origin === 'deployment' ? 'deployment-actor' : 'alice' },
    status: 'not-tested',
    auditHistory: [],
  })
}

describe('InMemoryConnectorSourceRepository', () => {
  it('isolates sources by estate and keeps idempotent create retries stable', async () => {
    const repository = new InMemoryConnectorSourceRepository()
    const source = makeSource('shared-source', estateA)

    const first = await repository.create(estateA, source, 'create-1')
    const second = await repository.create(estateA, source, 'create-1')
    const crossEstate = await repository.create(estateB, source, 'create-2')

    expect(first.created).toBe(true)
    expect(second).toMatchObject({ created: false, reason: 'idempotency_conflict' })
    expect(crossEstate.created).toBe(true)
    expect((await repository.list(estateA)).total).toBe(1)
    expect((await repository.list(estateB)).total).toBe(1)
  })

  it('rejects stale ETags and deployment overrides', async () => {
    const repository = new InMemoryConnectorSourceRepository()
    const deploymentSource = makeSource('deployment-source', estateA, 'deployment')
    await repository.create(estateA, deploymentSource, 'deploy-create')

    const stale = await repository.update(
      estateA,
      deploymentSource.id,
      'wrong-etag',
      {
        ...deploymentSource,
        enabled: false,
        etag: 'etag-2',
        version: 2,
        updatedAt: '2026-08-28T00:00:00.000Z',
        actor: { type: 'user', id: 'mallory' },
        status: 'disabled',
      },
      'deploy-update',
    )
    expect(stale).toEqual({ applied: false, reason: 'etag_conflict' })

    const immutable = await repository.update(
      estateA,
      deploymentSource.id,
      deploymentSource.etag,
      {
        ...deploymentSource,
        enabled: false,
        etag: 'etag-2',
        version: 2,
        updatedAt: '2026-08-28T00:00:00.000Z',
        actor: { type: 'user', id: 'mallory' },
        status: 'disabled',
      },
      'deploy-update-2',
    )
    expect(immutable).toEqual({ applied: false, reason: 'immutable_origin' })
  })

  it('records immutable audit transitions for create and update events', async () => {
    const repository = new InMemoryConnectorSourceRepository()
    const source = makeSource('audit-source', estateA)
    await repository.create(estateA, source, 'audit-create')

    const updated = await repository.update(
      estateA,
      source.id,
      source.etag,
      { ...source, enabled: false, status: 'disabled', etag: 'etag-2', version: 2, updatedAt: '2026-08-28T00:00:00.000Z', actor: { type: 'user', id: 'alice' } },
      'audit-update',
    )

    expect(updated).toMatchObject({ applied: true })
    const history = await repository.getAuditHistory(estateA, source.id)
    expect(history.map((transition) => transition.action)).toEqual(['create', 'disable'])
  })
})

describe('CosmosConnectorSourceRepository', () => {
  it('isolates estates via tenant partition, preserves ETag conflicts, and keeps audit history immutable', async () => {
    const store = new FakeCosmosStore()
    const repository = new CosmosConnectorSourceRepository(store.client, { tenantId: 'tenant-a' })
    const source = makeSource('cosmos-source', estateA)

    await expect(repository.create(estateA, source, 'cosmos-create')).resolves.toMatchObject({
      created: true,
    })
    await expect(repository.create(estateA, source, 'cosmos-create')).resolves.toMatchObject({
      reason: 'idempotency_conflict',
      created: false,
    })
    await expect(repository.create(estateB, source, 'cosmos-create-other')).resolves.toMatchObject({
      created: true,
    })

    const updated = await repository.update(
      estateA,
      source.id,
      source.etag,
      {
        ...source,
        enabled: false,
        etag: 'etag-2',
        version: 2,
        updatedAt: '2026-08-28T00:00:00.000Z',
        status: 'disabled',
        actor: { type: 'user', id: 'alice' },
      },
      'cosmos-update',
    )
    expect(updated).toMatchObject({ applied: true })
    expect(await repository.getAuditHistory(estateA, source.id)).toHaveLength(2)

    const stale = await repository.update(
      estateA,
      source.id,
      'wrong-etag',
      {
        ...source,
        enabled: true,
        etag: 'etag-3',
        version: 3,
        updatedAt: '2026-08-29T00:00:00.000Z',
        status: 'ready',
        actor: { type: 'user', id: 'alice' },
      },
      'cosmos-update-2',
    )
    expect(stale).toEqual({ applied: false, reason: 'etag_conflict' })
  })
})
