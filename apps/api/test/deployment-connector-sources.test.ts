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

  it('enables configured live sources from the runtime activation predicate only', () => {
    const [source] = buildDeploymentConnectorSources(configuredEnvironment, registry, 'live')

    expect(source).toMatchObject({
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

  it('projects configured sources as disabled in mock mode without synthetic readiness', () => {
    const [source] = buildDeploymentConnectorSources(configuredEnvironment, registry, 'mock')

    expect(source).toMatchObject({
      connectorType: 'azure-monitor-otel',
      enabled: false,
      testStatus: { status: 'not-tested' },
    })
  })

  it('omits empty source configuration and rejects invalid source configuration', () => {
    expect(
      buildDeploymentConnectorSources({ AZURE_MONITOR_SOURCES_JSON: '   ' }, registry, 'live'),
    ).toEqual([])
    expect(() =>
      buildDeploymentConnectorSources({ AZURE_MONITOR_SOURCES_JSON: '[]' }, registry, 'live'),
    ).toThrow()
    expect(() =>
      buildDeploymentConnectorSources(
        { AZURE_MONITOR_SOURCES_JSON: '{invalid' },
        registry,
        'live',
      ),
    ).toThrow('AZURE_MONITOR_SOURCES_JSON must be valid JSON')
  })
})
