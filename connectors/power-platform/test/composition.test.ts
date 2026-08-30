import type { AgentConnector, ConnectorHealthReport } from '@agent-sentinel/connector-sdk'
import type { EstateSnapshot } from '@agent-sentinel/domain'
import type { TokenCredential } from '@azure/core-auth'
import { describe, expect, it, vi } from 'vitest'

import {
  PowerPlatformInventoryConnector,
  PowerPlatformConnectorError,
  createOptionalPowerPlatformConnector,
  parsePowerPlatformConfig,
  powerPlatformLimitsSchema,
} from '../src/index.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const baseSnapshot: EstateSnapshot = {
  tenantId: 'estate',
  environment: 'portfolio',
  generatedAt: '2026-08-27T00:00:00Z',
  nodes: [
    {
      id: 'base-agent',
      kind: 'agent',
      name: 'Foundry agent',
      description: 'Base agent.',
      environment: 'portfolio',
      evidenceIds: ['base-evidence'],
      metadata: {},
    },
  ],
  edges: [],
  evidence: [
    {
      id: 'base-evidence',
      source: 'Base',
      sourceObjectId: 'base-agent',
      observedAt: '2026-08-27T00:00:00Z',
      freshness: 'live',
      confidence: 1,
      evidenceTypes: ['declared_configuration'],
      summary: 'Base evidence.',
    },
  ],
}

function baseConnector(): AgentConnector {
  const evidence = new Map(baseSnapshot.evidence.map((item) => [item.id, item]))
  const health: ConnectorHealthReport = {
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
    ],
  }
  return {
    descriptor: {
      id: 'base',
      name: 'Base',
      apiVersion: 'v1',
      releaseStatus: 'ga',
      capabilities: ['discovery', 'evidence'],
      requiredPermissions: [],
      blindSpots: [],
    },
    testConnection: () =>
      Promise.resolve({
        ok: true,
        checkedAt: '2026-08-28T00:00:00Z',
        message: 'ready',
      }),
    discover: () => Promise.resolve(structuredClone(baseSnapshot)),
    getEvidence: (id: string) => Promise.resolve(structuredClone(evidence.get(id)!)),
    getConnectorHealth: () => structuredClone(health),
  }
}

const credential: TokenCredential = {
  getToken: () => Promise.resolve({ token: 'token', expiresOnTimestamp: Date.now() + 60_000 }),
}

function source(id: string, environment: string) {
  return { id, name: id.toUpperCase(), tenantId, environment }
}

function successResponse(environment: string) {
  return Response.json({
    count: 1,
    data: [
      {
        name: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        type: 'microsoft.copilotstudio/agents',
        tenantId,
        environmentId: environment,
        properties: { displayName: `Agent ${environment}`, environmentId: environment },
      },
    ],
    resultTruncated: 1,
    totalRecords: 1,
  })
}

describe('Power Platform optional composition', () => {
  it('publishes an honest preview, read-only RBAC descriptor', () => {
    const connector = new PowerPlatformInventoryConnector(
      source('studio', 'environment-a'),
      powerPlatformLimitsSchema.parse({}),
      credential,
    )
    expect(connector.descriptor.releaseStatus).toBe('preview')
    expect(connector.descriptor.capabilities).toEqual(['discovery', 'evidence'])
    expect(connector.descriptor.requiredPermissions.join(' ')).toContain('Power Platform Reader')
    expect(connector.descriptor.requiredPermissions.join(' ')).not.toContain('Application.Read.All')
  })

  it.each([
    'http://api.powerplatform.com',
    'https://user:pass@api.powerplatform.com',
    'https://api.powerplatform.com:444',
    'https://api.powerplatform.com/path',
    'https://api.powerplatform.com?query=yes',
    'https://evil.example',
  ])('rejects a non-canonical API base URL: %s', (apiBaseUrl) => {
    expect(() =>
      parsePowerPlatformConfig({
        POWER_PLATFORM_TENANT_ID: tenantId,
        POWER_PLATFORM_ENVIRONMENT: 'environment-a',
        POWER_PLATFORM_API_BASE_URL: apiBaseUrl,
      }),
    ).toThrow('Power Platform API base URL')
  })

  it('returns the base connector unchanged while disabled', () => {
    const base = baseConnector()
    expect(
      createOptionalPowerPlatformConnector(base, {
        POWER_PLATFORM_CONNECTOR_ENABLED: 'false',
        POWER_PLATFORM_SOURCES_JSON: '{invalid',
      }),
    ).toBe(base)
  })

  it('isolates same provider IDs across independent sources and keeps the estate boundary', async () => {
    const sources = [source('studio', 'environment-a'), source('builder', 'environment-b')]
    const connector = createOptionalPowerPlatformConnector(
      baseConnector(),
      {
        POWER_PLATFORM_CONNECTOR_ENABLED: 'true',
        POWER_PLATFORM_SOURCES_JSON: JSON.stringify(sources),
      },
      {
        credential,
        clientFactory: (configured) => ({
          fetcher: vi.fn(() => Promise.resolve(successResponse(configured.environment))),
        }),
      },
    )

    const snapshot = await connector.discover()
    expect(snapshot.tenantId).toBe('estate')
    expect(snapshot.environment).toBe('portfolio')
    expect(snapshot.nodes.filter((node) => node.kind === 'agent')).toHaveLength(3)
    expect(new Set(snapshot.nodes.map((node) => node.id)).size).toBe(snapshot.nodes.length)
    expect(connector.getConnectorHealth?.()).toMatchObject({
      overall: 'ready',
      partial: false,
      sources: [
        { id: 'foundry:primary' },
        { id: 'power-platform:studio', role: 'discovery', readiness: 'ready' },
        { id: 'power-platform:builder', role: 'discovery', readiness: 'ready' },
      ],
    })
  })

  it('returns successful inventory plus the base and reports partial when one source fails', async () => {
    const connector = createOptionalPowerPlatformConnector(
      baseConnector(),
      {
        POWER_PLATFORM_CONNECTOR_ENABLED: 'true',
        POWER_PLATFORM_SOURCES_JSON: JSON.stringify([
          source('studio', 'environment-a'),
          source('builder', 'environment-b'),
        ]),
      },
      {
        credential,
        clientFactory: (configured) => ({
          fetcher: vi.fn(() =>
            Promise.resolve(
              configured.id === 'studio'
                ? successResponse(configured.environment)
                : new Response('', { status: 403 }),
            ),
          ),
        }),
      },
    )

    const snapshot = await connector.discover()
    expect(snapshot.nodes).toHaveLength(2)
    expect(connector.getConnectorHealth?.()).toMatchObject({
      overall: 'degraded',
      partial: true,
      sources: [
        { id: 'foundry:primary' },
        { id: 'power-platform:studio', readiness: 'ready' },
        {
          id: 'power-platform:builder',
          readiness: 'authorization-required',
          reason: 'authorization',
        },
      ],
    })
    const powerEvidence = snapshot.evidence.find((item) => item.id.startsWith('power-platform-'))!
    await expect(connector.getEvidence(powerEvidence.id)).resolves.toEqual(powerEvidence)
    await expect(connector.getEvidence('base-evidence')).resolves.toEqual(baseSnapshot.evidence[0])
  })

  it('keeps usable base discovery when every Power Platform source fails', async () => {
    const connector = createOptionalPowerPlatformConnector(
      baseConnector(),
      {
        POWER_PLATFORM_CONNECTOR_ENABLED: 'true',
        POWER_PLATFORM_TENANT_ID: tenantId,
        POWER_PLATFORM_ENVIRONMENT: 'environment-a',
      },
      {
        credential,
        client: {
          fetcher: vi.fn(() => Promise.resolve(new Response('', { status: 403 }))),
        },
      },
    )
    await expect(connector.discover()).resolves.toEqual(baseSnapshot)
    expect(connector.getConnectorHealth?.()).toMatchObject({
      overall: 'degraded',
      partial: true,
      sources: [
        { id: 'foundry:primary' },
        { id: 'power-platform:primary', readiness: 'authorization-required' },
      ],
    })
  })

  it('preserves credential-construction failure reasons during discovery', async () => {
    const connector = createOptionalPowerPlatformConnector(
      baseConnector(),
      {
        POWER_PLATFORM_CONNECTOR_ENABLED: 'true',
        POWER_PLATFORM_TENANT_ID: tenantId,
        POWER_PLATFORM_ENVIRONMENT: 'environment-a',
      },
      {
        credentialFactory: () => {
          throw new PowerPlatformConnectorError('authentication', 'credential unavailable')
        },
      },
    )

    await expect(connector.discover()).resolves.toEqual(baseSnapshot)
    expect(connector.getConnectorHealth?.()).toMatchObject({
      overall: 'degraded',
      partial: true,
      sources: [
        { id: 'foundry:primary' },
        {
          id: 'power-platform:primary',
          readiness: 'degraded',
          reason: 'authentication',
        },
      ],
    })
  })

  it('surfaces invalid enabled configuration as authorization-required partial health', async () => {
    const connector = createOptionalPowerPlatformConnector(baseConnector(), {
      POWER_PLATFORM_CONNECTOR_ENABLED: 'true',
    })
    await expect(connector.discover()).resolves.toEqual(baseSnapshot)
    expect(connector.getConnectorHealth?.()).toMatchObject({
      overall: 'degraded',
      partial: true,
      sources: [
        { id: 'foundry:primary' },
        {
          id: 'power-platform:configuration',
          configured: false,
          readiness: 'authorization-required',
          reason: 'invalid-configuration',
        },
      ],
    })
  })

  it('does not add inferred edges, tools, or trust through composition', async () => {
    const connector = createOptionalPowerPlatformConnector(
      baseConnector(),
      {
        POWER_PLATFORM_CONNECTOR_ENABLED: 'true',
        POWER_PLATFORM_TENANT_ID: tenantId,
        POWER_PLATFORM_ENVIRONMENT: 'environment-a',
      },
      {
        credential,
        client: { fetcher: () => Promise.resolve(successResponse('environment-a')) },
      },
    )
    const snapshot = await connector.discover()
    const powerNode = snapshot.nodes.find((node) => node.id.startsWith('power-platform-'))!
    expect(powerNode.kind).toBe('agent')
    expect(powerNode).not.toHaveProperty('trust')
    expect(snapshot.nodes.some((node) => node.kind === 'tool')).toBe(false)
    expect(snapshot.edges).toEqual([])
  })
})
