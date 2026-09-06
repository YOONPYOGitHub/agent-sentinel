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
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    const result = await connectorsApi.listConnectors()
    expect(result.active.lifecycleState).toBe('degraded')
    expect(result.health?.sources).toHaveLength(2)
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
