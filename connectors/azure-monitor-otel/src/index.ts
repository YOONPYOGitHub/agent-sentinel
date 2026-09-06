import { createHash } from 'node:crypto'

import { runtimeObservationWindowsSchema } from '@agent-sentinel/connector-sdk'
import type {
  ConnectorHealthReport,
  RuntimeTelemetryRequest,
  RuntimeObservationWindows,
  RuntimeTelemetryConnector,
} from '@agent-sentinel/connector-sdk'
import {
  observationWindowSchema,
  runtimeObservationSchema,
  type RuntimeObservation,
} from '@agent-sentinel/domain'
import type { TokenCredential } from '@azure/core-auth'
import {
  ClientAssertionCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity'
import { z } from 'zod'

export {
  MAX_REPRESENTATIVE_OTEL_PAGES,
  MAX_REPRESENTATIVE_OTEL_OBSERVATIONS,
  MAX_REPRESENTATIVE_OTEL_RECORDS,
  MAX_REPRESENTATIVE_OTEL_RECORDS_PER_PAGE,
  normalizeRepresentativeOtelEvidence,
  representativeOtelInputRecordSchema,
  representativeOtelPageSchema,
  representativeOtelWindowBindingSchema,
  type RepresentativeOtelInputRecord,
  type RepresentativeOtelPage,
  type RepresentativeOtelWindowBinding,
  type RepresentativeOtelWindowNormalization,
} from './representative-evidence.js'

const LOGS_SCOPE = 'https://api.loganalytics.io/.default'
const LOGS_ORIGIN = 'https://api.loganalytics.io'
const MAX_QUERY_ROWS = 10_000
const MAX_QUERY_HOURS = 24 * 31
const WINDOW_ALIGNMENT_MS = 5 * 60 * 1_000
const SAFE_BINDING = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,199}$/

const bindingSchema = z.string().trim().min(1).max(200).regex(SAFE_BINDING)

export const azureMonitorOtelConfigSchema = z.strictObject({
  workspaceId: z.uuid(),
  tenantId: bindingSchema,
  environment: bindingSchema,
  baselineWindowHours: z.number().int().min(1).max(MAX_QUERY_HOURS).default(168),
  observedWindowHours: z.number().int().min(1).max(168).default(24),
  requestTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
})
export type AzureMonitorOtelConfig = z.infer<typeof azureMonitorOtelConfigSchema>

const telemetrySourceCredentialSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('default'),
    managedIdentityClientId: z.string().uuid().optional(),
  }),
  z.strictObject({
    mode: z.literal('federated-app'),
    clientId: z.string().uuid(),
    managedIdentityClientId: z.string().uuid().optional(),
  }),
])

export const azureMonitorOtelSourceConfigSchema = azureMonitorOtelConfigSchema.extend({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().trim().min(1).max(100),
  credential: telemetrySourceCredentialSchema.optional(),
})
export type AzureMonitorOtelSourceConfig = z.infer<typeof azureMonitorOtelSourceConfigSchema>
export type AzureMonitorCredentialFactory = (
  source: AzureMonitorOtelSourceConfig,
) => TokenCredential
export type AzureMonitorOtelRuntimeMode = 'mock' | 'live'
export interface AzureMonitorOtelRuntimeActivation {
  active: boolean
  sources: AzureMonitorOtelSourceConfig[]
}

const azureMonitorOtelSourcesConfigSchema = z
  .array(azureMonitorOtelSourceConfigSchema)
  .min(1)
  .max(50)
  .superRefine((sources, context) => {
    const ids = new Set<string>()
    for (const [index, source] of sources.entries()) {
      if (ids.has(source.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `Duplicate Azure Monitor source id: ${source.id}`,
        })
      }
      ids.add(source.id)
    }
  })

function createTelemetrySourceCredential(source: AzureMonitorOtelSourceConfig): TokenCredential {
  if (source.credential?.mode === 'federated-app') {
    const managedIdentityClientId =
      source.credential.managedIdentityClientId ?? process.env['AZURE_CLIENT_ID']?.trim()
    if (!managedIdentityClientId) {
      throw new AzureMonitorOtelConnectorError(
        'Cross-tenant telemetry federation requires a user-assigned managed identity client ID.',
      )
    }
    const assertionCredential = new ManagedIdentityCredential({
      clientId: managedIdentityClientId,
    })
    return new ClientAssertionCredential(source.tenantId, source.credential.clientId, async () => {
      const assertion = await assertionCredential.getToken('api://AzureADTokenExchange/.default')
      if (assertion === null) {
        throw new AzureMonitorOtelConnectorError(
          'Managed identity did not return a workload identity federation assertion.',
        )
      }
      return assertion.token
    })
  }
  return new DefaultAzureCredential({
    tenantId: source.tenantId,
    ...(source.credential?.managedIdentityClientId !== undefined
      ? { managedIdentityClientId: source.credential.managedIdentityClientId }
      : {}),
  })
}

export const runtimeTelemetryRequestSchema = z.strictObject({
  tenantId: bindingSchema,
  agentId: bindingSchema,
})

const rowBindingSchema = runtimeTelemetryRequestSchema.extend({
  environment: bindingSchema,
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
})

const expectedColumns = [
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
] as const

const queryTableSchema = z.strictObject({
  name: z.literal('PrimaryResult'),
  columns: z
    .array(
      z.strictObject({
        name: z.string(),
        type: z.string(),
      }),
    )
    .length(expectedColumns.length),
  rows: z.array(z.array(z.unknown()).length(expectedColumns.length)).max(MAX_QUERY_ROWS + 1),
})

export const azureMonitorLogsQueryResponseSchema = z.strictObject({
  tables: z.array(queryTableSchema).length(1),
})
export type AzureMonitorLogsQueryResponse = z.infer<typeof azureMonitorLogsQueryResponseSchema>

export class AzureMonitorOtelConnectorError extends Error {
  override readonly name = 'AzureMonitorOtelConnectorError'
}

function assertColumns(response: AzureMonitorLogsQueryResponse): void {
  const columns = response.tables[0]?.columns ?? []
  for (const [index, expected] of expectedColumns.entries()) {
    const actual = columns[index]
    if (actual?.name !== expected[0] || actual.type !== expected[1]) {
      throw new AzureMonitorOtelConnectorError(
        `Azure Monitor query column ${index} must be ${expected[0]} (${expected[1]}).`,
      )
    }
  }
}

const projectedRowSchema = z.strictObject({
  ObservationId: z.string().trim().min(1).max(200),
  ObservedAt: z.iso.datetime(),
  TenantId: bindingSchema,
  AgentId: bindingSchema,
  Environment: bindingSchema,
  AgentRunId: z.string().trim().max(200).nullable(),
  CorrelationId: z.string().trim().max(200).nullable(),
  AgentVersion: z.string().trim().max(200).nullable(),
  LatencyMs: z.number().int().min(0).max(300_000).nullable(),
  InputTokens: z.number().int().min(0).max(1_000_000).nullable(),
  OutputTokens: z.number().int().min(0).max(1_000_000).nullable(),
  CostUsd: z.number().min(0).max(10_000).nullable(),
  Success: z.boolean(),
  ErrorCode: z.string().max(100).nullable(),
  ToolCallNames: z.string().max(20_000).nullable(),
  Synthetic: z.boolean(),
})

function parseToolCallNames(value: string | null): string[] {
  if (value === null || value === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new AzureMonitorOtelConnectorError('ToolCallNames must be a JSON string array.')
  }
  return z.array(z.string().trim().min(1).max(200)).max(50).parse(parsed)
}

function rowCorrelations(
  row: Pick<z.infer<typeof projectedRowSchema>, 'AgentRunId' | 'CorrelationId' | 'AgentVersion'>,
) {
  return [
    ...(row.AgentRunId ? [{ kind: 'agent-run-id' as const, value: row.AgentRunId }] : []),
    ...(row.CorrelationId ? [{ kind: 'correlation-id' as const, value: row.CorrelationId }] : []),
    ...(row.AgentVersion ? [{ kind: 'agent-version' as const, value: row.AgentVersion }] : []),
  ]
}

export function mapAzureMonitorRows(
  value: unknown,
  binding: {
    tenantId: string
    agentId: string
    environment: string
    windowStart: string
    windowEnd: string
  },
): RuntimeObservation[] {
  const expectedBinding = rowBindingSchema.parse(binding)
  const response = azureMonitorLogsQueryResponseSchema.parse(value)
  assertColumns(response)
  const table = response.tables[0]
  if (table === undefined)
    throw new AzureMonitorOtelConnectorError('Azure Monitor returned no table.')
  if (table.rows.length > MAX_QUERY_ROWS) {
    throw new AzureMonitorOtelConnectorError(
      `Azure Monitor returned more than ${MAX_QUERY_ROWS} rows for the bounded window.`,
    )
  }

  const startMs = new Date(expectedBinding.windowStart).getTime()
  const endMs = new Date(expectedBinding.windowEnd).getTime()
  if (endMs <= startMs) {
    throw new AzureMonitorOtelConnectorError('The requested telemetry window is invalid.')
  }

  return table.rows.map((values, index) => {
    const row = projectedRowSchema.parse(
      Object.fromEntries(expectedColumns.map(([name], columnIndex) => [name, values[columnIndex]])),
    )
    const observedAtMs = new Date(row.ObservedAt).getTime()
    if (
      row.TenantId !== expectedBinding.tenantId ||
      row.AgentId !== expectedBinding.agentId ||
      row.Environment !== expectedBinding.environment ||
      observedAtMs < startMs ||
      observedAtMs > endMs
    ) {
      throw new AzureMonitorOtelConnectorError(
        `Azure Monitor row ${index} does not match the requested tenant, agent, environment, or time window.`,
      )
    }

    return runtimeObservationSchema.parse({
      id: row.ObservationId,
      tenantId: row.TenantId,
      agentId: row.AgentId,
      environment: row.Environment,
      source: 'azure-monitor-otel',
      observedAt: row.ObservedAt,
      correlations: rowCorrelations(row),
      ...(row.LatencyMs !== null ? { latencyMs: row.LatencyMs } : {}),
      ...(row.InputTokens !== null ? { inputTokens: row.InputTokens } : {}),
      ...(row.OutputTokens !== null ? { outputTokens: row.OutputTokens } : {}),
      ...(row.CostUsd !== null ? { costUsd: row.CostUsd } : {}),
      success: row.Success,
      ...(row.ErrorCode !== null && row.ErrorCode !== '' ? { errorCode: row.ErrorCode } : {}),
      toolCallNames: parseToolCallNames(row.ToolCallNames),
      synthetic: row.Synthetic,
    })
  })
}

function kqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Fixed, read-only query over AppRequests. Caller input is used only after
 * strict binding validation and literal escaping; no table/operator is configurable.
 */
export function buildAzureMonitorOtelQuery(binding: {
  tenantId: string
  agentId: string
  environment: string
  maximumRows?: number
}): string {
  const parsed = z
    .strictObject({
      tenantId: bindingSchema,
      agentId: bindingSchema,
      environment: bindingSchema,
      maximumRows: z
        .number()
        .int()
        .min(1)
        .max(MAX_QUERY_ROWS + 1)
        .default(MAX_QUERY_ROWS + 1),
    })
    .parse(binding)
  return [
    'AppRequests',
    '| extend OtelAttributes = Properties',
    '| extend TenantId = tostring(OtelAttributes["agent.sentinel.tenant_id"]),',
    '         AgentId = tostring(OtelAttributes["gen_ai.agent.id"]),',
    '         Environment = tostring(OtelAttributes["deployment.environment.name"])',
    `| where TenantId == ${kqlString(parsed.tenantId)}`,
    `| where AgentId == ${kqlString(parsed.agentId)}`,
    `| where Environment == ${kqlString(parsed.environment)}`,
    '| project ObservationId = coalesce(tostring(OtelAttributes["agent.sentinel.observation_id"]), Id, OperationId),',
    '          ObservedAt = TimeGenerated, TenantId, AgentId, Environment,',
    '          AgentRunId = tostring(coalesce(OtelAttributes["gen_ai.agent.run.id"], OtelAttributes["agent.sentinel.run_id"])),',
    '          CorrelationId = tostring(coalesce(OtelAttributes["agent.sentinel.correlation_id"], OperationId)),',
    '          AgentVersion = tostring(OtelAttributes["gen_ai.agent.version"]),',
    '          LatencyMs = tolong(round(DurationMs)),',
    '          InputTokens = tolong(coalesce(OtelAttributes["gen_ai.usage.input_tokens"], OtelAttributes["gen_ai.usage.prompt_tokens"])),',
    '          OutputTokens = tolong(coalesce(OtelAttributes["gen_ai.usage.output_tokens"], OtelAttributes["gen_ai.usage.completion_tokens"])),',
    '          CostUsd = todouble(OtelAttributes["agent.sentinel.cost.usd"]),',
    '          Success = tobool(Success),',
    '          ErrorCode = iff(tobool(Success), "", tostring(coalesce(OtelAttributes["error.type"], ResultCode))),',
    '          ToolCallNames = tostring(OtelAttributes["agent.sentinel.tool_call_names"]),',
    '          Synthetic = tobool(coalesce(OtelAttributes["agent.sentinel.synthetic"], false))',
    '| order by ObservedAt asc',
    `| take ${String(parsed.maximumRows)}`,
  ].join('\n')
}

function evidenceId(
  kind: 'baseline' | 'observed',
  windowId: string,
  observations: RuntimeObservation[],
): string {
  const compareCodeUnits = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0
  const canonicalObservations = observations
    .map((observation) => [
      observation.id,
      observation.tenantId,
      observation.agentId,
      observation.environment,
      observation.source,
      observation.observedAt,
      observation.latencyMs ?? null,
      observation.inputTokens ?? null,
      observation.outputTokens ?? null,
      observation.costUsd ?? null,
      observation.success,
      observation.errorCode ?? null,
      observation.toolCallNames,
      observation.synthetic,
      observation.correlations === undefined
        ? null
        : [...observation.correlations]
            .sort((left, right) => compareCodeUnits(left.kind, right.kind))
            .map((correlation) => [correlation.kind, correlation.value]),
    ])
    .map((observation) => JSON.stringify(observation))
    .sort(compareCodeUnits)
  return `otel-${kind}-${createHash('sha256')
    .update(`${windowId}\0${JSON.stringify(canonicalObservations)}`)
    .digest('hex')
    .slice(0, 16)}`
}

function windowId(
  kind: 'baseline' | 'observed',
  binding: string,
  start: string,
  end: string,
): string {
  return `otel-${kind}-${createHash('sha256')
    .update(`${binding}\0${start}\0${end}`)
    .digest('hex')
    .slice(0, 16)}`
}

function errorFromBody(body: unknown, status: number): AzureMonitorOtelConnectorError {
  const code =
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'object' &&
    body.error !== null &&
    'code' in body.error &&
    typeof body.error.code === 'string'
      ? ` (${body.error.code})`
      : ''
  return new AzureMonitorOtelConnectorError(
    `Azure Monitor Logs query failed with status ${status}${code}.`,
  )
}

export class AzureMonitorOtelConnector implements RuntimeTelemetryConnector {
  readonly id = 'azure-monitor-otel'
  private readonly config: AzureMonitorOtelConfig

  constructor(
    config: z.input<typeof azureMonitorOtelConfigSchema>,
    private readonly credential: TokenCredential,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.config = azureMonitorOtelConfigSchema.parse(config)
  }

  async readObservationWindows(request: {
    tenantId: string
    agentId: string
  }): Promise<RuntimeObservationWindows> {
    const binding = runtimeTelemetryRequestSchema.parse(request)
    if (binding.tenantId !== this.config.tenantId) {
      throw new AzureMonitorOtelConnectorError(
        'The requested tenant does not match the configured telemetry tenant.',
      )
    }

    const queryTime = this.clock()
    const queriedAt = queryTime.toISOString()
    const observedEnd = new Date(
      Math.floor(queryTime.getTime() / WINDOW_ALIGNMENT_MS) * WINDOW_ALIGNMENT_MS,
    ).toISOString()
    const observedStart = new Date(
      new Date(observedEnd).getTime() - this.config.observedWindowHours * 60 * 60 * 1000,
    ).toISOString()
    const baselineEnd = observedStart
    const baselineStart = new Date(
      new Date(baselineEnd).getTime() - this.config.baselineWindowHours * 60 * 60 * 1000,
    ).toISOString()
    const token = await this.credential.getToken(LOGS_SCOPE)
    if (token === null) {
      throw new AzureMonitorOtelConnectorError(
        'Azure credential did not return an Azure Monitor Logs access token.',
      )
    }

    const url = new URL(`/v1/workspaces/${this.config.workspaceId}/query`, LOGS_ORIGIN)
    const response = await this.fetcher(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + token.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: buildAzureMonitorOtelQuery({
          tenantId: binding.tenantId,
          agentId: binding.agentId,
          environment: this.config.environment,
        }),
        timespan: `${baselineStart}/${observedEnd}`,
      }),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    })

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new AzureMonitorOtelConnectorError('Azure Monitor Logs returned a non-JSON response.')
    }
    if (!response.ok) throw errorFromBody(body, response.status)

    const observations = mapAzureMonitorRows(body, {
      tenantId: binding.tenantId,
      agentId: binding.agentId,
      environment: this.config.environment,
      windowStart: baselineStart,
      windowEnd: observedEnd,
    })
    const baseBinding = `${binding.tenantId}\0${binding.agentId}\0${this.config.environment}`
    const baselineWindowId = windowId('baseline', baseBinding, baselineStart, baselineEnd)
    const observedWindowId = windowId('observed', baseBinding, observedStart, observedEnd)
    const baseline = observationWindowSchema.parse({
      windowId: baselineWindowId,
      tenantId: binding.tenantId,
      agentId: binding.agentId,
      environment: this.config.environment,
      source: 'azure-monitor-otel',
      windowStart: baselineStart,
      windowEnd: baselineEnd,
      observations: observations.filter(
        (item) => new Date(item.observedAt).getTime() < new Date(baselineEnd).getTime(),
      ),
    })
    const observed = observationWindowSchema.parse({
      windowId: observedWindowId,
      tenantId: binding.tenantId,
      agentId: binding.agentId,
      environment: this.config.environment,
      source: 'azure-monitor-otel',
      windowStart: observedStart,
      windowEnd: observedEnd,
      observations: observations.filter(
        (item) => new Date(item.observedAt).getTime() >= new Date(observedStart).getTime(),
      ),
    })

    return runtimeObservationWindowsSchema.parse({
      baseline,
      observed,
      baselineEvidenceId: evidenceId('baseline', baselineWindowId, baseline.observations),
      observedEvidenceId: evidenceId('observed', observedWindowId, observed.observations),
      queriedAt,
    })
  }
}

interface TelemetrySourceState {
  config: AzureMonitorOtelSourceConfig
  connector: AzureMonitorOtelConnector
  readiness: 'ready' | 'degraded' | 'unavailable'
  checkedAt: string | undefined
  reason: string | undefined
}

function rebindWindows(
  windows: RuntimeObservationWindows,
  request: RuntimeTelemetryRequest,
  source: AzureMonitorOtelSourceConfig,
): RuntimeObservationWindows {
  const boundedId = (kind: string, original: string): string =>
    `otel-${kind}-${createHash('sha256').update(`${source.id}\0${original}`).digest('hex')}`
  const rebindWindow = (window: RuntimeObservationWindows['baseline']) => ({
    ...window,
    windowId: boundedId('window', window.windowId),
    tenantId: request.tenantId,
    agentId: request.agentId,
    observations: window.observations.map((observation) => ({
      ...observation,
      id: boundedId('observation', observation.id),
      tenantId: request.tenantId,
      agentId: request.agentId,
    })),
  })
  return runtimeObservationWindowsSchema.parse({
    baseline: rebindWindow(windows.baseline),
    observed: rebindWindow(windows.observed),
    baselineEvidenceId: boundedId('evidence', windows.baselineEvidenceId),
    observedEvidenceId: boundedId('evidence', windows.observedEvidenceId),
    queriedAt: windows.queriedAt,
  })
}

export class MultiAzureMonitorOtelConnector implements RuntimeTelemetryConnector {
  readonly id = 'azure-monitor-otel'
  private readonly sources: TelemetrySourceState[]

  constructor(
    sourcesInput: readonly AzureMonitorOtelSourceConfig[],
    credentialFactory: AzureMonitorCredentialFactory = createTelemetrySourceCredential,
    fetcherFactory: (source: AzureMonitorOtelSourceConfig) => typeof fetch = () => fetch,
    clock: () => Date = () => new Date(),
  ) {
    const sources = azureMonitorOtelSourcesConfigSchema.parse(sourcesInput)
    this.sources = sources.map((config) => ({
      config,
      connector: new AzureMonitorOtelConnector(
        {
          workspaceId: config.workspaceId,
          tenantId: config.tenantId,
          environment: config.environment,
          baselineWindowHours: config.baselineWindowHours,
          observedWindowHours: config.observedWindowHours,
          requestTimeoutMs: config.requestTimeoutMs,
        },
        credentialFactory(config),
        fetcherFactory(config),
        clock,
      ),
      readiness: 'degraded',
      checkedAt: undefined,
      reason: 'not-queried',
    }))
  }

  async readObservationWindows(
    request: RuntimeTelemetryRequest,
  ): Promise<RuntimeObservationWindows> {
    const source =
      request.sourceConnectorId === undefined && this.sources.length === 1
        ? this.sources[0]
        : this.sources.find((candidate) => candidate.config.id === request.sourceConnectorId)
    if (source === undefined) {
      throw new AzureMonitorOtelConnectorError(
        'No Azure Monitor source matches the requested agent source.',
      )
    }
    const sourceTenantId = request.sourceTenantId ?? source.config.tenantId
    const sourceEnvironment = request.sourceEnvironment ?? source.config.environment
    const sourceAgentId = request.sourceAgentId ?? request.agentId
    if (
      sourceTenantId.toLowerCase() !== source.config.tenantId.toLowerCase() ||
      sourceEnvironment !== source.config.environment
    ) {
      throw new AzureMonitorOtelConnectorError(
        'The requested agent source boundary does not match the Azure Monitor source.',
      )
    }
    try {
      const windows = await source.connector.readObservationWindows({
        tenantId: source.config.tenantId,
        agentId: sourceAgentId,
      })
      source.readiness = 'ready'
      source.checkedAt = windows.queriedAt
      source.reason = undefined
      return rebindWindows(windows, request, source.config)
    } catch (error) {
      source.readiness = 'unavailable'
      source.checkedAt = new Date().toISOString()
      source.reason = 'query-failed'
      throw error
    }
  }

  getConnectorHealth(): ConnectorHealthReport {
    const ready = this.sources.filter((source) => source.readiness === 'ready').length
    const allUnavailable = this.sources.every((source) => source.readiness === 'unavailable')
    return {
      overall: allUnavailable
        ? 'unavailable'
        : ready === this.sources.length
          ? 'ready'
          : 'degraded',
      partial: ready > 0 && ready < this.sources.length,
      sources: this.sources.map((source) => ({
        id: `otel:${source.config.id}`,
        name: `${source.config.name} · Azure Monitor`,
        role: 'enrichment',
        enabled: true,
        configured: true,
        readiness: source.readiness,
        ...(source.checkedAt !== undefined ? { checkedAt: source.checkedAt } : {}),
        ...(source.reason !== undefined ? { reason: source.reason } : {}),
      })),
    }
  }
}

function numberValue(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = environment[name]?.trim()
  return value === undefined || value === '' ? fallback : Number(value)
}

export function parseAzureMonitorOtelSources(
  environment: NodeJS.ProcessEnv = process.env,
): AzureMonitorOtelSourceConfig[] {
  const sourcesJson = environment['AZURE_MONITOR_SOURCES_JSON']?.trim()
  if (sourcesJson !== undefined && sourcesJson.length > 0) {
    let sources: unknown
    try {
      sources = JSON.parse(sourcesJson)
    } catch {
      throw new AzureMonitorOtelConnectorError('AZURE_MONITOR_SOURCES_JSON must be valid JSON.')
    }
    return azureMonitorOtelSourcesConfigSchema.parse(sources)
  }
  const names = [
    'AZURE_MONITOR_WORKSPACE_ID',
    'AZURE_MONITOR_TENANT_ID',
    'AZURE_MONITOR_ENVIRONMENT',
  ] as const
  const configured = names.filter((name) => (environment[name]?.trim().length ?? 0) > 0)
  if (configured.length === 0) return []
  if (configured.length !== names.length) return []
  return [
    azureMonitorOtelSourceConfigSchema.parse({
      id: 'primary',
      name: 'Primary Foundry project',
      workspaceId: environment.AZURE_MONITOR_WORKSPACE_ID,
      tenantId: environment.AZURE_MONITOR_TENANT_ID,
      environment: environment.AZURE_MONITOR_ENVIRONMENT,
      baselineWindowHours: numberValue(environment, 'AZURE_MONITOR_BASELINE_WINDOW_HOURS', 168),
      observedWindowHours: numberValue(environment, 'AZURE_MONITOR_OBSERVED_WINDOW_HOURS', 24),
      requestTimeoutMs: numberValue(environment, 'AZURE_MONITOR_REQUEST_TIMEOUT_MS', 15_000),
    }),
  ]
}

export function isAzureMonitorOtelRuntimeActive(
  mode: AzureMonitorOtelRuntimeMode,
  sources: readonly AzureMonitorOtelSourceConfig[],
): boolean {
  return mode === 'live' && sources.length > 0
}

export function resolveAzureMonitorOtelRuntimeActivation(
  environment: NodeJS.ProcessEnv = process.env,
  mode: AzureMonitorOtelRuntimeMode = 'live',
): AzureMonitorOtelRuntimeActivation {
  if (mode !== 'live') return { active: false, sources: [] }
  const sources = parseAzureMonitorOtelSources(environment)
  return {
    active: isAzureMonitorOtelRuntimeActive(mode, sources),
    sources,
  }
}

export function createAzureMonitorOtelConnector(
  environment: NodeJS.ProcessEnv = process.env,
  credential?: TokenCredential,
  mode: AzureMonitorOtelRuntimeMode = 'live',
): MultiAzureMonitorOtelConnector | undefined {
  const activation = resolveAzureMonitorOtelRuntimeActivation(environment, mode)
  if (!activation.active) return undefined
  return new MultiAzureMonitorOtelConnector(
    activation.sources,
    (source) => credential ?? createTelemetrySourceCredential(source),
  )
}
