import { readFileSync } from 'node:fs'

import type { AgentConnector } from '@agent-sentinel/connector-sdk'
import type { AccessToken, TokenCredential } from '@azure/core-auth'
import type { EstateSnapshot } from '@agent-sentinel/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  EntraEnrichmentConnector,
  EntraGraphClient,
  EntraIdentityConnector,
  MultiEntraEnrichmentConnector,
  createEntraIdentityConnector,
  createOptionalEntraEnrichmentConnector,
  enrichSnapshotWithEntra,
  entraIdentityConnectorConfigSchema,
  mapEntraInventoryToSnapshot,
  parseEntraSourcesConfig,
  servicePrincipalPageSchema,
} from '../src/index.js'

const tenantId = '99999999-9999-4999-8999-999999999999'
const config = {
  tenantId,
  environment: 'validation',
  graphBaseUrl: 'https://graph.microsoft.com',
  capabilities: { owners: false, appRoleAssignments: false, agentIdentityPreview: false },
  limits: {
    maxPages: 10,
    maxItems: 100,
    requestTimeoutMs: 100,
    maxRetries: 2,
    maxRetryAfterMs: 5_000,
  },
}

class Credential implements TokenCredential {
  constructor(private readonly token = 'super-secret-token') {}
  getToken(): Promise<AccessToken> {
    return Promise.resolve({ token: this.token, expiresOnTimestamp: Date.now() + 60_000 })
  }
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}

function response(name: string, init?: ResponseInit): Response {
  return Response.json(fixture(name), init)
}

function baseSnapshot(metadata: Record<string, string>): EstateSnapshot {
  const observedAt = '2026-08-27T08:00:00.000Z'
  return {
    tenantId,
    environment: 'validation',
    generatedAt: observedAt,
    nodes: [
      {
        id: 'agent-1',
        kind: 'agent',
        name: 'Different display name',
        description: 'test',
        environment: 'validation',
        evidenceIds: ['base-evidence'],
        metadata,
      },
    ],
    edges: [],
    evidence: [
      {
        id: 'base-evidence',
        source: 'Foundry',
        sourceObjectId: 'agent-1',
        observedAt,
        freshness: 'live',
        confidence: 1,
        summary: 'Declared configuration.',
      },
    ],
  }
}

function baseConnector(): AgentConnector {
  return {
    descriptor: {
      id: 'base',
      name: 'base',
      apiVersion: 'v1',
      releaseStatus: 'ga',
      capabilities: ['discovery'],
      requiredPermissions: [],
      blindSpots: [],
    },
    testConnection: () =>
      Promise.resolve({
        ok: true,
        checkedAt: '2026-08-27T08:00:00.000Z',
        message: 'ok',
      }),
    discover: () =>
      Promise.resolve(baseSnapshot({ servicePrincipalId: '22222222-2222-4222-8222-222222222222' })),
    getEvidence: () => Promise.reject(new Error('not used')),
  }
}

function connectorForSnapshot(snapshot: EstateSnapshot): AgentConnector {
  return {
    ...baseConnector(),
    discover: () => Promise.resolve(structuredClone(snapshot)),
  }
}

function inventorySnapshot() {
  const principal = (fixture('service-principals-page-1.json') as { value: unknown[] }).value[0]
  const assignment = (fixture('app-role-assignments.json') as { value: unknown[] }).value[0]
  return mapEntraInventoryToSnapshot(
    {
      servicePrincipals: [principal as never],
      owners: new Map(),
      appRoleAssignments: new Map([
        ['11111111-1111-4111-8111-111111111111', [assignment as never]],
      ]),
      agentIdentitiesPreview: [],
    },
    config,
    '2026-08-27T08:00:00.000Z',
  )
}

afterEach(() => vi.useRealTimers())

describe('Microsoft Graph client contracts', () => {
  it('accepts Azure application GUIDs that are not RFC UUIDs', () => {
    expect(
      servicePrincipalPageSchema.parse({
        value: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            appId: '00000003-0000-0000-c000-000000000000',
            displayName: 'Microsoft Graph',
          },
        ],
      }),
    ).toMatchObject({
      value: [{ appId: '00000003-0000-0000-c000-000000000000' }],
    })
  })

  it('accepts only the HTTPS public Microsoft Graph base URL', () => {
    expect(entraIdentityConnectorConfigSchema.parse(config).graphBaseUrl).toBe(
      'https://graph.microsoft.com',
    )
    for (const graphBaseUrl of [
      'http://graph.microsoft.com',
      'https://evil.example',
      'https://graph.microsoft.com.evil.example',
      'https://graph.microsoft.com/v1.0',
      'https://user@graph.microsoft.com',
    ]) {
      expect(() => entraIdentityConnectorConfigSchema.parse({ ...config, graphBaseUrl })).toThrow()
    }
  })

  it('loads bounded environment configuration without sharing user-auth settings', async () => {
    const connector = createEntraIdentityConnector(
      {
        ENTRA_CONNECTOR_TENANT_ID: tenantId,
        ENTRA_CONNECTOR_ENVIRONMENT: 'validation',
        ENTRA_CONNECTOR_MAX_ITEMS: '10',
        ENTRA_CONNECTOR_AGENT_IDENTITY_PREVIEW: 'false',
        AUTH_TENANT_ID: '88888888-8888-4888-8888-888888888888',
      },
      new Credential(),
      {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(response('service-principals-page-2.json')),
      },
    )
    await expect(connector.discover()).resolves.toMatchObject({ tenantId })
  })

  it('follows same-resource pagination and enforces item bounds', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('service-principals-page-1.json'))
      .mockResolvedValueOnce(response('service-principals-page-2.json'))
    const client = new EntraGraphClient(config, new Credential(), { fetcher })
    await expect(client.listServicePrincipals()).resolves.toHaveLength(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const boundedFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('service-principals-page-1.json'))
      .mockResolvedValueOnce(response('service-principals-page-2.json'))
    await expect(
      new EntraGraphClient(
        { ...config, limits: { ...config.limits, maxItems: 1 } },
        new Credential(),
        { fetcher: boundedFetcher },
      ).listServicePrincipals(),
    ).rejects.toThrow('item limit')

    const pageBoundFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('service-principals-page-1.json'))
    await expect(
      new EntraGraphClient(
        { ...config, limits: { ...config.limits, maxPages: 1 } },
        new Credential(),
        { fetcher: pageBoundFetcher },
      ).listServicePrincipals(),
    ).rejects.toThrow('page limit')
  })

  it('rejects next links on another host or resource path', async () => {
    for (const nextLink of [
      'https://evil.example/v1.0/servicePrincipals',
      'https://graph.microsoft.com/v1.0/users',
    ]) {
      const client = new EntraGraphClient(config, new Credential(), {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            value: [],
            '@odata.nextLink': nextLink,
          }),
        ),
      })
      await expect(client.listServicePrincipals()).rejects.toThrow('untrusted nextLink')
    }
  })

  it('rejects malformed payloads and cross-principal assignments', async () => {
    await expect(
      new EntraGraphClient(config, new Credential(), {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ value: [{ id: 'bad' }] })),
      }).listServicePrincipals(),
    ).rejects.toThrow()

    const principal = (fixture('service-principals-page-1.json') as { value: unknown[] }).value[0]
    await expect(
      new EntraGraphClient(config, new Credential(), {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            value: [
              {
                ...(fixture('app-role-assignments.json') as { value: Record<string, unknown>[] })
                  .value[0],
                principalId: '22222222-2222-4222-8222-222222222222',
              },
            ],
          }),
        ),
      }).listAppRoleAssignments([principal as never]),
    ).rejects.toThrow('outside the requested principal boundary')
  })

  it('retries only retryable statuses with Retry-After', async () => {
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(response('service-principals-page-2.json'))
    await new EntraGraphClient(config, new Credential(), { fetcher, sleep }).listServicePrincipals()
    expect(sleep).toHaveBeenCalledWith(1000)
    expect(fetcher).toHaveBeenCalledTimes(2)

    const noRetry = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }))
    await expect(
      new EntraGraphClient(config, new Credential(), {
        fetcher: noRetry,
        sleep,
      }).listServicePrincipals(),
    ).rejects.toThrow('status 503')
    expect(noRetry).toHaveBeenCalledTimes(1)
  })

  it('aborts timed-out requests', async () => {
    const client = new EntraGraphClient(
      { ...config, limits: { ...config.limits, requestTimeoutMs: 100 } },
      new Credential(),
      {
        fetcher: vi.fn<typeof fetch>().mockImplementation(
          (_input, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
            }),
        ),
      },
    )
    await expect(client.listServicePrincipals()).rejects.toThrow('timed out')
  })

  it('sanitizes Graph and credential errors without leaking tokens', async () => {
    const secret = 'super-secret-token'
    const connector = new EntraIdentityConnector(config, new Credential(secret), {
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ error: { message: `denied ${secret}` } }, { status: 403 }),
        ),
    })
    const result = await connector.testConnection()
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(connector.getHealth())).not.toContain(secret)
  })

  it('reads optional owners and app-role assignments with explicit health', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('service-principals-page-1.json'))
      .mockResolvedValueOnce(response('service-principals-page-2.json'))
      .mockResolvedValueOnce(response('owners.json'))
      .mockResolvedValueOnce(Response.json({ value: [] }))
      .mockResolvedValueOnce(response('app-role-assignments.json'))
      .mockResolvedValueOnce(Response.json({ value: [] }))
    const connector = new EntraIdentityConnector(
      {
        ...config,
        capabilities: {
          owners: true,
          appRoleAssignments: true,
          agentIdentityPreview: false,
        },
      },
      new Credential(),
      { fetcher },
    )
    const snapshot = await connector.discover()
    expect(snapshot.nodes[0]?.owner).toBe('Identity Owner')
    expect(snapshot.edges).toHaveLength(1)
    expect(connector.getHealth()).toMatchObject({
      owners: { status: 'available' },
      appRoleAssignments: { status: 'available' },
    })
  })

  it('reports optional stable enrichment degradation without dropping inventory', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('service-principals-page-2.json'))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
    const connector = new EntraIdentityConnector(
      { ...config, capabilities: { ...config.capabilities, owners: true } },
      new Credential(),
      { fetcher },
    )
    const snapshot = await connector.discover()
    expect(snapshot.nodes).toHaveLength(1)
    expect(connector.getHealth().stableInventory.status).toBe('available')
    expect(connector.getHealth().owners.status).toBe('degraded')
  })
})

describe('normalization and correlation', () => {
  it('keeps identity nodes distinct and normalizes app-role evidence', () => {
    const snapshot = inventorySnapshot()
    expect(snapshot.nodes.filter((node) => node.kind === 'identity')).toHaveLength(2)
    expect(snapshot.edges).toEqual([
      expect.objectContaining({ relationship: 'CAN_CALL', removable: false }),
    ])
    expect(snapshot.nodes[0]?.metadata['correlationStatus']).toBe('uncorrelated')
    expect(snapshot.evidence.every((item) => item.confidence === 1)).toBe(true)
  })

  it('correlates only an explicit directory or application ID', () => {
    const identities = inventorySnapshot()
    const directoryMatch = enrichSnapshotWithEntra(
      baseSnapshot({ servicePrincipalId: '11111111-1111-4111-8111-111111111111' }),
      identities,
    )
    expect(directoryMatch.edges.some((edge) => edge.relationship === 'RUNS_AS')).toBe(true)

    const appMatch = enrichSnapshotWithEntra(
      baseSnapshot({ clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      identities,
    )
    expect(appMatch.edges.some((edge) => edge.relationship === 'RUNS_AS')).toBe(true)

    const noMatch = enrichSnapshotWithEntra(
      baseSnapshot({ displayName: 'Explicit Agent Identity' }),
      identities,
    )
    expect(noMatch.edges.some((edge) => edge.relationship === 'RUNS_AS')).toBe(false)
    expect(
      noMatch.nodes.find((node) => node.kind === 'identity')?.metadata['correlationStatus'],
    ).toBe('uncorrelated')
  })

  it('rejects cross-tenant composition', () => {
    expect(() =>
      enrichSnapshotWithEntra(
        { ...baseSnapshot({}), tenantId: '88888888-8888-4888-8888-888888888888' },
        inventorySnapshot(),
      ),
    ).toThrow('different Microsoft Entra tenants')
  })
})

describe('optional preview capability', () => {
  it('does not call beta when disabled', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response('service-principals-page-2.json'))
    const connector = new EntraIdentityConnector(config, new Credential(), { fetcher })
    await connector.discover()
    expect(
      fetcher.mock.calls.some(([request]) => {
        const url =
          request instanceof URL
            ? request.href
            : typeof request === 'string'
              ? request
              : request.url
        return url.includes('/beta/')
      }),
    ).toBe(false)
    expect(connector.getHealth().agentIdentityPreview.status).toBe('disabled')
  })

  it('enriches from beta when enabled', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('service-principals-page-2.json'))
      .mockResolvedValueOnce(response('agent-identities-preview.json'))
    const connector = new EntraIdentityConnector(
      { ...config, capabilities: { ...config.capabilities, agentIdentityPreview: true } },
      new Credential(),
      { fetcher },
    )
    const snapshot = await connector.discover()
    expect(snapshot.nodes.some((node) => node.metadata['agentIdentityPreview'] === 'true')).toBe(
      true,
    )
    expect(connector.getHealth().agentIdentityPreview.status).toBe('available')
  })

  it('degrades beta failure without falsifying stable inventory', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('service-principals-page-2.json'))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
    const connector = new EntraIdentityConnector(
      { ...config, capabilities: { ...config.capabilities, agentIdentityPreview: true } },
      new Credential(),
      { fetcher },
    )
    const snapshot = await connector.discover()
    expect(snapshot.nodes).toHaveLength(1)
    expect(connector.getHealth().stableInventory.status).toBe('available')
    expect(connector.getHealth().agentIdentityPreview.status).toBe('degraded')
  })
})
describe('composite enrichment connector', () => {
  it('preserves base discovery and reports explicit Entra health', async () => {
    const entra = new EntraIdentityConnector(config, new Credential(), {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(response('service-principals-page-2.json')),
    })
    const composite = new EntraEnrichmentConnector(baseConnector(), entra)
    const snapshot = await composite.discover()
    expect(snapshot.nodes.some((node) => node.kind === 'agent')).toBe(true)
    expect(snapshot.nodes.some((node) => node.kind === 'identity')).toBe(true)
    expect(snapshot.edges.some((edge) => edge.relationship === 'RUNS_AS')).toBe(true)
    expect(composite.getHealth().entra.stableInventory.status).toBe('available')
  })

  describe('multi-source Entra enrichment', () => {
    const tenantA = '99999999-9999-4999-8999-999999999999'
    const tenantB = '88888888-8888-4888-8888-888888888888'
    const expectedSources = [
      {
        id: 'project-a',
        name: 'Project A',
        tenantId: tenantA,
        environment: 'production',
      },
      {
        id: 'project-b',
        name: 'Project B',
        tenantId: tenantB,
        environment: 'validation',
      },
    ]

    function aggregateBase(): EstateSnapshot {
      const observedAt = '2026-08-28T00:00:00.000Z'
      return {
        tenantId: 'estate',
        environment: 'portfolio',
        generatedAt: observedAt,
        nodes: expectedSources.map((source) => ({
          id: `agent-${source.id}`,
          kind: 'agent' as const,
          name: `Agent ${source.id}`,
          description: 'test',
          environment: source.environment,
          evidenceIds: [`evidence-${source.id}`],
          metadata: {
            sourceConnectorId: source.id,
            sourceTenantId: source.tenantId,
            sourceEnvironment: source.environment,
            servicePrincipalId: '11111111-1111-4111-8111-111111111111',
          },
        })),
        edges: [],
        evidence: expectedSources.map((source) => ({
          id: `evidence-${source.id}`,
          source: 'Foundry',
          sourceObjectId: source.id,
          observedAt,
          freshness: 'live' as const,
          confidence: 1,
          summary: 'Declared configuration.',
        })),
      }
    }

    function sourceConfig(source: (typeof expectedSources)[number]) {
      return {
        ...source,
        graphBaseUrl: 'https://graph.microsoft.com',
        capabilities: {
          owners: false,
          appRoleAssignments: false,
          agentIdentityPreview: false,
        },
        limits: config.limits,
      }
    }

    it('parses legacy and multi-source environment configuration', () => {
      expect(
        parseEntraSourcesConfig({
          ENTRA_CONNECTOR_TENANT_ID: tenantA,
          ENTRA_CONNECTOR_ENVIRONMENT: 'production',
        }),
      ).toMatchObject([{ id: 'primary', tenantId: tenantA }])
      expect(
        parseEntraSourcesConfig({
          ENTRA_SOURCES_JSON: JSON.stringify(expectedSources),
        }),
      ).toMatchObject([
        { id: 'project-a', tenantId: tenantA },
        { id: 'project-b', tenantId: tenantB },
      ])
    })

    it('correlates identical directory ids only within matching source boundaries', async () => {
      const servicePrincipal = {
        id: '11111111-1111-4111-8111-111111111111',
        appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Shared provider id',
        servicePrincipalType: 'Application',
        accountEnabled: true,
        appOwnerOrganizationId: tenantA,
        tags: [],
      }
      const connector = new MultiEntraEnrichmentConnector(
        connectorForSnapshot(aggregateBase()),
        expectedSources.map(sourceConfig),
        {
          enabled: true,
          expectedSources,
          credentialFactory: () => new Credential(),
          clientFactory: () => ({
            fetcher: vi
              .fn<typeof fetch>()
              .mockResolvedValue(Response.json({ value: [servicePrincipal] })),
          }),
        },
      )

      const snapshot = await connector.discover()
      const correlations = snapshot.edges.filter((edge) => edge.relationship === 'RUNS_AS')
      expect(correlations).toHaveLength(2)
      for (const source of expectedSources) {
        const agent = snapshot.nodes.find((node) => node.id === `agent-${source.id}`)
        expect(agent?.metadata['entraIdentityNodeId']).toContain(`entra-source-${source.id}--`)
        const edge = correlations.find((candidate) => candidate.from === agent?.id)
        const identity = snapshot.nodes.find((node) => node.id === edge?.to)
        expect(identity?.metadata['sourceTenantId']).toBe(source.tenantId)
      }
      expect(connector.getConnectorHealth()).toMatchObject({
        overall: 'ready',
        partial: false,
        sources: [
          { id: 'base', readiness: 'ready' },
          { id: 'entra:project-a', readiness: 'ready' },
          { id: 'entra:project-b', readiness: 'ready' },
        ],
      })
    })

    it('reports missing tenant authorization without correlating another source', async () => {
      const connector = new MultiEntraEnrichmentConnector(
        connectorForSnapshot(aggregateBase()),
        [sourceConfig(expectedSources[0]!)],
        {
          enabled: true,
          expectedSources,
          credentialFactory: () => new Credential(),
          clientFactory: () => ({
            fetcher: vi.fn<typeof fetch>().mockResolvedValue(
              Response.json({
                value: [
                  {
                    id: '11111111-1111-4111-8111-111111111111',
                    appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    displayName: 'Tenant A identity',
                    servicePrincipalType: 'Application',
                    accountEnabled: true,
                    appOwnerOrganizationId: tenantA,
                    tags: [],
                  },
                ],
              }),
            ),
          }),
        },
      )
      const snapshot = await connector.discover()
      expect(snapshot.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(1)
      expect(connector.getConnectorHealth()).toMatchObject({
        overall: 'degraded',
        partial: true,
        sources: [
          { id: 'base', readiness: 'ready' },
          { id: 'entra:project-a', readiness: 'ready' },
          {
            id: 'entra:project-b',
            configured: false,
            readiness: 'authorization-required',
          },
        ],
      })
    })

    it('preserves sanitized Graph failure reasons in source health', async () => {
      const expected = [expectedSources[0]!]
      const connector = new MultiEntraEnrichmentConnector(
        connectorForSnapshot(aggregateBase()),
        [sourceConfig(expected[0]!)],
        {
          enabled: true,
          expectedSources: expected,
          credentialFactory: () => new Credential(),
          clientFactory: () => ({
            fetcher: vi
              .fn<typeof fetch>()
              .mockResolvedValue(new Response(undefined, { status: 403 })),
          }),
        },
      )

      await connector.discover()

      expect(connector.getConnectorHealth()).toMatchObject({
        overall: 'degraded',
        partial: true,
        sources: [
          { id: 'base', readiness: 'ready' },
          {
            id: 'entra:project-a',
            readiness: 'unavailable',
            reason: 'authorization (403)',
          },
        ],
      })
    })
  })

  it('fails closed on invalid activation configuration without blocking base discovery', async () => {
    const composite = createOptionalEntraEnrichmentConnector(baseConnector(), {
      ENTRA_CONNECTOR_ENABLED: 'not-a-boolean',
    })
    await expect(composite.discover()).resolves.toMatchObject({ tenantId })
    await expect(composite.testConnection()).resolves.toMatchObject({ ok: true })
    expect(composite.getConnectorHealth?.()).toMatchObject({
      overall: 'degraded',
      partial: true,
      sources: [
        { id: 'base', readiness: 'ready' },
        {
          id: 'microsoft-entra-service-principals',
          enabled: true,
          configured: false,
          readiness: 'degraded',
          reason: 'invalid-configuration',
        },
      ],
    })
  })

  it('does not report enabled optional capabilities ready before they are queried', async () => {
    const entra = new EntraIdentityConnector(
      { ...config, capabilities: { ...config.capabilities, owners: true } },
      new Credential(),
      {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(response('service-principals-page-2.json')),
      },
    )
    const composite = new EntraEnrichmentConnector(baseConnector(), entra)
    await expect(composite.testConnection()).resolves.toMatchObject({ ok: true })
    expect(composite.getConnectorHealth()).toMatchObject({
      overall: 'degraded',
      partial: true,
      sources: [
        { id: 'base', readiness: 'ready' },
        { id: 'microsoft-entra-service-principals', readiness: 'degraded' },
      ],
    })
  })
})
