import type { AccessToken, TokenCredential } from '@azure/core-auth'
import type { Remediation } from '@agent-sentinel/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FoundryAgentConnector,
  FOUNDRY_TRUST_REQUIRED_PLANES,
  MultiFoundryConnector,
  foundryAgentPageSchema,
  foundryConnectorConfigSchema,
  parseFoundryPortfolioConfig,
  mapAgentToSnapshot,
} from '../src/index.js'
class Credential implements TokenCredential {
  getToken(): Promise<AccessToken> {
    return Promise.resolve({ token: 'token', expiresOnTimestamp: Date.now() + 10000 })
  }
}
const config = {
  projectEndpoint: 'https://example.services.ai.azure.com/api/projects/test',
  tenantId: 'tenant',
  environment: 'validation',
}
const externalAgent = {
  id: 'a1',
  name: 'sales-research-vulnerable',
  model: 'gpt-5.4',
  metadata: {
    approvalRequired: 'false',
    owner: 'Revenue AI',
    businessUnit: 'Sales',
  },
  tools: [
    {
      type: 'function',
      function: { name: 'external_send', description: 'Send externally.', parameters: {} },
    },
  ],
}
const approvalAgent = {
  id: 'a2',
  name: 'procurement-gated',
  metadata: { approvalRequired: 'true' },
}

function completeTrustAssessment(
  overrides: {
    sourceMode?: 'live' | 'synthetic'
    freshness?: 'live' | 'recent' | 'stale'
    evidenceTypes?: Array<
      'declared_configuration' | 'observed_runtime' | 'synthetic_validation' | 'unknown'
    >
  } = {},
) {
  const sourceMode = overrides.sourceMode ?? 'live'
  const freshness = overrides.freshness ?? 'live'
  const evidenceTypes = overrides.evidenceTypes ?? ['observed_runtime']
  return {
    tier: 'trusted' as const,
    sourceMode,
    assessedAt: '2026-09-04T08:00:00.000Z',
    requiredPlanes: [...FOUNDRY_TRUST_REQUIRED_PLANES],
    planeEvidence: FOUNDRY_TRUST_REQUIRED_PLANES.map((plane) => ({
      plane,
      evidenceReferences: [`${plane}-evidence`],
    })),
    evidence: FOUNDRY_TRUST_REQUIRED_PLANES.map((plane) => ({
      id: `${plane}-evidence`,
      source: `Trust source for ${plane}`,
      sourceObjectId: `${plane}-object`,
      observedAt: '2026-09-04T08:00:00.000Z',
      freshness,
      confidence: 1,
      evidenceTypes,
      summary: `Evidence for ${plane}.`,
    })),
  }
}
function connector(fetcher: typeof fetch) {
  vi.stubGlobal('fetch', fetcher)
  return new FoundryAgentConnector(config, new Credential())
}
afterEach(() => vi.unstubAllGlobals())
describe('Foundry connector', () => {
  it('validates config', () => {
    expect(foundryConnectorConfigSchema.parse(config)).toEqual(config)
    expect(() =>
      foundryConnectorConfigSchema.parse({ ...config, projectEndpoint: 'bad' }),
    ).toThrow()
  })
  it('preserves legacy environment configuration as one primary source', () => {
    expect(
      parseFoundryPortfolioConfig({
        FOUNDRY_PROJECT_ENDPOINT: config.projectEndpoint,
        FOUNDRY_TENANT_ID: config.tenantId,
        FOUNDRY_ENVIRONMENT: config.environment,
      }),
    ).toMatchObject({
      estateTenantId: 'tenant',
      estateEnvironment: 'validation',
      sources: [{ id: 'primary', tenantId: 'tenant' }],
    })
  })
  it('parses multiple unique tenant and project sources', () => {
    const portfolio = parseFoundryPortfolioConfig({
      AGENT_SENTINEL_TENANT_ID: 'estate',
      AGENT_SENTINEL_ENVIRONMENT: 'portfolio',
      FOUNDRY_ENVIRONMENT: 'fallback',
      FOUNDRY_SOURCES_JSON: JSON.stringify([
        {
          id: 'tenant-a-project',
          name: 'Tenant A project',
          projectEndpoint: 'https://a.services.ai.azure.com/api/projects/project-a',
          tenantId: 'tenant-a',
          environment: 'production',
        },
        {
          id: 'tenant-b-project',
          name: 'Tenant B project',
          projectEndpoint: 'https://b.services.ai.azure.com/api/projects/project-b',
          tenantId: 'tenant-b',
          environment: 'validation',
        },
      ]),
    })
    expect(portfolio.sources).toHaveLength(2)
    expect(portfolio.estateTenantId).toBe('estate')
    expect(portfolio.estateEnvironment).toBe('portfolio')
  })
  it('rejects duplicate source ids and project endpoints', () => {
    const source = {
      id: 'duplicate',
      name: 'Duplicate',
      projectEndpoint: 'https://a.services.ai.azure.com/api/projects/project-a',
      tenantId: 'tenant-a',
      environment: 'production',
    }
    expect(() =>
      parseFoundryPortfolioConfig({
        AGENT_SENTINEL_TENANT_ID: 'estate',
        FOUNDRY_ENVIRONMENT: 'portfolio',
        FOUNDRY_SOURCES_JSON: JSON.stringify([source, source]),
      }),
    ).toThrow()
  })
  it('maps tools, trust and declared evidence', () => {
    const snapshot = mapAgentToSnapshot([externalAgent, approvalAgent], 'v1', config)
    expect(snapshot.nodes.filter((n) => n.kind === 'tool')).toHaveLength(1)
    expect(snapshot.edges[0]?.relationship).toBe('CAN_CALL')
    expect(snapshot.nodes.find((n) => n.id === 'foundry-agent-a1')?.trust).toBe('untrusted')
    expect(snapshot.nodes.find((n) => n.id === 'foundry-agent-a1')).toMatchObject({
      owner: 'Revenue AI',
      metadata: { businessUnit: 'Sales' },
    })
    expect(snapshot.nodes.find((n) => n.id === 'foundry-agent-a2')?.trust).toBe('conditional')
    expect(snapshot.evidence[0]?.summary).toContain('Declared configuration')
  })
  it('does not infer trust for sparse agents with no tools or approval metadata', () => {
    const snapshot = mapAgentToSnapshot([{ id: 'sparse-agent' }], 'v1', config)
    const agent = snapshot.nodes.find((node) => node.id === 'foundry-agent-sparse-agent')

    expect(agent).toMatchObject({
      trust: 'conditional',
      metadata: {
        approvalRequired: 'unknown',
        trustAssessmentStatus: 'missing',
      },
    })
  })
  it('does not infer trust when approval metadata is missing', () => {
    const snapshot = mapAgentToSnapshot(
      [
        {
          ...externalAgent,
          id: 'missing-approval',
          metadata: { owner: 'Revenue AI' },
        },
      ],
      'v1',
      config,
    )

    expect(snapshot.nodes.find((node) => node.id === 'foundry-agent-missing-approval')?.trust).toBe(
      'untrusted',
    )
    expect(
      snapshot.nodes.find((node) => node.id === 'foundry-agent-missing-approval')?.metadata[
        'approvalRequired'
      ],
    ).toBe('unknown')
  })
  it('emits trusted only for a complete live assessment with cited evidence for every plane', () => {
    const snapshot = mapAgentToSnapshot(
      [
        {
          id: 'assessed-agent',
          metadata: { approvalRequired: 'true' },
          trustAssessment: completeTrustAssessment(),
        },
      ],
      'v1',
      config,
    )
    const agent = snapshot.nodes.find((node) => node.id === 'foundry-agent-assessed-agent')

    expect(agent).toMatchObject({
      trust: 'trusted',
      metadata: {
        trustAssessmentStatus: 'complete',
        trustAssessmentSourceMode: 'live',
      },
    })
    expect(agent?.evidenceIds).toHaveLength(FOUNDRY_TRUST_REQUIRED_PLANES.length + 1)
    expect(
      snapshot.evidence.filter((item) => item.metadata?.['trustAssessmentSourceMode'] === 'live'),
    ).toHaveLength(FOUNDRY_TRUST_REQUIRED_PLANES.length)
  })
  it.each([
    {
      name: 'stale evidence',
      assessment: completeTrustAssessment({ freshness: 'stale' }),
      sourceMode: 'live',
    },
    {
      name: 'unknown evidence',
      assessment: completeTrustAssessment({ evidenceTypes: ['unknown'] }),
      sourceMode: 'live',
    },
    {
      name: 'synthetic evidence',
      assessment: completeTrustAssessment({
        sourceMode: 'synthetic',
        evidenceTypes: ['synthetic_validation'],
      }),
      sourceMode: 'synthetic',
    },
    {
      name: 'synthetic evidence mislabeled as live',
      assessment: completeTrustAssessment({
        sourceMode: 'live',
        evidenceTypes: ['synthetic_validation'],
      }),
      sourceMode: 'live',
    },
    {
      name: 'declared configuration without observed evidence',
      assessment: completeTrustAssessment({
        sourceMode: 'live',
        evidenceTypes: ['declared_configuration'],
      }),
      sourceMode: 'live',
    },
  ])('keeps a trusted claim conditional when it relies on $name', ({ assessment, sourceMode }) => {
    const snapshot = mapAgentToSnapshot(
      [{ id: 'incomplete-assessment', trustAssessment: assessment }],
      'v1',
      config,
    )
    const agent = snapshot.nodes.find((node) => node.id === 'foundry-agent-incomplete-assessment')

    expect(agent).toMatchObject({
      trust: 'conditional',
      metadata: {
        trustAssessmentStatus: 'incomplete',
        trustAssessmentSourceMode: sourceMode,
      },
    })
  })
  it('keeps a trusted claim conditional when a required plane is missing', () => {
    const assessment = completeTrustAssessment()
    assessment.requiredPlanes = assessment.requiredPlanes.filter((plane) => plane !== 'runtime')
    assessment.planeEvidence = assessment.planeEvidence.filter((plane) => plane.plane !== 'runtime')
    const snapshot = mapAgentToSnapshot(
      [{ id: 'missing-plane', trustAssessment: assessment }],
      'v1',
      config,
    )

    const agent = snapshot.nodes.find((node) => node.id === 'foundry-agent-missing-plane')
    expect(agent).toMatchObject({
      trust: 'conditional',
      metadata: { trustAssessmentStatus: 'incomplete' },
    })
    expect(agent?.metadata['trustAssessmentMissingPlanes']).toContain('runtime')
  })
  it('preserves every supplied Entra identity identifier for fail-closed correlation', () => {
    const snapshot = mapAgentToSnapshot(
      [
        {
          ...approvalAgent,
          metadata: {
            servicePrincipalId: '11111111-1111-4111-8111-111111111111',
            clientId: 'not-an-authoritative-identifier',
            objectId: '22222222-2222-4222-8222-222222222222',
          },
        },
      ],
      'v1',
      config,
    )
    expect(snapshot.nodes[0]?.metadata['servicePrincipalId']).toBe(
      '11111111-1111-4111-8111-111111111111',
    )
    expect(snapshot.nodes[0]?.metadata['clientId']).toBe('not-an-authoritative-identifier')
    expect(snapshot.nodes[0]?.metadata['objectId']).toBe('22222222-2222-4222-8222-222222222222')
  })
  it('handles data pagination', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: [externalAgent],
          nextLink: `${config.projectEndpoint}/agents?api-version=v1&after=a1`,
        }),
      )
      .mockResolvedValueOnce(Response.json({ data: [approvalAgent], has_more: false }))
    const snapshot = await connector(fetcher).discover()
    expect(snapshot.nodes.filter((n) => n.kind === 'agent')).toHaveLength(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('rejects invalid API shape', async () => {
    expect(() => foundryAgentPageSchema.parse({ object: 'list' })).toThrow()
    await expect(
      connector(vi.fn<typeof fetch>().mockResolvedValue(Response.json({ nope: [] }))).discover(),
    ).rejects.toThrow()
  })
  it('handles auth errors', async () => {
    const result = await connector(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ error: { message: 'Forbidden' } }, { status: 403 })),
    ).testConnection()
    expect(result).toMatchObject({ ok: false, message: 'Forbidden' })
  })
  it('rejects live remediation', async () => {
    const remediation = {
      id: 'r',
      findingId: 'f',
      title: 'x',
      description: 'x',
      targetEdgeId: 'e',
      status: 'approved',
      expectedRiskReduction: 1,
      businessDisruption: 'low',
      rollbackAvailable: true,
    } satisfies Remediation
    await expect(
      connector(vi.fn<typeof fetch>()).execute(remediation, {
        approvedBy: 'tester',
        approvedAt: new Date().toISOString(),
        reason: 'test',
      }),
    ).rejects.toThrow('Live remediation not supported for Foundry connector')
  })
})

describe('multi-Foundry connector', () => {
  const portfolio = {
    estateTenantId: 'estate',
    estateEnvironment: 'portfolio',
    sources: [
      {
        id: 'tenant-a-project',
        name: 'Tenant A project',
        projectEndpoint: 'https://a.services.ai.azure.com/api/projects/project-a',
        tenantId: 'tenant-a',
        environment: 'production',
      },
      {
        id: 'tenant-b-project',
        name: 'Tenant B project',
        projectEndpoint: 'https://b.services.ai.azure.com/api/projects/project-b',
        tenantId: 'tenant-b',
        environment: 'validation',
      },
    ],
  }

  it('aggregates colliding provider ids with source provenance and estate isolation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        return Promise.resolve(
          Response.json({
            data: [
              {
                ...externalAgent,
                name: url.hostname.startsWith('a.') ? 'Tenant A agent' : 'Tenant B agent',
              },
            ],
            has_more: false,
          }),
        )
      }),
    )
    const credentialTenants: string[] = []
    const connector = new MultiFoundryConnector(portfolio, (source) => {
      credentialTenants.push(source.tenantId)
      return new Credential()
    })

    const snapshot = await connector.discover()
    expect(credentialTenants).toEqual(['tenant-a', 'tenant-b'])
    expect(snapshot).toMatchObject({
      tenantId: 'estate',
      environment: 'portfolio',
    })
    const agents = snapshot.nodes.filter((node) => node.kind === 'agent')
    expect(agents).toHaveLength(2)
    expect(new Set(agents.map((agent) => agent.id)).size).toBe(2)
    expect(agents.map((agent) => agent.metadata['sourceTenantId']).sort()).toEqual([
      'tenant-a',
      'tenant-b',
    ])
    expect(snapshot.evidence[0]?.metadata).toMatchObject({
      sourceConnectorId: 'tenant-a-project',
      sourceTenantId: 'tenant-a',
      sourceProjectId: 'project-a',
      sourceEnvironment: 'production',
    })
    expect(connector.getConnectorHealth()).toMatchObject({
      overall: 'ready',
      partial: false,
      sources: [
        { id: 'foundry:tenant-a-project', readiness: 'ready' },
        { id: 'foundry:tenant-b-project', readiness: 'ready' },
      ],
    })
  })

  it('reports partial discovery without claiming all configured sources', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        return Promise.resolve(
          url.hostname.startsWith('a.')
            ? Response.json({ data: [externalAgent], has_more: false })
            : Response.json({ error: { message: 'Forbidden' } }, { status: 403 }),
        )
      }),
    )
    const connector = new MultiFoundryConnector(portfolio, () => new Credential())
    const snapshot = await connector.discover()
    expect(snapshot.nodes.filter((node) => node.kind === 'agent')).toHaveLength(1)
    expect(connector.getConnectorHealth()).toMatchObject({
      overall: 'degraded',
      partial: true,
      sources: [
        { id: 'foundry:tenant-a-project', readiness: 'ready' },
        { id: 'foundry:tenant-b-project', readiness: 'unavailable' },
      ],
    })
  })

  it('preserves legacy ids for the primary source during migration', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ data: [externalAgent], has_more: false })),
    )
    const connector = new MultiFoundryConnector(
      {
        estateTenantId: 'tenant-a',
        estateEnvironment: 'production',
        sources: [
          {
            id: 'primary',
            name: 'Current project',
            projectEndpoint: 'https://a.services.ai.azure.com/api/projects/project-a',
            tenantId: 'tenant-a',
            environment: 'production',
          },
        ],
      },
      () => new Credential(),
    )
    const snapshot = await connector.discover()
    expect(snapshot.nodes.some((node) => node.id === 'foundry-agent-a1')).toBe(true)
    expect(snapshot.nodes[0]?.metadata['sourceConnectorId']).toBe('primary')
  })

  it('preserves trust assessment mode and connector source provenance together', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: [{ ...approvalAgent, trustAssessment: completeTrustAssessment() }],
          has_more: false,
        }),
      ),
    )
    const connector = new MultiFoundryConnector(
      {
        estateTenantId: 'estate',
        estateEnvironment: 'portfolio',
        sources: [portfolio.sources[0]!],
      },
      () => new Credential(),
    )

    const snapshot = await connector.discover()
    const trustEvidence = snapshot.evidence.find(
      (item) => item.metadata?.['trustAssessmentSourceMode'] === 'live',
    )

    expect(trustEvidence?.metadata).toMatchObject({
      trustAssessmentSourceMode: 'live',
      sourceConnectorId: 'tenant-a-project',
      sourceTenantId: 'tenant-a',
      sourceEnvironment: 'production',
    })
  })

  it('fails when no configured source completes discovery', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ error: { message: 'Forbidden' } }, { status: 403 })),
    )
    const connector = new MultiFoundryConnector(portfolio, () => new Credential())
    await expect(connector.discover()).rejects.toThrow(
      'No configured Foundry source completed discovery',
    )
  })
})
