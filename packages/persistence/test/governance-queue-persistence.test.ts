import { describe, expect, it } from 'vitest'

import type { GovernanceCase, GovernanceCaseTransition } from '@agent-sentinel/domain'
import { InMemoryGovernanceCaseRepository } from '../src/index.js'

const caseRecord: GovernanceCase = {
  id: 'case-1',
  kind: 'finding-review',
  title: 'Immutable history',
  description: 'Verify callers cannot mutate persisted audit evidence.',
  status: 'open',
  createdByIdentity: 'anonymous',
  createdByRole: 'Anonymous',
  createdAt: '2026-08-26T00:00:00.000Z',
  lastTransitionAt: '2026-08-26T00:00:00.000Z',
  evidenceSnapshotIds: ['snapshot-1'],
  sourceMode: 'mock',
  writeEnabledAtCreation: false,
}

const transition: GovernanceCaseTransition = {
  id: 'transition-1',
  caseId: 'case-1',
  operation: 'create',
  fromStatus: null,
  toStatus: 'open',
  actorIdentity: 'anonymous',
  actorRole: 'Anonymous',
  actorCapability: 'proposeRemediation',
  timestamp: '2026-08-26T00:00:00.000Z',
  authorizationContext: {
    mode: 'disabled',
    authenticated: false,
    subject: 'anonymous',
  },
  source: {
    type: 'governance-workflow',
    mode: 'mock',
    referenceIds: ['case-1', 'snapshot-1'],
  },
  evidenceSnapshotIds: ['snapshot-1'],
  idempotencyKey: 'create-case-1',
}

describe('InMemoryGovernanceCaseRepository', () => {
  it('returns clones so persisted audit history is append-only to callers', async () => {
    const repository = InMemoryGovernanceCaseRepository.seed([caseRecord], [transition])
    const firstRead = await repository.findById('case-1')
    expect(firstRead).not.toBeNull()
    firstRead!.transitions[0]!.source.referenceIds.push('tampered')
    firstRead!.transitions[0]!.actorIdentity = 'tampered'

    const secondRead = await repository.findById('case-1')
    expect(secondRead?.transitions[0]).toMatchObject({
      actorIdentity: 'anonymous',
      source: { referenceIds: ['case-1', 'snapshot-1'] },
    })
  })
})
