import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../src/app.js'
import { buildConnectorsCollection, connectorBaseCatalog } from '../src/connectors-catalog.js'
import { DemoService } from '../src/demo-service.js'
import { MockAgentConnector } from '@agent-sentinel/mock-connector'

const apps: Awaited<ReturnType<typeof createApp>>[] = []

beforeEach(() => {
  process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
})

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()))
  delete process.env['AGENT_SENTINEL_CONNECTOR']
  delete process.env['AGENT_SENTINEL_WRITE_ENABLED']
})

describe('GET /api/connectors', () => {
  it('returns 200 with active connector and catalog', async () => {
    const app = await createApp()
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/connectors' })
    expect(response.statusCode).toBe(200)
    const body: { active: unknown; catalog: unknown[] } = response.json()
    expect(body).toMatchObject({
      active: { mode: 'mock', source: 'mock', lifecycleState: 'connected' },
    })
    const { catalog } = body
    expect(Array.isArray(catalog)).toBe(true)
    expect(catalog.length).toBeGreaterThan(0)
  })

  it('marks Azure AI Foundry as available-to-configure in mock mode', async () => {
    const app = await createApp()
    apps.push(app)
    const body: { catalog: Array<{ id: string; lifecycleState: string }> } = (
      await app.inject({ method: 'GET', url: '/api/connectors' })
    ).json()
    const foundry = body.catalog.find((e) => e.id === 'azure-ai-foundry')
    expect(foundry?.lifecycleState).toBe('available-to-configure')
  })

  it('marks Agent 365 as authorization-required', async () => {
    const app = await createApp()
    apps.push(app)
    const body: { catalog: Array<{ id: string; lifecycleState: string }> } = (
      await app.inject({ method: 'GET', url: '/api/connectors' })
    ).json()
    const agent365 = body.catalog.find((e) => e.id === 'm365-agent-registry')
    expect(agent365?.lifecycleState).toBe('authorization-required')
  })

  it('does not expose secrets or credentials in the response', async () => {
    const app = await createApp()
    apps.push(app)
    const raw = (await app.inject({ method: 'GET', url: '/api/connectors' })).body
    const forbidden = ['password', 'client_secret', 'private_key', 'access_key', 'api_key']
    for (const term of forbidden) {
      expect(raw.toLowerCase()).not.toContain(term)
    }
  })

  it('keeps /api/connector/status backward compatible', async () => {
    const app = await createApp()
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/api/connector/status' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      source: 'mock',
      connectorId: 'mock-agent-estate',
      mode: 'mock',
    })
  })
})

describe('buildConnectorsCollection', () => {
  it('marks Foundry as connected in foundry mode', () => {
    const result = buildConnectorsCollection('foundry', { connectorId: 'foundry-connector' })
    const foundry = result.catalog.find((e) => e.id === 'azure-ai-foundry')
    expect(foundry?.lifecycleState).toBe('connected')
  })

  it('marks Foundry as available-to-configure in mock mode', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const foundry = result.catalog.find((e) => e.id === 'azure-ai-foundry')
    expect(foundry?.lifecycleState).toBe('available-to-configure')
  })

  it('active connector always shows lifecycleState connected', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    expect(result.active.lifecycleState).toBe('connected')
  })

  it('marks Azure Monitor OTel connected only when runtime configuration is injected', () => {
    const unavailable = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-connector',
    })
    const configured = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-connector',
      runtimeTelemetryConfigured: true,
    })
    expect(
      unavailable.catalog.find((entry) => entry.id === 'azure-monitor-otel')?.lifecycleState,
    ).toBe('available-to-configure')
    expect(
      configured.catalog.find((entry) => entry.id === 'azure-monitor-otel')?.lifecycleState,
    ).toBe('connected')
  })

  it('Entra inventory is implemented, authorization-required, and distinct from Foundry auth', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const entra = result.catalog.find((e) => e.id === 'entra-agent-id')
    expect(entra?.lifecycleState).toBe('authorization-required')
    expect(entra?.capabilities).toContain('identity')
    expect(entra?.capabilities).toContain('entitlement')
    expect(entra?.prerequisiteNote).toContain('Application.Read.All')
  })

  it('maps measured Entra health without hiding partial readiness', () => {
    const health = {
      overall: 'degraded' as const,
      partial: true,
      sources: [
        {
          id: 'microsoft-entra-service-principals',
          name: 'Microsoft Entra service principals',
          role: 'enrichment' as const,
          enabled: true,
          configured: true,
          readiness: 'degraded' as const,
          reason: 'unavailable',
        },
      ],
    }
    const degraded = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-connector',
      connectorHealth: health,
    })

    expect(degraded.health).toEqual(health)
    expect(degraded.catalog.find((entry) => entry.id === 'entra-agent-id')?.lifecycleState).toBe(
      'unavailable',
    )

    const ready = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-connector',
      connectorHealth: {
        ...health,
        overall: 'ready',
        partial: false,
        sources: [{ ...health.sources[0]!, readiness: 'ready' }],
      },
    })
    expect(ready.catalog.find((entry) => entry.id === 'entra-agent-id')?.lifecycleState).toBe(
      'connected',
    )
  })

  it('reports partially reachable Foundry sources as degraded', () => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'azure-ai-foundry-agent-service',
      connectionOk: false,
      connectorHealth: {
        overall: 'degraded',
        partial: true,
        sources: [
          {
            id: 'project-a',
            name: 'Project A',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
          },
          {
            id: 'project-b',
            name: 'Project B',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'unavailable',
            reason: 'authentication-or-access',
          },
        ],
      },
    })
    expect(result.active.lifecycleState).toBe('degraded')
    expect(result.catalog.find((entry) => entry.id === 'azure-ai-foundry')?.lifecycleState).toBe(
      'degraded',
    )
  })

  it('custom manifest adapter is configurable but never a source of truth', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const manifest = result.catalog.find((e) => e.id === 'custom-manifest-adapter')
    expect(manifest?.lifecycleState).toBe('available-to-configure')
    expect(manifest?.sourceOfTruth).toBe(false)
    expect(manifest?.capabilities).toContain('discovery')
    expect(manifest?.prerequisiteNote).toContain('non-authoritative evidence')
    expect(manifest?.settingsPath).toBeUndefined()
  })

  it('Agent 365 has sourceOfTruth and requires authorization', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const agent365 = result.catalog.find((e) => e.id === 'm365-agent-registry')
    expect(agent365?.sourceOfTruth).toBe(true)
    expect(agent365?.lifecycleState).toBe('authorization-required')
    expect(agent365?.prerequisiteNote).toBeTruthy()
  })

  it('includes expected capability kinds for all entries', () => {
    const validCapabilities = new Set([
      'discovery',
      'identity',
      'entitlement',
      'runtime-telemetry',
      'security-alerts',
      'data-governance',
      'lifecycle-admin',
      'write-remediation',
    ])
    for (const entry of connectorBaseCatalog) {
      for (const cap of entry.capabilities as string[]) {
        expect(validCapabilities).toContain(cap)
      }
    }
  })

  it('no catalog entry exposes secrets or tenant-private fields', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const json = JSON.stringify(result)
    const forbidden = ['password', 'client_secret', 'private_key', 'access_key', 'api_key']
    for (const term of forbidden) {
      expect(json.toLowerCase()).not.toContain(term)
    }
  })

  it('propagates writeEnabled and projectEndpoint when provided', () => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      connectionOk: true,
      writeEnabled: false,
      projectEndpoint: 'https://example.services.ai.azure.com/api/projects/test',
    })
    expect(result.active.writeEnabled).toBe(false)
    expect(result.active.projectEndpoint).toBe(
      'https://example.services.ai.azure.com/api/projects/test',
    )
  })

  it('marks configured Foundry unavailable when its connection test fails', () => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      connectionOk: false,
    })
    expect(result.active.lifecycleState).toBe('unavailable')
    expect(result.catalog.find((entry) => entry.id === 'azure-ai-foundry')?.lifecycleState).toBe(
      'unavailable',
    )
  })
})

describe('connector write status', () => {
  it('keeps mock simulation enabled by default', async () => {
    const service = new DemoService(new MockAgentConnector(), 'mock')
    await expect(service.getConnectorStatus()).resolves.toMatchObject({ writeEnabled: true })
  })

  it('fails closed for Foundry unless writes are explicitly enabled', async () => {
    const service = new DemoService(new MockAgentConnector(), 'foundry')
    await expect(service.getConnectorStatus()).resolves.toMatchObject({ writeEnabled: false })

    process.env['AGENT_SENTINEL_WRITE_ENABLED'] = 'true'
    await expect(service.getConnectorStatus()).resolves.toMatchObject({ writeEnabled: true })
  })
})
