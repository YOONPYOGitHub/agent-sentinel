import { describe, expect, it } from 'vitest'

import type { EstateContext, EstateSnapshot, RiskFactors } from '@agent-sentinel/domain'

import {
  calculateBlastRadius,
  createLiveGraphTraversalContextForSnapshot,
  disableEdge,
  findAttackPaths,
  simulateEdgeRemoval,
  trustedMockGraphTraversalContext,
} from '../src/index.js'

const evidence = {
  id: 'evidence-1',
  source: 'mock',
  sourceObjectId: 'object-1',
  observedAt: '2026-08-14T12:00:00.000Z',
  freshness: 'live' as const,
  confidence: 1,
  evidenceTypes: ['synthetic_validation' as const],
  summary: 'Synthetic evidence',
}

const snapshot: EstateSnapshot = {
  tenantId: 'tenant-demo',
  environment: 'demo',
  generatedAt: '2026-08-14T12:00:00.000Z',
  evidence: [evidence],
  nodes: ['input', 'agent', 'identity', 'data', 'mcp'].map((id) => ({
    id,
    kind:
      id === 'input'
        ? 'input'
        : id === 'agent'
          ? 'agent'
          : id === 'identity'
            ? 'identity'
            : id === 'data'
              ? 'data'
              : 'mcp',
    name: id,
    description: id,
    environment: 'demo',
    evidenceIds: [evidence.id],
    metadata: {},
  })),
  edges: [
    ['input-agent', 'input', 'agent', 'TRIGGERS', false],
    ['agent-identity', 'agent', 'identity', 'RUNS_AS', false],
    ['identity-data', 'identity', 'data', 'CAN_READ', false],
    ['data-mcp', 'data', 'mcp', 'CAN_EXFILTRATE_TO', true],
  ].map(([id, from, to, relationship, removable]) => ({
    id: String(id),
    from: String(from),
    to: String(to),
    relationship: relationship as 'TRIGGERS',
    evidenceIds: [evidence.id],
    active: true,
    removable: Boolean(removable),
  })),
}

const factors: RiskFactors = {
  reachability: 1,
  exploitability: 1,
  businessImpact: 1,
  privilege: 1,
  dataSensitivity: 1,
  activity: 1,
  confidence: 1,
  compensatingControlDiscount: 0.05,
}

describe('graph engine', () => {
  it('finds an evidence-backed path from untrusted input to external MCP', () => {
    const paths = findAttackPaths(
      snapshot,
      {
        sourceNodeIds: ['input'],
        targetNodeIds: ['mcp'],
        factors,
      },
      trustedMockGraphTraversalContext,
    )

    expect(paths).toHaveLength(1)
    expect(paths[0]?.nodeIds).toEqual(['input', 'agent', 'identity', 'data', 'mcp'])
    expect(paths[0]?.riskScore).toBe(95)
    expect(paths[0]?.evidenceIds).toEqual(['evidence-1'])
  })

  it('removes the attack path and reduces blast radius after remediation', () => {
    const before = calculateBlastRadius(snapshot, 'input', trustedMockGraphTraversalContext)
    const remediated = disableEdge(snapshot, 'data-mcp')
    const after = calculateBlastRadius(remediated, 'input', trustedMockGraphTraversalContext)
    const paths = findAttackPaths(
      remediated,
      {
        sourceNodeIds: ['input'],
        targetNodeIds: ['mcp'],
        factors,
      },
      trustedMockGraphTraversalContext,
    )

    expect(before.map((node) => node.id)).toContain('mcp')
    expect(after.map((node) => node.id)).not.toContain('mcp')
    expect(paths).toHaveLength(0)
  })

  it('previews a non-removable edge without mutating the source snapshot', () => {
    const immutableEdge = snapshot.edges.find((edge) => edge.id === 'data-mcp')
    expect(immutableEdge).toBeDefined()
    const previewSource = {
      ...snapshot,
      edges: snapshot.edges.map((edge) =>
        edge.id === 'data-mcp' ? { ...edge, removable: false } : edge,
      ),
    }

    const preview = simulateEdgeRemoval(previewSource, 'data-mcp')

    expect(preview.edges.find((edge) => edge.id === 'data-mcp')?.active).toBe(false)
    expect(previewSource.edges.find((edge) => edge.id === 'data-mcp')?.active).toBe(true)
  })

  it('retains an alternate active path when only one route is simulated as removed', () => {
    const alternateSnapshot: EstateSnapshot = {
      ...snapshot,
      edges: [
        ...snapshot.edges,
        {
          id: 'agent-mcp-alternate',
          from: 'agent',
          to: 'mcp',
          relationship: 'CAN_CALL',
          evidenceIds: [evidence.id],
          active: true,
          removable: true,
        },
      ],
    }

    const simulated = simulateEdgeRemoval(alternateSnapshot, 'data-mcp')
    const paths = findAttackPaths(
      simulated,
      {
        sourceNodeIds: ['input'],
        targetNodeIds: ['mcp'],
        factors,
      },
      trustedMockGraphTraversalContext,
    )

    expect(paths).toHaveLength(1)
    expect(paths[0]?.edgeIds).toContain('agent-mcp-alternate')
  })

  it('traverses RUNS_AS only with the registered exact live endpoint evidence pair', () => {
    const liveSnapshot = exactLiveSnapshot()
    const context = createLiveGraphTraversalContextForSnapshot(liveSnapshot, {
      estate,
      clock: () => new Date('2026-09-09T00:05:00.000Z'),
      maxEvidenceAgeMs: 15 * 60 * 1_000,
    })

    expect(
      findAttackPaths(
        liveSnapshot,
        { sourceNodeIds: ['agent'], targetNodeIds: ['identity'], factors },
        context,
      ),
    ).toHaveLength(1)
  })

  it('rejects an application binding without application-ID-specific identity authority', () => {
    const liveSnapshot = exactLiveSnapshot()
    const applicationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    liveSnapshot.nodes[0] = {
      ...liveSnapshot.nodes[0]!,
      metadata: {
        ...liveSnapshot.nodes[0]!.metadata,
        entraAppId: applicationId,
      },
    }
    liveSnapshot.nodes[1] = {
      ...liveSnapshot.nodes[1]!,
      metadata: {
        ...liveSnapshot.nodes[1]!.metadata,
        providerObjectId: applicationId,
      },
    }
    liveSnapshot.evidence[1] = {
      ...liveSnapshot.evidence[1]!,
      sourceObjectId: `directory-a:${applicationId}`,
      authority: {
        ...liveSnapshot.evidence[1]!.authority!,
        providerObjectId: applicationId,
      },
    }
    const applicationAuthority = liveSnapshot.evidence[1]?.authority
    if (applicationAuthority === undefined) {
      throw new Error('Expected application authority evidence.')
    }
    liveSnapshot.edges[0] = {
      ...liveSnapshot.edges[0]!,
      runsAsBinding: {
        ...liveSnapshot.edges[0]!.runsAsBinding!,
        identity: applicationAuthority,
        identifier: { kind: 'application-id', value: applicationId },
      },
    }
    const context = createLiveGraphTraversalContextForSnapshot(liveSnapshot, {
      estate,
      clock: () => new Date('2026-09-09T00:05:00.000Z'),
      maxEvidenceAgeMs: 15 * 60 * 1_000,
    })

    expect(
      findAttackPaths(
        liveSnapshot,
        { sourceNodeIds: ['agent'], targetNodeIds: ['identity'], factors },
        context,
      ),
    ).toHaveLength(0)
  })

  it('traverses registered cross-tenant source authorities in an independent estate', () => {
    const liveSnapshot = exactLiveSnapshot()
    const foundryTenantId = '88888888-8888-4888-8888-888888888888'
    const entraTenantId = '77777777-7777-4777-8777-777777777777'
    liveSnapshot.nodes[0] = {
      ...liveSnapshot.nodes[0]!,
      metadata: {
        ...liveSnapshot.nodes[0]!.metadata,
        sourceTenantId: foundryTenantId,
      },
    }
    liveSnapshot.nodes[1] = {
      ...liveSnapshot.nodes[1]!,
      metadata: {
        ...liveSnapshot.nodes[1]!.metadata,
        sourceTenantId: entraTenantId,
        sourceInventoryObjectId: entraTenantId,
      },
    }
    liveSnapshot.evidence[0] = {
      ...liveSnapshot.evidence[0]!,
      authority: {
        ...liveSnapshot.evidence[0]!.authority!,
        tenantId: foundryTenantId,
      },
    }
    liveSnapshot.evidence[1] = {
      ...liveSnapshot.evidence[1]!,
      authority: {
        ...liveSnapshot.evidence[1]!.authority!,
        tenantId: entraTenantId,
        sourceObjectId: entraTenantId,
      },
    }
    const agentAuthority = liveSnapshot.evidence[0]?.authority
    const identityAuthority = liveSnapshot.evidence[1]?.authority
    if (agentAuthority === undefined || identityAuthority === undefined) {
      throw new Error('Expected exact endpoint authority evidence.')
    }
    liveSnapshot.edges[0] = {
      ...liveSnapshot.edges[0]!,
      runsAsBinding: {
        ...liveSnapshot.edges[0]!.runsAsBinding!,
        agent: agentAuthority,
        identity: identityAuthority,
      },
    }
    const context = createLiveGraphTraversalContextForSnapshot(liveSnapshot, {
      estate,
      clock: () => new Date('2026-09-09T00:05:00.000Z'),
    })

    expect(
      findAttackPaths(
        liveSnapshot,
        { sourceNodeIds: ['agent'], targetNodeIds: ['identity'], factors },
        context,
      ),
    ).toHaveLength(1)
  })

  it.each([
    {
      name: 'stale endpoint evidence',
      mutate: (candidate: EstateSnapshot) => {
        candidate.evidence[0] = { ...candidate.evidence[0]!, freshness: 'stale' }
      },
    },
    {
      name: 'synthetic endpoint evidence',
      mutate: (candidate: EstateSnapshot) => {
        candidate.evidence[1] = {
          ...candidate.evidence[1]!,
          evidenceTypes: ['synthetic_validation'],
        }
      },
    },
    {
      name: 'unregistered project authority',
      mutate: (candidate: EstateSnapshot) => {
        candidate.edges[0] = {
          ...candidate.edges[0]!,
          runsAsBinding: {
            ...candidate.edges[0]!.runsAsBinding!,
            agent: {
              ...candidate.edges[0]!.runsAsBinding!.agent,
              sourceObjectId: 'other-project',
            },
          },
        }
      },
    },
    {
      name: 'unregistered source release',
      mutate: (candidate: EstateSnapshot) => {
        candidate.edges[0] = {
          ...candidate.edges[0]!,
          runsAsBinding: {
            ...candidate.edges[0]!.runsAsBinding!,
            identity: {
              ...candidate.edges[0]!.runsAsBinding!.identity,
              sourceRelease: 'beta',
            },
          },
        }
      },
    },
    {
      name: 'unregistered source generation',
      mutate: (candidate: EstateSnapshot) => {
        candidate.edges[0] = {
          ...candidate.edges[0]!,
          runsAsBinding: {
            ...candidate.edges[0]!.runsAsBinding!,
            agent: {
              ...candidate.edges[0]!.runsAsBinding!.agent,
              snapshotGeneratedAt: '2026-09-09T00:01:00.000Z',
            },
          },
        }
      },
    },
    {
      name: 'identifier kind not explicitly supplied by the agent',
      mutate: (candidate: EstateSnapshot) => {
        candidate.edges[0] = {
          ...candidate.edges[0]!,
          runsAsBinding: {
            ...candidate.edges[0]!.runsAsBinding!,
            identifier: {
              kind: 'application-id',
              value: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            },
          },
        }
      },
    },
    {
      name: 'ambiguous agent authority evidence',
      mutate: (candidate: EstateSnapshot) => {
        candidate.evidence.push({
          ...candidate.evidence[0]!,
          id: 'foundry-evidence-duplicate',
        })
        candidate.nodes[0] = {
          ...candidate.nodes[0]!,
          evidenceIds: ['foundry-evidence', 'foundry-evidence-duplicate'],
        }
        candidate.edges[0] = {
          ...candidate.edges[0]!,
          evidenceIds: ['foundry-evidence', 'foundry-evidence-duplicate', 'entra-evidence'],
        }
      },
    },
    {
      name: 'application identifier different from the evidence-backed provider object',
      mutate: (candidate: EstateSnapshot) => {
        candidate.nodes[0] = {
          ...candidate.nodes[0]!,
          metadata: {
            ...candidate.nodes[0]!.metadata,
            entraAppId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
        }
        candidate.edges[0] = {
          ...candidate.edges[0]!,
          runsAsBinding: {
            ...candidate.edges[0]!.runsAsBinding!,
            identifier: {
              kind: 'application-id',
              value: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            },
          },
        }
      },
    },
    {
      name: 'globally registered agent authority evidence not attached to the endpoint',
      mutate: (candidate: EstateSnapshot) => {
        candidate.evidence.push({
          ...candidate.evidence[0]!,
          id: 'foundry-evidence-unattached',
        })
        candidate.edges[0] = {
          ...candidate.edges[0]!,
          evidenceIds: ['foundry-evidence-unattached', 'entra-evidence'],
        }
      },
    },
    {
      name: 'multiple matching agent authority records attached to the endpoint',
      mutate: (candidate: EstateSnapshot) => {
        candidate.evidence.push({
          ...candidate.evidence[0]!,
          id: 'foundry-evidence-duplicate',
        })
        candidate.nodes[0] = {
          ...candidate.nodes[0]!,
          evidenceIds: ['foundry-evidence', 'foundry-evidence-duplicate'],
        }
      },
    },
    {
      name: 'multiple matching identity authority records attached to the endpoint',
      mutate: (candidate: EstateSnapshot) => {
        candidate.evidence.push({
          ...candidate.evidence[1]!,
          id: 'entra-evidence-duplicate',
        })
        candidate.nodes[1] = {
          ...candidate.nodes[1]!,
          evidenceIds: ['entra-evidence', 'entra-evidence-duplicate'],
        }
      },
    },
  ])('rejects $name from live RUNS_AS traversal', ({ mutate }) => {
    const registered = exactLiveSnapshot()
    const context = createLiveGraphTraversalContextForSnapshot(registered, {
      estate,
      clock: () => new Date('2026-09-09T00:05:00.000Z'),
      maxEvidenceAgeMs: 15 * 60 * 1_000,
    })
    const candidate = structuredClone(registered)
    mutate(candidate)

    expect(
      findAttackPaths(
        candidate,
        { sourceNodeIds: ['agent'], targetNodeIds: ['identity'], factors },
        context,
      ),
    ).toHaveLength(0)
  })

  it('rejects duplicate live node IDs before traversal', () => {
    const candidate = exactLiveSnapshot()
    candidate.nodes.push({ ...candidate.nodes[1]! })

    expect(() =>
      createLiveGraphTraversalContextForSnapshot(candidate, {
        estate,
        clock: () => new Date('2026-09-09T00:05:00.000Z'),
      }),
    ).toThrow(/duplicate graph node id/i)
  })

  it('rejects an edge citation that is not attached to its matching endpoint', () => {
    const candidate = exactLiveSnapshot()
    candidate.evidence.push({
      ...candidate.evidence[0]!,
      id: 'foundry-evidence-unattached',
    })
    candidate.edges[0] = {
      ...candidate.edges[0]!,
      evidenceIds: ['foundry-evidence-unattached', 'entra-evidence'],
    }
    const context = createLiveGraphTraversalContextForSnapshot(candidate, {
      estate,
      clock: () => new Date('2026-09-09T00:05:00.000Z'),
    })

    expect(
      findAttackPaths(
        candidate,
        { sourceNodeIds: ['agent'], targetNodeIds: ['identity'], factors },
        context,
      ),
    ).toHaveLength(0)
  })

  it('rejects duplicate live evidence IDs before traversal', () => {
    const candidate = exactLiveSnapshot()
    candidate.evidence.push({ ...candidate.evidence[1]! })

    expect(() =>
      createLiveGraphTraversalContextForSnapshot(candidate, {
        estate,
        clock: () => new Date('2026-09-09T00:05:00.000Z'),
      }),
    ).toThrow(/duplicate evidence id/i)
  })

  it('rejects a directory correlation GUID owned by multiple identities', () => {
    const candidate = exactLiveSnapshot()
    candidate.nodes.push({
      ...candidate.nodes[1]!,
      id: 'identity-duplicate',
    })

    expect(() =>
      createLiveGraphTraversalContextForSnapshot(candidate, {
        estate,
        clock: () => new Date('2026-09-09T00:05:00.000Z'),
      }),
    ).toThrow(/correlation guid resolves to multiple identities/i)
  })

  it('rejects an application correlation GUID owned by multiple identities', () => {
    const candidate = exactLiveSnapshot()
    const duplicateIdentityAuthority = {
      ...candidate.evidence[1]!.authority!,
      providerObjectId: '22222222-2222-4222-8222-222222222222',
    }
    candidate.nodes.push({
      ...candidate.nodes[1]!,
      id: 'identity-duplicate',
      evidenceIds: ['entra-evidence-duplicate'],
      metadata: {
        ...candidate.nodes[1]!.metadata,
        providerObjectId: duplicateIdentityAuthority.providerObjectId,
        directoryObjectId: duplicateIdentityAuthority.providerObjectId,
      },
    })
    candidate.evidence.push({
      ...candidate.evidence[1]!,
      id: 'entra-evidence-duplicate',
      sourceObjectId: `directory-a:${duplicateIdentityAuthority.providerObjectId}`,
      authority: duplicateIdentityAuthority,
    })

    expect(() =>
      createLiveGraphTraversalContextForSnapshot(candidate, {
        estate,
        clock: () => new Date('2026-09-09T00:05:00.000Z'),
      }),
    ).toThrow(/correlation guid resolves to multiple identities/i)
  })

  it('allows a reused application ID across exact source boundaries', () => {
    const candidate = exactLiveSnapshot()
    const reusedApplicationId = candidate.nodes[1]!.metadata['applicationId']!
    candidate.nodes.push({
      ...candidate.nodes[1]!,
      id: 'identity-other-source',
      evidenceIds: ['entra-evidence-other-source'],
      metadata: {
        ...candidate.nodes[1]!.metadata,
        sourceId: 'entra:directory-b',
        sourceTenantId: '88888888-8888-4888-8888-888888888888',
        sourceEnvironment: 'other-directory',
        sourceInventoryObjectId: '88888888-8888-4888-8888-888888888888',
        providerObjectId: '22222222-2222-4222-8222-222222222222',
        directoryObjectId: '22222222-2222-4222-8222-222222222222',
        applicationId: reusedApplicationId,
      },
    })
    candidate.evidence.push({
      ...candidate.evidence[1]!,
      id: 'entra-evidence-other-source',
      sourceObjectId: 'directory-b:22222222-2222-4222-8222-222222222222',
      authority: {
        ...candidate.evidence[1]!.authority!,
        sourceId: 'entra:directory-b',
        tenantId: '88888888-8888-4888-8888-888888888888',
        environment: 'other-directory',
        sourceObjectId: '88888888-8888-4888-8888-888888888888',
        providerObjectId: '22222222-2222-4222-8222-222222222222',
      },
    })

    expect(() =>
      createLiveGraphTraversalContextForSnapshot(candidate, {
        estate,
        clock: () => new Date('2026-09-09T00:05:00.000Z'),
      }),
    ).not.toThrow()
  })

  it('does not collide an object ID with an application ID in the same source boundary', () => {
    const candidate = exactLiveSnapshot()
    const sharedGuid = candidate.nodes[1]!.metadata['applicationId']!
    candidate.nodes.push({
      ...candidate.nodes[1]!,
      id: 'identity-object-kind',
      evidenceIds: ['entra-evidence-object-kind'],
      metadata: {
        ...candidate.nodes[1]!.metadata,
        providerObjectId: sharedGuid,
        directoryObjectId: sharedGuid,
        applicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    })
    candidate.evidence.push({
      ...candidate.evidence[1]!,
      id: 'entra-evidence-object-kind',
      sourceObjectId: `directory-a:${sharedGuid}`,
      authority: {
        ...candidate.evidence[1]!.authority!,
        providerObjectId: sharedGuid,
      },
    })

    expect(() =>
      createLiveGraphTraversalContextForSnapshot(candidate, {
        estate,
        clock: () => new Date('2026-09-09T00:05:00.000Z'),
      }),
    ).not.toThrow()
  })

  it('rejects an edge-state variant that replaces the registered RUNS_AS binding', () => {
    const registered = exactLiveSnapshot()
    registered.nodes.push({
      id: 'tool',
      kind: 'tool',
      name: 'Tool',
      description: 'Unrelated tool.',
      environment: 'production',
      evidenceIds: ['foundry-evidence'],
      metadata: {},
    })
    registered.edges.push({
      id: 'can-call',
      from: 'agent',
      to: 'tool',
      relationship: 'CAN_CALL',
      evidenceIds: ['foundry-evidence'],
      active: true,
      removable: true,
    })
    const context = createLiveGraphTraversalContextForSnapshot(registered, {
      estate,
      clock: () => new Date('2026-09-09T00:05:00.000Z'),
    })
    const candidate = {
      ...registered,
      edges: registered.edges.map((edge) =>
        edge.id === 'runs-as'
          ? {
              ...edge,
              active: false,
              runsAsBinding: {
                ...edge.runsAsBinding!,
                identifier: {
                  kind: 'application-id' as const,
                  value: registered.nodes[1]!.metadata['applicationId']!,
                },
              },
            }
          : { ...edge },
      ),
    }

    expect(calculateBlastRadius(candidate, 'agent', context)).toEqual([])
  })

  it('reuses the registered snapshot index across live traversals', () => {
    const candidate = exactLiveSnapshot()
    const nodes = candidate.nodes
    let nodeReads = 0
    Object.defineProperty(candidate, 'nodes', {
      configurable: true,
      enumerable: true,
      get() {
        nodeReads += 1
        return nodes
      },
    })
    const context = createLiveGraphTraversalContextForSnapshot(candidate, {
      estate,
      clock: () => new Date('2026-09-09T00:05:00.000Z'),
    })
    nodeReads = 0

    findAttackPaths(
      candidate,
      { sourceNodeIds: ['agent'], targetNodeIds: ['identity'], factors },
      context,
    )
    calculateBlastRadius(candidate, 'agent', context)

    expect(nodeReads).toBe(0)
  })

  it('filters unrelated RUNS_AS edge origins during live traversal', () => {
    const candidate = exactLiveSnapshot()
    candidate.nodes.push({
      ...candidate.nodes[0]!,
      id: 'unrelated-agent',
    })
    candidate.edges.push({
      ...candidate.edges[0]!,
      id: 'unrelated-runs-as',
      from: 'unrelated-agent',
    })
    const context = createLiveGraphTraversalContextForSnapshot(candidate, {
      estate,
      clock: () => new Date('2026-09-09T00:05:00.000Z'),
    })
    const edgeStateVariant = {
      ...candidate,
      edges: candidate.edges.map((edge) => ({ ...edge })),
    }

    expect(calculateBlastRadius(edgeStateVariant, 'agent', context).map((node) => node.id)).toEqual(
      ['identity'],
    )
  })
})

const estate: EstateContext = {
  id: 'estate-a',
  tenantId: '99999999-9999-4999-8999-999999999999',
  environment: 'portfolio',
}

function exactLiveSnapshot(): EstateSnapshot {
  const generatedAt = '2026-09-09T00:00:00.000Z'
  const principalId = '11111111-1111-4111-8111-111111111111'
  const agentAuthority = {
    estateId: estate.id,
    sourceId: 'foundry:project-a',
    tenantId: estate.tenantId,
    environment: 'production',
    provider: 'azure-ai-foundry-agent-service' as const,
    sourceObjectId: 'project-a',
    providerObjectId: 'agent-a',
    snapshotGeneratedAt: generatedAt,
    sourceRelease: 'v1',
  }
  const identityAuthority = {
    estateId: estate.id,
    sourceId: 'entra:directory-a',
    tenantId: estate.tenantId,
    environment: 'directory',
    provider: 'microsoft-entra' as const,
    sourceObjectId: estate.tenantId,
    providerObjectId: principalId,
    snapshotGeneratedAt: generatedAt,
    sourceRelease: 'v1.0',
  }
  return {
    tenantId: estate.tenantId,
    environment: estate.environment,
    generatedAt,
    nodes: [
      {
        id: 'agent',
        kind: 'agent',
        name: 'Agent',
        description: 'Foundry agent.',
        environment: 'production',
        evidenceIds: ['foundry-evidence'],
        metadata: {
          sourceOfTruth: 'true',
          estateId: estate.id,
          sourceId: agentAuthority.sourceId,
          sourceTenantId: agentAuthority.tenantId,
          sourceEnvironment: agentAuthority.environment,
          sourceProjectId: agentAuthority.sourceObjectId,
          provider: agentAuthority.provider,
          providerObjectId: agentAuthority.providerObjectId,
          snapshotGeneratedAt: agentAuthority.snapshotGeneratedAt,
          sourceRelease: agentAuthority.sourceRelease,
          servicePrincipalId: principalId,
        },
      },
      {
        id: 'identity',
        kind: 'identity',
        name: 'Identity',
        description: 'Entra service principal.',
        environment: 'directory',
        evidenceIds: ['entra-evidence'],
        metadata: {
          sourceOfTruth: 'true',
          estateId: estate.id,
          sourceId: identityAuthority.sourceId,
          sourceTenantId: identityAuthority.tenantId,
          sourceEnvironment: identityAuthority.environment,
          sourceInventoryObjectId: identityAuthority.sourceObjectId,
          provider: identityAuthority.provider,
          providerObjectId: identityAuthority.providerObjectId,
          snapshotGeneratedAt: identityAuthority.snapshotGeneratedAt,
          sourceRelease: identityAuthority.sourceRelease,
          directoryObjectId: principalId,
          applicationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      },
    ],
    edges: [
      {
        id: 'runs-as',
        from: 'agent',
        to: 'identity',
        relationship: 'RUNS_AS',
        evidenceIds: ['foundry-evidence', 'entra-evidence'],
        active: true,
        removable: false,
        runsAsBinding: {
          agent: agentAuthority,
          identity: identityAuthority,
          identifier: { kind: 'object-id', value: principalId },
        },
      },
    ],
    evidence: [
      {
        id: 'foundry-evidence',
        source: 'Foundry',
        sourceObjectId: 'project-a:agent-a',
        observedAt: generatedAt,
        freshness: 'live',
        confidence: 1,
        evidenceTypes: ['declared_configuration'],
        summary: 'Foundry evidence.',
        authority: agentAuthority,
      },
      {
        id: 'entra-evidence',
        source: 'Entra',
        sourceObjectId: `directory-a:${principalId}`,
        observedAt: generatedAt,
        freshness: 'live',
        confidence: 1,
        evidenceTypes: ['declared_configuration'],
        summary: 'Entra evidence.',
        authority: identityAuthority,
      },
    ],
  }
}
