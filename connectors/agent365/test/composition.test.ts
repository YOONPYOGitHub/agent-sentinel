import type { TokenCredential } from '@azure/core-auth'
import type { AgentConnector } from '@agent-sentinel/connector-sdk'
import type { EstateSnapshot, Evidence } from '@agent-sentinel/domain'
import { describe, expect, it, vi } from 'vitest'

import {
  Agent365CompositionConnector,
  createAgent365SourceCredential,
  createOptionalAgent365Connector,
  parseAgent365Config,
} from '../src/index.js'

function tokenCredential(tenantId: string): TokenCredential {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const token = `${encode({ alg: 'none' })}.${encode({ tid: tenantId })}.signature`
  return {
    getToken: () => Promise.resolve({ token, expiresOnTimestamp: Date.now() + 60_000 }),
  }
}

const baseEvidence: Evidence = {
  id: 'base-evidence',
  source: 'base',
  sourceObjectId: 'base-object',
  observedAt: '2026-08-28T00:00:00Z',
  freshness: 'live',
  confidence: 1,
  evidenceTypes: ['declared_configuration'],
  summary: 'Base evidence.',
}
const baseSnapshot: EstateSnapshot = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  environment: 'base-environment',
  generatedAt: '2026-08-28T00:00:00Z',
  nodes: [
    {
      id: 'base-node',
      kind: 'agent',
      name: 'Base agent',
      description: 'Base node.',
      environment: 'base-environment',
      evidenceIds: [baseEvidence.id],
      metadata: {},
    },
  ],
  edges: [],
  evidence: [baseEvidence],
}

function baseConnector(): AgentConnector {
  return {
    descriptor: {
      id: 'base',
      name: 'Base',
      apiVersion: '1',
      releaseStatus: 'ga',
      capabilities: ['discovery', 'evidence'],
      requiredPermissions: [],
      blindSpots: [],
    },
    testConnection: () =>
      Promise.resolve({ ok: true, checkedAt: '2026-08-28T00:00:00Z', message: 'ready' }),
    discover: () => Promise.resolve(structuredClone(baseSnapshot)),
    getEvidence: (id) =>
      id === baseEvidence.id
        ? Promise.resolve(structuredClone(baseEvidence))
        : Promise.reject(new Error('not found')),
  }
}

function graphResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const sources = [
  {
    id: 'tenant-a',
    name: 'Tenant A',
    tenantId: '00000000-0000-0000-0000-000000000001',
    environment: 'agent365-a',
  },
  {
    id: 'tenant-b',
    name: 'Tenant B',
    tenantId: '00000000-0000-0000-0000-000000000002',
    environment: 'agent365-b',
  },
]

describe('Agent365 composition', () => {
  it('returns the exact base object when disabled', () => {
    const base = baseConnector()
    expect(createOptionalAgent365Connector(base, {})).toBe(base)
    expect(createOptionalAgent365Connector(base, { AGENT365_CONNECTOR_ENABLED: 'false' })).toBe(
      base,
    )
  })

  it('reports enabled invalid configuration without attempting a mock fallback', async () => {
    const connector = createOptionalAgent365Connector(baseConnector(), {
      AGENT365_CONNECTOR_ENABLED: 'true',
    })
    expect(connector).toBeInstanceOf(Agent365CompositionConnector)
    await connector.discover()
    expect(connector.getConnectorHealth?.()).toMatchObject({
      overall: 'degraded',
      partial: true,
      sources: [
        expect.anything(),
        {
          id: 'agent365:configuration',
          enabled: true,
          configured: false,
          readiness: 'authorization-required',
          reason: 'invalid-configuration',
        },
      ],
    })
  })

  it('rejects ambient AZURE_CLIENT_ID for federated Agent 365 sources', () => {
    expect(() =>
      parseAgent365Config({
        AZURE_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
        AGENT365_SOURCES_JSON: JSON.stringify([
          {
            ...sources[0],
            credential: {
              mode: 'federated-app',
              clientId: '22222222-2222-4222-8222-222222222222',
            },
          },
        ]),
      }),
    ).toThrow('managedIdentityClientId')
  })

  it('does not use ambient credentials when a source has no explicit managed identity', () => {
    const config = parseAgent365Config({
      AZURE_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
      AGENT365_TENANT_ID: sources[0]!.tenantId,
      AGENT365_ENVIRONMENT: sources[0]!.environment,
    })

    expect(() => createAgent365SourceCredential(config.sources[0]!)).toThrow(
      'explicit user-assigned managed identity',
    )
  })

  it('fails the legacy scalar connection test when managed identity is missing', async () => {
    const connector = createOptionalAgent365Connector(baseConnector(), {
      AGENT365_CONNECTOR_ENABLED: 'true',
      AGENT365_TENANT_ID: sources[0]!.tenantId,
      AGENT365_ENVIRONMENT: sources[0]!.environment,
    })

    await expect(connector.testConnection()).resolves.toMatchObject({
      ok: false,
      message: 'The base connector or one or more enabled Agent 365 sources are unavailable.',
    })
    expect(connector.getConnectorHealth?.().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent365:primary',
          enabled: true,
          readiness: 'unavailable',
          dataState: 'failed',
          reason: 'authentication',
        }),
      ]),
    )
  })

  it('maps the legacy explicit managed identity setting into the source credential', () => {
    const config = parseAgent365Config({
      AGENT365_TENANT_ID: sources[0]!.tenantId,
      AGENT365_ENVIRONMENT: sources[0]!.environment,
      AGENT365_MANAGED_IDENTITY_CLIENT_ID: '59dbea72-1e91-403a-89cf-e02cdb8da350',
    })

    expect(config.sources[0]?.credential).toEqual({
      mode: 'managed-identity',
      managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
    })
  })

  it('preserves base and successful additions while marking partial source failure', async () => {
    const config = parseAgent365Config({ AGENT365_SOURCES_JSON: JSON.stringify(sources) })
    const connector = new Agent365CompositionConnector(baseConnector(), config, {
      credentialFactory: (source) => tokenCredential(source.tenantId),
      clientFactory: (source) => ({
        fetcher:
          source.id === 'tenant-a'
            ? vi.fn<typeof fetch>().mockResolvedValue(
                graphResponse({
                  value: [
                    {
                      id: 'P_shared',
                      displayName: 'Shared display name',
                      supportedHosts: ['Copilot'],
                      elementTypes: ['declarativeAgent'],
                    },
                  ],
                }),
              )
            : vi
                .fn<typeof fetch>()
                .mockResolvedValue(
                  graphResponse({ error: { code: 'Authorization_RequestDenied' } }, 403),
                ),
      }),
    })
    const snapshot = await connector.discover()
    expect(snapshot.nodes.map((node) => node.name)).toEqual(['Base agent', 'Shared display name'])
    expect(snapshot.nodes[1]?.metadata).toMatchObject({
      estateTenantId: baseSnapshot.tenantId,
      estateEnvironment: baseSnapshot.environment,
      sourceConnectorId: 'tenant-a',
      sourceTenantId: sources[0]!.tenantId,
      sourceEnvironment: 'agent365-a',
    })
    expect(snapshot.evidence[1]?.metadata).toMatchObject({
      estateTenantId: baseSnapshot.tenantId,
      estateEnvironment: baseSnapshot.environment,
      sourceConnectorId: 'tenant-a',
      sourceProviderObjectId: 'P_shared',
    })
    expect(connector.getConnectorHealth()).toMatchObject({ overall: 'degraded', partial: true })
    expect(connector.getConnectorHealth().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'agent365:tenant-a', readiness: 'ready' }),
        expect.objectContaining({
          id: 'agent365:tenant-b',
          readiness: 'authorization-required',
          reason: 'authorization',
        }),
      ]),
    )
    await expect(connector.getEvidence('base-evidence')).resolves.toMatchObject({
      id: 'base-evidence',
    })
    await expect(connector.getEvidence(snapshot.evidence[1]!.id)).resolves.toMatchObject({
      sourceObjectId: 'tenant-a:P_shared',
    })
  })

  it('keeps identical provider ids and names distinct across successful sources', async () => {
    const config = parseAgent365Config({ AGENT365_SOURCES_JSON: JSON.stringify(sources) })
    const connector = new Agent365CompositionConnector(baseConnector(), config, {
      credentialFactory: (source) => tokenCredential(source.tenantId),
      clientFactory: () => ({
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(
          graphResponse({
            value: [
              {
                id: 'P_same',
                displayName: 'Same name',
                supportedHosts: ['Copilot'],
              },
            ],
          }),
        ),
      }),
    })
    const snapshot = await connector.discover()
    const additions = snapshot.nodes.filter((node) => node.name === 'Same name')
    expect(additions).toHaveLength(2)
    expect(new Set(additions.map((node) => node.id)).size).toBe(2)
    expect(connector.getConnectorHealth()).toMatchObject({ overall: 'ready', partial: false })
    expect(connector.getConnectorHealth().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent365:tenant-a',
          dataState: 'complete',
          pages: 1,
          records: 1,
          provenance: {
            estateTenantId: baseSnapshot.tenantId,
            estateEnvironment: baseSnapshot.environment,
            sourceConnectorId: 'tenant-a',
            sourceTenantId: sources[0]!.tenantId,
            sourceEnvironment: sources[0]!.environment,
            provider: 'microsoft-graph-agent365-package-catalog',
            providerObjectId: '/v1.0/copilot/admin/catalog/packages',
          },
        }),
      ]),
    )
  })

  it('keeps a valid empty package catalog distinct from complete discovery', async () => {
    const connector = createOptionalAgent365Connector(
      baseConnector(),
      {
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_TENANT_ID: sources[0]!.tenantId,
        AGENT365_ENVIRONMENT: sources[0]!.environment,
      },
      {
        credential: tokenCredential(sources[0]!.tenantId),
        client: {
          fetcher: vi.fn<typeof fetch>().mockResolvedValue(graphResponse({ value: [] })),
        },
      },
    )

    const snapshot = await connector.discover()

    expect(snapshot.nodes).toEqual(baseSnapshot.nodes)
    const health = connector.getConnectorHealth?.()
    expect(health).toMatchObject({
      overall: 'degraded',
      partial: true,
    })
    expect(health?.sources.find((source) => source.id === 'agent365:primary')).toMatchObject({
      readiness: 'degraded',
      dataState: 'empty',
      pages: 1,
      records: 0,
      reason: 'empty',
    })
  })

  it('cancels in-flight collection without converting cancellation to timeout', async () => {
    let requestSignal: AbortSignal | undefined
    const connector = createOptionalAgent365Connector(
      baseConnector(),
      {
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_TENANT_ID: sources[0]!.tenantId,
        AGENT365_ENVIRONMENT: sources[0]!.environment,
      },
      {
        credential: tokenCredential(sources[0]!.tenantId),
        client: {
          fetcher: vi.fn<typeof fetch>().mockImplementation(
            (_url, init) =>
              new Promise((_resolve, reject) => {
                requestSignal = init?.signal as AbortSignal | undefined
                requestSignal?.addEventListener('abort', () =>
                  reject(new DOMException('aborted', 'AbortError')),
                )
              }),
          ),
        },
      },
    )
    const controller = new AbortController()
    const result = connector.discover({ signal: controller.signal })
    await vi.waitFor(() => expect(requestSignal).toBeDefined())

    controller.abort()
    const snapshot = await result

    expect(snapshot.nodes).toEqual(baseSnapshot.nodes)
    expect(connector.getConnectorHealth?.().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent365:primary',
          readiness: 'unavailable',
          dataState: 'cancelled',
          reason: 'cancelled',
        }),
      ]),
    )
  })

  it('bounds Agent 365 source concurrency at the configured value', async () => {
    const threeSources = [
      ...sources,
      {
        id: 'tenant-c',
        name: 'Tenant C',
        tenantId: '00000000-0000-0000-0000-000000000003',
        environment: 'agent365-c',
      },
    ]
    const config = parseAgent365Config({
      AGENT365_SOURCES_JSON: JSON.stringify(threeSources),
      AGENT365_MAX_CONCURRENCY: '2',
    })
    let active = 0
    let maximumActive = 0
    const releases: Array<() => void> = []
    const connector = new Agent365CompositionConnector(baseConnector(), config, {
      credentialFactory: (source) => tokenCredential(source.tenantId),
      clientFactory: () => ({
        fetcher: vi.fn<typeof fetch>().mockImplementation(
          () =>
            new Promise<Response>((resolve) => {
              active += 1
              maximumActive = Math.max(maximumActive, active)
              releases.push(() => {
                active -= 1
                resolve(
                  graphResponse({ value: [{ id: `P_${releases.length}`, displayName: 'A' }] }),
                )
              })
            }),
        ),
      }),
    })

    const result = connector.discover()
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    expect(maximumActive).toBe(2)
    releases.shift()!()
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases.splice(0).forEach((release) => release())
    await result

    expect(maximumActive).toBe(2)
  })

  it('keeps the aggregate item budget atomic across concurrent sources', async () => {
    const config = parseAgent365Config({
      AGENT365_SOURCES_JSON: JSON.stringify(sources),
      AGENT365_MAX_ITEMS: '2',
      AGENT365_MAX_CONCURRENCY: '2',
    })
    const fetchers = new Map(
      sources.map((source) => [
        source.id,
        vi.fn<typeof fetch>().mockResolvedValue(
          graphResponse({
            value: [
              { id: `${source.id}-first`, displayName: `${source.name} first` },
              { id: `${source.id}-second`, displayName: `${source.name} second` },
            ],
          }),
        ),
      ]),
    )
    const connector = new Agent365CompositionConnector(baseConnector(), config, {
      credentialFactory: (source) => tokenCredential(source.tenantId),
      clientFactory: (source) => ({ fetcher: fetchers.get(source.id)! }),
    })

    const snapshot = await connector.discover()
    const sourceHealth = connector
      .getConnectorHealth()
      .sources.filter((source) => source.id.startsWith('agent365:'))

    expect(fetchers.get('tenant-a')).toHaveBeenCalledOnce()
    expect(fetchers.get('tenant-b')).toHaveBeenCalledOnce()
    expect(sourceHealth.reduce((total, source) => total + (source.records ?? 0), 0)).toBe(2)
    expect(snapshot.nodes.map((node) => node.name)).toEqual([
      'Base agent',
      'Tenant A first',
      'Tenant B first',
    ])
  })

  it.each([
    {
      name: 'the response page contains extra records',
      body: {
        value: [
          { id: 'P_first', displayName: 'First' },
          { id: 'P_extra', displayName: 'Extra' },
        ],
      },
    },
    {
      name: 'a nextLink remains at the record cap',
      body: {
        '@odata.nextLink':
          'https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?$skiptoken=next',
        value: [{ id: 'P_first', displayName: 'First' }],
      },
    },
  ])('reports partial bounds health when $name', async ({ body }) => {
    const config = parseAgent365Config({
      AGENT365_SOURCES_JSON: JSON.stringify([
        {
          ...sources[0],
          limits: {
            maxItems: 10,
          },
        },
      ]),
      AGENT365_MAX_ITEMS: '1',
    })
    const connector = new Agent365CompositionConnector(baseConnector(), config, {
      credentialFactory: (source) => tokenCredential(source.tenantId),
      clientFactory: () => ({
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(graphResponse(body)),
      }),
    })

    const snapshot = await connector.discover()
    const health = connector.getConnectorHealth()

    expect(snapshot.nodes.map((node) => node.name)).toEqual(['Base agent', 'First'])
    expect(health).toMatchObject({
      overall: 'degraded',
      partial: true,
    })
    expect(health.sources.find((source) => source.id === 'agent365:tenant-a')).toMatchObject({
      readiness: 'degraded',
      dataState: 'partial',
      records: 1,
      reason: 'bounds',
    })
  })

  it('preserves page-cap measurements as partial bounds health', async () => {
    const config = parseAgent365Config({
      AGENT365_SOURCES_JSON: JSON.stringify([
        {
          ...sources[0],
          limits: {
            maxPages: 2,
          },
        },
      ]),
    })
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        graphResponse({
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?$skiptoken=second',
          value: [{ id: 'P_first', displayName: 'First' }],
        }),
      )
      .mockResolvedValueOnce(
        graphResponse({
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?$skiptoken=third',
          value: [{ id: 'P_second', displayName: 'Second' }],
        }),
      )
    const connector = new Agent365CompositionConnector(baseConnector(), config, {
      credentialFactory: (source) => tokenCredential(source.tenantId),
      clientFactory: () => ({ fetcher }),
    })

    const snapshot = await connector.discover()
    const health = connector.getConnectorHealth()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(snapshot.nodes.map((node) => node.name)).toEqual(['Base agent', 'First', 'Second'])
    expect(health).toMatchObject({
      overall: 'degraded',
      partial: true,
    })
    expect(health.sources.find((source) => source.id === 'agent365:tenant-a')).toMatchObject({
      readiness: 'degraded',
      dataState: 'partial',
      pages: 2,
      records: 2,
      reason: 'bounds',
    })
  })

  it('enforces one actual response-byte budget across concurrent sources', async () => {
    const config = parseAgent365Config({
      AGENT365_SOURCES_JSON: JSON.stringify(sources),
      AGENT365_MAX_RESPONSE_BYTES: '1024',
      AGENT365_MAX_CONCURRENCY: '2',
    })
    const connector = new Agent365CompositionConnector(baseConnector(), config, {
      credentialFactory: (source) => tokenCredential(source.tenantId),
      clientFactory: (source) => ({
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(
          graphResponse({
            value: [
              {
                id: `P_${source.id}`,
                displayName: source.name,
                shortDescription: 'x'.repeat(700),
                supportedHosts: ['Copilot'],
              },
            ],
          }),
        ),
      }),
    })

    const snapshot = await connector.discover()
    const sourceHealth = connector
      .getConnectorHealth()
      .sources.filter((source) => source.id.startsWith('agent365:'))

    expect(snapshot.nodes.filter((node) => node.id !== 'base-node')).toHaveLength(1)
    expect(sourceHealth.filter((source) => source.readiness === 'ready')).toHaveLength(1)
    expect(sourceHealth.filter((source) => source.reason === 'bounds')).toHaveLength(1)
  })

  it('enforces one actual response-byte budget across pages', async () => {
    const config = parseAgent365Config({
      AGENT365_SOURCES_JSON: JSON.stringify([sources[0]]),
      AGENT365_MAX_RESPONSE_BYTES: '1024',
    })
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        graphResponse({
          '@odata.nextLink':
            'https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?$skiptoken=next',
          value: [
            {
              id: 'P_first',
              displayName: 'First',
              shortDescription: 'x'.repeat(600),
              supportedHosts: ['Copilot'],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        graphResponse({
          value: [
            {
              id: 'P_second',
              displayName: 'Second',
              shortDescription: 'x'.repeat(600),
              supportedHosts: ['Copilot'],
            },
          ],
        }),
      )
    const connector = new Agent365CompositionConnector(baseConnector(), config, {
      credentialFactory: (source) => tokenCredential(source.tenantId),
      clientFactory: () => ({ fetcher }),
    })

    const snapshot = await connector.discover()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(snapshot.nodes).toEqual(baseSnapshot.nodes)
    expect(connector.getConnectorHealth().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent365:tenant-a',
          readiness: 'unavailable',
          dataState: 'failed',
          reason: 'bounds',
        }),
      ]),
    )
  })

  it('keeps aggregate response-byte exhaustion terminal for queued sources', async () => {
    const threeSources = [
      ...sources,
      {
        id: 'tenant-c',
        name: 'Tenant C',
        tenantId: '00000000-0000-0000-0000-000000000003',
        environment: 'agent365-c',
      },
    ]
    const config = parseAgent365Config({
      AGENT365_SOURCES_JSON: JSON.stringify(threeSources),
      AGENT365_MAX_RESPONSE_BYTES: '1024',
      AGENT365_MAX_CONCURRENCY: '1',
    })
    const connector = new Agent365CompositionConnector(baseConnector(), config, {
      credentialFactory: (source) => tokenCredential(source.tenantId),
      clientFactory: (source) => ({
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(
          graphResponse({
            value: [
              {
                id: `P_${source.id}`,
                displayName: source.name,
                shortDescription: source.id === 'tenant-c' ? 'small' : 'x'.repeat(700),
                supportedHosts: ['Copilot'],
              },
            ],
          }),
        ),
      }),
    })

    const snapshot = await connector.discover()
    const sourceHealth = connector
      .getConnectorHealth()
      .sources.filter((source) => source.id.startsWith('agent365:'))

    expect(snapshot.nodes.filter((node) => node.id !== 'base-node')).toHaveLength(1)
    expect(sourceHealth.filter((source) => source.reason === 'bounds')).toHaveLength(2)
  })

  it('bounds 50-source connection probes by configured concurrency and aggregate deadline', async () => {
    const fiftySources = Array.from({ length: 50 }, (_, index) => ({
      id: `tenant-${String(index).padStart(2, '0')}`,
      name: `Tenant ${index}`,
      tenantId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      environment: `agent365-${index}`,
      limits: {
        maxPages: 20,
        maxItems: 5_000,
        requestTimeoutMs: 1_000,
        maxRetries: 0,
        maxRetryAfterMs: 0,
        maxResponseBytes: 2_000_000,
      },
    }))
    const config = parseAgent365Config({
      AGENT365_SOURCES_JSON: JSON.stringify(fiftySources),
      AGENT365_MAX_CONCURRENCY: '2',
      AGENT365_MAX_DURATION_MS: '100',
    })
    let active = 0
    let maximumActive = 0
    let started = 0
    const connector = new Agent365CompositionConnector(baseConnector(), config, {
      credentialFactory: (source) => tokenCredential(source.tenantId),
      clientFactory: () => ({
        fetcher: vi.fn<typeof fetch>().mockImplementation(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              started += 1
              active += 1
              maximumActive = Math.max(maximumActive, active)
              init?.signal?.addEventListener(
                'abort',
                () => {
                  active -= 1
                  reject(new DOMException('aborted', 'AbortError'))
                },
                { once: true },
              )
            }),
        ),
      }),
    })
    const startedAt = Date.now()

    const result = await connector.testConnection()

    expect(Date.now() - startedAt).toBeLessThan(750)
    expect(result.ok).toBe(false)
    expect(maximumActive).toBe(2)
    expect(started).toBe(2)
    expect(
      connector.getConnectorHealth().sources.filter((source) => source.id.startsWith('agent365:')),
    ).toHaveLength(50)
    expect(
      connector
        .getConnectorHealth()
        .sources.filter((source) => source.id.startsWith('agent365:'))
        .every(
          (source) =>
            source.readiness === 'unavailable' &&
            source.dataState === 'cancelled' &&
            source.reason === 'duration-exceeded',
        ),
    ).toBe(true)
  })

  it('cancels unfinished sources at the aggregate duration bound', async () => {
    const connector = createOptionalAgent365Connector(
      baseConnector(),
      {
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_TENANT_ID: sources[0]!.tenantId,
        AGENT365_ENVIRONMENT: sources[0]!.environment,
        AGENT365_MAX_DURATION_MS: '100',
      },
      {
        credential: tokenCredential(sources[0]!.tenantId),
        client: {
          fetcher: vi.fn<typeof fetch>().mockImplementation(
            (_url, init) =>
              new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () =>
                  reject(new DOMException('aborted', 'AbortError')),
                )
              }),
          ),
        },
      },
    )

    const snapshot = await connector.discover()

    expect(snapshot.nodes).toEqual(baseSnapshot.nodes)
    expect(connector.getConnectorHealth?.().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent365:primary',
          readiness: 'unavailable',
          dataState: 'cancelled',
          reason: 'duration-exceeded',
        }),
      ]),
    )
  })

  it('maps license-required and tenant-not-available failures honestly', async () => {
    for (const [status, code, readiness, expectedReason] of [
      [403, 'LicenseRequired', 'authorization-required', 'license-required'],
      [404, 'NotFound', 'unavailable', 'not-available'],
    ] as const) {
      const connector = createOptionalAgent365Connector(
        baseConnector(),
        {
          AGENT365_CONNECTOR_ENABLED: 'true',
          AGENT365_TENANT_ID: sources[0]!.tenantId,
          AGENT365_ENVIRONMENT: 'agent365-a',
        },
        {
          credential: tokenCredential(sources[0]!.tenantId),
          client: {
            fetcher: vi
              .fn<typeof fetch>()
              .mockResolvedValue(graphResponse({ error: { code } }, status)),
          },
        },
      )
      await connector.discover()
      expect(connector.getConnectorHealth?.().sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'agent365:primary',
            readiness,
            reason: expectedReason,
          }),
        ]),
      )
    }
  })

  it('marks prior complete discovery stale when a later connection probe fails', async () => {
    let failProbe = false
    const connector = createOptionalAgent365Connector(
      baseConnector(),
      {
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_TENANT_ID: sources[0]!.tenantId,
        AGENT365_ENVIRONMENT: sources[0]!.environment,
        AGENT365_MANAGED_IDENTITY_CLIENT_ID: '59dbea72-1e91-403a-89cf-e02cdb8da350',
      },
      {
        credential: tokenCredential(sources[0]!.tenantId),
        client: {
          fetcher: vi.fn<typeof fetch>().mockImplementation(() =>
            Promise.resolve(
              failProbe
                ? graphResponse({ error: { code: 'Authorization_RequestDenied' } }, 403)
                : graphResponse({
                    value: [{ id: 'P_live', displayName: 'Live package' }],
                  }),
            ),
          ),
        },
      },
    )
    await connector.discover()
    expect(connector.getConnectorHealth?.()).toMatchObject({
      overall: 'ready',
      partial: false,
    })
    await expect(connector.testConnection()).resolves.toMatchObject({
      ok: true,
      message: 'The base connector and all enabled Agent 365 sources are reachable.',
    })

    failProbe = true
    await connector.testConnection()

    const health = connector.getConnectorHealth?.()
    expect(health).toMatchObject({
      overall: 'degraded',
      partial: true,
    })
    expect(health?.sources.find((source) => source.id === 'agent365:primary')).toMatchObject({
      readiness: 'authorization-required',
      dataState: 'stale',
      reason: 'authorization',
    })
  })

  it('collects sources sequentially and enforces the aggregate item bound', async () => {
    const config = parseAgent365Config({
      AGENT365_SOURCES_JSON: JSON.stringify(sources),
      AGENT365_MAX_ITEMS: '1',
      AGENT365_MAX_CONCURRENCY: '1',
    })
    const first = vi.fn<typeof fetch>().mockResolvedValue(
      graphResponse({
        value: [{ id: 'P_first', displayName: 'First', supportedHosts: ['Copilot'] }],
      }),
    )
    const second = vi.fn<typeof fetch>().mockResolvedValue(
      graphResponse({
        value: [{ id: 'P_second', displayName: 'Second', supportedHosts: ['Copilot'] }],
      }),
    )
    const connector = new Agent365CompositionConnector(baseConnector(), config, {
      credentialFactory: (source) => tokenCredential(source.tenantId),
      clientFactory: (source) => ({ fetcher: source.id === 'tenant-a' ? first : second }),
    })

    const snapshot = await connector.discover()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(snapshot.nodes.map((node) => node.name)).toEqual(['Base agent', 'First'])
    expect(connector.getConnectorHealth().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'agent365:tenant-a', readiness: 'ready' }),
        expect.objectContaining({
          id: 'agent365:tenant-b',
          readiness: 'unavailable',
          reason: 'bounds',
        }),
      ]),
    )
  })
})
