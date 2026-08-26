import { describe, expect, it } from 'vitest'

import {
  governanceCaseSchema,
  governanceCaseTransitionSchema,
  validTransitionsForCase,
  type GovernanceCase,
} from '../src/index.js'

function caseRecord(overrides: Partial<GovernanceCase> = {}): GovernanceCase {
  return governanceCaseSchema.parse({
    id: 'case-1',
    kind: 'finding-review',
    title: 'Review a finding',
    description: 'Review cited evidence.',
    status: 'open',
    createdByIdentity: 'Analyst',
    createdByRole: 'Analyst',
    createdAt: '2026-08-26T00:00:00.000Z',
    lastTransitionAt: '2026-08-26T00:00:00.000Z',
    evidenceSnapshotIds: ['snapshot-1'],
    sourceMode: 'mock',
    writeEnabledAtCreation: false,
    ...overrides,
  })
}

describe('governance workflow domain', () => {
  it('requires bounded policy exceptions and explicit lifecycle actions', () => {
    expect(() => caseRecord({ kind: 'policy-exception' })).toThrow()
    expect(() => caseRecord({ kind: 'lifecycle-review', agentId: 'agent-1' })).toThrow()

    expect(
      caseRecord({
        kind: 'policy-exception',
        policyId: 'AS-POL-001',
        expiresAt: '2026-09-01T00:00:00.000Z',
      }),
    ).toMatchObject({ policyId: 'AS-POL-001' })
    expect(
      caseRecord({
        kind: 'lifecycle-review',
        agentId: 'agent-1',
        lifecycleAction: 'rollback',
      }),
    ).toMatchObject({ lifecycleAction: 'rollback' })
  })

  it('offers only the lifecycle action selected by an approved case', () => {
    const lifecycle = caseRecord({
      kind: 'lifecycle-review',
      status: 'approved',
      agentId: 'agent-1',
      lifecycleAction: 'retire',
    })
    expect(validTransitionsForCase(lifecycle)).toEqual(['expire', 'retire'])
    expect(validTransitionsForCase(caseRecord({ status: 'approved' }))).toEqual(['close', 'expire'])
  })

  it('validates immutable audit evidence and assignment operations', () => {
    const transition = {
      id: 'transition-1',
      caseId: 'case-1',
      operation: 'pick-up',
      fromStatus: 'open',
      toStatus: 'in-review',
      actorIdentity: 'Morgan Coordinator',
      actorRole: 'Analyst',
      actorCapability: 'validateFinding',
      timestamp: '2026-08-26T00:01:00.000Z',
      authorizationContext: {
        mode: 'mock',
        authenticated: false,
        subject: 'Morgan Coordinator',
      },
      source: {
        type: 'governance-workflow',
        mode: 'mock',
        referenceIds: ['case-1', 'snapshot-1'],
      },
      assignedToIdentity: 'Dana Reviewer',
      evidenceSnapshotIds: ['snapshot-1'],
      idempotencyKey: 'transition-1',
    }

    expect(governanceCaseTransitionSchema.parse(transition)).toMatchObject({
      assignedToIdentity: 'Dana Reviewer',
    })
    expect(() =>
      governanceCaseTransitionSchema.parse({
        ...transition,
        operation: 'propose',
        fromStatus: 'in-review',
        toStatus: 'pending-approval',
      }),
    ).toThrow()
  })
})
