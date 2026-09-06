import type { AccessToken, TokenCredential } from '@azure/core-auth'
import type { EvidenceType, Remediation } from '@agent-sentinel/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FoundryAgentConnector,
  FOUNDRY_TRUST_REQUIRED_PLANES,
  MultiFoundryConnector,
  composeFoundryTrustAssessment,
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

const defaultTrustSubject = {
  agentId: 'assessed-agent',
  sourceId: 'primary',
  tenantId: config.tenantId,
  environment: config.environment,
}
const assessmentTime = '2026-09-04T08:10:00.000Z'
const trustServerContext = {
  auth: {
    issuerId: 'agent-sentinel-trust-composer',
    authenticationMode: 'managed-identity' as const,
  },
  clock: () => new Date(assessmentTime),
}

function trustCompositionInput(
  overrides: {
    subject?: Partial<typeof defaultTrustSubject>
    observedAt?: string
    evidenceTypes?: EvidenceType[]
    runtimeEvidenceTypes?: EvidenceType[]
    omitPlane?: (typeof FOUNDRY_TRUST_REQUIRED_PLANES)[number]
  } = {},
) {
  const evidenceTypes = overrides.evidenceTypes ?? ['observed_runtime']
  const subject = { ...defaultTrustSubject, ...overrides.subject }
  return {
    tier: 'trusted' as const,
    subject,
    evidence: FOUNDRY_TRUST_REQUIRED_PLANES.filter((plane) => plane !== overrides.omitPlane).map(
      (plane) => ({
        id: `${plane}-evidence`,
        plane,
        subject,
        source: `Trust source for ${plane}`,
        sourceObjectId: `${plane}-object`,
        observedAt: overrides.observedAt ?? '2026-09-04T08:05:00.000Z',
        confidence: 1,
        evidenceTypes:
          plane === 'runtime' ? (overrides.runtimeEvidenceTypes ?? evidenceTypes) : evidenceTypes,
        summary: `Evidence for ${plane}.`,
      }),
    ),
  }
}

function completeTrustAssessment(overrides: Parameters<typeof trustCompositionInput>[0] = {}) {
  return composeFoundryTrustAssessment(trustCompositionInput(overrides), trustServerContext)
}

function trustComposition(assessment: ReturnType<typeof completeTrustAssessment>) {
  return {
    sourceId: 'primary',
    trustAssessments: [assessment],
    clock: trustServerContext.clock,
  }
}
function connector(
  fetcher: typeof fetch,
  options: ConstructorParameters<typeof FoundryAgentConnector>[3] = {},
) {
  vi.stubGlobal('fetch', fetcher)
  return new FoundryAgentConnector(config, new Credential(), undefined, options)
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
  it('discards a trust claim embedded in the raw Foundry inventory payload', () => {
    const snapshot = mapAgentToSnapshot(
      [
        {
          id: 'raw-self-promoter',
          trustAssessment: {
            tier: 'trusted',
            sourceMode: 'live',
            assessedAt: '2026-09-04T08:10:00.000Z',
            requiredPlanes: [...FOUNDRY_TRUST_REQUIRED_PLANES],
            planeEvidence: [],
            evidence: [],
          },
        },
      ],
      'v1',
      config,
    )

    expect(snapshot.nodes[0]).toMatchObject({
      trust: 'conditional',
      metadata: { trustAssessmentStatus: 'missing' },
    })
    expect(snapshot.evidence).toHaveLength(1)
  })
  it('emits trusted only for a complete live assessment with cited evidence for every plane', () => {
    const assessment = completeTrustAssessment()
    const snapshot = mapAgentToSnapshot(
      [
        {
          id: 'assessed-agent',
          metadata: { approvalRequired: 'true' },
        },
      ],
      'v1',
      config,
      trustComposition(assessment),
    )
    const agent = snapshot.nodes.find((node) => node.id === 'foundry-agent-assessed-agent')

    expect(agent).toMatchObject({
      trust: 'trusted',
      metadata: {
        trustAssessmentStatus: 'complete',
        trustAssessmentSourceMode: 'live',
        trustAssessmentIssuerId: 'agent-sentinel-trust-composer',
      },
    })
    expect(agent?.evidenceIds).toHaveLength(FOUNDRY_TRUST_REQUIRED_PLANES.length + 1)
    expect(
      snapshot.evidence.filter((item) => item.metadata?.['trustAssessmentSourceMode'] === 'live'),
    ).toHaveLength(FOUNDRY_TRUST_REQUIRED_PLANES.length)
    expect(
      snapshot.evidence.every((item) =>
        item.id.startsWith('foundry-trust-evidence-') ? item.freshness === 'live' : true,
      ),
    ).toBe(true)
  })
  it.each([
    {
      name: 'stale evidence',
      assessment: completeTrustAssessment({ observedAt: '2026-09-02T08:05:00.000Z' }),
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
        evidenceTypes: ['synthetic_validation'],
      }),
      sourceMode: 'synthetic',
    },
    {
      name: 'declared configuration without observed evidence',
      assessment: completeTrustAssessment({
        evidenceTypes: ['declared_configuration'],
      }),
      sourceMode: 'live',
    },
  ])('keeps a trusted claim conditional when it relies on $name', ({ assessment, sourceMode }) => {
    const snapshot = mapAgentToSnapshot(
      [{ id: 'assessed-agent' }],
      'v1',
      config,
      trustComposition(assessment),
    )
    const agent = snapshot.nodes.find((node) => node.id === 'foundry-agent-assessed-agent')

    expect(agent).toMatchObject({
      trust: 'conditional',
      metadata: {
        trustAssessmentStatus: 'incomplete',
        trustAssessmentSourceMode: sourceMode,
      },
    })
  })
  it('requires runtime-plane evidence itself to contain an observed runtime signal', () => {
    const assessment = completeTrustAssessment({
      evidenceTypes: ['observed_runtime'],
      runtimeEvidenceTypes: ['declared_configuration'],
    })
    const snapshot = mapAgentToSnapshot(
      [{ id: 'assessed-agent' }],
      'v1',
      config,
      trustComposition(assessment),
    )

    expect(snapshot.nodes[0]).toMatchObject({
      trust: 'conditional',
      metadata: { trustAssessmentStatus: 'incomplete' },
    })
  })
  it('keeps a trusted claim conditional when a required plane is missing', () => {
    const assessment = completeTrustAssessment({ omitPlane: 'runtime' })
    const snapshot = mapAgentToSnapshot(
      [{ id: 'assessed-agent' }],
      'v1',
      config,
      trustComposition(assessment),
    )

    const agent = snapshot.nodes.find((node) => node.id === 'foundry-agent-assessed-agent')
    expect(agent).toMatchObject({
      trust: 'conditional',
      metadata: { trustAssessmentStatus: 'incomplete' },
    })
    expect(agent?.metadata['trustAssessmentMissingPlanes']).toContain('runtime')
  })
  it.each([
    {
      name: 'agent',
      subject: { agentId: 'different-agent' },
      expectedStatus: 'missing',
    },
    {
      name: 'source',
      subject: { sourceId: 'different-source' },
      expectedStatus: 'binding-mismatch',
    },
    {
      name: 'tenant',
      subject: { tenantId: 'different-tenant' },
      expectedStatus: 'binding-mismatch',
    },
    {
      name: 'environment',
      subject: { environment: 'production' },
      expectedStatus: 'binding-mismatch',
    },
  ])(
    'does not apply an authenticated assessment with a mismatched $name binding',
    ({ subject, expectedStatus }) => {
      const assessment = completeTrustAssessment({ subject })
      const snapshot = mapAgentToSnapshot(
        [{ id: 'assessed-agent' }],
        'v1',
        config,
        trustComposition(assessment),
      )

      expect(snapshot.nodes[0]).toMatchObject({
        trust: 'conditional',
        environment: config.environment,
        metadata: { trustAssessmentStatus: expectedStatus },
      })
      expect(snapshot.nodes[0]?.evidenceIds).toEqual(['foundry-evidence-assessed-agent'])
    },
  )
  it('rejects caller-supplied authentication, assessment time, freshness, or source mode', () => {
    const input = trustCompositionInput()
    expect(() =>
      composeFoundryTrustAssessment(
        {
          ...input,
          issuer: {
            id: 'attacker',
            authenticationMode: 'jwt',
            authenticated: true,
          },
        },
        trustServerContext,
      ),
    ).toThrow()
    expect(() =>
      composeFoundryTrustAssessment(
        { ...input, assessedAt: '2099-01-01T00:00:00.000Z' },
        trustServerContext,
      ),
    ).toThrow()
    expect(() =>
      composeFoundryTrustAssessment({ ...input, sourceMode: 'live' }, trustServerContext),
    ).toThrow()
    expect(() =>
      composeFoundryTrustAssessment(
        {
          ...input,
          evidence: input.evidence.map((item) => ({ ...item, freshness: 'live' })),
        },
        trustServerContext,
      ),
    ).toThrow()
    expect(() =>
      composeFoundryTrustAssessment(
        {
          ...input,
          subject: { ...input.subject, sourceId: ' primary ' },
        },
        trustServerContext,
      ),
    ).toThrow('must not contain surrounding whitespace')
  })
  it('rejects future-dated evidence against the injected server clock', () => {
    expect(() =>
      composeFoundryTrustAssessment(
        trustCompositionInput({ observedAt: '2026-09-04T08:10:00.001Z' }),
        trustServerContext,
      ),
    ).toThrow('cannot be observed after the server assessment time')
  })
  it('reevaluates evidence freshness when trust is applied during discovery', () => {
    const assessment = completeTrustAssessment()
    const snapshot = mapAgentToSnapshot([{ id: 'assessed-agent' }], 'v1', config, {
      ...trustComposition(assessment),
      clock: () => new Date('2026-09-04T08:26:00.000Z'),
    })

    expect(snapshot.nodes[0]).toMatchObject({
      trust: 'conditional',
      metadata: { trustAssessmentStatus: 'incomplete' },
    })
    expect(snapshot.evidence.filter((item) => item.id.includes('trust-evidence'))).toEqual(
      expect.arrayContaining([expect.objectContaining({ freshness: 'recent' })]),
    )
  })
  it('rejects a trust assessment that is future-dated at discovery', () => {
    const assessment = completeTrustAssessment()

    expect(() =>
      mapAgentToSnapshot([{ id: 'assessed-agent' }], 'v1', config, {
        ...trustComposition(assessment),
        clock: () => new Date('2026-09-04T08:09:59.999Z'),
      }),
    ).toThrow('future-dated')
  })
  it('does not accept a serialized assessment as authenticated server composition', () => {
    const forgedAssessment = structuredClone(completeTrustAssessment())
    const snapshot = mapAgentToSnapshot([{ id: 'assessed-agent' }], 'v1', config, {
      sourceId: 'primary',
      trustAssessments: [forgedAssessment],
      clock: trustServerContext.clock,
    })

    expect(snapshot.nodes[0]).toMatchObject({
      trust: 'conditional',
      metadata: { trustAssessmentStatus: 'missing' },
    })
  })
  it('rejects evidence whose subject differs from the assessment subject', () => {
    const input = trustCompositionInput()
    expect(() =>
      composeFoundryTrustAssessment(
        {
          ...input,
          evidence: input.evidence.map((item, index) =>
            index === 0
              ? { ...item, subject: { ...item.subject, tenantId: 'different-tenant' } }
              : item,
          ),
        },
        trustServerContext,
      ),
    ).toThrow('Trust evidence subject binding must exactly match')
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
  it('rejects a repeated continuation token instead of paginating forever', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ data: [], continuationToken: 'same-token' })),
      )
    const foundry = connector(fetcher)

    await expect(foundry.discover()).rejects.toMatchObject({
      reason: 'repeated-continuation',
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(foundry.getLastFailureReason()).toBe('repeated-continuation')
  })
  it('stops unique infinite pagination at the configured page bound', async () => {
    let page = 0
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          data: [],
          continuationToken: `token-${++page}`,
        }),
      ),
    )

    await expect(connector(fetcher, { limits: { maxPages: 2 } }).discover()).rejects.toMatchObject({
      reason: 'page-limit-exceeded',
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('rejects a page that exceeds the item bound', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [externalAgent, approvalAgent] }))

    await expect(connector(fetcher, { limits: { maxItems: 1 } }).discover()).rejects.toMatchObject({
      reason: 'item-limit-exceeded',
    })
  })
  it('rejects a response body that exceeds the byte bound', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ data: [{ ...externalAgent, description: 'x'.repeat(200) }] }),
      )

    await expect(
      connector(fetcher, {
        limits: { maxResponseBytes: 100, maxTotalResponseBytes: 200 },
      }).discover(),
    ).rejects.toMatchObject({
      reason: 'response-too-large',
    })
  })
  it('rejects discovery that exceeds the cumulative response byte bound', async () => {
    const page = { data: [], continuationToken: 'next' }
    const firstSize = new TextEncoder().encode(JSON.stringify(page)).byteLength
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(page))
      .mockResolvedValueOnce(Response.json({ data: [] }))

    await expect(
      connector(fetcher, {
        limits: {
          maxResponseBytes: firstSize + 20,
          maxTotalResponseBytes: firstSize + 5,
        },
      }).discover(),
    ).rejects.toMatchObject({
      reason: 'total-response-too-large',
    })
  })
  it('times out and aborts a stalled request', async () => {
    const fetcher = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal === undefined || signal === null) {
            reject(new Error('Missing request abort signal.'))
            return
          }
          signal.addEventListener('abort', () => reject(new Error('Request aborted.')), {
            once: true,
          })
        }),
    )

    await expect(
      connector(fetcher, { limits: { requestTimeoutMs: 10 } }).discover(),
    ).rejects.toMatchObject({
      reason: 'request-timeout',
    })
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })
  it('honors an explicit caller abort before issuing a request', async () => {
    const abortController = new AbortController()
    abortController.abort()
    const fetcher = vi.fn<typeof fetch>()

    await expect(
      connector(fetcher, { signal: abortController.signal }).discover(),
    ).rejects.toMatchObject({
      reason: 'request-aborted',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects unsafe continuation URLs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [externalAgent],
        nextLink: 'https://attacker.example/agents?continuationToken=stolen',
      }),
    )

    await expect(connector(fetcher).discover()).rejects.toMatchObject({
      reason: 'unsafe-continuation-url',
    })
  })
  it('does not promote first-page inventory after a second-page failure', async () => {
    const foundry = connector(
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({ data: [externalAgent], continuationToken: 'second-page' }),
        )
        .mockResolvedValueOnce(
          Response.json({ error: { message: 'Service unavailable' } }, { status: 503 }),
        ),
    )

    await expect(foundry.discover()).rejects.toMatchObject({
      reason: 'provider-request-failed',
    })
    expect(() => foundry.getEvidence('foundry-evidence-a1')).toThrow(
      'Foundry evidence was not found',
    )
  })
  it('rejects invalid API shape', async () => {
    expect(() => foundryAgentPageSchema.parse({ object: 'list' })).toThrow()
    const foundry = connector(vi.fn<typeof fetch>().mockResolvedValue(Response.json({ nope: [] })))
    await expect(foundry.discover()).rejects.toMatchObject({ reason: 'malformed-page' })
    expect(foundry.getLastFailureReason()).toBe('malformed-page')
  })
  it('accepts a bounded header continuation only when another page exists', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { data: [externalAgent], has_more: true },
          { headers: { 'x-ms-continuation': 'second-page' } },
        ),
      )
      .mockResolvedValueOnce(Response.json({ data: [approvalAgent], has_more: false }))

    const snapshot = await connector(fetcher).discover()
    expect(snapshot.nodes.filter((node) => node.kind === 'agent')).toHaveLength(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
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
    const assessment = completeTrustAssessment({
      subject: {
        agentId: approvalAgent.id,
        sourceId: 'tenant-a-project',
        tenantId: 'tenant-a',
        environment: 'production',
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: [approvalAgent],
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
      [assessment],
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

  it('reports bounded discovery failure with exact source provenance', async () => {
    const connector = new MultiFoundryConnector(
      {
        estateTenantId: 'estate',
        estateEnvironment: 'portfolio',
        sources: [portfolio.sources[0]!],
      },
      () => new Credential(),
      [],
      {
        fetch: vi
          .fn<typeof fetch>()
          .mockImplementation(() =>
            Promise.resolve(Response.json({ data: [], continuationToken: 'same-token' })),
          ),
      },
    )

    await expect(connector.discover()).rejects.toThrow(
      'No configured Foundry source completed discovery',
    )
    const health = connector.getConnectorHealth()
    expect(health.sources[0]?.checkedAt).toBeDefined()
    expect(health).toEqual({
      overall: 'degraded',
      partial: false,
      sources: [
        {
          id: 'foundry:tenant-a-project',
          name: 'Tenant A project',
          role: 'discovery',
          enabled: true,
          configured: true,
          readiness: 'degraded',
          checkedAt: health.sources[0]?.checkedAt,
          reason: 'repeated-continuation',
          provenance: {
            estateTenantId: 'estate',
            estateEnvironment: 'portfolio',
            sourceConnectorId: 'tenant-a-project',
            sourceTenantId: 'tenant-a',
            sourceEnvironment: 'production',
            provider: 'azure-ai-foundry-agent-service',
            providerObjectId: 'project-a',
          },
        },
      ],
    })
  })
})
