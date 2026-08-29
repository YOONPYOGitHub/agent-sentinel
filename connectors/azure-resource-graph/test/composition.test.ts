import type { TokenCredential } from '@azure/core-auth'
import type { AgentConnector } from '@agent-sentinel/connector-sdk'
import type { EstateSnapshot, Evidence } from '@agent-sentinel/domain'
import { describe, expect, it, vi } from 'vitest'

import {
  AzureResourceGraphCompositionConnector,
  createOptionalAzureResourceGraphConnector,
  parseAzureResourceGraphConfig,
} from '../src/index.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'
const SUBSCRIPTION_ID = '10000000-0000-0000-0000-000000000001'
const baseEvidence: Evidence = {
  id: 'base-evidence',
  source: 'base',
  sourceObjectId: 'base-object',
  observedAt: '2026-08-29T00:00:00Z',
  freshness: 'live',
  confidence: 1,
  summary: 'Base evidence.',
}
const baseSnapshot: EstateSnapshot = {
  tenantId: TENANT_ID,
  environment: 'validation',
  generatedAt: '2026-08-29T00:00:00Z',
  nodes: [],
  edges: [],
  evidence: [baseEvidence],
}

function baseConnector(): AgentConnector {
  return {
    descriptor: {
      id: 'purview-base',
      name: 'Purview base',
      apiVersion: '1',
      releaseStatus: 'ga',
      capabilities: ['discovery', 'evidence'],
      requiredPermissions: [],
      blindSpots: [],
    },
    testConnection: () =>
      Promise.resolve({ ok: true, checkedAt: '2026-08-29T00:00:00Z', message: 'ready' }),
    discover: () => Promise.resolve(structuredClone(baseSnapshot)),
    getEvidence: (id) =>
      id === baseEvidence.id
        ? Promise.resolve(structuredClone(baseEvidence))
        : Promise.reject(new Error('not found')),
  }
}

function credential(): TokenCredential {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return {
    getToken: () =>
      Promise.resolve({
        token: `${encode({ alg: 'none' })}.${encode({ tid: TENANT_ID })}.signature`,
        expiresOnTimestamp: Date.now() + 60_000,
      }),
  }
}

const source = {
  id: 'primary',
  name: 'Primary Azure subscription',
  tenantId: TENANT_ID,
  environment: 'validation',
  subscriptions: [SUBSCRIPTION_ID],
}
const resource = {
  id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/ai`,
  name: 'ai',
  type: 'microsoft.cognitiveservices/accounts',
  location: 'koreacentral',
  subscriptionId: SUBSCRIPTION_ID,
  resourceGroup: 'rg',
}

describe('Azure Resource Graph composition', () => {
  it('returns the base when disabled and reports invalid enabled configuration', async () => {
    const base = baseConnector()
    expect(createOptionalAzureResourceGraphConnector(base, {})).toBe(base)
    const invalid = createOptionalAzureResourceGraphConnector(base, {
      AZURE_RESOURCE_GRAPH_CONNECTOR_ENABLED: 'true',
    })
    await invalid.discover()
    expect(invalid.getConnectorHealth?.().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'azure-resource-graph:configuration',
          readiness: 'authorization-required',
        }),
      ]),
    )
  })

  it('appends direct control evidence without agent or relationship inference', async () => {
    const config = parseAzureResourceGraphConfig({
      AZURE_RESOURCE_GRAPH_SOURCES_JSON: JSON.stringify([source]),
    })
    const connector = new AzureResourceGraphCompositionConnector(baseConnector(), config, {
      credentialFactory: credential,
      clientFactory: () => ({
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            totalRecords: 1,
            count: 1,
            resultTruncated: 'false',
            data: [resource],
          }),
        ),
      }),
    })
    const snapshot = await connector.discover()
    expect(snapshot.nodes).toHaveLength(1)
    expect(snapshot.nodes[0]).toMatchObject({
      kind: 'control',
      name: 'ai',
      metadata: {
        sourceConnector: 'azure-resource-graph',
        sourceConnectorId: 'primary',
        attribution: 'unattributed',
      },
    })
    expect(snapshot.edges).toEqual([])
    expect(snapshot.evidence).toHaveLength(2)
    expect(connector.getConnectorHealth().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'azure-resource-graph:primary',
          readiness: 'ready',
        }),
      ]),
    )
  })

  it('keeps provider failure partial and preserves the authoritative base snapshot', async () => {
    const config = parseAzureResourceGraphConfig({
      AZURE_RESOURCE_GRAPH_SOURCES_JSON: JSON.stringify([source]),
    })
    const connector = new AzureResourceGraphCompositionConnector(baseConnector(), config, {
      credentialFactory: credential,
      clientFactory: () => ({
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 })),
      }),
    })
    await expect(connector.discover()).resolves.toEqual(baseSnapshot)
    expect(connector.getConnectorHealth()).toMatchObject({ overall: 'degraded', partial: true })
    expect(connector.getConnectorHealth().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'azure-resource-graph:primary',
          readiness: 'authorization-required',
          reason: 'authorization',
        }),
      ]),
    )
  })
})
