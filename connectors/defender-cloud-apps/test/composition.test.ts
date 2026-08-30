import type { TokenCredential } from '@azure/core-auth'
import type { AgentConnector } from '@agent-sentinel/connector-sdk'
import type { EstateSnapshot, Evidence } from '@agent-sentinel/domain'
import { describe, expect, it, vi } from 'vitest'

import {
  DefenderCloudAppsCompositionConnector,
  createOptionalDefenderCloudAppsConnector,
  parseDefenderCloudAppsConfig,
} from '../src/index.js'

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
  environment: 'base',
  generatedAt: '2026-08-28T00:00:00Z',
  nodes: [
    {
      id: 'base-node',
      kind: 'agent',
      name: 'Base agent',
      description: 'Base node.',
      environment: 'base',
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

function credential(tenantId: string): TokenCredential {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return {
    getToken: () =>
      Promise.resolve({
        token: `${encode({ alg: 'none' })}.${encode({ tid: tenantId })}.signature`,
        expiresOnTimestamp: Date.now() + 60_000,
      }),
  }
}

const sources = [
  {
    id: 'tenant-a',
    name: 'Tenant A',
    tenantId: '00000000-0000-0000-0000-000000000001',
    environment: 'security-a',
    portalHostname: 'contoso.us2.portal.cloudappsecurity.com',
  },
  {
    id: 'tenant-b',
    name: 'Tenant B',
    tenantId: '00000000-0000-0000-0000-000000000002',
    environment: 'security-b',
    portalHostname: 'fabrikam.eu1.portal.cloudappsecurity.com',
  },
]

function responseFor(pathname: string, id: string): Response {
  return pathname.endsWith('/alerts/')
    ? Response.json({ data: [{ _id: `alert-${id}`, timestamp: Date.now() }], hasNext: false })
    : Response.json({ data: [], hasNext: false })
}

function requestPath(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.pathname
  return new URL(typeof input === 'string' ? input : input.url).pathname
}

describe('Defender for Cloud Apps composition', () => {
  it('returns the exact base connector object while disabled', () => {
    const base = baseConnector()
    expect(createOptionalDefenderCloudAppsConnector(base, {})).toBe(base)
    expect(
      createOptionalDefenderCloudAppsConnector(base, {
        DEFENDER_CLOUD_APPS_CONNECTOR_ENABLED: 'false',
      }),
    ).toBe(base)
  })

  it('preserves composition order after Agent 365 and reports enabled invalid configuration', async () => {
    const base = baseConnector()
    base.getConnectorHealth = () => ({
      overall: 'ready',
      partial: false,
      sources: [
        {
          id: 'foundry:primary',
          name: 'Foundry',
          role: 'discovery',
          enabled: true,
          configured: true,
          readiness: 'ready',
        },
        {
          id: 'entra:primary',
          name: 'Entra',
          role: 'enrichment',
          enabled: true,
          configured: true,
          readiness: 'ready',
        },
        {
          id: 'power-platform:primary',
          name: 'Power Platform',
          role: 'discovery',
          enabled: true,
          configured: true,
          readiness: 'ready',
        },
        {
          id: 'agent365:primary',
          name: 'Agent 365',
          role: 'discovery',
          enabled: true,
          configured: true,
          readiness: 'ready',
        },
      ],
    })
    const connector = createOptionalDefenderCloudAppsConnector(base, {
      DEFENDER_CLOUD_APPS_CONNECTOR_ENABLED: 'true',
    })
    await connector.discover()
    expect(connector.getConnectorHealth?.().sources.map((item) => item.id)).toEqual([
      'foundry:primary',
      'entra:primary',
      'power-platform:primary',
      'agent365:primary',
      'defender-cloud-apps:configuration',
    ])
    expect(connector.getConnectorHealth?.()).toMatchObject({
      overall: 'degraded',
      partial: true,
    })
  })

  it('collects sources sequentially, preserves successful evidence, and marks authoritative failure partial', async () => {
    const config = parseDefenderCloudAppsConfig({
      DEFENDER_CLOUD_APPS_SOURCES_JSON: JSON.stringify(sources),
    })
    let inFlight = 0
    let maximumInFlight = 0
    const connector = new DefenderCloudAppsCompositionConnector(baseConnector(), config, {
      credentialFactory: (source) => credential(source.tenantId),
      clientFactory: (source) => ({
        fetcher: vi.fn<typeof fetch>().mockImplementation(async (input) => {
          inFlight += 1
          maximumInFlight = Math.max(maximumInFlight, inFlight)
          await Promise.resolve()
          inFlight -= 1
          if (source.id === 'tenant-b') {
            return Response.json({ private: 'body' }, { status: 403 })
          }
          return responseFor(requestPath(input), source.id)
        }),
      }),
    })
    const snapshot = await connector.discover()
    expect(maximumInFlight).toBe(1)
    expect(snapshot.nodes).toHaveLength(2)
    expect(snapshot.nodes[1]?.metadata).toMatchObject({
      sourceConnectorId: 'tenant-a',
      sourceTenantId: sources[0]!.tenantId,
      sourceEnvironment: 'security-a',
      attribution: 'unattributed',
    })
    expect(snapshot.edges).toEqual([])
    expect(connector.getConnectorHealth()).toMatchObject({ overall: 'degraded', partial: true })
    expect(connector.getConnectorHealth().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'defender-cloud-apps:tenant-a', readiness: 'ready' }),
        expect.objectContaining({
          id: 'defender-cloud-apps:tenant-b',
          readiness: 'authorization-required',
          reason: 'authorization',
        }),
      ]),
    )
    await expect(connector.getEvidence('base-evidence')).resolves.toEqual(baseEvidence)
    await expect(connector.getEvidence(snapshot.evidence[1]!.id)).resolves.toMatchObject({
      sourceObjectId: 'tenant-a:alert:alert-tenant-a',
    })
  })

  it('keeps identical provider ids distinct across sources', async () => {
    const config = parseDefenderCloudAppsConfig({
      DEFENDER_CLOUD_APPS_SOURCES_JSON: JSON.stringify(sources),
    })
    const connector = new DefenderCloudAppsCompositionConnector(baseConnector(), config, {
      credentialFactory: (source) => credential(source.tenantId),
      clientFactory: () => ({
        fetcher: vi
          .fn<typeof fetch>()
          .mockImplementation((input) =>
            Promise.resolve(responseFor(requestPath(input), 'same-provider-id')),
          ),
      }),
    })
    const snapshot = await connector.discover()
    expect(new Set(snapshot.nodes.map((node) => node.id)).size).toBe(3)
    expect(connector.getConnectorHealth()).toMatchObject({ overall: 'ready', partial: false })
  })

  it('marks later sources bounded rather than silently truncating the aggregate', async () => {
    const config = parseDefenderCloudAppsConfig({
      DEFENDER_CLOUD_APPS_SOURCES_JSON: JSON.stringify(sources),
      DEFENDER_CLOUD_APPS_MAX_ITEMS: '1',
    })
    const first = vi
      .fn<typeof fetch>()
      .mockImplementation((input) => Promise.resolve(responseFor(requestPath(input), 'first')))
    const second = vi
      .fn<typeof fetch>()
      .mockImplementation((input) => Promise.resolve(responseFor(requestPath(input), 'second')))
    const connector = new DefenderCloudAppsCompositionConnector(baseConnector(), config, {
      credentialFactory: (source) => credential(source.tenantId),
      clientFactory: (source) => ({ fetcher: source.id === 'tenant-a' ? first : second }),
    })
    const snapshot = await connector.discover()
    expect(snapshot.nodes).toHaveLength(2)
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).not.toHaveBeenCalled()
    expect(connector.getConnectorHealth().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'defender-cloud-apps:tenant-b',
          readiness: 'unavailable',
          reason: 'bounds',
        }),
      ]),
    )
  })

  it('preserves constructor authentication failures and never creates a fallback', async () => {
    const config = parseDefenderCloudAppsConfig({
      DEFENDER_CLOUD_APPS_SOURCES_JSON: JSON.stringify([sources[0]]),
    })
    const connector = new DefenderCloudAppsCompositionConnector(baseConnector(), config, {
      credentialFactory: () => {
        throw new Error('private credential detail')
      },
    })
    const snapshot = await connector.discover()
    expect(snapshot).toEqual(baseSnapshot)
    expect(connector.getConnectorHealth().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'defender-cloud-apps:tenant-a',
          readiness: 'unavailable',
          reason: 'request-failed',
        }),
      ]),
    )
  })
})
