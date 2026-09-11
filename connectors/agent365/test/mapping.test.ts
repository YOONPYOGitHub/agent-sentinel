import { describe, expect, it } from 'vitest'

import {
  classifyAgent365Package,
  isAgentPackage,
  mapAgent365PackagesToSnapshot,
  mergeAgent365Snapshots,
  parseAgent365Config,
  type Agent365SourceConfig,
  type CopilotPackage,
} from '../src/index.js'

const source: Agent365SourceConfig = {
  id: 'tenant-a',
  name: 'Tenant A catalog',
  tenantId: '00000000-0000-0000-0000-000000000001',
  environment: 'production',
  graphBaseUrl: 'https://graph.microsoft.com',
  limits: {
    maxPages: 20,
    maxItems: 5_000,
    requestTimeoutMs: 15_000,
    maxRetries: 2,
    maxRetryAfterMs: 30_000,
    maxResponseBytes: 2_000_000,
  },
}

const agent: CopilotPackage = {
  id: 'P_agent',
  displayName: 'Sales assistant',
  type: 'custom',
  shortDescription: 'Catalog-declared sales agent.',
  isBlocked: false,
  supportedHosts: ['Copilot', 'Teams'],
  lastModifiedDateTime: '2026-08-20T10:00:00Z',
  publisher: 'Contoso',
  availableTo: 'some',
  deployedTo: 'all',
  elementTypes: ['declarativeAgent'],
  platform: 'teams',
  version: '1.2.3',
  manifestVersion: '2.0',
  manifestId: 'manifest-sales',
  appId: '00000000-0000-0000-0000-000000000000',
  assetId: 'asset-sales',
}

const extension: CopilotPackage = {
  id: 'P_extension',
  displayName: 'Document uploader',
  type: 'external',
  supportedHosts: ['Word', 'Excel'],
  elementTypes: ['officeAddIn'],
  platform: 'web',
}

describe('Agent 365 package mapping', () => {
  it('classifies documented agent signals but keeps non-agent extensions honest', () => {
    expect(isAgentPackage(agent)).toBe(true)
    expect(
      isAgentPackage({
        id: 'P_bot',
        displayName: 'Bot package',
        elementTypes: ['Bots'],
      }),
    ).toBe(true)
    expect(isAgentPackage(extension)).toBe(false)
    const snapshot = mapAgent365PackagesToSnapshot(
      [extension, agent],
      source,
      '2026-08-28T00:00:00Z',
    )
    const agentNode = snapshot.nodes.find((node) => node.name === agent.displayName)!
    const extensionNode = snapshot.nodes.find((node) => node.name === extension.displayName)!
    expect(agentNode.kind).toBe('agent')
    expect(agentNode.metadata).toMatchObject({
      inventoryEntityType: 'agent-package',
      providerPackageId: 'P_agent',
      packageType: 'custom',
      packagePlatform: 'teams',
      supportedHosts: '["Copilot","Teams"]',
      elementTypes: '["declarativeAgent"]',
      packageStatus: 'unblocked',
      providerApplicationId: agent.appId,
      sourceConnectorId: source.id,
      sourceTenantId: source.tenantId,
      sourceEnvironment: source.environment,
    })
    expect(extensionNode.kind).toBe('control')
    expect(extensionNode.metadata['inventoryEntityType']).toBe('extension-package')
    expect(snapshot.edges).toEqual([])
  })

  it('classifies M365 and SharePoint declarative agents without classifying extensions', () => {
    expect(
      classifyAgent365Package({
        id: 'P_m365',
        displayName: 'M365 declarative agent',
        supportedHosts: ['M365'],
        elementTypes: ['DeclarativeAgent'],
      }),
    ).toEqual(['agent365-agent', 'm365-declarative-agent'])
    expect(
      classifyAgent365Package({
        id: 'P_sharepoint',
        displayName: 'SharePoint declarative agent',
        supportedHosts: ['sharePoint'],
        elementTypes: ['declarativeAgent'],
      }),
    ).toEqual(['agent365-agent', 'sharepoint-declarative-agent'])
    expect(classifyAgent365Package(extension)).toEqual(['extension-package'])

    const snapshot = mapAgent365PackagesToSnapshot(
      [
        {
          id: 'P_m365',
          displayName: 'M365 declarative agent',
          supportedHosts: ['M365'],
          elementTypes: ['DeclarativeAgent'],
        },
      ],
      source,
      '2026-09-09T00:00:00Z',
    )
    expect(snapshot.nodes[0]).toMatchObject({
      kind: 'agent',
      metadata: {
        inventoryEntityType: 'agent-package',
        packageClassifications: '["agent365-agent","m365-declarative-agent"]',
      },
    })
  })

  it('does not infer trust, tools, identity, entitlements, access, private principals, or edges', () => {
    const snapshot = mapAgent365PackagesToSnapshot([agent], source)
    const node = snapshot.nodes[0]!
    expect(node).not.toHaveProperty('trust')
    expect(node).not.toHaveProperty('owner')
    expect(node).not.toHaveProperty('sensitivity')
    expect(Object.keys(node.metadata)).not.toContain('tools')
    expect(Object.keys(node.metadata)).not.toContain('identity')
    expect(Object.keys(node.metadata)).not.toContain('allowedUsersAndGroups')
    expect(Object.keys(node.metadata)).not.toContain('acquireUsersAndGroups')
    expect(snapshot.edges).toHaveLength(0)
    expect(snapshot.evidence[0]).toMatchObject({ confidence: 1, freshness: 'live' })
    expect(snapshot.evidence[0]?.summary).toContain(
      'runtime behavior, trust, tools, identity, entitlement, and access are not inferred',
    )
  })

  it('produces deterministic source-namespaced IDs and never deduplicates display names', () => {
    const left = mapAgent365PackagesToSnapshot([agent], source, '2026-08-28T00:00:00Z')
    const repeated = mapAgent365PackagesToSnapshot([agent], source, '2026-08-28T01:00:00Z')
    const otherSource = { ...source, id: 'tenant-b', name: 'Tenant B' }
    const right = mapAgent365PackagesToSnapshot(
      [{ ...agent, id: agent.id, displayName: agent.displayName }],
      otherSource,
      '2026-08-28T00:00:00Z',
    )
    expect(left.nodes[0]?.id).toBe(repeated.nodes[0]?.id)
    expect(left.nodes[0]?.id).not.toBe(right.nodes[0]?.id)

    const merged = mergeAgent365Snapshots(left, [{ source: otherSource, snapshot: right }])
    expect(merged.nodes.filter((node) => node.name === agent.displayName)).toHaveLength(2)
    expect(new Set(merged.nodes.map((node) => node.id)).size).toBe(2)
  })

  it('rejects duplicate provider IDs', () => {
    expect(() => mapAgent365PackagesToSnapshot([agent, agent], source)).toThrow(
      'duplicate package identifier',
    )
  })
})

describe('Agent 365 configuration', () => {
  it('supports legacy primary source settings and bounded defaults', () => {
    const config = parseAgent365Config({
      AGENT365_TENANT_ID: source.tenantId,
      AGENT365_ENVIRONMENT: source.environment,
    })
    expect(config.graphBaseUrl).toBe('https://graph.microsoft.com')
    expect(config.sources).toHaveLength(1)
    expect(config.sources[0]).toMatchObject({
      id: 'primary',
      name: 'Primary Microsoft Agent 365 tenant',
      tenantId: source.tenantId,
      environment: source.environment,
      graphBaseUrl: 'https://graph.microsoft.com',
    })
    expect(config.sources[0]?.limits).toMatchObject({
      maxPages: 20,
      maxItems: 5_000,
    })
    expect(config.limits.maxItems).toBe(5_000)
    expect(config.aggregation).toEqual({
      maxConcurrency: 2,
      maxDurationMs: 60_000,
    })
  })

  it('parses bounded aggregate concurrency and duration', () => {
    const config = parseAgent365Config({
      AGENT365_TENANT_ID: source.tenantId,
      AGENT365_ENVIRONMENT: source.environment,
      AGENT365_MAX_CONCURRENCY: '1',
      AGENT365_MAX_DURATION_MS: '5000',
    })

    expect(config.aggregation).toEqual({
      maxConcurrency: 1,
      maxDurationMs: 5_000,
    })
  })

  it('enforces the same strict retry-after bound for environment configuration', () => {
    expect(
      parseAgent365Config({
        AGENT365_TENANT_ID: source.tenantId,
        AGENT365_ENVIRONMENT: source.environment,
        AGENT365_MAX_RETRY_AFTER_MS: '60000',
      }).limits.maxRetryAfterMs,
    ).toBe(60_000)
    expect(() =>
      parseAgent365Config({
        AGENT365_TENANT_ID: source.tenantId,
        AGENT365_ENVIRONMENT: source.environment,
        AGENT365_MAX_RETRY_AFTER_MS: '60001',
      }),
    ).toThrow()
  })

  it('accepts explicit managed identity and per-source execution limits', () => {
    const config = parseAgent365Config({
      AGENT365_SOURCES_JSON: JSON.stringify([
        {
          id: 'persisted',
          name: 'Persisted Agent 365',
          tenantId: source.tenantId,
          environment: source.environment,
          graphBaseUrl: 'https://graph.microsoft.com',
          limits: {
            maxPages: 3,
            maxItems: 500,
            requestTimeoutMs: 5_000,
            maxRetries: 1,
            maxRetryAfterMs: 1_000,
            maxResponseBytes: 50_000,
          },
          credential: {
            mode: 'managed-identity',
            managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
          },
        },
      ]),
    })

    expect(config.sources[0]).toMatchObject({
      graphBaseUrl: 'https://graph.microsoft.com',
      limits: { maxPages: 3, maxItems: 500 },
      credential: {
        mode: 'managed-identity',
        managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
      },
    })
  })

  it('accepts up to 50 independent secretless sources and non-versioned Azure GUIDs', () => {
    const sources = Array.from({ length: 50 }, (_, index) => ({
      id: `source-${index}`,
      name: `Source ${index}`,
      tenantId: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
      environment: `environment-${index}`,
      credential: {
        mode: 'federated-app' as const,
        clientId: '00000000-0000-0000-0000-000000000000',
        managedIdentityClientId: '11111111-1111-1111-1111-111111111111',
      },
    }))
    expect(
      parseAgent365Config({ AGENT365_SOURCES_JSON: JSON.stringify(sources) }).sources,
    ).toHaveLength(50)
  })

  it('rejects duplicate ids, duplicate boundaries, secrets, and more than 50 sources', () => {
    const base = {
      id: 'source-a',
      name: 'Source A',
      tenantId: source.tenantId,
      environment: source.environment,
    }
    for (const sources of [
      [base, { ...base, tenantId: '00000000-0000-0000-0000-000000000002' }],
      [base, { ...base, id: 'source-b', environment: 'other-environment' }],
      [{ ...base, clientSecret: 'must-not-be-supported' }],
      Array.from({ length: 51 }, (_, index) => ({
        ...base,
        id: `source-${index}`,
        environment: `env-${index}`,
      })),
    ]) {
      expect(() =>
        parseAgent365Config({ AGENT365_SOURCES_JSON: JSON.stringify(sources) }),
      ).toThrow()
    }
  })
})
