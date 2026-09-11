import { afterEach, describe, expect, it, vi } from 'vitest'

import { connectorSourcesApi, connectorsApi } from './connectors-api'

afterEach(() => {
  vi.unstubAllGlobals()
})

const validResponse = {
  active: {
    id: 'mock-agent-estate',
    mode: 'mock',
    source: 'mock',
    lifecycleState: 'connected',
    writeEnabled: true,
  },
  catalog: [
    {
      id: 'azure-ai-foundry',
      name: 'Azure AI Foundry',
      description: 'Discovers agents.',
      lifecycleState: 'available-to-configure',
      capabilities: ['discovery'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
    },
    {
      id: 'm365-agent-registry',
      name: 'Microsoft Agent 365',
      description: 'Authoritative registry.',
      lifecycleState: 'authorization-required',
      capabilities: ['discovery', 'identity'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
    },
  ],
}

describe('connectorsApi', () => {
  it('parses a valid collection response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(validResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const result = await connectorsApi.listConnectors()
    expect(result.active.mode).toBe('mock')
    expect(result.catalog).toHaveLength(2)
    expect(result.catalog[0]?.id).toBe('azure-ai-foundry')
  })

  const source = {
    estateId: 'estate-one',
    tenantId: 'tenant-one',
    environment: 'production',
    sourceId: 'primary',
    connectorType: 'foundry',
    displayName: 'Primary Foundry',
    enabled: true,
    origin: 'user',
    configuration: {
      type: 'foundry',
      projectEndpoint: 'https://safe.services.ai.azure.com/api/projects/primary',
    },
    credential: { mode: 'default' },
    testStatus: { status: 'not-tested' },
    version: 1,
    etag: 'etag-one',
    createdBy: { type: 'user', id: 'administrator-object-id' },
    updatedBy: { type: 'user', id: 'administrator-object-id' },
    createdAt: '2026-09-06T04:00:00.000Z',
    updatedAt: '2026-09-06T04:00:00.000Z',
  } as const

  describe('connectorSourcesApi', () => {
    it('parses an estate-scoped source page and mutation policy', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [source],
            page: { limit: 50, nextCursor: null },
            mutationPolicy: {
              enabled: true,
              requiresAuthentication: true,
              requiredCapability: 'configure',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      vi.stubGlobal('fetch', fetchMock)

      const result = await connectorSourcesApi.list()

      expect(result.items[0]?.sourceId).toBe('primary')
      expect(result.mutationPolicy.enabled).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/connector-sources?limit=50')
      expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers)).toBeInstanceOf(Headers)
    })

    it('parses an inactive migration-required legacy Azure Monitor source', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(
            JSON.stringify({
              items: [
                {
                  ...source,
                  sourceId: 'azure-monitor-primary',
                  connectorType: 'azure-monitor-otel',
                  displayName: 'Legacy runtime telemetry',
                  enabled: false,
                  configuration: {
                    type: 'azure-monitor-otel',
                    workspaceId: '11111111-1111-4111-8111-111111111111',
                    logsBaseUrl: 'https://api.loganalytics.io',
                    baselineWindowHours: 168,
                    observedWindowHours: 24,
                    requestTimeoutMs: 15_000,
                    maxResponseBytes: 4_194_304,
                  },
                  migration: {
                    status: 'migration-required',
                    active: false,
                    reason: 'missing-source-project-id',
                    action: 'supply-exact-source-project-id',
                  },
                },
              ],
              page: { limit: 50, nextCursor: null },
              mutationPolicy: {
                enabled: true,
                requiresAuthentication: true,
                requiredCapability: 'configure',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      )

      const result = await connectorSourcesApi.list()

      expect(result.items[0]).toMatchObject({
        sourceId: 'azure-monitor-primary',
        enabled: false,
        migration: { status: 'migration-required', active: false },
      })
    })

    it('sends idempotency and concurrency headers for create, update, and delete', async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ replayed: false, source, audit: null }), {
            status: 201,
            headers: { 'Content-Type': 'application/json', ETag: '"etag-one"' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              replayed: false,
              source: { ...source, displayName: 'Updated', etag: 'etag-two', version: 2 },
              audit: null,
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json', ETag: '"etag-two"' },
            },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ replayed: false, source: null, audit: null }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      vi.stubGlobal('fetch', fetchMock)

      await connectorSourcesApi.create(
        {
          sourceId: 'primary',
          connectorType: 'foundry',
          displayName: 'Primary Foundry',
          enabled: true,
          configuration: source.configuration,
          credential: { mode: 'default' },
        },
        'create-primary',
      )
      await connectorSourcesApi.update(
        'primary',
        { displayName: 'Updated' },
        'etag-one',
        'update-primary',
      )
      await connectorSourcesApi.delete('primary', 'etag-two', 'delete-primary')

      const createHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
      const updateHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers)
      const deleteHeaders = new Headers(fetchMock.mock.calls[2]?.[1]?.headers)
      expect(createHeaders.get('idempotency-key')).toBe('create-primary')
      expect(updateHeaders.get('if-match')).toBe('"etag-one"')
      expect(updateHeaders.get('idempotency-key')).toBe('update-primary')
      expect(deleteHeaders.get('if-match')).toBe('"etag-two"')
      expect(deleteHeaders.get('idempotency-key')).toBe('delete-primary')
    })

    it('round-trips Agent 365 aggregation fields through list and create payloads', async () => {
      const agent365Source = {
        ...source,
        sourceId: 'agent365-live',
        connectorType: 'agent365',
        displayName: 'Live Agent 365',
        configuration: {
          type: 'agent365',
          graphBaseUrl: 'https://graph.microsoft.com',
          limits: {
            maxPages: 20,
            maxItems: 5_000,
            requestTimeoutMs: 15_000,
            maxRetries: 2,
            maxRetryAfterMs: 30_000,
            maxResponseBytes: 2_000_000,
          },
          aggregation: {
            maxConcurrency: 4,
            maxDurationMs: 120_000,
          },
        },
      } as const
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              items: [agent365Source],
              page: { limit: 50, nextCursor: null },
              mutationPolicy: {
                enabled: true,
                requiresAuthentication: true,
                requiredCapability: 'configure',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ replayed: false, source: agent365Source, audit: null }), {
            status: 201,
            headers: { 'Content-Type': 'application/json', ETag: '"etag-one"' },
          }),
        )
      vi.stubGlobal('fetch', fetchMock)

      const page = await connectorSourcesApi.list()
      const listed = page.items[0]!
      if (listed.configuration.type !== 'agent365') {
        throw new Error('Expected the listed Agent 365 source configuration.')
      }
      await connectorSourcesApi.create(
        {
          sourceId: listed.sourceId,
          connectorType: listed.connectorType,
          displayName: listed.displayName,
          enabled: listed.enabled,
          configuration: listed.configuration,
          credential: listed.credential,
        },
        'create-agent365-live',
      )

      expect(listed.configuration).toMatchObject({
        type: 'agent365',
        aggregation: {
          maxConcurrency: 4,
          maxDurationMs: 120_000,
        },
      })
      const requestBody = fetchMock.mock.calls[1]?.[1]?.body
      if (typeof requestBody !== 'string') {
        throw new Error('Expected the create request body to be serialized JSON.')
      }
      const payload: unknown = JSON.parse(requestBody)
      expect(payload).toMatchObject({
        configuration: {
          type: 'agent365',
          aggregation: {
            maxConcurrency: 4,
            maxDurationMs: 120_000,
          },
        },
      })
    })

    it('parses unknown connection evidence without manufacturing readiness', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(
            JSON.stringify({
              estateId: 'estate-one',
              tenantId: 'tenant-one',
              environment: 'production',
              sourceId: 'primary',
              connectorType: 'foundry',
              readOnly: true,
              status: 'unknown',
              evidenceAvailability: 'unavailable',
              evidenceBasis: null,
              evidenceIds: [],
              checkedAt: null,
              checkedBy: null,
              summary: 'No evidence-backed connection test has been recorded.',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      )

      const result = await connectorSourcesApi.getConnectionTestStatus('primary')
      expect(result).toMatchObject({
        readOnly: true,
        status: 'unknown',
        evidenceAvailability: 'unavailable',
      })
    })

    it('surfaces stale ETag conflicts with status and API code', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(
            JSON.stringify({
              error: 'etag_mismatch',
              message: 'The connector source changed. Refresh its ETag and retry.',
            }),
            { status: 412, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      )

      await expect(
        connectorSourcesApi.update(
          'primary',
          { displayName: 'Stale edit' },
          'old-etag',
          'update-stale',
        ),
      ).rejects.toMatchObject({ status: 412, code: 'etag_mismatch' })
    })
  })

  it('preserves per-source health and degraded lifecycle state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...validResponse,
            active: { ...validResponse.active, lifecycleState: 'degraded' },
            health: {
              overall: 'degraded',
              partial: true,
              sourceSetFingerprint: 'a'.repeat(64),
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
                  dataState: 'stale',
                  pages: 2,
                  records: 25,
                  checkedAt: '2026-09-09T00:00:00.000Z',
                  reason: 'authentication-or-access',
                  provenance: {
                    estateTenantId: 'tenant-a',
                    estateEnvironment: 'production',
                    sourceConnectorId: 'project-b',
                    sourceTenantId: 'tenant-b',
                    sourceEnvironment: 'production',
                    provider: 'microsoft-graph-agent365-package-catalog',
                    providerObjectId: '/v1.0/copilot/admin/catalog/packages',
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    const result = await connectorsApi.listConnectors()
    expect(result.active.lifecycleState).toBe('degraded')
    expect(result.health?.sources).toHaveLength(2)
    expect(result.health?.sourceSetFingerprint).toBe('a'.repeat(64))
    expect(result.health?.sources[1]).toMatchObject({
      dataState: 'stale',
      pages: 2,
      records: 25,
      checkedAt: '2026-09-09T00:00:00.000Z',
      provenance: {
        sourceConnectorId: 'project-b',
        provider: 'microsoft-graph-agent365-package-catalog',
      },
    })
  })

  it('rejects an invalid lifecycle state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...validResponse,
            catalog: [{ ...validResponse.catalog[0], lifecycleState: 'not-a-real-state' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    await expect(connectorsApi.listConnectors()).rejects.toThrow()
  })

  it('surfaces the API error message on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Service unavailable.' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    await expect(connectorsApi.listConnectors()).rejects.toThrow('Service unavailable.')
  })

  it('defaults writeEnabled to false when omitted', async () => {
    const withoutWrite = {
      ...validResponse,
      active: { ...validResponse.active, writeEnabled: undefined },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(withoutWrite), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const result = await connectorsApi.listConnectors()
    expect(result.active.writeEnabled).toBe(false)
  })
})
