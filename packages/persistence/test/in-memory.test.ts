import { describe, expect, it } from 'vitest'

import type { EstateSnapshot, Finding, ValidationRun } from '@agent-sentinel/domain'

import {
  InMemoryFindingRepository,
  InMemorySnapshotRepository,
  InMemoryValidationRunRepository,
} from '../src/index.js'

const snapshotOne: EstateSnapshot = {
  tenantId: 'tenant-one',
  environment: 'production',
  generatedAt: '2024-01-01T00:00:00.000Z',
  nodes: [],
  edges: [],
  evidence: [],
}

const snapshotTwo: EstateSnapshot = {
  ...snapshotOne,
  generatedAt: '2024-01-02T00:00:00.000Z',
}

const finding: Finding & { tenantId: string } = {
  id: 'finding-1',
  tenantId: 'tenant-one',
  title: 'Exposed agent',
  summary: 'An agent is reachable from an untrusted input.',
  severity: 'high',
  owner: 'security-team',
  policyId: 'policy-1',
  detectedAt: '2024-01-01T00:00:00.000Z',
  recommendation: 'Restrict the input path.',
  path: {
    id: 'path-1',
    nodeIds: ['node-1', 'node-2'],
    edgeIds: ['edge-1'],
    evidenceIds: ['evidence-1'],
    riskScore: 80,
    status: 'theoretical',
    factors: {
      reachability: 1,
      exploitability: 0.8,
      businessImpact: 0.8,
      privilege: 0.7,
      dataSensitivity: 0.8,
      activity: 0.5,
      confidence: 0.9,
      compensatingControlDiscount: 0.1,
    },
  },
}

const validationRun: ValidationRun = {
  id: 'run-1',
  findingId: 'finding-1',
  status: 'queued',
  startedAt: '2024-01-03T00:00:00.000Z',
  syntheticCanary: 'canary-1',
  trace: [],
}

describe('in-memory repositories', () => {
  it('saves, finds the latest, and lists snapshots', async () => {
    const repository = new InMemorySnapshotRepository()
    await repository.save(snapshotOne)
    await repository.save(snapshotTwo)

    await expect(repository.findLatest('tenant-one', 'production')).resolves.toEqual(snapshotTwo)
    await expect(repository.list('tenant-one', 1)).resolves.toEqual([snapshotTwo])
  })

  it('saves, finds, and filters findings', async () => {
    const repository = new InMemoryFindingRepository()
    await repository.save(finding)

    await expect(repository.findById('finding-1')).resolves.toEqual(finding)
    await expect(repository.listByTenantAndSeverity('tenant-one', 'high')).resolves.toEqual([
      finding,
    ])
    await expect(repository.listByTenantAndSeverity('tenant-one', 'critical')).resolves.toEqual([])
  })

  it('saves, lists, and updates validation runs', async () => {
    const repository = new InMemoryValidationRunRepository()
    await repository.save(validationRun)

    await expect(repository.findByFindingId('finding-1')).resolves.toEqual([validationRun])
    await expect(repository.update('run-1', { status: 'running' })).resolves.toMatchObject({
      id: 'run-1',
      status: 'running',
    })
  })
})
