import { AzureMonitorOtelConfigurationError } from '@agent-sentinel/azure-monitor-otel-connector'
import { buildDeploymentConnectorSources } from '@agent-sentinel/connector-runtime'
import { describe, expect, it } from 'vitest'

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
      sourceProjectId: 'primary',
      environment: estate.environment,
      maxResponseBytes: 8_192,
    },
  ]),
}

describe('deployment Azure Monitor OTel source projection', () => {
  it('projects immutable Agent 365 sources with exact workload identity and limits', () => {
    const [source] = buildDeploymentConnectorSources(
      {
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_SOURCES_JSON: JSON.stringify([
          {
            id: 'live',
            name: 'Live Agent 365',
            tenantId: entraEstate.tenantId,
            environment: entraEstate.environment,
            limits: {
              maxPages: 4,
              maxItems: 600,
              requestTimeoutMs: 6_000,
              maxRetries: 1,
              maxRetryAfterMs: 2_000,
              maxResponseBytes: 60_000,
            },
          },
        ]),
        AGENT365_MANAGED_IDENTITY_CLIENT_ID: '59dbea72-1e91-403a-89cf-e02cdb8da350',
        AGENT365_MAX_CONCURRENCY: '1',
        AGENT365_MAX_DURATION_MS: '5000',
      },
      entraRegistry,
      'live',
    )

    expect(source).toMatchObject({
      sourceId: 'agent365-live',
      runtimeBinding: {
        bindingSourceId: 'live',
      },
      connectorType: 'agent365',
      enabled: true,
      origin: 'deployment',
      credential: {
        mode: 'managed-identity',
        managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
      },
      configuration: {
        type: 'agent365',
        graphBaseUrl: 'https://graph.microsoft.com',
        aggregation: {
          maxConcurrency: 1,
          maxDurationMs: 5_000,
        },
        limits: {
          maxPages: 4,
          maxItems: 600,
          requestTimeoutMs: 6_000,
          maxRetries: 1,
          maxRetryAfterMs: 2_000,
          maxResponseBytes: 60_000,
        },
      },
    })
  })

  it('rejects ambient AZURE_CLIENT_ID as Agent 365 federation metadata', () => {
    expect(() =>
      buildDeploymentConnectorSources(
        {
          AZURE_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
          AGENT365_CONNECTOR_ENABLED: 'true',
          AGENT365_SOURCES_JSON: JSON.stringify([
            {
              id: 'federated',
              name: 'Federated Agent 365',
              tenantId: entraEstate.tenantId,
              environment: entraEstate.environment,
              credential: {
                mode: 'federated-app',
                clientId: '22222222-2222-4222-8222-222222222222',
              },
            },
          ]),
        },
        entraRegistry,
        'live',
      ),
    ).toThrow('managedIdentityClientId')
  })

  it('projects legacy Agent 365 deployment ownership without ambient identity activation', () => {
    const [projected] = buildDeploymentConnectorSources(
      {
        AZURE_CLIENT_ID: '11111111-1111-4111-8111-111111111111',
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_TENANT_ID: entraEstate.tenantId,
        AGENT365_ENVIRONMENT: entraEstate.environment,
      },
      entraRegistry,
      'live',
    )

    expect(projected).toMatchObject({
      sourceId: 'agent365-primary',
      runtimeBinding: {
        bindingSourceId: 'primary',
      },
      connectorType: 'agent365',
      enabled: true,
      origin: 'deployment',
      credential: { mode: 'default' },
    })
  })

  it('projects legacy Agent 365 deployment with its explicit managed identity', () => {
    const [projected] = buildDeploymentConnectorSources(
      {
        AGENT365_CONNECTOR_ENABLED: 'true',
        AGENT365_TENANT_ID: entraEstate.tenantId,
        AGENT365_ENVIRONMENT: entraEstate.environment,
        AGENT365_MANAGED_IDENTITY_CLIENT_ID: '59dbea72-1e91-403a-89cf-e02cdb8da350',
      },
      entraRegistry,
      'live',
    )

    expect(projected?.credential).toEqual({
      mode: 'managed-identity',
      managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
    })
  })

  it('rejects enabled Agent 365 deployment without a source boundary', () => {
    expect(() =>
      buildDeploymentConnectorSources(
        {
          AGENT365_CONNECTOR_ENABLED: 'true',
          AGENT365_SOURCES_JSON: ' ',
          AGENT365_TENANT_ID: ' ',
          AGENT365_ENVIRONMENT: ' ',
        },
        entraRegistry,
        'live',
      ),
    ).toThrow(
      'AGENT365_TENANT_ID and AGENT365_ENVIRONMENT are required when no source JSON is supplied.',
    )
  })

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

  it('projects cross-tenant Foundry sources under the portfolio estate boundary', () => {
    const sources = buildDeploymentConnectorSources(
      {
        AGENT_SENTINEL_CONNECTOR: 'foundry',
        AGENT_SENTINEL_TENANT_ID: estate.tenantId,
        AGENT_SENTINEL_ENVIRONMENT: estate.environment,
        FOUNDRY_ENVIRONMENT: estate.environment,
        FOUNDRY_SOURCES_JSON: JSON.stringify([
          {
            id: 'external-project',
            name: 'External Foundry project',
            projectEndpoint: 'https://external.services.ai.azure.com/api/projects/provider-project',
            tenantId: 'tenant-provider',
            environment: 'provider-production',
          },
        ]),
      },
      registry,
      'live',
    )
    const source = sources.find((candidate) => candidate.sourceId === 'foundry-external-project')

    expect(source).toMatchObject({
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      sourceId: 'foundry-external-project',
      connectorType: 'foundry',
      origin: 'deployment',
      configuration: {
        type: 'foundry',
        projectEndpoint: 'https://external.services.ai.azure.com/api/projects/provider-project',
        sourceTenantId: 'tenant-provider',
        sourceEnvironment: 'provider-production',
        sourceProjectId: 'provider-project',
      },
    })
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
        sourceProjectId: 'primary',
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
        FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/primary',
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
        sourceProjectId: 'primary',
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
