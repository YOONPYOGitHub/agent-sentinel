import type { AccessToken, TokenCredential } from '@azure/core-auth'
import type { Remediation } from '@agent-sentinel/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FoundryAgentConnector,
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
  metadata: { approvalRequired: 'false' },
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
    expect(snapshot.nodes.find((n) => n.id === 'foundry-agent-a2')?.trust).toBe('conditional')
    expect(snapshot.evidence[0]?.summary).toContain('Declared configuration')
  })
  it('preserves only valid explicit Entra identity identifiers for correlation', () => {
    const snapshot = mapAgentToSnapshot(
      [
        {
          ...approvalAgent,
          metadata: {
            servicePrincipalId: '11111111-1111-4111-8111-111111111111',
            clientId: 'not-an-authoritative-identifier',
          },
        },
      ],
      'v1',
      config,
    )
    expect(snapshot.nodes[0]?.metadata['servicePrincipalId']).toBe(
      '11111111-1111-4111-8111-111111111111',
    )
    expect(snapshot.nodes[0]?.metadata['clientId']).toBeUndefined()
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
