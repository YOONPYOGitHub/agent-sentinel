import type { TokenCredential } from '@azure/core-auth'
import type { AgentConnector } from '@agent-sentinel/connector-sdk'
import type { EstateSnapshot, Evidence } from '@agent-sentinel/domain'
import { describe, expect, it, vi } from 'vitest'

import {
  PurviewCompositionConnector,
  createOptionalPurviewConnector,
  parsePurviewConfig,
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
  nodes: [],
  edges: [],
  evidence: [baseEvidence],
}

function baseConnector(): AgentConnector {
  return {
    descriptor: {
      id: 'defender-base',
      name: 'Defender base',
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
    getConnectorHealth: () => ({
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
        {
          id: 'defender-cloud-apps:primary',
          name: 'Defender',
          role: 'enrichment',
          enabled: true,
          configured: true,
          readiness: 'ready',
        },
      ],
    }),
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
    environment: 'governance-a',
  },
  {
    id: 'tenant-b',
    name: 'Tenant B',
    tenantId: '00000000-0000-0000-0000-000000000002',
    environment: 'governance-b',
  },
]

function label(id: string): object {
  return {
    id: `10000000-0000-0000-0000-${id.padStart(12, '0')}`,
    displayName: `Label ${id}`,
    applicableTo: 'file',
    isEnabled: true,
  }
}

describe('Purview composition', () => {
  it('returns the exact base when disabled and appends after Defender when enabled', async () => {
    const base = baseConnector()
    expect(createOptionalPurviewConnector(base, {})).toBe(base)
    expect(createOptionalPurviewConnector(base, { PURVIEW_CONNECTOR_ENABLED: 'false' })).toBe(base)

    const invalid = createOptionalPurviewConnector(base, { PURVIEW_CONNECTOR_ENABLED: 'true' })
    await invalid.discover()
    expect(invalid.getConnectorHealth?.().sources.map((item) => item.id)).toEqual([
      'foundry:primary',
      'entra:primary',
      'power-platform:primary',
      'agent365:primary',
      'defender-cloud-apps:primary',
      'purview:configuration',
    ])
    expect(invalid.getConnectorHealth?.()).toMatchObject({ overall: 'degraded', partial: true })
  })

  it('collects sources sequentially, keeps successful evidence, and marks 403 partial', async () => {
    const config = parsePurviewConfig({ PURVIEW_SOURCES_JSON: JSON.stringify(sources) })
    let inFlight = 0
    let maximumInFlight = 0
    const connector = new PurviewCompositionConnector(baseConnector(), config, {
      credentialFactory: (source) => credential(source.tenantId),
      clientFactory: (source) => ({
        fetcher: vi.fn<typeof fetch>().mockImplementation(async () => {
          inFlight += 1
          maximumInFlight = Math.max(maximumInFlight, inFlight)
          await Promise.resolve()
          inFlight -= 1
          return source.id === 'tenant-a'
            ? Response.json({ value: [label('1')] })
            : Response.json({ error: { message: 'private' } }, { status: 403 })
        }),
      }),
    })
    const snapshot = await connector.discover()
    expect(maximumInFlight).toBe(1)
    expect(snapshot.nodes).toHaveLength(1)
    expect(snapshot.nodes[0]?.metadata).toMatchObject({
      sourceConnectorId: 'tenant-a',
      sourceTenantId: sources[0]!.tenantId,
      attribution: 'unattributed',
    })
    expect(snapshot.edges).toEqual([])
    expect(connector.getConnectorHealth()).toMatchObject({ overall: 'degraded', partial: true })
    expect(connector.getConnectorHealth().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'purview:tenant-a', readiness: 'ready' }),
        expect.objectContaining({
          id: 'purview:tenant-b',
          readiness: 'authorization-required',
          reason: 'authorization',
        }),
      ]),
    )
    await expect(connector.getEvidence('base-evidence')).resolves.toEqual(baseEvidence)
    const purviewEvidence = await connector.getEvidence(snapshot.evidence[1]!.id)
    expect(purviewEvidence.sourceObjectId).toContain('tenant-a:')
  })

  it('keeps equal label ids separate by tenant and fails later source at aggregate cap', async () => {
    const config = parsePurviewConfig({
      PURVIEW_SOURCES_JSON: JSON.stringify(sources),
      PURVIEW_MAX_ITEMS: '1',
    })
    const first = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ value: [label('1')] }))
    const second = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ value: [label('1')] }))
    const connector = new PurviewCompositionConnector(baseConnector(), config, {
      credentialFactory: (source) => credential(source.tenantId),
      clientFactory: (source) => ({ fetcher: source.id === 'tenant-a' ? first : second }),
    })
    const snapshot = await connector.discover()
    expect(snapshot.nodes).toHaveLength(1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(connector.getConnectorHealth().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'purview:tenant-b',
          readiness: 'unavailable',
          reason: 'bounds',
        }),
      ]),
    )
  })

  it('preserves constructor failure reasons and creates no fallback', async () => {
    const config = parsePurviewConfig({
      PURVIEW_SOURCES_JSON: JSON.stringify([sources[0]]),
    })
    const connector = new PurviewCompositionConnector(baseConnector(), config, {
      credentialFactory: () => {
        throw new Error('private credential detail')
      },
    })
    await expect(connector.discover()).resolves.toEqual(baseSnapshot)
    expect(connector.getConnectorHealth().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'purview:tenant-a',
          readiness: 'unavailable',
          reason: 'request-failed',
        }),
      ]),
    )
  })
})
