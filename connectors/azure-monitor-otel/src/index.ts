import { createHash } from 'node:crypto'

import { runtimeObservationWindowsSchema } from '@agent-sentinel/connector-sdk'
import type {
  RuntimeObservationWindows,
  RuntimeTelemetryConnector,
} from '@agent-sentinel/connector-sdk'
import {
  observationWindowSchema,
  runtimeObservationSchema,
  type RuntimeObservation,
} from '@agent-sentinel/domain'
import type { TokenCredential } from '@azure/core-auth'
import { DefaultAzureCredential } from '@azure/identity'
import { z } from 'zod'

const LOGS_SCOPE = 'https://api.loganalytics.io/.default'
const LOGS_ORIGIN = 'https://api.loganalytics.io'
const MAX_QUERY_ROWS = 10_000
const MAX_QUERY_HOURS = 24 * 31
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
  ['LatencyMs', 'long'],
  ['InputTokens', 'long'],
  ['OutputTokens', 'long'],
  ['CostUsd', 'real'],
  ['Success', 'bool'],
  ['ErrorCode', 'string'],
  ['ToolCallNames', 'string'],
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
  LatencyMs: z.number().int().min(0).max(300_000).nullable(),
  InputTokens: z.number().int().min(0).max(1_000_000).nullable(),
  OutputTokens: z.number().int().min(0).max(1_000_000).nullable(),
  CostUsd: z.number().min(0).max(10_000).nullable(),
  Success: z.boolean(),
  ErrorCode: z.string().max(100).nullable(),
  ToolCallNames: z.string().max(20_000).nullable(),
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
      ...(row.LatencyMs !== null ? { latencyMs: row.LatencyMs } : {}),
      ...(row.InputTokens !== null ? { inputTokens: row.InputTokens } : {}),
      ...(row.OutputTokens !== null ? { outputTokens: row.OutputTokens } : {}),
      ...(row.CostUsd !== null ? { costUsd: row.CostUsd } : {}),
      success: row.Success,
      ...(row.ErrorCode !== null && row.ErrorCode !== '' ? { errorCode: row.ErrorCode } : {}),
      toolCallNames: parseToolCallNames(row.ToolCallNames),
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
    '          LatencyMs = tolong(round(DurationMs)),',
    '          InputTokens = tolong(coalesce(OtelAttributes["gen_ai.usage.input_tokens"], OtelAttributes["gen_ai.usage.prompt_tokens"])),',
    '          OutputTokens = tolong(coalesce(OtelAttributes["gen_ai.usage.output_tokens"], OtelAttributes["gen_ai.usage.completion_tokens"])),',
    '          CostUsd = todouble(OtelAttributes["agent.sentinel.cost.usd"]),',
    '          Success = tobool(Success),',
    '          ErrorCode = iff(tobool(Success), "", tostring(coalesce(OtelAttributes["error.type"], ResultCode))),',
    '          ToolCallNames = tostring(OtelAttributes["agent.sentinel.tool_call_names"])',
    '| order by ObservedAt asc',
    `| take ${String(parsed.maximumRows)}`,
  ].join('\n')
}

function evidenceId(kind: 'baseline' | 'observed', windowId: string): string {
  return `otel-${kind}-${createHash('sha256').update(windowId).digest('hex').slice(0, 16)}`
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

    const queriedAt = this.clock().toISOString()
    const observedEnd = queriedAt
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
      baselineEvidenceId: evidenceId('baseline', baselineWindowId),
      observedEvidenceId: evidenceId('observed', observedWindowId),
      queriedAt,
    })
  }
}

export function createAzureMonitorOtelConnector(
  environment: NodeJS.ProcessEnv = process.env,
  credential?: TokenCredential,
): AzureMonitorOtelConnector | undefined {
  const names = [
    'AZURE_MONITOR_WORKSPACE_ID',
    'AZURE_MONITOR_TENANT_ID',
    'AZURE_MONITOR_ENVIRONMENT',
  ] as const
  const configured = names.filter((name) => (environment[name]?.trim().length ?? 0) > 0)
  if (configured.length === 0) return undefined
  if (configured.length !== names.length) {
    return undefined
  }

  const numberValue = (name: string, fallback: number): number => {
    const value = environment[name]?.trim()
    return value === undefined || value === '' ? fallback : Number(value)
  }
  return new AzureMonitorOtelConnector(
    {
      workspaceId: environment.AZURE_MONITOR_WORKSPACE_ID!,
      tenantId: environment.AZURE_MONITOR_TENANT_ID!,
      environment: environment.AZURE_MONITOR_ENVIRONMENT!,
      baselineWindowHours: numberValue('AZURE_MONITOR_BASELINE_WINDOW_HOURS', 168),
      observedWindowHours: numberValue('AZURE_MONITOR_OBSERVED_WINDOW_HOURS', 24),
      requestTimeoutMs: numberValue('AZURE_MONITOR_REQUEST_TIMEOUT_MS', 15_000),
    },
    credential ?? new DefaultAzureCredential(),
  )
}
