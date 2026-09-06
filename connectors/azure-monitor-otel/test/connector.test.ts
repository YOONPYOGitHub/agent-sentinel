import { readFile } from 'node:fs/promises'

import type { AccessToken, TokenCredential } from '@azure/core-auth'
import { describe, expect, it, vi } from 'vitest'

import {
  AzureMonitorOtelConnector,
  MultiAzureMonitorOtelConnector,
  azureMonitorOtelConfigSchema,
  buildAzureMonitorOtelQuery,
  createAzureMonitorOtelConnector,
  isAzureMonitorOtelRuntimeActive,
  mapAzureMonitorRows,
  parseAzureMonitorOtelSources,
  resolveAzureMonitorOtelRuntimeActivation,
} from '../src/index.js'

const columns = [
  ['ObservationId', 'string'],
  ['ObservedAt', 'datetime'],
  ['TenantId', 'string'],
  ['AgentId', 'string'],
  ['Environment', 'string'],
  ['AgentRunId', 'string'],
  ['CorrelationId', 'string'],
  ['AgentVersion', 'string'],
  ['LatencyMs', 'long'],
  ['InputTokens', 'long'],
  ['OutputTokens', 'long'],
  ['CostUsd', 'real'],
  ['Success', 'bool'],
  ['ErrorCode', 'string'],
  ['ToolCallNames', 'string'],
  ['Synthetic', 'bool'],
].map(([name, type]) => ({ name, type }))

class Credential implements TokenCredential {
  getToken(): Promise<AccessToken> {
    return Promise.resolve({ token: 'test-token', expiresOnTimestamp: Date.now() + 60_000 })
  }
}

const config = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-a',
  environment: 'production',
  baselineWindowHours: 24,
  observedWindowHours: 24,
}

function row(
  id: string,
  observedAt: string,
  index: number,
  tenantId = 'tenant-a',
  agentId = 'agent-a',
  environment = 'production',
): unknown[] {
  return [
    id,
    observedAt,
    tenantId,
    agentId,
    environment,
    `run-${id}`.slice(0, 200),
    `correlation-${id}`.slice(0, 200),
    '17',
    800 + index,
    300 + index,
    100 + index,
    0.01 + index / 10_000,
    true,
    '',
    '["knowledge_search","answer"]',
    false,
  ]
}

describe('Azure Monitor OTel connector', () => {
  it('strictly validates the checked-in local Azure Monitor fixture', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/azure-monitor-query.json', import.meta.url), 'utf8'),
    ) as unknown
    const observations = mapAzureMonitorRows(fixture, {
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      environment: 'production',
      windowStart: '2026-08-22T12:00:00.000Z',
      windowEnd: '2026-08-24T12:00:00.000Z',
    })

    expect(observations).toHaveLength(4)
    expect(observations[0]).toMatchObject({
      source: 'azure-monitor-otel',
      latencyMs: 820,
      inputTokens: 320,
      outputTokens: 110,
      costUsd: 0.012,
      success: true,
      toolCallNames: ['knowledge_search', 'answer'],
      synthetic: false,
      correlations: [
        { kind: 'agent-run-id', value: 'run-baseline-1' },
        { kind: 'correlation-id', value: 'correlation-baseline-1' },
        { kind: 'agent-version', value: '17' },
      ],
    })
    expect(observations[1]).toMatchObject({
      success: false,
      errorCode: 'timeout',
      toolCallNames: ['knowledge_search'],
      synthetic: true,
      correlations: [
        { kind: 'correlation-id', value: 'operation-baseline-2' },
        { kind: 'agent-version', value: '17' },
      ],
    })
    expect(observations[1]?.costUsd).toBeUndefined()
  })

  it('rejects mismatched row bindings, time ranges, malformed tools, and columns', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/azure-monitor-query.json', import.meta.url), 'utf8'),
    ) as { tables: Array<{ columns: Array<{ name: string; type: string }>; rows: unknown[][] }> }
    const binding = {
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      environment: 'production',
      windowStart: '2026-08-22T12:00:00.000Z',
      windowEnd: '2026-08-24T12:00:00.000Z',
    }

    for (const [columnIndex, invalidValue] of [
      [2, 'tenant-b'],
      [3, 'agent-b'],
      [4, 'staging'],
      [1, '2026-08-25T00:00:00.000Z'],
    ] as const) {
      const mismatched = structuredClone(fixture)
      mismatched.tables[0]!.rows[0]![columnIndex] = invalidValue
      expect(() => mapAzureMonitorRows(mismatched, binding)).toThrow(/does not match/)
    }

    const malformedTools = structuredClone(fixture)
    malformedTools.tables[0]!.rows[0]![14] = '{"tool":"not-an-array"}'
    expect(() => mapAzureMonitorRows(malformedTools, binding)).toThrow()

    const unexpectedColumn = structuredClone(fixture)
    unexpectedColumn.tables[0]!.columns[0]!.name = 'Wrong'
    expect(() => mapAzureMonitorRows(unexpectedColumn, binding)).toThrow(/column 0/)
  })

  it('uses one bounded fixed read-only query and splits mapped rows into windows', async () => {
    const baselineRows = Array.from({ length: 10 }, (_, index) =>
      row(`baseline-${index}`, `2026-08-23T${String(index).padStart(2, '0')}:00:00.000Z`, index),
    )
    const observedRows = Array.from({ length: 10 }, (_, index) =>
      row(`observed-${index}`, `2026-08-24T${String(index).padStart(2, '0')}:00:00.000Z`, index),
    )
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        tables: [{ name: 'PrimaryResult', columns, rows: [...baselineRows, ...observedRows] }],
      }),
    )
    const connector = new AzureMonitorOtelConnector(
      config,
      new Credential(),
      fetcher,
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    const result = await connector.readObservationWindows({
      tenantId: 'tenant-a',
      agentId: 'agent-a',
    })

    expect(result.baseline.observations).toHaveLength(10)
    expect(result.observed.observations).toHaveLength(10)
    expect(result.baseline.source).toBe('azure-monitor-otel')
    expect(result.observedEvidenceId).toMatch(/^otel-observed-/)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBeInstanceOf(URL)
    if (!(url instanceof URL)) throw new Error('Expected the connector to call a URL.')
    expect(url.toString()).toBe(
      'https://api.loganalytics.io/v1/workspaces/11111111-1111-4111-8111-111111111111/query',
    )
    expect(init?.method).toBe('POST')
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.')
    const body = JSON.parse(init.body) as { query: string; timespan: string }
    expect(body.query).toMatch(/^AppRequests\n/)
    expect(body.query).toContain('| take 10001')
    expect(body.query).toContain('CorrelationId')
    expect(body.query).toContain('OperationId')
    expect(body.query).not.toMatch(/\b(delete|drop|set|ingest)\b/i)
    expect(body.timespan).toBe('2026-08-22T12:00:00.000Z/2026-08-24T12:00:00.000Z')
  })

  it('stabilizes evidence IDs within a five-minute query window', async () => {
    let now = new Date('2026-08-24T12:01:15.000Z')
    let rows: unknown[][] = []
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ tables: [{ name: 'PrimaryResult', columns, rows }] })),
      )
    const connector = new AzureMonitorOtelConnector(config, new Credential(), fetcher, () => now)

    const first = await connector.readObservationWindows({
      tenantId: 'tenant-a',
      agentId: 'agent-a',
    })
    now = new Date('2026-08-24T12:04:59.000Z')
    const second = await connector.readObservationWindows({
      tenantId: 'tenant-a',
      agentId: 'agent-a',
    })
    rows = [row('late-observation', '2026-08-24T11:59:00.000Z', 1)]
    const lateArrival = await connector.readObservationWindows({
      tenantId: 'tenant-a',
      agentId: 'agent-a',
    })

    expect(second.baselineEvidenceId).toBe(first.baselineEvidenceId)
    expect(second.observedEvidenceId).toBe(first.observedEvidenceId)
    expect(lateArrival.baselineEvidenceId).toBe(first.baselineEvidenceId)
    expect(lateArrival.observedEvidenceId).not.toBe(first.observedEvidenceId)
    expect(first.observed.windowEnd).toBe('2026-08-24T12:00:00.000Z')
    for (const call of fetcher.mock.calls) {
      const init = call[1]
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.')
      const body = JSON.parse(init.body) as { timespan: string }
      expect(body.timespan).toBe('2026-08-22T12:00:00.000Z/2026-08-24T12:00:00.000Z')
    }
  })

  it('hashes observation content independently of row order and locale collation', async () => {
    let rows = [row('é', '2026-08-24T11:58:00.000Z', 1), row('é', '2026-08-24T11:59:00.000Z', 2)]
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ tables: [{ name: 'PrimaryResult', columns, rows }] })),
      )
    const connector = new AzureMonitorOtelConnector(
      config,
      new Credential(),
      fetcher,
      () => new Date('2026-08-24T12:01:00.000Z'),
    )

    const first = await connector.readObservationWindows({
      tenantId: 'tenant-a',
      agentId: 'agent-a',
    })
    rows = [...rows].reverse()
    const reversed = await connector.readObservationWindows({
      tenantId: 'tenant-a',
      agentId: 'agent-a',
    })

    expect(reversed.observedEvidenceId).toBe(first.observedEvidenceId)
  })

  it('activates a complete legacy source in live mode and ignores empty or partial tuples', () => {
    expect(createAzureMonitorOtelConnector({}, new Credential())).toBeUndefined()
    expect(
      createAzureMonitorOtelConnector(
        { AZURE_MONITOR_WORKSPACE_ID: config.workspaceId },
        new Credential(),
      ),
    ).toBeUndefined()
    expect(
      createAzureMonitorOtelConnector(
        {
          AZURE_MONITOR_WORKSPACE_ID: config.workspaceId,
          AZURE_MONITOR_TENANT_ID: config.tenantId,
          AZURE_MONITOR_ENVIRONMENT: config.environment,
        },
        new Credential(),
      ),
    ).toBeInstanceOf(MultiAzureMonitorOtelConnector)
    expect(
      resolveAzureMonitorOtelRuntimeActivation(
        {
          AZURE_MONITOR_SOURCES_JSON: '   ',
          AZURE_MONITOR_WORKSPACE_ID: config.workspaceId,
          AZURE_MONITOR_TENANT_ID: config.tenantId,
          AZURE_MONITOR_ENVIRONMENT: config.environment,
        },
        'live',
      ),
    ).toMatchObject({
      active: true,
      sources: [
        {
          id: 'primary',
          name: 'Primary Foundry project',
          workspaceId: config.workspaceId,
          tenantId: config.tenantId,
          environment: config.environment,
          baselineWindowHours: 168,
          observedWindowHours: 24,
          requestTimeoutMs: 15_000,
        },
      ],
    })
    expect(
      resolveAzureMonitorOtelRuntimeActivation(
        {
          AZURE_MONITOR_WORKSPACE_ID: config.workspaceId,
          AZURE_MONITOR_TENANT_ID: '   ',
        },
        'live',
      ),
    ).toEqual({ active: false, sources: [] })
    expect(resolveAzureMonitorOtelRuntimeActivation({}, 'live')).toEqual({
      active: false,
      sources: [],
    })
  })

  it('gives non-empty JSON precedence over the legacy tuple and release flags', () => {
    const activation = resolveAzureMonitorOtelRuntimeActivation(
      {
        AZURE_MONITOR_CONNECTOR_ENABLED: 'false',
        AZURE_MONITOR_OTEL_CONNECTOR_ENABLED: 'false',
        AZURE_MONITOR_SOURCES_JSON: JSON.stringify([
          {
            id: 'project-a',
            name: 'Project A',
            workspaceId: config.workspaceId,
            tenantId: config.tenantId,
            environment: config.environment,
          },
        ]),
        AZURE_MONITOR_WORKSPACE_ID: 'not-a-workspace-guid',
        AZURE_MONITOR_TENANT_ID: 'wrong-tenant',
        AZURE_MONITOR_ENVIRONMENT: 'wrong-environment',
      },
      'live',
    )

    expect(activation.active).toBe(true)
    expect(activation.sources).toMatchObject([
      {
        id: 'project-a',
        workspaceId: config.workspaceId,
        tenantId: config.tenantId,
        environment: config.environment,
      },
    ])
    expect(
      createAzureMonitorOtelConnector(
        {
          AZURE_MONITOR_SOURCES_JSON: JSON.stringify([
            {
              id: 'project-a',
              name: 'Project A',
              workspaceId: config.workspaceId,
              tenantId: config.tenantId,
              environment: config.environment,
            },
          ]),
        },
        new Credential(),
        'live',
      ),
    ).toBeInstanceOf(MultiAzureMonitorOtelConnector)
  })

  it('uses live mode and parsed sources as the runtime activation predicate', () => {
    const sourceEnvironment = {
      AZURE_MONITOR_SOURCES_JSON: JSON.stringify([
        {
          id: 'project-a',
          name: 'Project A',
          workspaceId: config.workspaceId,
          tenantId: config.tenantId,
          environment: config.environment,
        },
      ]),
    }
    const sources = parseAzureMonitorOtelSources(sourceEnvironment)
    expect(isAzureMonitorOtelRuntimeActive('live', sources)).toBe(true)
    expect(isAzureMonitorOtelRuntimeActive('mock', sources)).toBe(false)
    expect(isAzureMonitorOtelRuntimeActive('live', [])).toBe(false)
    expect(
      resolveAzureMonitorOtelRuntimeActivation({ AZURE_MONITOR_SOURCES_JSON: '{invalid' }, 'mock'),
    ).toEqual({ active: false, sources: [] })
    expect(
      createAzureMonitorOtelConnector(sourceEnvironment, new Credential(), 'mock'),
    ).toBeUndefined()
    expect(
      createAzureMonitorOtelConnector(
        { AZURE_MONITOR_SOURCES_JSON: '{invalid' },
        new Credential(),
        'mock',
      ),
    ).toBeUndefined()
    expect(() =>
      createAzureMonitorOtelConnector(
        { AZURE_MONITOR_SOURCES_JSON: '{invalid' },
        new Credential(),
        'live',
      ),
    ).toThrow('AZURE_MONITOR_SOURCES_JSON must be valid JSON')
  })

  it('routes aggregate agents to their exact source workspace and rebinds results', async () => {
    const sources = [
      {
        id: 'project-a',
        name: 'Project A',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        tenantId: 'tenant-a',
        environment: 'production',
        baselineWindowHours: 24,
        observedWindowHours: 24,
        requestTimeoutMs: 15_000,
      },
      {
        id: 'project-b',
        name: 'Project B',
        workspaceId: '22222222-2222-4222-8222-222222222222',
        tenantId: 'tenant-b',
        environment: 'validation',
        baselineWindowHours: 24,
        observedWindowHours: 24,
        requestTimeoutMs: 15_000,
      },
    ]
    const fetchers = new Map(
      sources.map((source) => {
        const rows = [
          row(
            `${source.id}-baseline`,
            '2026-08-23T12:00:00.000Z',
            0,
            source.tenantId,
            `provider-${source.id}`,
            source.environment,
          ),
          row(
            source.id === 'project-b' ? 'x'.repeat(200) : `${source.id}-observed`,
            '2026-08-24T01:00:00.000Z',
            1,
            source.tenantId,
            `provider-${source.id}`,
            source.environment,
          ),
        ]
        return [
          source.id,
          vi.fn<typeof fetch>().mockResolvedValue(
            Response.json({
              tables: [{ name: 'PrimaryResult', columns, rows }],
            }),
          ),
        ] as const
      }),
    )
    const connector = new MultiAzureMonitorOtelConnector(
      sources,
      () => new Credential(),
      (source) => fetchers.get(source.id)!,
      () => new Date('2026-08-24T12:00:00.000Z'),
    )
    const aggregateAgentId = 'foundry-source-project-b--foundry-agent-provider-project-b'
    const windows = await connector.readObservationWindows({
      tenantId: 'estate',
      agentId: aggregateAgentId,
      sourceConnectorId: 'project-b',
      sourceTenantId: 'tenant-b',
      sourceAgentId: 'provider-project-b',
      sourceEnvironment: 'validation',
    })

    expect(fetchers.get('project-a')).not.toHaveBeenCalled()
    expect(fetchers.get('project-b')).toHaveBeenCalledOnce()
    expect(windows.observed).toMatchObject({
      tenantId: 'estate',
      agentId: aggregateAgentId,
      environment: 'validation',
    })
    expect(windows.observed.observations[0]).toMatchObject({
      tenantId: 'estate',
      agentId: aggregateAgentId,
    })
    expect(windows.observed.observations[0]?.id.length).toBeLessThanOrEqual(200)
    expect(connector.getConnectorHealth()).toMatchObject({
      overall: 'degraded',
      partial: true,
      sources: [
        { id: 'otel:project-a', readiness: 'degraded' },
        { id: 'otel:project-b', readiness: 'ready' },
      ],
    })
  })

  it('parses multi-source configuration and rejects a mismatched source request', async () => {
    const sources = parseAzureMonitorOtelSources({
      AZURE_MONITOR_SOURCES_JSON: JSON.stringify([
        {
          id: 'project-a',
          name: 'Project A',
          workspaceId: config.workspaceId,
          tenantId: config.tenantId,
          environment: config.environment,
        },
      ]),
    })
    const connector = new MultiAzureMonitorOtelConnector(
      sources,
      () => new Credential(),
      () => vi.fn<typeof fetch>(),
    )
    await expect(
      connector.readObservationWindows({
        tenantId: 'estate',
        agentId: 'aggregate-agent',
        sourceConnectorId: 'project-a',
        sourceTenantId: 'tenant-b',
        sourceAgentId: 'provider-agent',
        sourceEnvironment: 'production',
      }),
    ).rejects.toThrow('does not match the Azure Monitor source')
  })

  it('reports unavailable after every configured source query fails', async () => {
    const connector = new MultiAzureMonitorOtelConnector(
      [
        {
          id: 'project-a',
          name: 'Project A',
          workspaceId: config.workspaceId,
          tenantId: config.tenantId,
          environment: config.environment,
          baselineWindowHours: 24,
          observedWindowHours: 24,
          requestTimeoutMs: 15_000,
        },
      ],
      () => new Credential(),
      () =>
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json({ error: { code: 'Forbidden' } }, { status: 403 })),
    )
    await expect(
      connector.readObservationWindows({
        tenantId: 'estate',
        agentId: 'aggregate-agent',
      }),
    ).rejects.toThrow()
    expect(connector.getConnectorHealth()).toMatchObject({
      overall: 'unavailable',
      partial: false,
      sources: [{ id: 'otel:project-a', readiness: 'unavailable' }],
    })
  })

  it('rejects unsafe bindings and invalid time configuration', () => {
    expect(() =>
      buildAzureMonitorOtelQuery({
        tenantId: 'tenant-a',
        agentId: "agent' | take 100",
        environment: 'production',
      }),
    ).toThrow()
    expect(() =>
      azureMonitorOtelConfigSchema.parse({ ...config, observedWindowHours: 0 }),
    ).toThrow()
  })

  it('fails closed when Azure Monitor rejects the query', async () => {
    const connector = new AzureMonitorOtelConnector(
      config,
      new Credential(),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ error: { code: 'Forbidden' } }, { status: 403 })),
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    await expect(
      connector.readObservationWindows({ tenantId: 'tenant-a', agentId: 'agent-a' }),
    ).rejects.toThrow('status 403')
  })
})
