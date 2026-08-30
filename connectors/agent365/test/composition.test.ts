import type { TokenCredential } from '@azure/core-auth'
import type { AgentConnector } from '@agent-sentinel/connector-sdk'
import type { EstateSnapshot, Evidence } from '@agent-sentinel/domain'
import { describe, expect, it, vi } from 'vitest'

import {
  Agent365CompositionConnector,
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
      sourceConnectorId: 'tenant-a',
      sourceTenantId: sources[0]!.tenantId,
      sourceEnvironment: 'agent365-a',
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

  it('collects sources sequentially and enforces the aggregate item bound', async () => {
    const config = parseAgent365Config({
      AGENT365_SOURCES_JSON: JSON.stringify(sources),
      AGENT365_MAX_ITEMS: '1',
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
