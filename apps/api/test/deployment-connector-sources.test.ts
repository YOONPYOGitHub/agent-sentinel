import { AzureMonitorOtelConfigurationError } from '@agent-sentinel/azure-monitor-otel-connector'
import { describe, expect, it } from 'vitest'

import { buildDeploymentConnectorSources } from '../src/deployment-connector-sources.js'
import { buildEstateRegistry } from '../src/estate-config.js'

const estate = {
  id: 'default',
  tenantId: 'tenant-default',
  environment: 'production',
}

const registry = buildEstateRegistry({}, estate)
const entraEstate = {
  id: 'entra',
  tenantId: '11111111-1111-4111-8111-111111111111',
  environment: 'production',
}
const entraRegistry = buildEstateRegistry({}, entraEstate)

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
      maxResponseBytes: 8_192,
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
        maxResponseBytes: 8_192,
      },
    })
  })

  describe('deployment Entra source projection', () => {
    it('projects a complete legacy tuple through the runtime resolver', () => {
      const [source] = buildDeploymentConnectorSources(
        {
          ENTRA_CONNECTOR_ENABLED: 'true',
          ENTRA_CONNECTOR_TENANT_ID: entraEstate.tenantId,
          ENTRA_CONNECTOR_ENVIRONMENT: entraEstate.environment,
        },
        entraRegistry,
        'live',
      )

      expect(source).toMatchObject({
        estateId: entraEstate.id,
        tenantId: entraEstate.tenantId,
        environment: entraEstate.environment,
        sourceId: 'entra-identity-primary',
        connectorType: 'entra-identity',
        enabled: true,
      })
    })

    it.each([
      ['tenant only', { ENTRA_CONNECTOR_TENANT_ID: estate.tenantId }],
      ['environment only', { ENTRA_CONNECTOR_ENVIRONMENT: estate.environment }],
    ])('rejects partial legacy tuples before projection: %s', (_label, environment) => {
      expect(() => buildDeploymentConnectorSources(environment, registry, 'live')).toThrow(
        'Legacy Entra configuration requires',
      )
    })

    it('hides inactive Entra sources and invalid configuration in mock mode', () => {
      expect(
        buildDeploymentConnectorSources(
          {
            ENTRA_CONNECTOR_ENABLED: 'true',
            ENTRA_SOURCES_JSON: JSON.stringify([
              {
                id: 'primary',
                name: 'Production Entra',
                tenantId: estate.tenantId,
                environment: estate.environment,
              },
            ]),
          },
          registry,
          'mock',
        ),
      ).toEqual([])
      expect(
        buildDeploymentConnectorSources(
          {
            ENTRA_CONNECTOR_ENABLED: 'true',
            ENTRA_SOURCES_JSON: '{invalid',
          },
          registry,
          'mock',
        ),
      ).toEqual([])
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
        AZURE_MONITOR_MAX_RESPONSE_BYTES: '2048',
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
        maxResponseBytes: 2_048,
      },
    })
  })

  it('omits an empty legacy tuple', () => {
    expect(buildDeploymentConnectorSources({}, registry, 'live')).toEqual([])
  })

  it.each([
    ['workspace only', { AZURE_MONITOR_WORKSPACE_ID: '11111111-1111-4111-8111-111111111111' }],
    ['tenant only', { AZURE_MONITOR_TENANT_ID: estate.tenantId }],
    ['environment only', { AZURE_MONITOR_ENVIRONMENT: estate.environment }],
    [
      'workspace and tenant',
      {
        AZURE_MONITOR_SOURCES_JSON: '',
        AZURE_MONITOR_WORKSPACE_ID: '11111111-1111-4111-8111-111111111111',
        AZURE_MONITOR_TENANT_ID: estate.tenantId,
      },
    ],
    [
      'workspace and environment',
      {
        AZURE_MONITOR_WORKSPACE_ID: '11111111-1111-4111-8111-111111111111',
        AZURE_MONITOR_ENVIRONMENT: estate.environment,
      },
    ],
    [
      'tenant and environment',
      {
        AZURE_MONITOR_TENANT_ID: estate.tenantId,
        AZURE_MONITOR_ENVIRONMENT: estate.environment,
      },
    ],
  ])('rejects partial legacy configuration before projection: %s', (_label, environment) => {
    expect(() => buildDeploymentConnectorSources(environment, registry, 'live')).toThrow(
      AzureMonitorOtelConfigurationError,
    )
  })

  it('does not parse or project Azure Monitor configuration in mock mode', () => {
    expect(buildDeploymentConnectorSources(configuredEnvironment, registry, 'mock')).toEqual([])
    expect(
      buildDeploymentConnectorSources({ AZURE_MONITOR_SOURCES_JSON: '{invalid' }, registry, 'mock'),
    ).toEqual([])
    expect(
      buildDeploymentConnectorSources(
        {
          AZURE_MONITOR_WORKSPACE_ID: '11111111-1111-4111-8111-111111111111',
          AZURE_MONITOR_TENANT_ID: estate.tenantId,
        },
        registry,
        'mock',
      ),
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
