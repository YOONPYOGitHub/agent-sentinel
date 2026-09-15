import { readFileSync } from 'node:fs'

import type {
  AgentConnector,
  ConnectionTestResult,
  ConnectorOperationRequest,
} from '@agent-sentinel/connector-sdk'
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
  enrichAggregateSnapshotWithEntraAndDiagnostics,
  enrichSnapshotWithEntra as enrichSnapshotWithEntraWithoutBinding,
  enrichSnapshotWithEntraAndDiagnostics as enrichSnapshotWithEntraAndDiagnosticsWithoutBinding,
  entraIdentityConnectorConfigSchema,
  mapEntraInventoryToSnapshot,
  parseEntraRunsAsBindings,
  parseEntraSourcesConfig,
  resolveEntraRuntimeActivation,
  servicePrincipalPageSchema,
} from '../src/index.js'
import { enrichAggregateSnapshotWithExactEntraBindingsAndDiagnostics } from '../src/normalize.js'

const tenantId = '99999999-9999-4999-8999-999999999999'
function tokenForTenant(
  tokenTenantId: string = tenantId,
  payload: Record<string, unknown> = {},
  signature = 'signature',
): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ tid: tokenTenantId, ...payload })}.${signature}`
}

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
    maxResponseBytes: 2_000_000,
  },
}

const defaultRunsAsBinding = {
  estateId: 'default',
  foundry: {
    sourceId: 'foundry:primary',
    tenantId,
    environment: 'validation',
    provider: 'azure-ai-foundry-agent-service' as const,
    sourceObjectId: 'test',
  },
  entra: {
    sourceId: 'entra:primary',
    tenantId,
    environment: 'validation',
    provider: 'microsoft-entra' as const,
    sourceObjectId: tenantId,
  },
}

function enrichSnapshotWithEntra(base: EstateSnapshot, identities: EstateSnapshot): EstateSnapshot {
  return enrichSnapshotWithEntraWithoutBinding(base, identities, defaultRunsAsBinding)
}

function enrichSnapshotWithEntraAndDiagnostics(base: EstateSnapshot, identities: EstateSnapshot) {
  return enrichSnapshotWithEntraAndDiagnosticsWithoutBinding(base, identities, defaultRunsAsBinding)
}

class Credential implements TokenCredential {
  constructor(private readonly token = tokenForTenant()) {}
  getToken(): Promise<AccessToken> {
    return Promise.resolve({ token: this.token, expiresOnTimestamp: Date.now() + 60_000 })
  }
}

function credentialForTenant(source: { tenantId: string }): TokenCredential {
  return new Credential(tokenForTenant(source.tenantId))
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}

function response(name: string, init?: ResponseInit): Response {
  return Response.json(fixture(name), init)
}

function baseSnapshot(metadata: Record<string, string>): EstateSnapshot {
  const observedAt = '2026-08-27T08:00:00.000Z'
  const authority = {
    estateId: 'default',
    sourceId: 'foundry:primary',
    tenantId,
    environment: 'validation',
    provider: 'azure-ai-foundry-agent-service' as const,
    sourceObjectId: 'test',
    providerObjectId: 'agent-1',
    snapshotGeneratedAt: observedAt,
    sourceRelease: 'v1',
  }
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
        metadata: {
          sourceOfTruth: 'true',
          estateId: authority.estateId,
          sourceId: authority.sourceId,
          sourceTenantId: authority.tenantId,
          sourceEnvironment: authority.environment,
          sourceProjectId: authority.sourceObjectId,
          provider: authority.provider,
          providerObjectId: authority.providerObjectId,
          snapshotGeneratedAt: authority.snapshotGeneratedAt,
          sourceRelease: authority.sourceRelease,
          ...metadata,
        },
      },
    ],
    edges: [],
    evidence: [
      {
        id: 'base-evidence',
        source: 'Foundry',
        sourceObjectId: 'primary:agent-1',
        observedAt,
        freshness: 'live',
        confidence: 1,
        evidenceTypes: ['declared_configuration'],
        summary: 'Declared configuration.',
        authority,
      },
    ],
  }
}

function baseSnapshotWithAgents(
  agents: Array<{ id: string; metadata: Record<string, string> }>,
): EstateSnapshot {
  const observedAt = '2026-08-27T08:00:00.000Z'
  return {
    tenantId,
    environment: 'validation',
    generatedAt: observedAt,
    nodes: agents.map((agent) => ({
      id: agent.id,
      kind: 'agent' as const,
      name: `Agent ${agent.id}`,
      description: 'test',
      environment: 'validation',
      evidenceIds: [`evidence-${agent.id}`],
      metadata: {
        sourceOfTruth: 'true',
        estateId: 'default',
        sourceId: 'foundry:primary',
        sourceTenantId: tenantId,
        sourceEnvironment: 'validation',
        sourceProjectId: 'test',
        provider: 'azure-ai-foundry-agent-service',
        providerObjectId: agent.id,
        snapshotGeneratedAt: observedAt,
        sourceRelease: 'v1',
        ...agent.metadata,
      },
    })),
    edges: [],
    evidence: agents.map((agent) => ({
      id: `evidence-${agent.id}`,
      source: 'Foundry',
      sourceObjectId: `primary:${agent.id}`,
      observedAt,
      freshness: 'live' as const,
      confidence: 1,
      evidenceTypes: ['declared_configuration' as const],
      summary: 'Declared configuration.',
      authority: {
        estateId: 'default',
        sourceId: 'foundry:primary',
        tenantId,
        environment: 'validation',
        provider: 'azure-ai-foundry-agent-service' as const,
        sourceObjectId: 'test',
        providerObjectId: agent.id,
        snapshotGeneratedAt: observedAt,
        sourceRelease: 'v1',
      },
    })),
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

  it('resolves complete legacy Entra tuples in live mode', () => {
    expect(
      resolveEntraRuntimeActivation(
        {
          ENTRA_CONNECTOR_ENABLED: 'true',
          ENTRA_CONNECTOR_TENANT_ID: tenantId,
          ENTRA_CONNECTOR_ENVIRONMENT: 'validation',
        },
        'live',
      ),
    ).toMatchObject({
      active: true,
      enabled: true,
      sources: [{ id: 'primary', tenantId, environment: 'validation' }],
    })
  })

  it.each([
    ['tenant only', { ENTRA_CONNECTOR_TENANT_ID: tenantId }],
    ['environment only', { ENTRA_CONNECTOR_ENVIRONMENT: 'validation' }],
  ])('rejects partial legacy Entra tuples: %s', (_label, environment) => {
    expect(() => resolveEntraRuntimeActivation(environment, 'live')).toThrow(
      'Legacy Entra configuration requires',
    )
  })

  it('hides and does not parse inactive Entra sources in mock mode', () => {
    expect(
      resolveEntraRuntimeActivation(
        {
          ENTRA_CONNECTOR_ENABLED: 'true',
          ENTRA_SOURCES_JSON: '{invalid',
          ENTRA_CONNECTOR_TENANT_ID: tenantId,
        },
        'mock',
      ),
    ).toEqual({ active: false, enabled: false, sources: [] })
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

  it.each([
    ['a missing tid claim', tokenForTenant('', { tid: undefined })],
    ['a malformed JWT', 'not-a-jwt'],
    ['a malformed tid claim', tokenForTenant('not-a-guid')],
    ['a different tenant', tokenForTenant('88888888-8888-4888-8888-888888888888')],
  ])('rejects %s before issuing a Graph request', async (_label, token) => {
    const fetcher = vi.fn<typeof fetch>()
    const client = new EntraGraphClient(config, new Credential(token), { fetcher })

    await expect(client.listServicePrincipals()).rejects.toMatchObject({
      code: 'authentication',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('accepts the configured tenant GUID case-insensitively', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response('service-principals-page-2.json'))
    const client = new EntraGraphClient(
      config,
      new Credential(tokenForTenant(tenantId.toUpperCase())),
      {
        fetcher,
      },
    )

    await expect(client.listServicePrincipals()).resolves.toHaveLength(1)
    expect(fetcher).toHaveBeenCalledOnce()
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

  it('propagates caller cancellation to credential and Graph requests', async () => {
    const controller = new AbortController()
    const credentialSignals: Array<{ readonly aborted: boolean }> = []
    const client = new EntraGraphClient(
      config,
      {
        getToken: (_scopes, options) => {
          if (options?.abortSignal !== undefined) credentialSignals.push(options.abortSignal)
          return Promise.resolve({
            token: tokenForTenant(),
            expiresOnTimestamp: Date.now() + 60_000,
          })
        },
      },
      {
        fetcher: vi.fn<typeof fetch>().mockImplementation(
          (_input, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
            }),
        ),
      },
    )
    const pending = client.listServicePrincipals({ signal: controller.signal })

    await Promise.resolve()
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(credentialSignals).toHaveLength(1)
    expect(credentialSignals[0]?.aborted).toBe(true)
  })

  it('cancels a stalled streamed response body when the caller aborts', async () => {
    const controller = new AbortController()
    const client = new EntraGraphClient(config, new Credential(), {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => undefined),
          }),
        ),
      ),
    })
    const pending = client.listServicePrincipals({ signal: controller.signal })

    await Promise.resolve()
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  }, 1_000)

  it.each([
    {
      name: 'declared content length',
      response: () =>
        new Response('x'.repeat(1_025), {
          headers: { 'content-length': '1025' },
        }),
    },
    {
      name: 'streamed bytes without content length',
      response: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('x'.repeat(1_025)))
              controller.close()
            },
          }),
        ),
    },
  ])('rejects a response above the byte limit from $name', async ({ response }) => {
    const boundedConfig = {
      ...config,
      limits: { ...config.limits, maxResponseBytes: 1_024 },
    }
    const client = new EntraGraphClient(boundedConfig, new Credential(), {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(response()),
    })

    await expect(client.listServicePrincipals()).rejects.toMatchObject({ code: 'bounds' })
  })

  it('sanitizes Graph and credential errors without leaking tokens', async () => {
    const secret = 'super-secret-token'
    const connector = new EntraIdentityConnector(
      config,
      new Credential(tokenForTenant(tenantId, {}, secret)),
      {
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            Response.json({ error: { message: `denied ${secret}` } }, { status: 403 }),
          ),
      },
    )

    const result = await connector.testConnection()
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(connector.getHealth())).not.toContain(secret)
  })

  it('reports an empty stable inventory probe as insufficient', async () => {
    const connector = new EntraIdentityConnector(config, new Credential(), {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ value: [] })),
    })

    await expect(connector.testConnection()).resolves.toMatchObject({ ok: false })
    expect(connector.getHealth().stableInventory).toEqual({
      status: 'insufficient',
      reason: 'empty',
    })
  })

  it('keeps an empty stable inventory non-ready during composition', async () => {
    const entra = new EntraIdentityConnector(config, new Credential(), {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ value: [] })),
    })
    const composite = new EntraEnrichmentConnector(baseConnector(), entra)

    const snapshot = await composite.discover()

    expect(snapshot.nodes.filter((node) => node.kind === 'identity')).toHaveLength(0)
    expect(composite.getConnectorHealth()).toMatchObject({
      overall: 'degraded',
      partial: true,
      sources: [
        { id: 'base', readiness: 'ready' },
        {
          id: 'microsoft-entra-service-principals',
          readiness: 'degraded',
          reason: 'empty',
        },
      ],
    })
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

  it('correlates an explicit directory ID and fails closed for application-ID-only authority', () => {
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
    expect(appMatch.edges.some((edge) => edge.relationship === 'RUNS_AS')).toBe(false)
    expect(appMatch.nodes.find((node) => node.id === 'agent-1')?.metadata).toMatchObject({
      entraCorrelationStatus: 'unmatched',
      entraCorrelationReason: 'application-id-authority-unavailable',
    })

    const noMatch = enrichSnapshotWithEntra(
      baseSnapshot({ displayName: 'Explicit Agent Identity' }),
      identities,
    )
    expect(noMatch.edges.some((edge) => edge.relationship === 'RUNS_AS')).toBe(false)
    expect(
      noMatch.nodes.find((node) => node.kind === 'identity')?.metadata['correlationStatus'],
    ).toBe('uncorrelated')
  })

  it('creates one RUNS_AS edge for a stable Foundry instance principal ID', () => {
    const principalId = '11111111-1111-4111-8111-111111111111'
    const result = enrichSnapshotWithEntra(
      baseSnapshot({
        servicePrincipalId: principalId,
        foundryInstanceIdentityPrincipalId: principalId,
        foundryInstanceIdentityClientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        foundryInstanceIdentityStatus: 'active',
      }),
      inventorySnapshot(),
    )

    expect(result.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(1)
    expect(result.nodes.find((node) => node.id === 'agent-1')?.metadata).toMatchObject({
      entraCorrelationStatus: 'matched',
      entraCorrelationMatchKind: 'object-id',
    })
  })

  it('keeps a stable Foundry instance client ID insufficient without object authority', () => {
    const result = enrichSnapshotWithEntra(
      baseSnapshot({
        clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        foundryInstanceIdentityClientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        foundryInstanceIdentityStatus: 'active',
      }),
      inventorySnapshot(),
    )

    expect(result.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(0)
    expect(result.nodes.find((node) => node.id === 'agent-1')?.metadata).toMatchObject({
      entraCorrelationStatus: 'unmatched',
      entraCorrelationReason: 'application-id-authority-unavailable',
    })
  })

  it('never treats Foundry blueprint or project managed identity IDs as RUNS_AS authority', () => {
    const principalId = '11111111-1111-4111-8111-111111111111'
    const result = enrichSnapshotWithEntra(
      baseSnapshot({
        foundryBlueprintPrincipalId: principalId,
        foundryBlueprintClientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        foundryBlueprintReferenceId: principalId,
        foundryProjectAgentIdentityId: principalId,
        foundryProjectManagedIdentityPrincipalId: principalId,
      }),
      inventorySnapshot(),
    )

    expect(result.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(0)
    expect(result.nodes.find((node) => node.id === 'agent-1')?.metadata).toMatchObject({
      entraCorrelationStatus: 'unmatched',
      entraCorrelationReason: 'missing-authoritative-identifier',
    })
  })

  it('does not correlate a tenant-wide inventory without an explicit source binding', () => {
    const result = enrichSnapshotWithEntraWithoutBinding(
      baseSnapshot({ servicePrincipalId: '11111111-1111-4111-8111-111111111111' }),
      inventorySnapshot(),
    )

    expect(result.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(0)
  })

  it('treats objectId as an exact directory object identifier', () => {
    const result = enrichSnapshotWithEntra(
      baseSnapshot({ objectId: '11111111-1111-4111-8111-111111111111' }),
      inventorySnapshot(),
    )

    expect(result.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(1)
    expect(result.nodes.find((node) => node.id === 'agent-1')?.metadata).toMatchObject({
      entraCorrelationStatus: 'matched',
      entraCorrelationMatchKind: 'object-id',
      entraIdentityNodeId:
        'entra-source-primary--entra-service-principal-11111111-1111-4111-8111-111111111111',
    })
  })

  it('does not correlate when objectId conflicts with servicePrincipalId', () => {
    const identities = mapEntraInventoryToSnapshot(
      {
        servicePrincipals: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            displayName: 'First identity',
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            appId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            displayName: 'Second identity',
          },
        ],
        owners: new Map(),
        appRoleAssignments: new Map(),
        agentIdentitiesPreview: [],
      },
      config,
      '2026-08-27T08:00:00.000Z',
    )
    const result = enrichSnapshotWithEntra(
      baseSnapshot({
        servicePrincipalId: '11111111-1111-4111-8111-111111111111',
        objectId: '22222222-2222-4222-8222-222222222222',
      }),
      identities,
    )

    expect(result.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(0)
    expect(result.nodes.find((node) => node.id === 'agent-1')?.metadata).toMatchObject({
      entraCorrelationStatus: 'ambiguous',
      entraCorrelationReason: 'conflicting-exact-source-matches',
    })
  })

  it('does not correlate when one exact identifier matches and another is unresolved', () => {
    const result = enrichSnapshotWithEntra(
      baseSnapshot({
        servicePrincipalId: '11111111-1111-4111-8111-111111111111',
        clientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
      inventorySnapshot(),
    )

    expect(result.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(0)
    expect(result.nodes.find((node) => node.id === 'agent-1')?.metadata).toMatchObject({
      entraCorrelationStatus: 'ambiguous',
      entraCorrelationReason: 'incomplete-exact-source-match',
    })
  })

  it('does not correlate when one exact identifier matches and another is malformed', () => {
    const result = enrichSnapshotWithEntra(
      baseSnapshot({
        servicePrincipalId: '11111111-1111-4111-8111-111111111111',
        clientId: 'not-a-guid',
      }),
      inventorySnapshot(),
    )

    expect(result.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(0)
    expect(result.nodes.find((node) => node.id === 'agent-1')?.metadata).toMatchObject({
      entraCorrelationStatus: 'unmatched',
      entraCorrelationReason: 'malformed-authoritative-identifier',
    })
  })

  it('marks conflicting stable Foundry principal and client identifiers ambiguous', () => {
    const identities = mapEntraInventoryToSnapshot(
      {
        servicePrincipals: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            displayName: 'First identity',
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            appId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            displayName: 'Second identity',
          },
        ],
        owners: new Map(),
        appRoleAssignments: new Map(),
        agentIdentitiesPreview: [],
      },
      config,
      '2026-08-27T08:00:00.000Z',
    )

    const result = enrichSnapshotWithEntra(
      baseSnapshot({
        servicePrincipalId: '11111111-1111-4111-8111-111111111111',
        clientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        foundryInstanceIdentityPrincipalId: '11111111-1111-4111-8111-111111111111',
        foundryInstanceIdentityClientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
      identities,
    )

    expect(result.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(0)
    expect(result.nodes.find((node) => node.id === 'agent-1')?.metadata).toMatchObject({
      entraCorrelationStatus: 'ambiguous',
      entraCorrelationReason: 'conflicting-exact-source-matches',
    })
  })

  it('emits one edge when every exact identifier resolves to the same identity', () => {
    const result = enrichSnapshotWithEntra(
      baseSnapshot({
        entraServicePrincipalId: '11111111-1111-4111-8111-111111111111',
        servicePrincipalId: '11111111-1111-4111-8111-111111111111',
        entraAppId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
      inventorySnapshot(),
    )

    expect(result.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(1)
    expect(result.nodes.find((node) => node.id === 'agent-1')?.metadata).toMatchObject({
      entraCorrelationStatus: 'matched',
      entraCorrelationMatchKind: 'object-id',
      entraIdentityNodeId:
        'entra-source-primary--entra-service-principal-11111111-1111-4111-8111-111111111111',
    })
  })

  it('correlates exact cross-tenant sources inside an independently scoped estate', () => {
    const entraTenantId = '88888888-8888-4888-8888-888888888888'
    const identities = mapEntraInventoryToSnapshot(
      {
        servicePrincipals: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            displayName: 'Cross-tenant identity',
          },
        ],
        owners: new Map(),
        appRoleAssignments: new Map(),
        agentIdentitiesPreview: [],
      },
      { ...config, tenantId: entraTenantId, environment: 'directory' },
      '2026-08-27T08:00:00.000Z',
    )
    const base = {
      ...baseSnapshot({ servicePrincipalId: '11111111-1111-4111-8111-111111111111' }),
      tenantId: '77777777-7777-4777-8777-777777777777',
      environment: 'portfolio',
    }
    base.nodes[0] = {
      ...base.nodes[0]!,
      metadata: {
        ...base.nodes[0]!.metadata,
        estateId: 'custom-estate',
      },
    }
    base.evidence[0] = {
      ...base.evidence[0]!,
      authority: {
        ...base.evidence[0]!.authority!,
        estateId: 'custom-estate',
      },
    }
    const result = enrichAggregateSnapshotWithExactEntraBindingsAndDiagnostics(
      base,
      identities,
      {
        id: 'directory-b',
        name: 'Directory B',
        tenantId: entraTenantId,
        environment: 'directory',
      },
      [
        {
          estateId: 'custom-estate',
          foundry: {
            ...defaultRunsAsBinding.foundry,
            tenantId,
          },
          entra: {
            sourceId: 'entra:directory-b',
            tenantId: entraTenantId,
            environment: 'directory',
            provider: 'microsoft-entra',
            sourceObjectId: entraTenantId,
          },
        },
      ],
      'custom-estate',
    )

    expect(result.snapshot.tenantId).toBe('77777777-7777-4777-8777-777777777777')
    expect(result.snapshot.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(1)
  })

  it('requires preview classification for an Agent Identity identifier', () => {
    const result = enrichSnapshotWithEntra(
      baseSnapshot({ agentIdentityId: '11111111-1111-4111-8111-111111111111' }),
      inventorySnapshot(),
    )

    expect(result.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(0)
    expect(result.nodes.find((node) => node.id === 'agent-1')?.metadata).toMatchObject({
      entraCorrelationStatus: 'unmatched',
      entraCorrelationReason: 'no-exact-source-match',
    })
  })

  it('rejects an exact identifier from another connector source', () => {
    const base = {
      ...baseSnapshotWithAgents([
        {
          id: 'agent-other-source',
          metadata: {
            sourceConnectorId: 'project-b',
            sourceTenantId: tenantId,
            sourceEnvironment: 'validation',
            servicePrincipalId: '11111111-1111-4111-8111-111111111111',
          },
        },
      ]),
      tenantId: 'estate',
      environment: 'portfolio',
    }

    const result = enrichAggregateSnapshotWithEntraAndDiagnostics(base, inventorySnapshot(), {
      id: 'project-a',
      name: 'Project A',
      tenantId,
      environment: 'validation',
    })

    expect(result.snapshot.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(0)
    expect(result.diagnostics).toMatchObject({
      authoritativeAgentsConsidered: 0,
      exactObjectIdMatches: 0,
      unmatched: 0,
      ambiguous: 0,
      runsAsEdgesEmitted: 0,
      evidenceReferences: [],
    })
  })

  it('marks duplicate exact identity candidates ambiguous without name fallback', () => {
    const duplicateAppId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const identities = mapEntraInventoryToSnapshot(
      {
        servicePrincipals: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            appId: duplicateAppId,
            displayName: 'Duplicate display name',
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            appId: duplicateAppId,
            displayName: 'Duplicate display name',
          },
        ],
        owners: new Map(),
        appRoleAssignments: new Map(),
        agentIdentitiesPreview: [],
      },
      config,
      '2026-08-27T08:00:00.000Z',
    )

    const result = enrichSnapshotWithEntra(
      baseSnapshot({
        clientId: duplicateAppId,
        displayName: 'Duplicate display name',
        owner: 'Identity Owner',
        alias: 'duplicate',
      }),
      identities,
    )

    expect(result.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(0)
    expect(result.nodes.find((node) => node.id === 'agent-1')?.metadata).toMatchObject({
      entraCorrelationStatus: 'ambiguous',
      entraCorrelationReason: 'multiple-exact-source-matches',
    })
  })

  it('rejects duplicate authoritative object IDs during Entra normalization', () => {
    const duplicateObjectId = '11111111-1111-4111-8111-111111111111'
    expect(() =>
      mapEntraInventoryToSnapshot(
        {
          servicePrincipals: [
            {
              id: duplicateObjectId,
              appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              displayName: 'First duplicate record',
            },
            {
              id: duplicateObjectId,
              appId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              displayName: 'Second duplicate record',
            },
          ],
          owners: new Map(),
          appRoleAssignments: new Map(),
          agentIdentitiesPreview: [],
        },
        config,
        '2026-08-27T08:00:00.000Z',
      ),
    ).toThrow(/duplicate graph node id/i)
  })

  it('rejects duplicate node IDs before Entra composition maps or deduplication', () => {
    const base = baseSnapshot({ servicePrincipalId: '11111111-1111-4111-8111-111111111111' })
    base.nodes.push({ ...base.nodes[0]! })

    expect(() => enrichSnapshotWithEntra(base, inventorySnapshot())).toThrow(
      /duplicate graph node id/i,
    )
  })

  it('rejects duplicate evidence IDs before Entra composition maps or deduplication', () => {
    const base = baseSnapshot({ servicePrincipalId: '11111111-1111-4111-8111-111111111111' })
    base.evidence.push({ ...base.evidence[0]! })

    expect(() => enrichSnapshotWithEntra(base, inventorySnapshot())).toThrow(
      /duplicate evidence id/i,
    )
  })

  it('reports malformed identifiers without treating them as missing', () => {
    const result = enrichSnapshotWithEntra(
      baseSnapshot({
        servicePrincipalId: 'not-a-guid',
        clientId: 'also-not-a-guid',
        displayName: 'Explicit Agent Identity',
      }),
      inventorySnapshot(),
    )

    expect(result.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(0)
    expect(result.nodes.find((node) => node.id === 'agent-1')?.metadata).toMatchObject({
      entraCorrelationStatus: 'unmatched',
      entraCorrelationReason: 'malformed-authoritative-identifier',
    })
  })

  it('keeps diagnostics disjoint when supplied identifiers are mixed', () => {
    const result = enrichSnapshotWithEntraAndDiagnostics(
      baseSnapshotWithAgents([
        {
          id: 'agent-object',
          metadata: { objectId: '11111111-1111-4111-8111-111111111111' },
        },
        {
          id: 'agent-unresolved',
          metadata: {
            servicePrincipalId: '11111111-1111-4111-8111-111111111111',
            clientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          },
        },
        {
          id: 'agent-malformed',
          metadata: {
            servicePrincipalId: '11111111-1111-4111-8111-111111111111',
            clientId: 'not-a-guid',
          },
        },
      ]),
      inventorySnapshot(),
    )

    expect(result.snapshot.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(1)
    expect(result.diagnostics).toMatchObject({
      authoritativeAgentsConsidered: 3,
      exactObjectIdMatches: 1,
      exactApplicationIdMatches: 0,
      exactAgentIdentityMatches: 0,
      unmatched: 1,
      ambiguous: 1,
      runsAsEdgesEmitted: 1,
    })
    expect(
      result.diagnostics.exactObjectIdMatches +
        result.diagnostics.exactApplicationIdMatches +
        result.diagnostics.exactAgentIdentityMatches +
        result.diagnostics.unmatched +
        result.diagnostics.ambiguous,
    ).toBe(result.diagnostics.authoritativeAgentsConsidered)
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
  it('keeps exact-match diagnostics unattributed without an explicit source binding', async () => {
    const objectId = '11111111-1111-4111-8111-111111111111'
    const applicationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const secondObjectId = '22222222-2222-4222-8222-222222222222'
    const secondApplicationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const previewObjectId = '33333333-3333-4333-8333-333333333333'
    const previewApplicationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const base = connectorForSnapshot(
      baseSnapshotWithAgents([
        { id: 'agent-object', metadata: { servicePrincipalId: objectId } },
        { id: 'agent-application', metadata: { clientId: secondApplicationId } },
        { id: 'agent-preview', metadata: { agentIdentityId: previewObjectId } },
        { id: 'agent-missing', metadata: {} },
        {
          id: 'agent-ambiguous',
          metadata: { servicePrincipalId: objectId, clientId: secondApplicationId },
        },
      ]),
    )
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          value: [
            {
              id: objectId,
              appId: applicationId,
              displayName: 'Object identity',
              servicePrincipalType: 'Application',
              accountEnabled: true,
              appOwnerOrganizationId: tenantId,
              tags: [],
            },
            {
              id: secondObjectId,
              appId: secondApplicationId,
              displayName: 'Application identity',
              servicePrincipalType: 'Application',
              accountEnabled: true,
              appOwnerOrganizationId: tenantId,
              tags: [],
            },
            {
              id: previewObjectId,
              appId: previewApplicationId,
              displayName: 'Preview identity',
              servicePrincipalType: 'ServiceIdentity',
              accountEnabled: true,
              appOwnerOrganizationId: tenantId,
              tags: [],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          value: [
            {
              '@odata.type': '#microsoft.graph.agentIdentity',
              id: previewObjectId,
              appId: previewApplicationId,
              displayName: 'Preview identity',
              accountEnabled: true,
              agentIdentityBlueprintId: null,
              createdByAppId: null,
              createdDateTime: null,
              managerApplications: [],
              servicePrincipalType: 'ServiceIdentity',
              tags: [],
            },
          ],
        }),
      )
    const entra = new EntraIdentityConnector(
      { ...config, capabilities: { ...config.capabilities, agentIdentityPreview: true } },
      new Credential(),
      { fetcher },
    )
    const composite = new EntraEnrichmentConnector(base, entra)

    const snapshot = await composite.discover()
    const diagnostics = composite.getConnectorHealth().sources[1]?.diagnostics

    expect(snapshot.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(0)
    expect(diagnostics).toMatchObject({
      kind: 'exact-identity-correlation',
      provider: 'microsoft-entra',
      sourceId: 'primary',
      sourceTenantId: tenantId,
      sourceEnvironment: 'validation',
      authoritativeAgentsConsidered: 0,
      exactObjectIdMatches: 0,
      exactApplicationIdMatches: 0,
      exactAgentIdentityMatches: 0,
      unmatched: 0,
      ambiguous: 0,
      runsAsEdgesEmitted: 0,
      ownerCoverage: { status: 'disabled', evidenceReferences: [] },
      appRoleCoverage: { status: 'disabled', evidenceReferences: [] },
      previewCoverage: { status: 'available', considered: 3, covered: 1 },
    })
    expect(diagnostics?.evidenceReferences).toEqual([])
    expect(snapshot.nodes.find((node) => node.id === 'agent-preview')?.metadata).not.toHaveProperty(
      'entraIdentityNodeId',
    )
    expect(
      snapshot.nodes.find((node) => node.id === 'agent-ambiguous')?.metadata,
    ).not.toHaveProperty('entraCorrelationStatus')
  })

  it('degrades only unauthorized preview coverage after stable inventory succeeds', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('service-principals-page-2.json'))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
    const entra = new EntraIdentityConnector(
      { ...config, capabilities: { ...config.capabilities, agentIdentityPreview: true } },
      new Credential(),
      { fetcher },
    )
    const composite = new EntraEnrichmentConnector(baseConnector(), entra)

    const snapshot = await composite.discover()
    const health = composite.getConnectorHealth()
    const coverage = health.sources[1]?.diagnostics?.previewCoverage

    expect(snapshot.nodes.some((node) => node.kind === 'identity')).toBe(true)
    expect(health).toMatchObject({ overall: 'degraded', partial: false })
    expect(coverage).toEqual({
      status: 'authorization-required',
      reason: 'authorization (403)',
      evidenceReferences: [],
    })
    expect(coverage).not.toHaveProperty('considered')
    expect(coverage).not.toHaveProperty('covered')
  })

  it('keeps owner and app-role failures independent in diagnostics', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('service-principals-page-2.json'))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(Response.json({ value: [] }))
    const entra = new EntraIdentityConnector(
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
    const composite = new EntraEnrichmentConnector(baseConnector(), entra)

    await composite.discover()
    const diagnostics = composite.getConnectorHealth().sources[1]?.diagnostics

    expect(diagnostics?.ownerCoverage).toEqual({
      status: 'authorization-required',
      reason: 'authorization (403)',
      evidenceReferences: [],
    })
    expect(diagnostics?.appRoleCoverage).toMatchObject({
      status: 'available',
      considered: 1,
      covered: 0,
    })
    expect(diagnostics?.previewCoverage).toEqual({
      status: 'disabled',
      evidenceReferences: [],
    })
  })

  it('preserves owner coverage when app-role enrichment alone fails', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('service-principals-page-2.json'))
      .mockResolvedValueOnce(response('owners.json'))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
    const entra = new EntraIdentityConnector(
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
    const composite = new EntraEnrichmentConnector(baseConnector(), entra)

    await composite.discover()
    const diagnostics = composite.getConnectorHealth().sources[1]?.diagnostics

    expect(diagnostics?.ownerCoverage).toMatchObject({
      status: 'available',
      considered: 1,
      covered: 1,
    })
    expect(diagnostics?.appRoleCoverage).toEqual({
      status: 'authorization-required',
      reason: 'authorization (403)',
      evidenceReferences: [],
    })
    expect(diagnostics?.previewCoverage).toEqual({
      status: 'disabled',
      evidenceReferences: [],
    })
  })

  it('reports malformed preview as degraded without success-shaped coverage counts', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('service-principals-page-2.json'))
      .mockResolvedValueOnce(Response.json({ value: [{ id: 'invalid' }] }))
    const entra = new EntraIdentityConnector(
      { ...config, capabilities: { ...config.capabilities, agentIdentityPreview: true } },
      new Credential(),
      { fetcher },
    )
    const composite = new EntraEnrichmentConnector(baseConnector(), entra)

    await composite.discover()
    const coverage = composite.getConnectorHealth().sources[1]?.diagnostics?.previewCoverage

    expect(coverage).toEqual({
      status: 'degraded',
      reason: 'malformed-response',
      evidenceReferences: [],
    })
    expect(coverage).not.toHaveProperty('considered')
    expect(coverage).not.toHaveProperty('covered')
  })

  it('preserves base discovery and reports explicit Entra health', async () => {
    const entra = new EntraIdentityConnector(config, new Credential(), {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(response('service-principals-page-2.json')),
    })
    const composite = new EntraEnrichmentConnector(baseConnector(), entra)
    const snapshot = await composite.discover()
    expect(snapshot.nodes.some((node) => node.kind === 'agent')).toBe(true)
    expect(snapshot.nodes.some((node) => node.kind === 'identity')).toBe(true)
    expect(snapshot.edges.some((edge) => edge.relationship === 'RUNS_AS')).toBe(false)
    expect(composite.getHealth().entra.stableInventory.status).toBe('available')
  })

  it('forwards caller cancellation to primary operations', async () => {
    const testConnection = vi.fn<
      (request?: ConnectorOperationRequest) => Promise<ConnectionTestResult>
    >(() =>
      Promise.resolve({
        ok: true,
        checkedAt: '2026-08-27T08:00:00.000Z',
        message: 'ok',
      }),
    )
    const discover = vi.fn<(request?: ConnectorOperationRequest) => Promise<EstateSnapshot>>(() =>
      Promise.resolve(baseSnapshot({ servicePrincipalId: '22222222-2222-4222-8222-222222222222' })),
    )
    const controller = new AbortController()
    const composite = new EntraEnrichmentConnector(
      {
        ...baseConnector(),
        testConnection,
        discover,
      },
      undefined,
      { enabled: false },
    )

    await composite.testConnection({ signal: controller.signal })
    await composite.discover({ signal: controller.signal })

    expect(testConnection).toHaveBeenCalledWith({ signal: controller.signal })
    expect(discover).toHaveBeenCalledWith({ signal: controller.signal })
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
        projectId: 'project-a',
      },
      {
        id: 'project-b',
        name: 'Project B',
        tenantId: tenantB,
        environment: 'validation',
        projectId: 'project-b',
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
            sourceOfTruth: 'true',
            estateId: 'estate-a',
            sourceId: `foundry:${source.id}`,
            sourceConnectorId: source.id,
            sourceTenantId: source.tenantId,
            sourceEnvironment: source.environment,
            sourceProjectId: source.projectId,
            provider: 'azure-ai-foundry-agent-service',
            providerObjectId: `provider-${source.id}`,
            snapshotGeneratedAt: observedAt,
            sourceRelease: 'v1',
            servicePrincipalId: '11111111-1111-4111-8111-111111111111',
          },
        })),
        edges: [],
        evidence: expectedSources.map((source) => ({
          id: `evidence-${source.id}`,
          source: 'Foundry',
          sourceObjectId: `${source.id}:provider-${source.id}`,
          observedAt,
          freshness: 'live' as const,
          confidence: 1,
          evidenceTypes: ['declared_configuration' as const],
          summary: 'Declared configuration.',
          authority: {
            estateId: 'estate-a',
            sourceId: `foundry:${source.id}`,
            tenantId: source.tenantId,
            environment: source.environment,
            provider: 'azure-ai-foundry-agent-service' as const,
            sourceObjectId: source.projectId,
            providerObjectId: `provider-${source.id}`,
            snapshotGeneratedAt: observedAt,
            sourceRelease: 'v1',
          },
        })),
      }
    }

    function sourceConfig(
      source: Pick<(typeof expectedSources)[number], 'id' | 'name' | 'tenantId' | 'environment'>,
    ) {
      return {
        id: source.id,
        name: source.name,
        tenantId: source.tenantId,
        environment: source.environment,
        graphBaseUrl: 'https://graph.microsoft.com',
        capabilities: {
          owners: false,
          appRoleAssignments: false,
          agentIdentityPreview: false,
        },
        limits: config.limits,
      }
    }

    function bindingsFor(sources: readonly (typeof expectedSources)[number][]) {
      return sources.map((source) => ({
        estateId: 'estate-a',
        foundry: {
          sourceId: `foundry:${source.id}`,
          tenantId: source.tenantId,
          environment: source.environment,
          provider: 'azure-ai-foundry-agent-service' as const,
          sourceObjectId: source.projectId,
        },
        entra: {
          sourceId: `entra:${source.id}`,
          tenantId: source.tenantId,
          environment: source.environment,
          provider: 'microsoft-entra' as const,
          sourceObjectId: source.tenantId,
        },
      }))
    }

    it('rejects an empty expected source set instead of reporting complete coverage', () => {
      expect(
        () =>
          new MultiEntraEnrichmentConnector(connectorForSnapshot(aggregateBase()), [], {
            enabled: false,
            expectedSources: [],
            credentialFactory: credentialForTenant,
          }),
      ).toThrow('at least one')
    })

    it('preserves degraded base health while Entra is disabled', () => {
      const base = {
        ...connectorForSnapshot(aggregateBase()),
        getConnectorHealth: () => ({
          overall: 'degraded' as const,
          partial: false,
          sources: [
            {
              id: 'base',
              name: 'base',
              role: 'discovery' as const,
              enabled: true,
              configured: true,
              readiness: 'degraded' as const,
              dataState: 'empty' as const,
              reason: 'empty-source',
            },
          ],
        }),
      }
      const connector = new MultiEntraEnrichmentConnector(base, [], {
        enabled: false,
        expectedSources,
        credentialFactory: credentialForTenant,
      })

      const health = connector.getConnectorHealth()
      expect(health).toMatchObject({ overall: 'degraded', partial: false })
      expect(health.sources[0]).toMatchObject({
        id: 'base',
        readiness: 'degraded',
        dataState: 'empty',
      })
    })

    it('preserves degraded base health after successful Entra enrichment', async () => {
      const expected = [expectedSources[0]!]
      const base = {
        ...connectorForSnapshot(aggregateBase()),
        getConnectorHealth: () => ({
          overall: 'degraded' as const,
          partial: false,
          sources: [
            {
              id: 'base',
              name: 'base',
              role: 'discovery' as const,
              enabled: true,
              configured: true,
              readiness: 'degraded' as const,
              dataState: 'failed' as const,
              reason: 'source-failed',
            },
          ],
        }),
      }
      const connector = new MultiEntraEnrichmentConnector(base, expected.map(sourceConfig), {
        enabled: true,
        expectedSources: expected,
        credentialFactory: credentialForTenant,
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
      })

      await connector.discover()

      expect(connector.getConnectorHealth()).toMatchObject({
        overall: 'degraded',
        partial: false,
        sources: [
          { id: 'base', readiness: 'degraded', dataState: 'failed' },
          { id: 'entra:project-a', readiness: 'ready', dataState: 'complete' },
        ],
      })
    })

    it('reports an empty connection probe as non-ready', async () => {
      const expected = [expectedSources[0]!]
      const connector = new MultiEntraEnrichmentConnector(
        connectorForSnapshot(aggregateBase()),
        expected.map(sourceConfig),
        {
          enabled: true,
          expectedSources: expected,
          bindings: bindingsFor(expected),
          credentialFactory: credentialForTenant,
          clientFactory: () => ({
            fetcher: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ value: [] })),
          }),
        },
      )

      await connector.testConnection()

      expect(connector.getConnectorHealth().sources[1]).toMatchObject({
        readiness: 'degraded',
        dataState: 'empty',
        pages: 1,
        records: 0,
        reason: 'empty',
      })
    })

    it('fails a connection probe closed when its shared record budget is exceeded', async () => {
      const expected = [expectedSources[0]!]
      const connector = new MultiEntraEnrichmentConnector(
        connectorForSnapshot(aggregateBase()),
        expected.map(sourceConfig),
        {
          enabled: true,
          expectedSources: expected,
          aggregation: { maxRecordsPerSource: 1 },
          credentialFactory: credentialForTenant,
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
                  {
                    id: '22222222-2222-4222-8222-222222222222',
                    appId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                    displayName: 'Tenant A identity 2',
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

      await connector.testConnection()

      expect(connector.getConnectorHealth().sources[1]).toMatchObject({
        readiness: 'unavailable',
        dataState: 'failed',
        pages: 1,
        records: 2,
        reason: 'bounds',
      })
    })

    it('reports cumulative inventory and enrichment measurements', async () => {
      const expected = [expectedSources[0]!]
      const connector = new MultiEntraEnrichmentConnector(
        connectorForSnapshot(aggregateBase()),
        [
          {
            ...sourceConfig(expected[0]!),
            capabilities: {
              owners: true,
              appRoleAssignments: true,
              agentIdentityPreview: true,
            },
          },
        ],
        {
          enabled: true,
          expectedSources: expected,
          bindings: bindingsFor(expected),
          credentialFactory: credentialForTenant,
          clientFactory: () => ({
            fetcher: vi
              .fn<typeof fetch>()
              .mockResolvedValueOnce(
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
              )
              .mockImplementation(() => Promise.resolve(Response.json({ value: [] }))),
          }),
        },
      )

      await connector.discover()

      expect(connector.getConnectorHealth().sources[1]).toMatchObject({
        readiness: 'ready',
        dataState: 'complete',
        pages: 4,
        records: 1,
      })
    })

    it('keeps stable exact correlation complete when optional preview enrichment fails', async () => {
      const expected = [expectedSources[0]!]
      const connector = new MultiEntraEnrichmentConnector(
        connectorForSnapshot(aggregateBase()),
        [
          {
            ...sourceConfig(expected[0]!),
            capabilities: {
              owners: false,
              appRoleAssignments: false,
              agentIdentityPreview: true,
            },
          },
        ],
        {
          enabled: true,
          expectedSources: expected,
          bindings: bindingsFor(expected),
          credentialFactory: credentialForTenant,
          clientFactory: () => ({
            fetcher: vi
              .fn<typeof fetch>()
              .mockResolvedValueOnce(
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
              )
              .mockResolvedValueOnce(new Response('', { status: 403 })),
          }),
        },
      )

      const snapshot = await connector.discover()

      expect(snapshot.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(1)
      expect(connector.getConnectorHealth()).toMatchObject({
        overall: 'degraded',
        partial: false,
        sources: [
          { id: 'base', readiness: 'ready' },
          {
            id: 'entra:project-a',
            readiness: 'degraded',
            dataState: 'complete',
            records: 1,
            diagnostics: {
              runsAsEdgesEmitted: 1,
              previewCoverage: {
                status: 'authorization-required',
                reason: 'authorization (403)',
                evidenceReferences: [],
              },
            },
          },
        ],
      })
    })

    it('preserves stable inventory when optional enrichment exhausts the shared page budget', async () => {
      const expected = [expectedSources[0]!]
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
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
        )
        .mockResolvedValue(Response.json({ value: [] }))
      const connector = new MultiEntraEnrichmentConnector(
        connectorForSnapshot(aggregateBase()),
        [
          {
            ...sourceConfig(expected[0]!),
            capabilities: {
              owners: true,
              appRoleAssignments: true,
              agentIdentityPreview: true,
            },
          },
        ],
        {
          enabled: true,
          expectedSources: expected,
          bindings: bindingsFor(expected),
          aggregation: { maxPagesPerSource: 2 },
          credentialFactory: credentialForTenant,
          clientFactory: () => ({ fetcher }),
        },
      )

      await connector.discover()

      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(connector.getConnectorHealth().sources[1]).toMatchObject({
        readiness: 'degraded',
        dataState: 'complete',
        pages: 2,
        records: 1,
        reason: 'bounds',
      })
      expect(connector.getConnectorHealth()).toMatchObject({
        overall: 'degraded',
        partial: false,
      })
    })

    it('fails closed and reports consumed records when the shared record budget is exceeded', async () => {
      const expected = [expectedSources[0]!]
      const connector = new MultiEntraEnrichmentConnector(
        connectorForSnapshot(aggregateBase()),
        expected.map(sourceConfig),
        {
          enabled: true,
          expectedSources: expected,
          aggregation: { maxRecordsPerSource: 1 },
          credentialFactory: credentialForTenant,
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
                  {
                    id: '22222222-2222-4222-8222-222222222222',
                    appId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                    displayName: 'Tenant A identity 2',
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

      await connector.discover()

      expect(connector.getConnectorHealth().sources[1]).toMatchObject({
        readiness: 'unavailable',
        dataState: 'failed',
        pages: 1,
        records: 2,
        reason: 'bounds',
      })
    })

    it('parses legacy and multi-source environment configuration', () => {
      expect(
        parseEntraSourcesConfig({
          ENTRA_CONNECTOR_TENANT_ID: tenantA,
          ENTRA_CONNECTOR_ENVIRONMENT: 'production',
        }),
      ).toMatchObject([{ id: 'primary', tenantId: tenantA }])
      expect(
        parseEntraSourcesConfig({
          ENTRA_SOURCES_JSON: JSON.stringify(
            expectedSources.map(({ id, name, tenantId, environment }) => ({
              id,
              name,
              tenantId,
              environment,
            })),
          ),
        }),
      ).toMatchObject([
        { id: 'project-a', tenantId: tenantA },
        { id: 'project-b', tenantId: tenantB },
      ])
    })

    it('parses only complete globally scoped Entra-to-Foundry bindings', () => {
      const binding = {
        estateId: 'estate-a',
        foundry: {
          sourceId: 'foundry:project-a',
          tenantId: tenantA,
          environment: 'production',
          provider: 'azure-ai-foundry-agent-service',
          sourceObjectId: 'project-a',
        },
        entra: {
          sourceId: 'entra:directory-a',
          tenantId: tenantA,
          environment: 'directory',
          provider: 'microsoft-entra',
          sourceObjectId: tenantA,
        },
      }
      expect(
        parseEntraRunsAsBindings({
          ENTRA_RUNS_AS_BINDINGS_JSON: JSON.stringify([binding]),
        }),
      ).toEqual([binding])
      expect(
        parseEntraRunsAsBindings({
          ENTRA_RUNS_AS_BINDINGS_JSON: JSON.stringify([
            {
              ...binding,
              entra: {
                ...binding.entra,
                tenantId: tenantB,
                sourceObjectId: tenantB,
              },
            },
          ]),
        }),
      ).toEqual([
        {
          ...binding,
          entra: {
            ...binding.entra,
            tenantId: tenantB,
            sourceObjectId: tenantB,
          },
        },
      ])
      expect(() =>
        parseEntraRunsAsBindings({
          ENTRA_RUNS_AS_BINDINGS_JSON: JSON.stringify([
            {
              ...binding,
              foundry: { ...binding.foundry, sourceId: 'primary' },
            },
          ]),
        }),
      ).toThrow()
      expect(() =>
        parseEntraRunsAsBindings({
          ENTRA_RUNS_AS_BINDINGS_JSON: JSON.stringify([
            binding,
            {
              ...binding,
              estateId: 'estate-b',
              foundry: {
                ...binding.foundry,
                sourceId: 'foundry:project-b',
                sourceObjectId: 'project-b',
              },
            },
          ]),
        }),
      ).toThrow()
    })

    it('canonicalizes binding tenant GUIDs and rejects malformed Entra source object IDs', () => {
      const parsed = parseEntraRunsAsBindings({
        ENTRA_RUNS_AS_BINDINGS_JSON: JSON.stringify([
          {
            estateId: 'estate-a',
            foundry: {
              sourceId: 'foundry:project-a',
              tenantId: tenantA.toUpperCase(),
              environment: 'production',
              provider: 'azure-ai-foundry-agent-service',
              sourceObjectId: 'project-a',
            },
            entra: {
              sourceId: 'entra:directory-a',
              tenantId: tenantA.toUpperCase(),
              environment: 'directory',
              provider: 'microsoft-entra',
              sourceObjectId: tenantA.toUpperCase(),
            },
          },
        ]),
      })

      expect(parsed).toMatchObject([
        {
          foundry: { tenantId: tenantA },
          entra: { tenantId: tenantA, sourceObjectId: tenantA },
        },
      ])
      expect(() =>
        parseEntraRunsAsBindings({
          ENTRA_RUNS_AS_BINDINGS_JSON: JSON.stringify([
            {
              ...parsed[0],
              entra: {
                ...parsed[0]!.entra,
                sourceObjectId: 'not-a-guid',
              },
            },
          ]),
        }),
      ).toThrow()
    })

    it('registers an exact cross-tenant binding against both configured source boundaries', () => {
      expect(
        () =>
          new MultiEntraEnrichmentConnector(
            connectorForSnapshot(aggregateBase()),
            [
              sourceConfig({
                id: 'directory-b',
                name: 'Directory B',
                tenantId: tenantB,
                environment: 'directory',
              }),
            ],
            {
              enabled: false,
              estateId: 'estate-a',
              expectedSources: [
                {
                  id: 'project-a',
                  name: 'Project A',
                  tenantId: tenantA,
                  environment: 'production',
                  projectId: 'project-a',
                },
              ],
              bindings: [
                {
                  estateId: 'estate-a',
                  foundry: {
                    sourceId: 'foundry:project-a',
                    tenantId: tenantA,
                    environment: 'production',
                    provider: 'azure-ai-foundry-agent-service',
                    sourceObjectId: 'project-a',
                  },
                  entra: {
                    sourceId: 'entra:directory-b',
                    tenantId: tenantB,
                    environment: 'directory',
                    provider: 'microsoft-entra',
                    sourceObjectId: tenantB,
                  },
                },
              ],
              credentialFactory: credentialForTenant,
            },
          ),
      ).not.toThrow()
    })

    it('queries one estate-scoped Entra inventory once for two explicit Foundry bindings', async () => {
      const observedAt = '2026-09-09T00:00:00.000Z'
      const principalId = '11111111-1111-4111-8111-111111111111'
      const foundrySources = [
        {
          id: 'project-a',
          name: 'Project A',
          tenantId: tenantA,
          environment: 'production',
          projectId: 'project-a',
        },
        {
          id: 'project-b',
          name: 'Project B',
          tenantId: tenantA,
          environment: 'validation',
          projectId: 'project-b',
        },
      ]
      const base: EstateSnapshot = {
        tenantId: 'estate',
        environment: 'portfolio',
        generatedAt: observedAt,
        nodes: [
          ...foundrySources.map((source) => ({
            id: `agent-${source.id}`,
            kind: 'agent' as const,
            name: `Agent ${source.id}`,
            description: 'Foundry agent.',
            environment: source.environment,
            evidenceIds: [`evidence-${source.id}`],
            metadata: {
              sourceOfTruth: 'true',
              estateId: 'estate-a',
              sourceId: `foundry:${source.id}`,
              sourceTenantId: source.tenantId,
              sourceEnvironment: source.environment,
              sourceProjectId: source.projectId,
              provider: 'azure-ai-foundry-agent-service',
              providerObjectId: `provider-agent-${source.id}`,
              snapshotGeneratedAt: observedAt,
              sourceRelease: 'v1',
              servicePrincipalId: principalId,
            },
          })),
          {
            id: 'agent365-package',
            kind: 'agent',
            name: 'Agent 365 package',
            description: 'Catalog package without principal evidence.',
            environment: 'global',
            evidenceIds: ['agent365-evidence'],
            metadata: {
              sourceOfTruth: 'true',
              estateId: 'estate-a',
              sourceId: 'agent365:catalog-a',
              sourceTenantId: tenantA,
              sourceEnvironment: 'global',
              provider: 'microsoft-agent-365',
              providerApplicationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            },
          },
        ],
        edges: [],
        evidence: [
          ...foundrySources.map((source) => ({
            id: `evidence-${source.id}`,
            source: 'Foundry',
            sourceObjectId: `${source.id}:provider-agent-${source.id}`,
            observedAt,
            freshness: 'live' as const,
            confidence: 1,
            evidenceTypes: ['declared_configuration' as const],
            summary: 'Authoritative Foundry agent configuration.',
            authority: {
              estateId: 'estate-a',
              sourceId: `foundry:${source.id}`,
              tenantId: source.tenantId,
              environment: source.environment,
              provider: 'azure-ai-foundry-agent-service' as const,
              sourceObjectId: source.projectId,
              providerObjectId: `provider-agent-${source.id}`,
              snapshotGeneratedAt: observedAt,
              sourceRelease: 'v1',
            },
          })),
          {
            id: 'agent365-evidence',
            source: 'Agent 365',
            sourceObjectId: 'package-a',
            observedAt,
            freshness: 'live',
            confidence: 1,
            evidenceTypes: ['declared_configuration'],
            summary: 'Authoritative package inventory, not principal evidence.',
          },
        ],
      }
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          value: [
            {
              id: principalId,
              appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              displayName: 'Shared principal',
              servicePrincipalType: 'Application',
              accountEnabled: true,
              appOwnerOrganizationId: tenantA,
              tags: [],
            },
          ],
        }),
      )
      const connector = new MultiEntraEnrichmentConnector(
        connectorForSnapshot(base),
        [
          {
            ...sourceConfig({
              id: 'directory-a',
              name: 'Tenant A directory',
              tenantId: tenantA,
              environment: 'directory',
            }),
          },
        ],
        {
          enabled: true,
          expectedSources: foundrySources,
          bindings: foundrySources.map((source) => ({
            estateId: 'estate-a',
            foundry: {
              sourceId: `foundry:${source.id}`,
              tenantId: source.tenantId,
              environment: source.environment,
              provider: 'azure-ai-foundry-agent-service',
              sourceObjectId: source.projectId,
            },
            entra: {
              sourceId: 'entra:directory-a',
              tenantId: tenantA,
              environment: 'directory',
              provider: 'microsoft-entra',
              sourceObjectId: tenantA,
            },
          })),
          credentialFactory: credentialForTenant,
          clientFactory: () => ({ fetcher }),
        },
      )

      const snapshot = await connector.discover()

      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(snapshot.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(2)
      expect(
        snapshot.edges.some(
          (edge) => edge.relationship === 'RUNS_AS' && edge.from === 'agent365-package',
        ),
      ).toBe(false)
      expect(
        snapshot.edges
          .filter((edge) => edge.relationship === 'RUNS_AS')
          .every((edge) => edge.runsAsBinding?.agent.estateId === 'estate-a'),
      ).toBe(true)
    })

    it('rejects an explicit binding whose Foundry project identity is not registered', () => {
      expect(
        () =>
          new MultiEntraEnrichmentConnector(
            connectorForSnapshot(aggregateBase()),
            [sourceConfig(expectedSources[0]!)],
            {
              enabled: true,
              expectedSources: [
                {
                  ...expectedSources[0]!,
                  projectId: 'project-a',
                },
              ],
              bindings: [
                {
                  estateId: 'estate-a',
                  foundry: {
                    sourceId: 'foundry:project-a',
                    tenantId: tenantA,
                    environment: 'production',
                    provider: 'azure-ai-foundry-agent-service',
                    sourceObjectId: 'different-project',
                  },
                  entra: {
                    sourceId: 'entra:project-a',
                    tenantId: tenantA,
                    environment: 'production',
                    provider: 'microsoft-entra',
                    sourceObjectId: tenantA,
                  },
                },
              ],
              credentialFactory: credentialForTenant,
            },
          ),
      ).toThrow(/binding/i)
      expect(
        () =>
          new MultiEntraEnrichmentConnector(
            connectorForSnapshot(aggregateBase()),
            [sourceConfig(expectedSources[0]!)],
            {
              enabled: true,
              estateId: 'estate-a',
              expectedSources: [expectedSources[0]!],
              bindings: [
                {
                  ...bindingsFor([expectedSources[0]!])[0]!,
                  estateId: 'estate-b',
                },
              ],
              credentialFactory: credentialForTenant,
            },
          ),
      ).toThrow(/estate/i)
    })

    it('keeps tenant-wide Entra inventory unattributed without an explicit source binding', async () => {
      const principalId = '11111111-1111-4111-8111-111111111111'
      const connector = new MultiEntraEnrichmentConnector(
        connectorForSnapshot(aggregateBase()),
        [sourceConfig(expectedSources[0]!)],
        {
          enabled: true,
          expectedSources: [expectedSources[0]!],
          credentialFactory: credentialForTenant,
          clientFactory: () => ({
            fetcher: vi.fn<typeof fetch>().mockResolvedValue(
              Response.json({
                value: [
                  {
                    id: principalId,
                    appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    displayName: 'Unbound inventory principal',
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

      expect(snapshot.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(0)
      expect(snapshot.nodes.find((node) => node.id === 'agent-project-a')?.metadata).toMatchObject({
        entraCorrelationStatus: 'unmatched',
        entraCorrelationReason: 'missing-explicit-source-binding',
      })
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
          bindings: bindingsFor(expectedSources),
          credentialFactory: credentialForTenant,
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
          { id: 'entra:project-a', readiness: 'ready', dataState: 'complete' },
          { id: 'entra:project-b', readiness: 'ready', dataState: 'complete' },
        ],
      })
    })

    it('bounds source concurrency while composing results in configured order', async () => {
      let active = 0
      let maximumActive = 0
      const completed: string[] = []
      const connector = new MultiEntraEnrichmentConnector(
        connectorForSnapshot(aggregateBase()),
        expectedSources.map(sourceConfig),
        {
          enabled: true,
          expectedSources,
          bindings: bindingsFor(expectedSources),
          aggregation: {
            maxConcurrency: 1,
            maxDurationMs: 1_000,
          },
          credentialFactory: credentialForTenant,
          clientFactory: (source) => ({
            fetcher: vi.fn<typeof fetch>(async () => {
              active += 1
              maximumActive = Math.max(maximumActive, active)
              await new Promise((resolve) => setTimeout(resolve, source.id === 'project-a' ? 5 : 1))
              active -= 1
              completed.push(source.id)
              return Response.json({
                value: [
                  {
                    id: '11111111-1111-4111-8111-111111111111',
                    appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    displayName: 'Shared identity',
                    servicePrincipalType: 'Application',
                    accountEnabled: true,
                    appOwnerOrganizationId: source.tenantId,
                    tags: [],
                  },
                ],
              })
            }),
          }),
        },
      )

      const snapshot = await connector.discover()

      expect(maximumActive).toBe(1)
      expect(completed).toEqual(['project-a', 'project-b'])
      expect(snapshot.edges.filter((edge) => edge.relationship === 'RUNS_AS')).toHaveLength(2)
    })

    it('forwards caller cancellation to multi-source primary operations', async () => {
      const testConnection = vi.fn<
        (request?: ConnectorOperationRequest) => Promise<ConnectionTestResult>
      >(() =>
        Promise.resolve({
          ok: true,
          checkedAt: '2026-08-27T08:00:00.000Z',
          message: 'ok',
        }),
      )
      const discover = vi.fn<(request?: ConnectorOperationRequest) => Promise<EstateSnapshot>>(() =>
        Promise.resolve(structuredClone(aggregateBase())),
      )
      const controller = new AbortController()
      const connector = new MultiEntraEnrichmentConnector(
        {
          ...baseConnector(),
          testConnection,
          discover,
        },
        [],
        {
          enabled: false,
          expectedSources,
          credentialFactory: credentialForTenant,
        },
      )

      await connector.testConnection({ signal: controller.signal })
      await connector.discover({ signal: controller.signal })

      expect(testConnection).toHaveBeenCalledWith({ signal: controller.signal })
      expect(discover).toHaveBeenCalledWith({ signal: controller.signal })
    })

    it('retains an empty source without promoting it to complete Entra coverage', async () => {
      const connector = new MultiEntraEnrichmentConnector(
        connectorForSnapshot(aggregateBase()),
        expectedSources.map(sourceConfig),
        {
          enabled: true,
          expectedSources,
          bindings: bindingsFor(expectedSources),
          credentialFactory: credentialForTenant,
          clientFactory: (source) => ({
            fetcher: vi.fn<typeof fetch>().mockResolvedValue(
              Response.json({
                value:
                  source.id === 'project-a'
                    ? [
                        {
                          id: '11111111-1111-4111-8111-111111111111',
                          appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                          displayName: 'Tenant A identity',
                          servicePrincipalType: 'Application',
                          accountEnabled: true,
                          appOwnerOrganizationId: tenantA,
                          tags: [],
                        },
                      ]
                    : [],
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
          { id: 'entra:project-a', dataState: 'complete' },
          {
            id: 'entra:project-b',
            readiness: 'degraded',
            dataState: 'empty',
            reason: 'empty',
          },
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
          bindings: bindingsFor([expectedSources[0]!]),
          credentialFactory: credentialForTenant,
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
            dataState: 'unsupported',
          },
        ],
      })
      expect(snapshot.nodes.find((node) => node.id === 'agent-project-b')?.metadata).toMatchObject({
        entraCorrelationStatus: 'unmatched',
        entraCorrelationReason: 'missing-explicit-source-binding',
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
          credentialFactory: credentialForTenant,
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
            dataState: 'failed',
            reason: 'authorization (403)',
          },
        ],
      })
    })

    it('source-scopes optional capability evidence references', async () => {
      const expected = [expectedSources[0]!]
      const previewId = '11111111-1111-4111-8111-111111111111'
      const connector = new MultiEntraEnrichmentConnector(
        connectorForSnapshot(aggregateBase()),
        [
          {
            ...sourceConfig(expected[0]!),
            capabilities: {
              owners: false,
              appRoleAssignments: false,
              agentIdentityPreview: true,
            },
          },
        ],
        {
          enabled: true,
          expectedSources: expected,
          credentialFactory: credentialForTenant,
          clientFactory: () => ({
            fetcher: vi
              .fn<typeof fetch>()
              .mockResolvedValueOnce(
                Response.json({
                  value: [
                    {
                      id: previewId,
                      appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                      displayName: 'Preview identity',
                      servicePrincipalType: 'ServiceIdentity',
                      accountEnabled: true,
                      appOwnerOrganizationId: tenantA,
                      tags: [],
                    },
                  ],
                }),
              )
              .mockResolvedValueOnce(
                Response.json({
                  value: [
                    {
                      '@odata.type': '#microsoft.graph.agentIdentity',
                      id: previewId,
                      appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                      displayName: 'Preview identity',
                      accountEnabled: true,
                      agentIdentityBlueprintId: null,
                      createdByAppId: null,
                      createdDateTime: null,
                      managerApplications: [],
                      servicePrincipalType: 'ServiceIdentity',
                      tags: [],
                    },
                  ],
                }),
              ),
          }),
        },
      )

      await connector.discover()

      expect(
        connector.getConnectorHealth().sources[1]?.diagnostics?.previewCoverage.evidenceReferences,
      ).toEqual([`entra-source-project-a--entra-agent-identity-preview-evidence-${previewId}`])
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
