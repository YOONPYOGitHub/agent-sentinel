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

  it('exposes measured multi-source OTel readiness', () => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-connector',
      runtimeTelemetryConfigured: true,
      runtimeTelemetryHealth: {
        overall: 'degraded',
        partial: false,
        sources: [
          {
            id: 'otel:project-a',
            name: 'Project A Azure Monitor',
            role: 'enrichment',
            enabled: true,
            configured: true,
            readiness: 'degraded',
            reason: 'not-queried',
          },
        ],
      },
    })
    expect(result.catalog.find((entry) => entry.id === 'azure-monitor-otel')?.lifecycleState).toBe(
      'degraded',
    )
    expect(result.health?.sources).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'otel:project-a' })]),
    )
  })

  it('Entra inventory is implemented, authorization-required, and distinct from Foundry auth', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const entra = result.catalog.find((e) => e.id === 'entra-agent-id')
    expect(entra?.lifecycleState).toBe('authorization-required')
    expect(entra?.capabilities).toContain('identity')
    expect(entra?.capabilities).toContain('entitlement')
    expect(entra?.prerequisiteNote).toContain('Application.Read.All')
  })

  it('describes the unsupported unattended Power Platform authorization boundary', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const powerPlatform = result.catalog.find((entry) => entry.id === 'copilot-studio')
    expect(powerPlatform).toMatchObject({
      lifecycleState: 'authorization-required',
      sourceOfTruth: true,
      ownershipModel: 'consumes',
    })
    expect(powerPlatform?.description).toContain('Microsoft 365 Copilot Agent Builder')
    expect(powerPlatform?.description).toContain('preview')
    expect(powerPlatform?.prerequisiteNote).toContain('ResourceQuery.Resources.Read')
    expect(powerPlatform?.prerequisiteNote).toContain('No supported unattended authorization path')
    expect(powerPlatform?.prerequisiteNote).not.toContain('requires Power Platform Reader')
  })

  it('maps enabled Power Platform source health without degrading Foundry catalog state', () => {
    const base = {
      connectorId: 'azure-ai-foundry-agent-service',
      connectorHealth: {
        overall: 'degraded' as const,
        partial: true,
        sources: [
          {
            id: 'foundry:primary',
            name: 'Foundry',
            role: 'discovery' as const,
            enabled: true,
            configured: true,
            readiness: 'ready' as const,
          },
          {
            id: 'power-platform:studio',
            name: 'Studio',
            role: 'discovery' as const,
            enabled: true,
            configured: true,
            readiness: 'authorization-required' as const,
            reason: 'authorization',
          },
        ],
      },
    }
    const authorizationRequired = buildConnectorsCollection('foundry', base)
    expect(
      authorizationRequired.catalog.find((entry) => entry.id === 'copilot-studio')?.lifecycleState,
    ).toBe('authorization-required')
    expect(
      authorizationRequired.catalog.find((entry) => entry.id === 'azure-ai-foundry')
        ?.lifecycleState,
    ).toBe('connected')

    const connected = buildConnectorsCollection('foundry', {
      ...base,
      connectorHealth: {
        overall: 'ready',
        partial: false,
        sources: [
          base.connectorHealth.sources[0]!,
          { ...base.connectorHealth.sources[1]!, readiness: 'ready' as const },
        ],
      },
    })
    expect(connected.catalog.find((entry) => entry.id === 'copilot-studio')?.lifecycleState).toBe(
      'connected',
    )

    const degraded = buildConnectorsCollection('foundry', {
      ...base,
      connectorHealth: {
        ...base.connectorHealth,
        sources: [
          base.connectorHealth.sources[0]!,
          { ...base.connectorHealth.sources[1]!, readiness: 'degraded' as const },
        ],
      },
    })
    expect(degraded.catalog.find((entry) => entry.id === 'copilot-studio')?.lifecycleState).toBe(
      'degraded',
    )

    const unavailable = buildConnectorsCollection('foundry', {
      ...base,
      connectorHealth: {
        ...base.connectorHealth,
        sources: [
          base.connectorHealth.sources[0]!,
          {
            ...base.connectorHealth.sources[1]!,
            readiness: 'unavailable' as const,
            reason: 'network',
          },
        ],
      },
    })
    expect(unavailable.catalog.find((entry) => entry.id === 'copilot-studio')?.lifecycleState).toBe(
      'unavailable',
    )
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

  it('reports partial multi-tenant Entra authorization as degraded', () => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'azure-ai-foundry-agent-service',
      connectorHealth: {
        overall: 'degraded',
        partial: true,
        sources: [
          {
            id: 'foundry:project-a',
            name: 'Project A',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
          },
          {
            id: 'entra:project-a',
            name: 'Project A Entra',
            role: 'enrichment',
            enabled: true,
            configured: true,
            readiness: 'ready',
          },
          {
            id: 'entra:project-b',
            name: 'Project B Entra',
            role: 'enrichment',
            enabled: true,
            configured: false,
            readiness: 'authorization-required',
          },
        ],
      },
    })
    expect(result.catalog.find((entry) => entry.id === 'entra-agent-id')?.lifecycleState).toBe(
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

  it('describes Defender for Cloud Apps as read-only unattributed OAuth evidence', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const defender = result.catalog.find((entry) => entry.id === 'defender-for-cloud-apps')
    expect(defender).toMatchObject({
      lifecycleState: 'authorization-required',
      capabilities: ['security-alerts'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
      unlocksScorecard: [],
    })

    expect(defender?.description).toContain('unattributed')
    expect(defender?.prerequisiteNote).toContain('Investigation.Read')
    expect(defender?.prerequisiteNote).toContain('Legacy API tokens are not accepted')
  })

  it('describes Purview as a read-only Global Graph label catalog without usage claims', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const purview = result.catalog.find((entry) => entry.id === 'purview')
    expect(purview).toMatchObject({
      lifecycleState: 'authorization-required',
      capabilities: ['data-governance'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
      unlocksScorecard: [],
    })
    expect(purview?.description).toContain('v1.0')
    expect(purview?.description).toContain('unattributed')
    expect(purview?.prerequisiteNote).toContain('SensitivityLabel.Read')
    expect(purview?.prerequisiteNote).toContain('Global Graph')
    expect(purview?.prerequisiteNote).toContain('no activity/usage evidence')
  })

  it('describes Azure Resource Graph as read-only unattributed resource evidence', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const resourceGraph = result.catalog.find((entry) => entry.id === 'azure-resource-graph')
    expect(resourceGraph).toMatchObject({
      lifecycleState: 'available-to-configure',
      capabilities: ['discovery'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
      unlocksScorecard: [],
    })
    expect(resourceGraph?.description).toContain('unattributed')
    expect(resourceGraph?.description).toContain('never classified as agents')
    expect(resourceGraph?.prerequisiteNote).toContain('Reader')
    expect(resourceGraph?.prerequisiteNote).toContain('does not require M365 E5')
  })

  it.each([
    ['ready', 'connected'],
    ['degraded', 'degraded'],
    ['authorization-required', 'authorization-required'],
    ['unavailable', 'unavailable'],
  ] as const)('maps enabled Azure Resource Graph %s health to %s', (readiness, lifecycle) => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      connectorHealth: {
        overall: readiness === 'ready' ? 'ready' : 'degraded',
        partial: readiness !== 'ready',
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
            id: 'azure-resource-graph:primary',
            name: 'Azure subscription',
            role: 'enrichment',
            enabled: true,
            configured: true,
            readiness,
          },
        ],
      },
    })
    expect(
      result.catalog.find((entry) => entry.id === 'azure-resource-graph')?.lifecycleState,
    ).toBe(lifecycle)
  })

  it.each([
    ['ready', 'connected'],
    ['degraded', 'degraded'],
    ['authorization-required', 'authorization-required'],
    ['unavailable', 'unavailable'],
  ] as const)('maps enabled Purview %s health to %s', (readiness, lifecycle) => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      connectorHealth: {
        overall: readiness === 'ready' ? 'ready' : 'degraded',
        partial: readiness !== 'ready',
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
            id: 'purview:tenant-a',
            name: 'Purview Tenant A',
            role: 'enrichment',
            enabled: true,
            configured: true,
            readiness,
          },
        ],
      },
    })
    expect(result.catalog.find((entry) => entry.id === 'purview')?.lifecycleState).toBe(lifecycle)
    expect(result.catalog.find((entry) => entry.id === 'azure-ai-foundry')?.lifecycleState).toBe(
      'connected',
    )
  })

  it('describes Teams distribution as tenant catalog evidence without installation claims', () => {
    const result = buildConnectorsCollection('mock', { connectorId: 'mock-agent-estate' })
    const teams = result.catalog.find((entry) => entry.id === 'teams-distribution')
    expect(teams).toMatchObject({
      lifecycleState: 'authorization-required',
      capabilities: ['discovery'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
      unlocksScorecard: [],
    })
    expect(teams?.description).toContain('organization app catalog')
    expect(teams?.description).toContain('does not prove an agent')
    expect(teams?.description).toContain('installation')
    expect(teams?.prerequisiteNote).toContain('AppCatalog.Read.All')
    expect(teams?.prerequisiteNote).toContain('Global Graph')
  })

  it.each([
    ['ready', 'connected'],
    ['degraded', 'degraded'],
    ['authorization-required', 'authorization-required'],
    ['unavailable', 'unavailable'],
  ] as const)('maps enabled Teams distribution %s health to %s', (readiness, lifecycle) => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      connectorHealth: {
        overall: readiness === 'ready' ? 'ready' : 'degraded',
        partial: readiness !== 'ready',
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
            id: 'teams-distribution:tenant-a',
            name: 'Teams Tenant A',
            role: 'enrichment',
            enabled: true,
            configured: true,
            readiness,
          },
        ],
      },
    })
    expect(result.catalog.find((entry) => entry.id === 'teams-distribution')?.lifecycleState).toBe(
      lifecycle,
    )
    expect(result.catalog.find((entry) => entry.id === 'azure-ai-foundry')?.lifecycleState).toBe(
      'connected',
    )
  })

  it.each([
    ['ready', 'connected'],
    ['degraded', 'degraded'],
    ['authorization-required', 'authorization-required'],
    ['unavailable', 'unavailable'],
  ] as const)('maps enabled Defender for Cloud Apps %s health to %s', (readiness, lifecycle) => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      connectorHealth: {
        overall: readiness === 'ready' ? 'ready' : 'degraded',
        partial: readiness !== 'ready',
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
            id: 'defender-cloud-apps:tenant-a',
            name: 'MDCA Tenant A',
            role: 'enrichment',
            enabled: true,
            configured: true,
            readiness,
          },
        ],
      },
    })
    expect(
      result.catalog.find((entry) => entry.id === 'defender-for-cloud-apps')?.lifecycleState,
    ).toBe(lifecycle)
    expect(result.catalog.find((entry) => entry.id === 'azure-ai-foundry')?.lifecycleState).toBe(
      'connected',
    )
  })

  it.each([
    ['ready', 'connected'],
    ['degraded', 'degraded'],
    ['authorization-required', 'authorization-required'],
    ['unavailable', 'unavailable'],
  ] as const)('maps enabled Agent 365 %s health to %s', (readiness, lifecycle) => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      connectorHealth: {
        overall: readiness === 'ready' ? 'ready' : 'degraded',
        partial: readiness !== 'ready',
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
            id: 'agent365:tenant-a',
            name: 'Agent 365 Tenant A',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness,
          },
        ],
      },
    })
    expect(result.catalog.find((entry) => entry.id === 'm365-agent-registry')?.lifecycleState).toBe(
      lifecycle,
    )
    expect(
      result.catalog.find((entry) => entry.id === 'm365-sharepoint-agents')?.lifecycleState,
    ).toBe(lifecycle)
    expect(result.catalog.find((entry) => entry.id === 'azure-ai-foundry')?.lifecycleState).toBe(
      'connected',
    )
  })

  it('marks mixed Agent 365 source health degraded and documents read-only prerequisites', () => {
    const result = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      connectorHealth: {
        overall: 'degraded',
        partial: true,
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
            id: 'agent365:a',
            name: 'A',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'ready',
          },
          {
            id: 'agent365:b',
            name: 'B',
            role: 'discovery',
            enabled: true,
            configured: true,
            readiness: 'authorization-required',
          },
        ],
      },
    })
    const entry = result.catalog.find((item) => item.id === 'm365-agent-registry')
    expect(entry?.lifecycleState).toBe('degraded')
    expect(entry?.description).toContain('v1.0')
    expect(entry?.description).toContain('read-only')
    expect(entry?.prerequisiteNote).toContain('Microsoft Agent 365 licensing')
    expect(entry?.prerequisiteNote).toContain('CopilotPackages.Read.All')
    expect(entry?.capabilities).not.toContain('lifecycle-admin')
    const sharePoint = result.catalog.find((item) => item.id === 'm365-sharepoint-agents')
    expect(sharePoint?.lifecycleState).toBe('degraded')
    expect(sharePoint?.prerequisiteNote).toContain('CopilotPackages.Read.All')
    expect(sharePoint?.description).toContain('without duplicating package evidence')
  })
  it('includes expected capability kinds for all entries', () => {
    const validCapabilities = new Set([
      'discovery',
      'identity',
      'entitlement',
      'runtime-telemetry',
      'business-outcomes',
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

  it('catalogs business outcomes without claiming an unconfigured live source', () => {
    const unconfigured = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
    }).catalog.find((entry) => entry.id === 'business-outcome-source')
    const configured = buildConnectorsCollection('foundry', {
      connectorId: 'foundry-test',
      businessOutcomeConfigured: true,
    }).catalog.find((entry) => entry.id === 'business-outcome-source')

    expect(unconfigured?.lifecycleState).toBe('available-to-configure')
    expect(configured?.lifecycleState).toBe('connected')
    expect(configured?.capabilities).toContain('business-outcomes')
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

  it('rejects execution when a connector method exists without execution capability', async () => {
    const base = new MockAgentConnector()
    const connector = {
      descriptor: {
        ...base.descriptor,
        capabilities: ['discovery', 'evidence'] as const,
      },
      testConnection: base.testConnection.bind(base),
      discover: base.discover.bind(base),
      getEvidence: base.getEvidence.bind(base),
      execute: base.execute.bind(base),
    }
    const service = new DemoService(connector, 'foundry')
    const initial = await service.getState()
    const findingId = initial.findings[0]?.id
    if (findingId === undefined) throw new Error('Expected a mock finding.')
    await service.validateFinding(findingId)
    const proposed = await service.proposeRemediation(findingId)
    const remediationId = proposed.remediations[0]?.id
    if (remediationId === undefined) throw new Error('Expected a proposed remediation.')
    await service.approveRemediation(
      remediationId,
      'approver',
      'Reviewed validated evidence and approved the reversible plan.',
    )

    const app = await createApp(service, { mode: 'disabled' }, { dataMode: 'mock' })
    apps.push(app)
    const response = await app.inject({
      method: 'POST',
      url: `/api/demo/remediations/${remediationId}/execute`,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({
      error: 'operation_rejected',
      message: 'The selected connector does not support remediation execution.',
    })
  })
})
