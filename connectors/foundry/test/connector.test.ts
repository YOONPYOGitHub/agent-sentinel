import type { AccessToken, TokenCredential } from '@azure/core-auth'
import type { Remediation } from '@agent-sentinel/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FoundryAgentConnector,
  foundryAgentPageSchema,
  foundryConnectorConfigSchema,
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
