import { describe, expect, it } from 'vitest'

import { buildDeploymentConnectorSources } from '../src/deployment-connector-sources.js'
import { buildEstateRegistry } from '../src/estate-config.js'

const estate = {
  id: 'default',
  tenantId: 'tenant-default',
  environment: 'production',
}

const registry = buildEstateRegistry({}, estate)

const configuredEnvironment = {
  AGENT_SENTINEL_DATA_MODE: 'live',
  AZURE_MONITOR_CONNECTOR_ENABLED: 'false',
  AZURE_MONITOR_OTEL_CONNECTOR_ENABLED: 'false',
  AZURE_MONITOR_SOURCES_JSON: JSON.stringify([
    {
      id: 'primary',
      name: 'Production telemetry',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      tenantId: estate.tenantId,
      environment: estate.environment,
    },
  ]),
}

describe('deployment Azure Monitor OTel source projection', () => {
  it('namespaces identical configured IDs by connector type', () => {
    const sources = buildDeploymentConnectorSources(
      {
        ...configuredEnvironment,
        AGENT_SENTINEL_TENANT_ID: estate.tenantId,
        FOUNDRY_ENVIRONMENT: estate.environment,
        FOUNDRY_SOURCES_JSON: JSON.stringify([
          {
            id: 'primary',
            name: 'Production Foundry',
            tenantId: estate.tenantId,
            environment: estate.environment,
            projectEndpoint: 'https://safe.services.ai.azure.com/api/projects/primary',
          },
        ]),
      },
      registry,
      'live',
    )

    expect(sources.map((source) => source.sourceId)).toEqual([
      'azure-monitor-otel-primary',
      'foundry-primary',
    ])
  })

  it('projects configured live JSON sources without release-flag gating', () => {
    const [source] = buildDeploymentConnectorSources(configuredEnvironment, registry, 'live')

    expect(source).toMatchObject({
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      sourceId: 'azure-monitor-otel-primary',
      connectorType: 'azure-monitor-otel',
      enabled: true,
      origin: 'deployment',
      testStatus: { status: 'not-tested' },
      configuration: {
        type: 'azure-monitor-otel',
        workspaceId: '11111111-1111-4111-8111-111111111111',
      },
    })
  })

  it('projects the complete legacy tuple when sources JSON is empty', () => {
    const [source] = buildDeploymentConnectorSources(
      {
        AZURE_MONITOR_SOURCES_JSON: '   ',
        AZURE_MONITOR_WORKSPACE_ID: '11111111-1111-4111-8111-111111111111',
        AZURE_MONITOR_TENANT_ID: estate.tenantId,
        AZURE_MONITOR_ENVIRONMENT: estate.environment,
        AZURE_MONITOR_BASELINE_WINDOW_HOURS: '48',
        AZURE_MONITOR_OBSERVED_WINDOW_HOURS: '12',
        AZURE_MONITOR_REQUEST_TIMEOUT_MS: '20000',
      },
      registry,
      'live',
    )

    expect(source).toMatchObject({
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      sourceId: 'azure-monitor-otel-primary',
      connectorType: 'azure-monitor-otel',
      displayName: 'Primary Foundry project',
      enabled: true,
      origin: 'deployment',
      testStatus: { status: 'not-tested' },
      configuration: {
        type: 'azure-monitor-otel',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        baselineWindowHours: 48,
        observedWindowHours: 12,
        requestTimeoutMs: 20_000,
      },
    })
  })

  it('omits empty and partial legacy tuples', () => {
    expect(buildDeploymentConnectorSources({}, registry, 'live')).toEqual([])
    expect(
      buildDeploymentConnectorSources(
        {
          AZURE_MONITOR_SOURCES_JSON: '',
          AZURE_MONITOR_WORKSPACE_ID: '11111111-1111-4111-8111-111111111111',
          AZURE_MONITOR_TENANT_ID: estate.tenantId,
        },
        registry,
        'live',
      ),
    ).toEqual([])
  })

  it('does not parse or project Azure Monitor configuration in mock mode', () => {
    expect(buildDeploymentConnectorSources(configuredEnvironment, registry, 'mock')).toEqual([])
    expect(
      buildDeploymentConnectorSources({ AZURE_MONITOR_SOURCES_JSON: '{invalid' }, registry, 'mock'),
    ).toEqual([])
  })

  it('rejects invalid JSON in live mode', () => {
    expect(() =>
      buildDeploymentConnectorSources({ AZURE_MONITOR_SOURCES_JSON: '[]' }, registry, 'live'),
    ).toThrow()
    expect(() =>
      buildDeploymentConnectorSources({ AZURE_MONITOR_SOURCES_JSON: '{invalid' }, registry, 'live'),
    ).toThrow('AZURE_MONITOR_SOURCES_JSON must be valid JSON')
  })

  it('gives non-empty JSON precedence over the complete legacy tuple', () => {
    const sources = buildDeploymentConnectorSources(
      {
        ...configuredEnvironment,
        AZURE_MONITOR_WORKSPACE_ID: '22222222-2222-4222-8222-222222222222',
        AZURE_MONITOR_TENANT_ID: estate.tenantId,
        AZURE_MONITOR_ENVIRONMENT: estate.environment,
      },
      registry,
      'live',
    )

    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      sourceId: 'azure-monitor-otel-primary',
      configuration: {
        workspaceId: '11111111-1111-4111-8111-111111111111',
      },
    })
  })
})
