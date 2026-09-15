import { readFile } from 'node:fs/promises'

import { projectRuntimeEvidence } from '@agent-sentinel/connector-sdk'
import type { AccessToken, TokenCredential } from '@azure/core-auth'
import type { EstateSnapshot, OtelEvidenceCaveat } from '@agent-sentinel/domain'
import {
  AGENT_INVOCATION_ATTRIBUTE_KEYS,
  AGENT_INVOCATION_CONTRACT_VERSION,
  AGENT_INVOCATION_RECORD_TYPE,
  agentInvocationContractFixtureSchema,
} from '@agent-sentinel/runtime-instrumentation'
import { describe, expect, it, vi } from 'vitest'

import {
  AzureMonitorOtelConfigurationError,
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

const providerResourceId =
  '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg-test/providers/Microsoft.Insights/components/app-test'

const columns = [
  ['ProviderInvocationId', 'string'],
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
  ['TraceId', 'string'],
  ['SpanId', 'string'],
  ['ItemCount', 'long'],
  ['SourceProjectId', 'string'],
  ['ResourceId', 'string'],
  ['ProviderResourceId', 'string'],
  ['ApplicationRoleName', 'string'],
  ['RequestName', 'string'],
  ['ContractVersion', 'long'],
  ['RecordType', 'string'],
  ['SourceConnectorId', 'string'],
  ['EstateId', 'string'],
  ['EstateTenantId', 'string'],
  ['EstateEnvironment', 'string'],
  ['SourceTenantId', 'string'],
  ['SourceEnvironment', 'string'],
  ['ProviderAgentId', 'string'],
  ['Outcome', 'string'],
].map(([name, type]) => ({ name, type }))

class Credential implements TokenCredential {
  getToken(): Promise<AccessToken> {
    return Promise.resolve({ token: 'test-token', expiresOnTimestamp: Date.now() + 60_000 })
  }
}

const config = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  providerResourceId,
  applicationRoleName: 'agent-runtime',
  requestName: 'agent.invoke' as const,
  tenantId: 'tenant-a',
  sourceProjectId: 'project-a',
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
  const sourceConnectorId = agentId.startsWith('provider-') ? 'project-a' : 'direct'
  const estateTenantId = agentId.startsWith('provider-') ? 'estate' : tenantId
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
    null,
    null,
    null,
    'project-a',
    providerResourceId,
    providerResourceId,
    'agent-runtime',
    'agent.invoke',
    1,
    'agent_invocation',
    sourceConnectorId,
    'estate-a',
    estateTenantId,
    'portfolio',
    tenantId,
    environment,
    agentId,
    'success',
  ]
}

const runtimeRequest = {
  snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
  estateId: 'estate-a',
  estateEnvironment: 'portfolio',
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  sourceConnectorId: 'direct',
  sourceTenantId: 'tenant-a',
  sourceProjectId: 'project-a',
  sourceAgentId: 'agent-a',
  sourceEnvironment: 'production',
} as const

const mapBinding = {
  ...runtimeRequest,
  environment: 'production',
  providerResourceId,
  applicationRoleName: 'agent-runtime',
  requestName: 'agent.invoke' as const,
  windowStart: '2026-08-22T12:00:00.000Z',
  windowEnd: '2026-08-24T12:00:00.000Z',
}

const queryBinding = {
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  environment: 'production',
  sourceConnectorId: 'direct',
  estateId: 'estate-a',
  estateTenantId: 'tenant-a',
  estateEnvironment: 'portfolio',
  sourceTenantId: 'tenant-a',
  sourceProjectId: 'project-a',
  providerResourceId,
  applicationRoleName: 'agent-runtime',
  requestName: 'agent.invoke' as const,
  windowStart: '2026-08-22T12:00:00.000Z',
  windowEnd: '2026-08-24T12:00:00.000Z',
}

function exactInvocationRow(
  spanId: string,
  traceId: string,
  observedAt: string,
  index: number,
  agentId = 'provider-project-a',
): unknown[] {
  const values = row(spanId, observedAt, index)
  values[3] = agentId
  values[6] = traceId
  values[16] = traceId
  values[17] = spanId
  values[18] = 1
  values[26] = agentId.startsWith('provider-') ? 'project-a' : 'direct'
  values[28] = agentId.startsWith('provider-') ? 'estate' : 'tenant-a'
  values[32] = agentId
  return values
}

function exactInvocationRows(
  count: number,
  observedAt: string,
  idOffset: number,
  agentId = 'agent-a',
): unknown[][] {
  const start = new Date(observedAt).getTime()
  return Array.from({ length: count }, (_, index) => {
    const id = idOffset + index + 1
    return exactInvocationRow(
      id.toString(16).padStart(16, '0'),
      id.toString(16).padStart(32, '0'),
      new Date(start + index * 1_000).toISOString(),
      index,
      agentId,
    )
  })
}

function distributedInvocationRows(
  count: number,
  windowStart: string,
  windowEnd: string,
  idOffset: number,
  agentId = 'agent-a',
): unknown[][] {
  const start = Date.parse(windowStart)
  const end = Date.parse(windowEnd)
  return Array.from({ length: count }, (_, index) => {
    const id = idOffset + index + 1
    const observedAt = new Date(start + Math.floor(((index + 1) * (end - start)) / (count + 1)))
    return exactInvocationRow(
      id.toString(16).padStart(16, '0'),
      id.toString(16).padStart(32, '0'),
      observedAt.toISOString(),
      index,
      agentId,
    )
  })
}

function partitioningFetcher(rows: readonly unknown[][]): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>().mockImplementation((_input, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.')
    const body = JSON.parse(init.body) as { query: string; timespan: string }
    const [start, end] = body.timespan.split('/')
    const take = Number(/\| take (\d+)/.exec(body.query)?.[1])
    const pageRows = rows
      .filter((candidate) => {
        const observedAt = String(candidate[1])
        return observedAt >= start! && observedAt < end!
      })
      .slice(0, take)
    return Promise.resolve(
      Response.json({ tables: [{ name: 'PrimaryResult', columns, rows: pageRows }] }),
    )
  })
}

describe('Azure Monitor OTel connector', () => {
  it('uses the shared source project ID length boundary', () => {
    const maximum = 'p'.repeat(200)

    expect(
      azureMonitorOtelConfigSchema.parse({
        ...config,
        sourceProjectId: maximum,
      }).sourceProjectId,
    ).toBe(maximum)
    expect(
      azureMonitorOtelConfigSchema.safeParse({
        ...config,
        sourceProjectId: `${maximum}x`,
      }).success,
    ).toBe(false)
  })

  it('strictly validates the checked-in local Azure Monitor fixture', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/azure-monitor-query.json', import.meta.url), 'utf8'),
    ) as {
      tables: Array<{ columns: Array<{ name: string; type: string }>; rows: unknown[][] }>
    }
    const contractFixture = agentInvocationContractFixtureSchema.parse(
      JSON.parse(
        await readFile(
          new URL(
            '../../../packages/runtime-instrumentation/contract/agent-invocation-v1.fixture.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    )
    const observations = mapAzureMonitorRows(fixture, mapBinding)
    const fixtureTable = fixture.tables[0]!
    const fixtureRow = Object.fromEntries(
      fixtureTable.columns.map((column, index) => [column.name, fixtureTable.rows[0]![index]]),
    )

    expect(observations).toHaveLength(4)
    expect(fixtureRow).toMatchObject({
      ProviderInvocationId:
        contractFixture.span.attributes[AGENT_INVOCATION_ATTRIBUTE_KEYS.providerInvocationId],
      TenantId: contractFixture.span.attributes[AGENT_INVOCATION_ATTRIBUTE_KEYS.tenantId],
      AgentId: contractFixture.span.attributes[AGENT_INVOCATION_ATTRIBUTE_KEYS.agentId],
      Environment: contractFixture.span.attributes[AGENT_INVOCATION_ATTRIBUTE_KEYS.environment],
      SourceProjectId:
        contractFixture.span.attributes[AGENT_INVOCATION_ATTRIBUTE_KEYS.sourceProjectId],
      ResourceId:
        contractFixture.span.attributes[AGENT_INVOCATION_ATTRIBUTE_KEYS.providerResourceId],
      ProviderResourceId:
        contractFixture.span.attributes[AGENT_INVOCATION_ATTRIBUTE_KEYS.providerResourceId],
      ApplicationRoleName: contractFixture.resourceAttributes['service.name'],
      RequestName: contractFixture.span.name,
      ContractVersion: contractFixture.contractVersion,
      RecordType: contractFixture.recordType,
      Outcome: contractFixture.span.attributes[AGENT_INVOCATION_ATTRIBUTE_KEYS.outcome],
    })
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
      synthetic: false,
      correlations: [
        { kind: 'correlation-id', value: 'operation-baseline-2' },
        { kind: 'agent-version', value: '17' },
      ],
    })
    expect(observations[1]?.costUsd).toBe(0.014)
  })

  it('rejects mismatched row bindings, time ranges, malformed tools, and columns', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/azure-monitor-query.json', import.meta.url), 'utf8'),
    ) as { tables: Array<{ columns: Array<{ name: string; type: string }>; rows: unknown[][] }> }
    const binding = mapBinding

    for (const [columnIndex, invalidValue] of [
      [2, 'tenant-b'],
      [3, 'agent-b'],
      [4, 'staging'],
      [19, 'project-b'],
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
      exactInvocationRow(
        String(index + 1).padStart(16, 'a'),
        String(index + 1).padStart(32, '1'),
        `2026-08-23T${String(index).padStart(2, '0')}:00:00.000Z`,
        index,
        'agent-a',
      ),
    )
    const observedRows = Array.from({ length: 10 }, (_, index) =>
      exactInvocationRow(
        String(index + 11).padStart(16, 'b'),
        String(index + 11).padStart(32, '2'),
        `2026-08-24T${String(index).padStart(2, '0')}:00:00.000Z`,
        index,
        'agent-a',
      ),
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
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      sourceConnectorId: 'direct',
      sourceTenantId: 'tenant-a',
      sourceProjectId: 'project-a',
      sourceAgentId: 'agent-a',
      sourceEnvironment: 'production',
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
    expect(body.query).toContain('| take 1001')
    expect(body.query).toContain(
      `ProviderInvocationId = tostring(OtelAttributes["${AGENT_INVOCATION_ATTRIBUTE_KEYS.providerInvocationId}"])`,
    )
    expect(body.query).toContain(
      `| where ContractVersion == ${String(AGENT_INVOCATION_CONTRACT_VERSION)}`,
    )
    expect(body.query).toContain(`| where RecordType == '${AGENT_INVOCATION_RECORD_TYPE}'`)
    expect(body.query).toContain('| where Synthetic == false')
    expect(body.query).toContain('TraceId = tostring(OperationId)')
    expect(body.query).toContain('SpanId = tostring(Id)')
    expect(body.query).toContain(
      `Synthetic = tobool(OtelAttributes["${AGENT_INVOCATION_ATTRIBUTE_KEYS.synthetic}"])`,
    )
    expect(body.query).not.toContain(
      'Synthetic = tobool(coalesce(OtelAttributes["agent.sentinel.synthetic"], false))',
    )
    expect(body.query).toContain('ItemCount = tolong(ItemCount)')
    expect(body.query).toContain('CorrelationId')
    expect(body.query).toContain('OperationId')
    expect(body.query).not.toContain('AppMetrics')
    expect(body.query).not.toContain('OtelAttributes["trace_id"]')
    expect(body.query).not.toContain('OtelAttributes["span_id"]')
    expect(body.query).not.toMatch(/\b(delete|drop|set|ingest)\b/i)
    expect(body.timespan).toBe('2026-08-22T12:00:00.000Z/2026-08-24T12:00:00.000Z')
  })

  it('applies the 500-observation limit independently to 300 baseline and 300 observed rows', async () => {
    const baselineRows = exactInvocationRows(300, '2026-08-23T00:00:00.000Z', 0)
    const observedRows = exactInvocationRows(300, '2026-08-24T00:00:00.000Z', 1_000)
    const connector = new AzureMonitorOtelConnector(
      config,
      new Credential(),
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          tables: [{ name: 'PrimaryResult', columns, rows: [...baselineRows, ...observedRows] }],
        }),
      ),
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    const windows = await connector.readObservationWindows({
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      sourceConnectorId: 'direct',
      sourceTenantId: 'tenant-a',
      sourceProjectId: 'project-a',
      sourceAgentId: 'agent-a',
      sourceEnvironment: 'production',
    })

    expect(windows.baseline.observations).toHaveLength(300)
    expect(windows.observed.observations).toHaveLength(300)
    expect(windows.baseline.otelQuality).toMatchObject({
      recordsReceived: 1_800,
      recordsAccepted: 1_800,
    })
    expect(windows.observed.otelQuality).toMatchObject({
      recordsReceived: 1_800,
      recordsAccepted: 1_800,
    })
  })

  it('retrieves more than 500 observations per window through bounded time partitions', async () => {
    const baselineRows = distributedInvocationRows(
      600,
      '2026-08-22T12:00:00.000Z',
      '2026-08-23T12:00:00.000Z',
      0,
    )
    const observedRows = distributedInvocationRows(
      600,
      '2026-08-23T12:00:00.000Z',
      '2026-08-24T12:00:00.000Z',
      1_000,
    )
    const fetcher = partitioningFetcher([...baselineRows, ...observedRows])
    const connector = new AzureMonitorOtelConnector(
      config,
      new Credential(),
      fetcher,
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    const windows = await connector.readObservationWindows({
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      sourceConnectorId: 'direct',
      sourceTenantId: 'tenant-a',
      sourceProjectId: 'project-a',
      sourceAgentId: 'agent-a',
      sourceEnvironment: 'production',
    })

    expect(windows.baseline.observations).toHaveLength(600)
    expect(windows.observed.observations).toHaveLength(600)
    expect(windows.baseline.otelQuality?.status).toBe('available')
    expect(windows.observed.otelQuality?.status).toBe('available')
    expect(fetcher.mock.calls.length).toBeGreaterThan(2)
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(20)
  })

  it('retains bounded quality counters above the representative single-batch limit', async () => {
    const baselineRows = distributedInvocationRows(
      1_700,
      '2026-08-22T12:00:00.000Z',
      '2026-08-23T12:00:00.000Z',
      0,
    )
    const fetcher = partitioningFetcher(baselineRows)
    const connector = new AzureMonitorOtelConnector(
      { ...config, maxResponseBytes: 64 * 1024 * 1024 },
      new Credential(),
      fetcher,
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    const windows = await connector.readObservationWindows({
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      sourceConnectorId: 'direct',
      sourceTenantId: 'tenant-a',
      sourceProjectId: 'project-a',
      sourceAgentId: 'agent-a',
      sourceEnvironment: 'production',
    })

    expect(windows.baseline.observations).toHaveLength(1_700)
    expect(windows.baseline.otelQuality).toMatchObject({
      status: 'available',
      recordsReceived: 10_200,
      recordsAccepted: 10_200,
      pagesProcessed: 21,
    })
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(20)
  })

  it('uses half-open partitions without duplicating boundary observations', async () => {
    const midpoint = '2026-08-23T00:00:00.000Z'
    const baselineRows = distributedInvocationRows(
      600,
      '2026-08-22T12:00:00.000Z',
      '2026-08-23T12:00:00.000Z',
      0,
    )
    baselineRows[299]![1] = midpoint
    const fetcher = partitioningFetcher(baselineRows)
    const connector = new AzureMonitorOtelConnector(
      config,
      new Credential(),
      fetcher,
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    const windows = await connector.readObservationWindows({
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      sourceConnectorId: 'direct',
      sourceTenantId: 'tenant-a',
      sourceProjectId: 'project-a',
      sourceAgentId: 'agent-a',
      sourceEnvironment: 'production',
    })

    expect(windows.baseline.observations).toHaveLength(600)
    expect(windows.baseline.otelQuality).toMatchObject({
      status: 'available',
      duplicatesRemoved: 0,
    })
    expect(windows.baseline.otelQuality?.caveats).not.toContain('duplicate-record')
  })

  it('fails closed when dense partitions exhaust the global page limit', async () => {
    const rows = distributedInvocationRows(
      1_001,
      '2026-08-22T12:00:00.000Z',
      '2026-08-24T12:00:00.000Z',
      0,
    )
    const connector = new AzureMonitorOtelConnector(
      { ...config, maxResponseBytes: 64 * 1024 * 1024 },
      new Credential(),
      vi
        .fn<typeof fetch>()
        .mockImplementation(() =>
          Promise.resolve(Response.json({ tables: [{ name: 'PrimaryResult', columns, rows }] })),
        ),
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    await expect(
      connector.readObservationWindows(
        {
          snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
          estateId: 'estate-a',
          estateEnvironment: 'portfolio',
          tenantId: 'tenant-a',
          agentId: 'agent-a',
          sourceConnectorId: 'direct',
          sourceTenantId: 'tenant-a',
          sourceProjectId: 'project-a',
          sourceAgentId: 'agent-a',
          sourceEnvironment: 'production',
        },
        {
          maxPages: 10,
          maxRecords: 1_000_000,
        },
      ),
    ).rejects.toThrow('10-page query limit')
  })

  it('requires and filters the exact authoritative Foundry project ID', () => {
    const query = buildAzureMonitorOtelQuery(queryBinding)

    expect(query).toContain(
      `SourceProjectId = tostring(OtelAttributes["${AGENT_INVOCATION_ATTRIBUTE_KEYS.sourceProjectId}"])`,
    )
    expect(query).toContain("| where SourceProjectId == 'project-a'")
  })

  it('rejects the same workspace and agent identifiers returned for another Foundry project', async () => {
    const projectColumns = columns
    const values = exactInvocationRow(
      'aaaaaaaaaaaaaaaa',
      '11111111111111111111111111111111',
      '2026-08-24T10:00:00.000Z',
      0,
      'provider-project-a',
    )
    values[19] = 'project-b'
    const connector = new AzureMonitorOtelConnector(
      { ...config, sourceProjectId: 'project-a' },
      new Credential(),
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          tables: [{ name: 'PrimaryResult', columns: projectColumns, rows: [values] }],
        }),
      ),
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    await expect(
      connector.readObservationWindows({
        snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
        estateId: 'estate-a',
        estateEnvironment: 'portfolio',
        tenantId: 'estate',
        agentId: 'aggregate-agent',
        sourceConnectorId: 'project-a',
        sourceTenantId: 'tenant-a',
        sourceProjectId: 'project-a',
        sourceAgentId: 'provider-project-a',
        sourceEnvironment: 'production',
      }),
    ).rejects.toThrow(/project/)
  })

  it('drops every conflicting observation reused across baseline and observed windows', async () => {
    const baseline = exactInvocationRow(
      'aaaaaaaaaaaaaaaa',
      '11111111111111111111111111111111',
      '2026-08-23T11:00:00.000Z',
      0,
      'agent-a',
    )
    const observed = [...baseline]
    observed[1] = '2026-08-24T01:00:00.000Z'
    observed[8] = 999
    const connector = new AzureMonitorOtelConnector(
      config,
      new Credential(),
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          tables: [{ name: 'PrimaryResult', columns, rows: [baseline, observed] }],
        }),
      ),
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    const windows = await connector.readObservationWindows({
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      sourceConnectorId: 'direct',
      sourceTenantId: 'tenant-a',
      sourceProjectId: 'project-a',
      sourceAgentId: 'agent-a',
      sourceEnvironment: 'production',
    })

    for (const window of [windows.baseline, windows.observed]) {
      expect(window.observations).toEqual([])
      expect(window.otelQuality).toMatchObject({
        status: 'degraded',
        recordsReceived: 6,
        recordsAccepted: 0,
        duplicatesRemoved: 6,
      })
      expect(window.otelQuality?.caveats).toContain('conflicting-duplicate')
    }
  })

  it('does not classify distinct missing observation IDs as a reused-ID conflict', async () => {
    const baseline = exactInvocationRow(
      'aaaaaaaaaaaaaaaa',
      '11111111111111111111111111111111',
      '2026-08-23T11:00:00.000Z',
      0,
      'agent-a',
    )
    const observed = exactInvocationRow(
      'bbbbbbbbbbbbbbbb',
      '22222222222222222222222222222222',
      '2026-08-24T01:00:00.000Z',
      1,
      'agent-a',
    )
    baseline[0] = null
    observed[0] = null
    const connector = new AzureMonitorOtelConnector(
      config,
      new Credential(),
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          tables: [{ name: 'PrimaryResult', columns, rows: [baseline, observed] }],
        }),
      ),
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    const windows = await connector.readObservationWindows({
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      sourceConnectorId: 'direct',
      sourceTenantId: 'tenant-a',
      sourceProjectId: 'project-a',
      sourceAgentId: 'agent-a',
      sourceEnvironment: 'production',
    })

    for (const window of [windows.baseline, windows.observed]) {
      expect(window.otelQuality?.caveats).toContain('invalid-record')
      expect(window.otelQuality?.caveats).not.toContain('conflicting-duplicate')
    }
  })

  it('removes exact duplicate rows before quality and readiness assessment', async () => {
    const duplicate = exactInvocationRow(
      'aaaaaaaaaaaaaaaa',
      '11111111111111111111111111111111',
      '2026-08-23T01:00:00.000Z',
      1,
    )
    const connector = new MultiAzureMonitorOtelConnector(
      [
        {
          id: 'project-a',
          name: 'Provider project A',
          workspaceId: config.workspaceId,
          providerResourceId: config.providerResourceId,
          applicationRoleName: config.applicationRoleName,
          requestName: config.requestName,
          tenantId: config.tenantId,
          sourceProjectId: config.sourceProjectId,
          environment: config.environment,
        },
      ],
      () => new Credential(),
      () =>
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            tables: [{ name: 'PrimaryResult', columns, rows: [duplicate, duplicate] }],
          }),
        ),
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    const windows = await connector.readObservationWindows({
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
      tenantId: 'estate',
      agentId: 'aggregate-agent',
      sourceConnectorId: 'project-a',
      sourceTenantId: config.tenantId,
      sourceEnvironment: config.environment,
      sourceAgentId: 'provider-project-a',
    })

    expect(windows.baseline.observations).toHaveLength(1)
    expect(windows.baseline.otelQuality).toMatchObject({
      status: 'degraded',
      duplicatesRemoved: 6,
    })
    expect(windows.baseline.otelQuality?.caveats).toContain('duplicate-record')
    expect(connector.getConnectorHealth().sources[0]).toMatchObject({
      readiness: 'degraded',
      dataState: 'partial',
      reason: 'degraded-quality',
    })
  })

  it('drops every conflicting duplicate row without reporting valid-empty readiness', async () => {
    const first = exactInvocationRow(
      'aaaaaaaaaaaaaaaa',
      '11111111111111111111111111111111',
      '2026-08-23T01:00:00.000Z',
      1,
    )
    const conflicting = [...first]
    conflicting[8] = 999
    const connector = new MultiAzureMonitorOtelConnector(
      [
        {
          id: 'project-a',
          name: 'Provider project A',
          workspaceId: config.workspaceId,
          providerResourceId: config.providerResourceId,
          applicationRoleName: config.applicationRoleName,
          requestName: config.requestName,
          tenantId: config.tenantId,
          sourceProjectId: config.sourceProjectId,
          environment: config.environment,
        },
      ],
      () => new Credential(),
      () =>
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            tables: [{ name: 'PrimaryResult', columns, rows: [first, conflicting] }],
          }),
        ),
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    const windows = await connector.readObservationWindows({
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
      tenantId: 'estate',
      agentId: 'aggregate-agent',
      sourceConnectorId: 'project-a',
      sourceTenantId: config.tenantId,
      sourceEnvironment: config.environment,
      sourceAgentId: 'provider-project-a',
    })

    expect(windows.baseline.observations).toEqual([])
    expect(windows.baseline.otelQuality).toMatchObject({
      status: 'degraded',
      duplicatesRemoved: 12,
    })
    expect(windows.baseline.otelQuality?.caveats).toContain('conflicting-duplicate')
    expect(connector.getConnectorHealth().sources[0]).toMatchObject({
      readiness: 'degraded',
      dataState: 'partial',
      reason: 'degraded-quality',
    })
  })

  it('binds evidence IDs to the exact measurement time within a five-minute window', async () => {
    let now = new Date('2026-08-24T12:01:15.000Z')
    let rows: unknown[][] = []
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ tables: [{ name: 'PrimaryResult', columns, rows }] })),
      )
    const connector = new AzureMonitorOtelConnector(config, new Credential(), fetcher, () => now)

    const first = await connector.readObservationWindows(runtimeRequest)
    now = new Date('2026-08-24T12:04:59.000Z')
    const second = await connector.readObservationWindows(runtimeRequest)
    rows = [row('late-observation', '2026-08-24T11:59:00.000Z', 1)]
    const lateArrival = await connector.readObservationWindows(runtimeRequest)

    expect(second.baselineEvidenceId).not.toBe(first.baselineEvidenceId)
    expect(second.observedEvidenceId).not.toBe(first.observedEvidenceId)
    expect(lateArrival.baselineEvidenceId).not.toBe(first.baselineEvidenceId)
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

    const first = await connector.readObservationWindows(runtimeRequest)
    rows = [...rows].reverse()
    const reversed = await connector.readObservationWindows(runtimeRequest)

    expect(reversed.observedEvidenceId).toBe(first.observedEvidenceId)
  })

  it('changes the evidence ID on a fresh read when enriched invocation identity changes', async () => {
    const observedRow = exactInvocationRow(
      'aaaaaaaaaaaaaaaa',
      '11111111111111111111111111111111',
      '2026-08-24T11:59:00.000Z',
      1,
      'agent-a',
    )
    let rows = [observedRow]
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
    const request = {
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      sourceConnectorId: 'direct',
      sourceTenantId: 'tenant-a',
      sourceProjectId: 'project-a',
      sourceEnvironment: 'production',
      sourceAgentId: 'agent-a',
    } as const

    const first = await connector.readObservationWindows(request)
    const changedRow = [...observedRow]
    changedRow[5] = 'run-b'
    changedRow[6] = 'correlation-b'
    changedRow[7] = '18'
    changedRow[14] = '["answer","knowledge_search"]'
    rows = [changedRow]
    const second = await connector.readObservationWindows(request)

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(second.observed.observations[0]).toMatchObject({
      correlations: [
        { kind: 'agent-run-id', value: 'run-b' },
        { kind: 'correlation-id', value: 'correlation-b' },
        { kind: 'agent-version', value: '18' },
      ],
      toolCallNames: ['answer', 'knowledge_search'],
    })
    expect(second.observedEvidenceId).not.toBe(first.observedEvidenceId)
  })

  it('activates a complete legacy source in live mode and ignores an empty tuple', () => {
    expect(createAzureMonitorOtelConnector({}, new Credential())).toBeUndefined()
    expect(
      createAzureMonitorOtelConnector(
        {
          AZURE_MONITOR_WORKSPACE_ID: config.workspaceId,
          AZURE_MONITOR_PROVIDER_RESOURCE_ID: config.providerResourceId,
          AZURE_MONITOR_APPLICATION_ROLE_NAME: config.applicationRoleName,
          AZURE_MONITOR_TENANT_ID: config.tenantId,
          AZURE_MONITOR_ENVIRONMENT: config.environment,
          FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/project-a',
        },
        new Credential(),
      ),
    ).toBeInstanceOf(MultiAzureMonitorOtelConnector)
    expect(
      resolveAzureMonitorOtelRuntimeActivation(
        {
          AZURE_MONITOR_SOURCES_JSON: '   ',
          AZURE_MONITOR_WORKSPACE_ID: config.workspaceId,
          AZURE_MONITOR_PROVIDER_RESOURCE_ID: config.providerResourceId,
          AZURE_MONITOR_APPLICATION_ROLE_NAME: config.applicationRoleName,
          AZURE_MONITOR_TENANT_ID: config.tenantId,
          AZURE_MONITOR_ENVIRONMENT: config.environment,
          FOUNDRY_PROJECT_ENDPOINT: 'https://example.services.ai.azure.com/api/projects/project-a',
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
          sourceProjectId: config.sourceProjectId,
          environment: config.environment,
          baselineWindowHours: 168,
          observedWindowHours: 24,
          requestTimeoutMs: 15_000,
        },
      ],
    })
    expect(resolveAzureMonitorOtelRuntimeActivation({}, 'live')).toEqual({
      active: false,
      sources: [],
    })
  })

  it.each([
    ['workspace only', { AZURE_MONITOR_WORKSPACE_ID: config.workspaceId }],
    ['tenant only', { AZURE_MONITOR_TENANT_ID: config.tenantId }],
    ['environment only', { AZURE_MONITOR_ENVIRONMENT: config.environment }],
    [
      'workspace and tenant',
      {
        AZURE_MONITOR_WORKSPACE_ID: config.workspaceId,
        AZURE_MONITOR_TENANT_ID: config.tenantId,
      },
    ],
    [
      'workspace and environment',
      {
        AZURE_MONITOR_WORKSPACE_ID: config.workspaceId,
        AZURE_MONITOR_ENVIRONMENT: config.environment,
      },
    ],
    [
      'tenant and environment',
      {
        AZURE_MONITOR_TENANT_ID: config.tenantId,
        AZURE_MONITOR_ENVIRONMENT: config.environment,
      },
    ],
  ])('rejects partial legacy configuration in live mode: %s', (_label, environment) => {
    expect(() => resolveAzureMonitorOtelRuntimeActivation(environment, 'live')).toThrow(
      AzureMonitorOtelConfigurationError,
    )
    expect(() => createAzureMonitorOtelConnector(environment, new Credential(), 'live')).toThrow(
      AzureMonitorOtelConfigurationError,
    )
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
            providerResourceId: config.providerResourceId,
            applicationRoleName: config.applicationRoleName,
            requestName: config.requestName,
            tenantId: config.tenantId,
            sourceProjectId: config.sourceProjectId,
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
        sourceProjectId: config.sourceProjectId,
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
              providerResourceId: config.providerResourceId,
              applicationRoleName: config.applicationRoleName,
              requestName: config.requestName,
              tenantId: config.tenantId,
              sourceProjectId: config.sourceProjectId,
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
          providerResourceId: config.providerResourceId,
          applicationRoleName: config.applicationRoleName,
          requestName: config.requestName,
          tenantId: config.tenantId,
          sourceProjectId: config.sourceProjectId,
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
      resolveAzureMonitorOtelRuntimeActivation(
        {
          AZURE_MONITOR_WORKSPACE_ID: config.workspaceId,
          AZURE_MONITOR_TENANT_ID: config.tenantId,
        },
        'mock',
      ),
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
        providerResourceId: config.providerResourceId,
        applicationRoleName: config.applicationRoleName,
        requestName: config.requestName,
        tenantId: 'tenant-a',
        sourceProjectId: 'project-a',
        environment: 'production',
        baselineWindowHours: 24,
        observedWindowHours: 24,
        requestTimeoutMs: 15_000,
      },
      {
        id: 'project-b',
        name: 'Project B',
        workspaceId: '22222222-2222-4222-8222-222222222222',
        providerResourceId: config.providerResourceId,
        applicationRoleName: config.applicationRoleName,
        requestName: config.requestName,
        tenantId: 'tenant-b',
        sourceProjectId: 'project-b',
        environment: 'validation',
        baselineWindowHours: 24,
        observedWindowHours: 24,
        requestTimeoutMs: 15_000,
      },
    ]
    const fetchers = new Map(
      sources.map((source) => {
        const rows = [
          exactInvocationRow(
            source.id === 'project-a' ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb',
            source.id === 'project-a'
              ? '11111111111111111111111111111111'
              : '22222222222222222222222222222222',
            '2026-08-23T11:00:00.000Z',
            0,
            `provider-${source.id}`,
          ),
          exactInvocationRow(
            source.id === 'project-a' ? 'cccccccccccccccc' : 'dddddddddddddddd',
            source.id === 'project-a'
              ? '33333333333333333333333333333333'
              : '44444444444444444444444444444444',
            '2026-08-24T01:00:00.000Z',
            1,
            `provider-${source.id}`,
          ),
        ]
        for (const values of rows) {
          values[2] = source.tenantId
          values[4] = source.environment
          values[19] = source.id
          values[26] = source.id
          values[28] = 'estate'
          values[30] = source.tenantId
          values[31] = source.environment
          values[32] = `provider-${source.id}`
        }
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
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      tenantId: 'estate',
      agentId: aggregateAgentId,
      sourceConnectorId: 'project-b',
      sourceTenantId: 'tenant-b',
      sourceAgentId: 'provider-project-b',
      sourceEnvironment: 'validation',
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
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
    expect(windows.provenance).toEqual({
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      estateId: 'estate-a',
      estateTenantId: 'estate',
      estateEnvironment: 'portfolio',
      sourceConnectorId: 'project-b',
      sourceTenantId: 'tenant-b',
      sourceProjectId: 'project-b',
      sourceEnvironment: 'validation',
      provider: 'azure-monitor-otel',
      providerResourceId: config.providerResourceId.toLowerCase(),
      providerAgentId: 'provider-project-b',
      sourceSetFingerprint: connector.sourceSetFingerprint,
      measuredAt: '2026-08-24T12:00:00.000Z',
      contract: {
        version: 1,
        recordType: 'agent_invocation',
        applicationRoleName: config.applicationRoleName,
        requestName: config.requestName,
      },
    })
    expect(connector.getConnectorHealth()).toMatchObject({
      overall: 'degraded',
      partial: true,
      sources: [
        { id: 'otel:project-a', readiness: 'degraded' },
        {
          id: 'otel:project-b',
          readiness: 'ready',
          dataState: 'complete',
        },
      ],
    })
  })

  it('constructs exact invocation provenance that survives projection for both windows', async () => {
    const source = {
      id: 'project-a',
      name: 'Project A',
      workspaceId: config.workspaceId,
      providerResourceId: config.providerResourceId,
      applicationRoleName: config.applicationRoleName,
      requestName: config.requestName,
      tenantId: config.tenantId,
      sourceProjectId: config.sourceProjectId,
      environment: config.environment,
      baselineWindowHours: 24,
      observedWindowHours: 24,
      requestTimeoutMs: 15_000,
    }
    const aggregateAgentId = 'foundry-source-project-a--foundry-agent-provider-project-a'
    const connector = new MultiAzureMonitorOtelConnector(
      [source],
      () => new Credential(),
      () =>
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            tables: [
              {
                name: 'PrimaryResult',
                columns,
                rows: [
                  exactInvocationRow(
                    'aaaaaaaaaaaaaaaa',
                    '11111111111111111111111111111111',
                    '2026-08-23T11:00:00.000Z',
                    0,
                  ),
                  exactInvocationRow(
                    'bbbbbbbbbbbbbbbb',
                    '22222222222222222222222222222222',
                    '2026-08-24T01:00:00.000Z',
                    1,
                  ),
                ],
              },
            ],
          }),
        ),
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    const windows = await connector.readObservationWindows({
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      tenantId: 'estate',
      agentId: aggregateAgentId,
      sourceConnectorId: source.id,
      sourceTenantId: source.tenantId,
      sourceAgentId: 'provider-project-a',
      sourceEnvironment: source.environment,
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
    })

    expect(windows.baseline.observations[0]?.id).toBe('aaaaaaaaaaaaaaaa')
    expect(windows.baseline.observations[0]).toMatchObject({
      correlations: [
        { kind: 'agent-run-id', value: 'run-aaaaaaaaaaaaaaaa' },
        { kind: 'correlation-id', value: '11111111111111111111111111111111' },
        { kind: 'agent-version', value: '17' },
      ],
      toolCallNames: ['knowledge_search', 'answer'],
    })
    expect(windows.baseline.observations[0]?.otelProvenance).toMatchObject({
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      estateId: 'estate-a',
      estateTenantId: 'estate',
      estateEnvironment: 'portfolio',
      sourceConnectorId: 'project-a',
      sourceTenantId: 'tenant-a',
      sourceProjectId: 'project-a',
      sourceEnvironment: 'production',
      provider: 'azure-monitor-otel',
      providerResourceId: config.providerResourceId.toLowerCase(),
      providerAgentId: 'provider-project-a',
      providerInvocationId: 'aaaaaaaaaaaaaaaa',
      sourceSetFingerprint: connector.sourceSetFingerprint,
      measuredAt: '2026-08-24T12:00:00.000Z',
      traceId: '11111111111111111111111111111111',
      spanId: 'aaaaaaaaaaaaaaaa',
      observedAt: '2026-08-23T11:00:00.000Z',
      classification: 'live',
      sampling: { state: 'complete', rate: 1 },
      aggregation: { kind: 'raw' },
      contract: {
        version: 1,
        recordType: 'agent_invocation',
        applicationRoleName: config.applicationRoleName,
        requestName: config.requestName,
        outcome: 'success',
      },
      partial: false,
    })
    expect(windows.baseline.observations[0]?.otelProvenance?.evidenceIds).toHaveLength(6)
    expect(windows.observed.observations[0]?.otelProvenance).toMatchObject({
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      traceId: '22222222222222222222222222222222',
      spanId: 'bbbbbbbbbbbbbbbb',
      observedAt: '2026-08-24T01:00:00.000Z',
    })
    expect(windows.baseline.otelQuality).toMatchObject({
      status: 'available',
      recordsReceived: 6,
      recordsAccepted: 6,
    })
    expect(windows.observed.otelQuality).toMatchObject({
      status: 'available',
      recordsReceived: 6,
      recordsAccepted: 6,
    })
    expect(connector.getConnectorHealth()).toMatchObject({
      overall: 'ready',
      partial: false,
      sources: [{ id: 'otel:project-a', readiness: 'ready', dataState: 'complete' }],
    })

    const snapshot: EstateSnapshot = {
      tenantId: 'estate',
      environment: 'portfolio',
      generatedAt: '2026-08-24T12:00:00.000Z',
      nodes: [
        {
          id: aggregateAgentId,
          kind: 'agent',
          name: 'Provider project A',
          description: 'Authoritative Foundry agent.',
          environment: 'production',
          evidenceIds: ['declared-agent'],
          metadata: {
            sourceOfTruth: 'true',
            sourceConnectorId: source.id,
            sourceTenantId: source.tenantId,
            sourceProjectId: source.sourceProjectId,
            sourceObjectId: 'provider-project-a',
            sourceEnvironment: source.environment,
          },
        },
      ],
      edges: [],
      evidence: [
        {
          id: 'declared-agent',
          source: 'Azure AI Foundry Agent Service',
          sourceObjectId: 'provider-project-a',
          observedAt: '2026-08-24T12:00:00.000Z',
          freshness: 'live',
          confidence: 1,
          evidenceTypes: ['declared_configuration'],
          summary: 'Declared configuration.',
          metadata: {
            sourceOfTruth: 'true',
            estateTenantId: 'estate',
            estateEnvironment: 'portfolio',
            sourceConnectorId: source.id,
            sourceTenantId: source.tenantId,
            sourceProjectId: source.sourceProjectId,
            sourceEnvironment: source.environment,
            sourceObjectId: 'provider-project-a',
          },
        },
      ],
    }
    const projection = projectRuntimeEvidence(snapshot, windows, {
      id: 'estate-a',
      tenantId: snapshot.tenantId,
      environment: snapshot.environment,
    })
    expect(projection.dataState).toEqual({ state: 'complete' })
    expect(
      projection.snapshot.evidence.filter((item) =>
        item.evidenceTypes.includes('observed_runtime'),
      ),
    ).toHaveLength(2)
  })

  it.each<{
    name: string
    mutate: (values: unknown[]) => void
    caveat: OtelEvidenceCaveat
  }>([
    {
      name: 'sampled evidence',
      mutate: (values: unknown[]) => {
        values[18] = 2
      },
      caveat: 'sampled',
    },
    {
      name: 'missing measured cost',
      mutate: (values: unknown[]) => {
        values[11] = null
      },
      caveat: 'invalid-record',
    },
  ])('keeps $name as insufficient production evidence', async ({ mutate, caveat }) => {
    const values = exactInvocationRow(
      'aaaaaaaaaaaaaaaa',
      '11111111111111111111111111111111',
      '2026-08-24T10:00:00.000Z',
      0,
    )
    mutate(values)
    const connector = new MultiAzureMonitorOtelConnector(
      [
        {
          id: 'project-a',
          name: 'Project A',
          workspaceId: config.workspaceId,
          providerResourceId: config.providerResourceId,
          applicationRoleName: config.applicationRoleName,
          requestName: config.requestName,
          tenantId: config.tenantId,
          sourceProjectId: config.sourceProjectId,
          environment: config.environment,
          baselineWindowHours: 24,
          observedWindowHours: 24,
        },
      ],
      () => new Credential(),
      () =>
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            tables: [{ name: 'PrimaryResult', columns, rows: [values] }],
          }),
        ),
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    const windows = await connector.readObservationWindows({
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
      tenantId: 'estate',
      agentId: 'aggregate-agent',
      sourceConnectorId: 'project-a',
      sourceTenantId: config.tenantId,
      sourceEnvironment: config.environment,
      sourceAgentId: 'provider-project-a',
    })

    expect(windows.observed.observations).toEqual([])
    expect(windows.observed.otelQuality?.status).toBe('degraded')
    expect(windows.observed.otelQuality?.caveats).toContain(caveat)
    expect(connector.getConnectorHealth().sources[0]).toMatchObject({
      readiness: 'degraded',
      dataState: 'partial',
      reason: 'degraded-quality',
    })
  })

  it('keeps the worst source result for one snapshot and resets on the next snapshot', async () => {
    let calls = 0
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => {
      calls += 1
      return Promise.resolve(
        calls === 1
          ? Response.json({ error: { code: 'Forbidden' } }, { status: 403 })
          : Response.json({
              tables: [
                {
                  name: 'PrimaryResult',
                  columns,
                  rows: [
                    exactInvocationRow(
                      'aaaaaaaaaaaaaaaa',
                      '11111111111111111111111111111111',
                      '2026-08-23T11:00:00.000Z',
                      0,
                    ),
                    exactInvocationRow(
                      'bbbbbbbbbbbbbbbb',
                      '22222222222222222222222222222222',
                      '2026-08-24T01:00:00.000Z',
                      1,
                    ),
                  ],
                },
              ],
            }),
      )
    })
    const connector = new MultiAzureMonitorOtelConnector(
      [
        {
          id: 'project-a',
          name: 'Project A',
          workspaceId: config.workspaceId,
          providerResourceId: config.providerResourceId,
          applicationRoleName: config.applicationRoleName,
          requestName: config.requestName,
          tenantId: config.tenantId,
          sourceProjectId: config.sourceProjectId,
          environment: config.environment,
          baselineWindowHours: 24,
          observedWindowHours: 24,
        },
      ],
      () => new Credential(),
      () => fetcher,
      () => new Date('2026-08-24T12:00:00.000Z'),
    )
    const request = {
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
      tenantId: 'estate',
      agentId: 'aggregate-agent',
      sourceConnectorId: 'project-a',
      sourceTenantId: config.tenantId,
      sourceProjectId: config.sourceProjectId,
      sourceAgentId: 'provider-project-a',
      sourceEnvironment: config.environment,
    }

    await expect(connector.readObservationWindows(request)).rejects.toThrow('status 403')
    await connector.readObservationWindows(request)
    expect(connector.getConnectorHealth()).toMatchObject({
      overall: 'unavailable',
      sources: [{ readiness: 'unavailable', dataState: 'failed', reason: 'query-failed' }],
    })

    await connector.readObservationWindows({
      ...request,
      snapshotGeneratedAt: '2026-08-24T12:05:00.000Z',
    })
    expect(connector.getConnectorHealth()).toMatchObject({
      overall: 'ready',
      sources: [{ readiness: 'ready', dataState: 'complete' }],
    })
  })

  it('marks stale representative evidence stale instead of live-ready', async () => {
    const values = exactInvocationRow(
      'aaaaaaaaaaaaaaaa',
      '11111111111111111111111111111111',
      '2026-08-24T10:00:00.000Z',
      0,
    )
    const connector = new MultiAzureMonitorOtelConnector(
      [
        {
          id: 'project-a',
          name: 'Project A',
          workspaceId: config.workspaceId,
          providerResourceId: config.providerResourceId,
          applicationRoleName: config.applicationRoleName,
          requestName: config.requestName,
          tenantId: config.tenantId,
          sourceProjectId: config.sourceProjectId,
          environment: config.environment,
          baselineWindowHours: 24,
          observedWindowHours: 24,
          maximumFreshnessHours: 1,
        },
      ],
      () => new Credential(),
      () =>
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            tables: [{ name: 'PrimaryResult', columns, rows: [values] }],
          }),
        ),
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    const windows = await connector.readObservationWindows({
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
      tenantId: 'estate',
      agentId: 'aggregate-agent',
      sourceConnectorId: 'project-a',
      sourceTenantId: config.tenantId,
      sourceEnvironment: config.environment,
      sourceAgentId: 'provider-project-a',
    })

    expect(windows.observed.otelQuality?.caveats).toContain('stale')
    expect(connector.getConnectorHealth().sources[0]).toMatchObject({
      readiness: 'degraded',
      dataState: 'stale',
      reason: 'stale',
    })
  })

  it('retains successful empty queries as empty rather than live-ready', async () => {
    const connector = new MultiAzureMonitorOtelConnector(
      [
        {
          id: 'project-a',
          name: 'Project A',
          workspaceId: config.workspaceId,
          providerResourceId: config.providerResourceId,
          applicationRoleName: config.applicationRoleName,
          requestName: config.requestName,
          tenantId: config.tenantId,
          sourceProjectId: config.sourceProjectId,
          environment: config.environment,
          baselineWindowHours: 24,
          observedWindowHours: 24,
          requestTimeoutMs: 15_000,
        },
      ],
      () => new Credential(),
      () =>
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            tables: [{ name: 'PrimaryResult', columns, rows: [] }],
          }),
        ),
      () => new Date('2026-08-24T12:00:00.000Z'),
    )

    const windows = await connector.readObservationWindows({
      snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
      estateId: 'estate-a',
      estateEnvironment: 'portfolio',
      tenantId: 'estate',
      agentId: 'aggregate-agent',
      sourceConnectorId: 'project-a',
      sourceTenantId: config.tenantId,
      sourceProjectId: config.sourceProjectId,
      sourceAgentId: 'provider-project-a',
      sourceEnvironment: config.environment,
    })

    expect(windows.baseline.observations).toEqual([])
    expect(windows.observed.observations).toEqual([])
    expect(connector.getConnectorHealth()).toMatchObject({
      overall: 'degraded',
      partial: false,
      sources: [
        {
          id: 'otel:project-a',
          readiness: 'degraded',
          dataState: 'empty',
          reason: 'empty',
        },
      ],
    })
  })

  it('propagates caller cancellation to Azure Monitor credentials and requests', async () => {
    const controller = new AbortController()
    const credentialSignals: Array<{ readonly aborted: boolean }> = []
    const connector = new AzureMonitorOtelConnector(
      config,
      {
        getToken: (_scopes, options) => {
          if (options?.abortSignal !== undefined) credentialSignals.push(options.abortSignal)
          return Promise.resolve({ token: 'token', expiresOnTimestamp: Date.now() + 60_000 })
        },
      },
      vi.fn<typeof fetch>().mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      ),
    )
    const pending = connector.readObservationWindows(runtimeRequest, { signal: controller.signal })

    await Promise.resolve()
    controller.abort()

    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
    expect(credentialSignals).toHaveLength(1)
    expect(credentialSignals[0]?.aborted).toBe(true)
  })

  it('cancels a stalled streamed response body when the caller aborts', async () => {
    const controller = new AbortController()
    const connector = new AzureMonitorOtelConnector(
      config,
      new Credential(),
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => undefined),
          }),
        ),
      ),
    )
    const pending = connector.readObservationWindows(runtimeRequest, { signal: controller.signal })

    await Promise.resolve()
    controller.abort()

    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
  }, 1_000)

  it.each([
    {
      name: 'declared content length',
      response: () =>
        new Response('x'.repeat(1_025), {
          headers: { 'content-length': '1025' },
        }),
    },
    {
      name: 'streamed bytes without content length',
      response: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('x'.repeat(1_025)))
              controller.close()
            },
          }),
        ),
    },
  ])('rejects a response above the byte limit from $name', async ({ response }) => {
    const connector = new AzureMonitorOtelConnector(
      { ...config, maxResponseBytes: 1_024 },
      new Credential(),
      vi.fn<typeof fetch>().mockResolvedValue(response()),
    )

    await expect(connector.readObservationWindows(runtimeRequest)).rejects.toMatchObject({
      reason: 'response-too-large',
    })
  })

  it('parses multi-source configuration and rejects a mismatched source request', async () => {
    const sources = parseAzureMonitorOtelSources({
      AZURE_MONITOR_SOURCES_JSON: JSON.stringify([
        {
          id: 'project-a',
          name: 'Project A',
          workspaceId: config.workspaceId,
          providerResourceId: config.providerResourceId,
          applicationRoleName: config.applicationRoleName,
          requestName: config.requestName,
          tenantId: config.tenantId,
          sourceProjectId: config.sourceProjectId,
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
          providerResourceId: config.providerResourceId,
          applicationRoleName: config.applicationRoleName,
          requestName: config.requestName,
          tenantId: config.tenantId,
          sourceProjectId: config.sourceProjectId,
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
        snapshotGeneratedAt: '2026-08-24T12:00:00.000Z',
        estateId: 'estate-a',
        estateEnvironment: 'portfolio',
        tenantId: 'estate',
        agentId: 'aggregate-agent',
        sourceConnectorId: 'project-a',
        sourceTenantId: config.tenantId,
        sourceProjectId: config.sourceProjectId,
        sourceAgentId: 'provider-project-a',
        sourceEnvironment: config.environment,
      }),
    ).rejects.toThrow()
    expect(connector.getConnectorHealth()).toMatchObject({
      overall: 'unavailable',
      partial: false,
      sources: [{ id: 'otel:project-a', readiness: 'unavailable', dataState: 'failed' }],
    })
  })

  it('rejects unsafe bindings and invalid time configuration', () => {
    expect(() =>
      buildAzureMonitorOtelQuery({
        ...queryBinding,
        agentId: "agent' | take 100",
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

    await expect(connector.readObservationWindows(runtimeRequest)).rejects.toThrow('status 403')
  })
})
