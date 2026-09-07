import { createHash } from 'node:crypto'

import { runtimeObservationWindowsSchema } from '@agent-sentinel/connector-sdk'
import type {
  ConnectorOperationRequest,
  ConnectorHealthReport,
  LiveSourceDataState,
  RuntimeTelemetryRequest,
  RuntimeObservationWindows,
  RuntimeTelemetryConnector,
} from '@agent-sentinel/connector-sdk'
import {
  assessRuntimeOtelQuality,
  observationWindowSchema,
  runtimeOtelProvenanceSchema,
  runtimeObservationSchema,
  type OtelEvidenceCaveat,
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
  maxResponseBytes: z
    .number()
    .int()
    .min(1_024)
    .max(64 * 1024 * 1024)
    .default(4 * 1024 * 1024),
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
export type AzureMonitorOtelSourceConfigInput = z.input<typeof azureMonitorOtelSourceConfigSchema>
export type AzureMonitorCredentialFactory = (
  source: AzureMonitorOtelSourceConfig,
) => TokenCredential
export type AzureMonitorOtelRuntimeMode = 'mock' | 'live'
export interface AzureMonitorOtelRuntimeActivation {
  active: boolean
  sources: AzureMonitorOtelSourceConfig[]
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw new Error('Azure Monitor response body read was aborted.')
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      void reader.cancel(signal.reason).catch(() => undefined)
      reject(new Error('Azure Monitor response body read was aborted.'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void reader
      .read()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new AzureMonitorOtelConnectorError(
        'Azure Monitor Logs returned an invalid content-length header.',
      )
    }
    if (Number(declaredLength) > maximumBytes) {
      void response.body?.cancel().catch(() => undefined)
      throw new AzureMonitorOtelConnectorError(
        `Azure Monitor Logs response exceeded the ${maximumBytes} byte response limit.`,
        'response-too-large',
      )
    }
  }
  if (response.body === null) {
    throw new AzureMonitorOtelConnectorError('Azure Monitor Logs returned no response body.')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytesRead = 0
  while (true) {
    const chunk = await readResponseChunk(reader, signal)
    if (chunk.done) break
    bytesRead += chunk.value.byteLength
    if (bytesRead > maximumBytes) {
      void reader.cancel().catch(() => undefined)
      throw new AzureMonitorOtelConnectorError(
        `Azure Monitor Logs response exceeded the ${maximumBytes} byte response limit.`,
        'response-too-large',
      )
    }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(bytesRead)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new AzureMonitorOtelConnectorError('Azure Monitor Logs returned a non-JSON response.')
  }
}

interface AzureMonitorRowQuality {
  recordsReceived: number
  duplicatesRemoved: number
  caveats: readonly OtelEvidenceCaveat[]
}

function windowQuality(
  observations: readonly RuntimeObservation[],
  rowQuality: AzureMonitorRowQuality = {
    recordsReceived: observations.length,
    duplicatesRemoved: 0,
    caveats: [],
  },
) {
  if (observations.length === 0 && rowQuality.recordsReceived === 0) {
    return {
      status: 'unknown' as const,
      classification: 'unknown' as const,
      caveats: ['empty' as const],
      recordsReceived: 0,
      recordsAccepted: 0,
      duplicatesRemoved: 0,
      pagesProcessed: 1,
    }
  }
  const classifications = new Set(
    observations.map((observation) => (observation.synthetic ? 'synthetic' : 'live')),
  )
  const valid = observations.filter((observation) => {
    const parsed = runtimeOtelProvenanceSchema.safeParse(observation.otelProvenance)
    return (
      parsed.success &&
      parsed.data.sampling.state === 'complete' &&
      parsed.data.sampling.rate === 1 &&
      parsed.data.aggregation.kind === 'raw' &&
      !parsed.data.partial
    )
  })
  const available =
    observations.length > 0 &&
    valid.length === observations.length &&
    classifications.size === 1 &&
    rowQuality.caveats.length === 0
  const caveats = new Set<OtelEvidenceCaveat>(rowQuality.caveats)
  if (valid.length !== observations.length) caveats.add('invalid-record')
  if (classifications.size > 1) caveats.add('mixed-classification')
  return {
    status: available ? ('available' as const) : ('degraded' as const),
    classification:
      classifications.size > 1
        ? ('mixed' as const)
        : classifications.has('synthetic')
          ? ('synthetic' as const)
          : ('live' as const),
    caveats: [...caveats].sort(),
    recordsReceived: Math.min(rowQuality.recordsReceived * 6, 10_000),
    recordsAccepted: valid.length * 6,
    duplicatesRemoved: rowQuality.duplicatesRemoved,
    pagesProcessed: 1,
  }
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
  provenance: z
    .strictObject({
      estateId: bindingSchema,
      estateTenantId: bindingSchema,
      estateEnvironment: bindingSchema,
      sourceConnectorId: bindingSchema,
      sourceTenantId: bindingSchema,
      sourceEnvironment: bindingSchema,
      providerResourceId: bindingSchema,
      providerAgentId: bindingSchema,
    })
    .optional(),
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
  ['TraceId', 'string'],
  ['SpanId', 'string'],
  ['ItemCount', 'long'],
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
  override readonly name: string = 'AzureMonitorOtelConnectorError'

  constructor(
    message: string,
    readonly reason:
      'cancelled' | 'timeout' | 'query-failed' | 'response-too-large' = 'query-failed',
  ) {
    super(message)
  }
}

export class AzureMonitorOtelConfigurationError extends AzureMonitorOtelConnectorError {
  override readonly name: string = 'AzureMonitorOtelConfigurationError'
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
  TraceId: z.string().max(64).nullable(),
  SpanId: z.string().max(32).nullable(),
  ItemCount: z.number().int().min(1).max(1_000_000).nullable(),
})
type ProjectedRow = z.infer<typeof projectedRowSchema>

interface CanonicalAzureMonitorRows {
  rows: ProjectedRow[]
  recordsReceived: number
  duplicatesRemoved: number
  caveats: OtelEvidenceCaveat[]
}

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

const invocationClaimNames = [
  'invocation',
  'latency',
  'error',
  'input-tokens',
  'output-tokens',
  'cost',
] as const

function invocationEvidenceIds(
  providerResourceId: string,
  traceId: string,
  spanId: string,
): string[] {
  return invocationClaimNames.map(
    (claim) =>
      `otel-claim-${createHash('sha256')
        .update(`${providerResourceId}\0${traceId}\0${spanId}\0${claim}`)
        .digest('hex')
        .slice(0, 32)}`,
  )
}

function rowOtelProvenance(row: ProjectedRow, binding: z.infer<typeof rowBindingSchema>) {
  const provenance = binding.provenance
  if (
    provenance === undefined ||
    row.TraceId === null ||
    row.SpanId === null ||
    !/^[0-9a-f]{32}$/.test(row.TraceId) ||
    !/^[0-9a-f]{16}$/.test(row.SpanId) ||
    row.LatencyMs === null ||
    row.InputTokens === null ||
    row.OutputTokens === null ||
    row.CostUsd === null
  ) {
    return undefined
  }
  return runtimeOtelProvenanceSchema.parse({
    ...provenance,
    provider: 'azure-monitor-otel',
    traceId: row.TraceId,
    spanId: row.SpanId,
    observedAt: row.ObservedAt,
    classification: row.Synthetic ? 'synthetic' : 'live',
    sampling:
      row.ItemCount === 1
        ? { state: 'complete', rate: 1 }
        : row.ItemCount === null
          ? { state: 'unknown' }
          : { state: 'sampled', rate: 1 / row.ItemCount },
    aggregation: { kind: 'raw' },
    partial: false,
    evidenceIds: invocationEvidenceIds(provenance.providerResourceId, row.TraceId, row.SpanId),
  })
}

function parseAzureMonitorRows(
  value: unknown,
  binding: z.input<typeof rowBindingSchema>,
): { binding: z.infer<typeof rowBindingSchema>; rows: ProjectedRow[] } {
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

  const rows = table.rows.map((values, index) => {
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
    return row
  })
  return { binding: expectedBinding, rows }
}

function canonicalizeAzureMonitorRows(rows: readonly ProjectedRow[]): CanonicalAzureMonitorRows {
  const grouped = new Map<string, Array<{ canonical: string; row: ProjectedRow }>>()
  for (const row of rows) {
    const group = grouped.get(row.ObservationId) ?? []
    group.push({ canonical: JSON.stringify(row), row })
    grouped.set(row.ObservationId, group)
  }
  const canonicalRows: ProjectedRow[] = []
  const caveats = new Set<OtelEvidenceCaveat>()
  let duplicatesRemoved = 0
  for (const [, group] of [...grouped.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const variants = new Set(group.map((item) => item.canonical))
    if (variants.size > 1) {
      duplicatesRemoved += group.length
      caveats.add('conflicting-duplicate')
      continue
    }
    if (group.length > 1) {
      duplicatesRemoved += group.length - 1
      caveats.add('duplicate-record')
    }
    canonicalRows.push(group[0]!.row)
  }
  return {
    rows: canonicalRows,
    recordsReceived: rows.length,
    duplicatesRemoved,
    caveats: [...caveats].sort(),
  }
}

function runtimeObservationForRow(
  row: ProjectedRow,
  binding: z.infer<typeof rowBindingSchema>,
): RuntimeObservation {
  const otelProvenance = rowOtelProvenance(row, binding)
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
    ...(otelProvenance === undefined ? {} : { otelProvenance }),
  })
}

export function mapAzureMonitorRows(
  value: unknown,
  binding: z.input<typeof rowBindingSchema>,
): RuntimeObservation[] {
  const parsed = parseAzureMonitorRows(value, binding)
  return canonicalizeAzureMonitorRows(parsed.rows).rows.map((row) =>
    runtimeObservationForRow(row, parsed.binding),
  )
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
    '          Synthetic = tobool(coalesce(OtelAttributes["agent.sentinel.synthetic"], false)),',
    '          TraceId = tolower(tostring(coalesce(OtelAttributes["trace_id"], OtelAttributes["otel.trace_id"], OperationId))),',
    '          SpanId = tolower(tostring(coalesce(OtelAttributes["span_id"], OtelAttributes["otel.span_id"], extract(@"([0-9a-fA-F]{16})\\|?$", 1, Id), Id))),',
    '          ItemCount = tolong(ItemCount)',
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
      observation.otelProvenance ?? null,
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

  async readObservationWindows(
    request: {
      tenantId: string
      agentId: string
    },
    options: ConnectorOperationRequest = {},
  ): Promise<RuntimeObservationWindows> {
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
    const timeoutSignal = AbortSignal.timeout(this.config.requestTimeoutMs)
    const signal =
      options.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([options.signal, timeoutSignal])
    let token
    try {
      token = await this.credential.getToken(LOGS_SCOPE, { abortSignal: signal })
    } catch {
      if (options.signal?.aborted === true) {
        throw new AzureMonitorOtelConnectorError(
          'Azure Monitor Logs query was cancelled.',
          'cancelled',
        )
      }
      if (timeoutSignal.aborted) {
        throw new AzureMonitorOtelConnectorError(
          'Azure Monitor Logs credential acquisition timed out.',
          'timeout',
        )
      }
      throw new AzureMonitorOtelConnectorError(
        'Azure credential failed to return an Azure Monitor Logs access token.',
      )
    }
    if (token === null) {
      throw new AzureMonitorOtelConnectorError(
        'Azure credential did not return an Azure Monitor Logs access token.',
      )
    }

    const url = new URL(`/v1/workspaces/${this.config.workspaceId}/query`, LOGS_ORIGIN)
    let response: Response
    try {
      response = await this.fetcher(url, {
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
        signal,
      })
    } catch {
      if (options.signal?.aborted === true) {
        throw new AzureMonitorOtelConnectorError(
          'Azure Monitor Logs query was cancelled.',
          'cancelled',
        )
      }
      if (timeoutSignal.aborted) {
        throw new AzureMonitorOtelConnectorError('Azure Monitor Logs query timed out.', 'timeout')
      }
      throw new AzureMonitorOtelConnectorError(
        'Azure Monitor Logs query failed before a response was received.',
      )
    }

    let body: unknown
    try {
      body = await readBoundedJson(response, this.config.maxResponseBytes, signal)
    } catch (error) {
      if (error instanceof AzureMonitorOtelConnectorError) throw error
      if (options.signal?.aborted === true) {
        throw new AzureMonitorOtelConnectorError(
          'Azure Monitor Logs query was cancelled.',
          'cancelled',
        )
      }
      if (timeoutSignal.aborted) {
        throw new AzureMonitorOtelConnectorError(
          'Azure Monitor Logs response timed out.',
          'timeout',
        )
      }
      throw new AzureMonitorOtelConnectorError('Azure Monitor Logs returned a non-JSON response.')
    }
    if (!response.ok) throw errorFromBody(body, response.status)

    const parsedRows = parseAzureMonitorRows(body, {
      tenantId: binding.tenantId,
      agentId: binding.agentId,
      environment: this.config.environment,
      windowStart: baselineStart,
      windowEnd: observedEnd,
      provenance: {
        estateId: this.config.tenantId,
        estateTenantId: this.config.tenantId,
        estateEnvironment: this.config.environment,
        sourceConnectorId: 'direct',
        sourceTenantId: this.config.tenantId,
        sourceEnvironment: this.config.environment,
        providerResourceId: this.config.workspaceId,
        providerAgentId: binding.agentId,
      },
    })
    const baselineRows = canonicalizeAzureMonitorRows(
      parsedRows.rows.filter(
        (row) => new Date(row.ObservedAt).getTime() < new Date(baselineEnd).getTime(),
      ),
    )
    const observedRows = canonicalizeAzureMonitorRows(
      parsedRows.rows.filter(
        (row) => new Date(row.ObservedAt).getTime() >= new Date(observedStart).getTime(),
      ),
    )
    const baselineObservations = baselineRows.rows.map((row) =>
      runtimeObservationForRow(row, parsedRows.binding),
    )
    const observedObservations = observedRows.rows.map((row) =>
      runtimeObservationForRow(row, parsedRows.binding),
    )
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
      observations: baselineObservations,
      otelQuality: windowQuality(baselineObservations, baselineRows),
    })
    const observed = observationWindowSchema.parse({
      windowId: observedWindowId,
      tenantId: binding.tenantId,
      agentId: binding.agentId,
      environment: this.config.environment,
      source: 'azure-monitor-otel',
      windowStart: observedStart,
      windowEnd: observedEnd,
      observations: observedObservations,
      otelQuality: windowQuality(observedObservations, observedRows),
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
  dataState: LiveSourceDataState | undefined
  checkedAt: string | undefined
  reason: string | undefined
}

function runtimeDataState(windows: RuntimeObservationWindows): {
  state: LiveSourceDataState
  reason?: string
} {
  const observations = [...windows.baseline.observations, ...windows.observed.observations]
  const quality = [windows.baseline, windows.observed].map((window) =>
    assessRuntimeOtelQuality(window),
  )
  if (quality.some((item) => item.quality?.caveats.includes('stale'))) {
    return { state: 'stale', reason: 'stale' }
  }
  if (observations.length === 0) {
    return quality.some((item) => item.quality?.status === 'degraded')
      ? { state: 'partial', reason: 'degraded-quality' }
      : { state: 'empty', reason: 'empty' }
  }
  const provenance = windows.provenance
  const exactInvocationCount = observations.filter((observation) => {
    const parsed = runtimeOtelProvenanceSchema.safeParse(observation.otelProvenance)
    if (!parsed.success || provenance === undefined) return false
    const nested = parsed.data
    return (
      observation.tenantId === windows.observed.tenantId &&
      observation.agentId === windows.observed.agentId &&
      nested.estateId === provenance.estateId &&
      nested.estateTenantId === provenance.estateTenantId &&
      nested.estateEnvironment === provenance.estateEnvironment &&
      nested.sourceConnectorId === provenance.sourceConnectorId &&
      nested.sourceTenantId === provenance.sourceTenantId &&
      nested.sourceEnvironment === provenance.sourceEnvironment &&
      nested.provider === provenance.provider &&
      nested.providerResourceId === provenance.providerResourceId &&
      nested.providerAgentId === provenance.providerAgentId
    )
  }).length
  if (
    exactInvocationCount !== observations.length ||
    quality.some(
      (item) => item.quality?.status !== 'available' || item.validObservationIds.length === 0,
    )
  ) {
    return { state: 'partial', reason: 'degraded-quality' }
  }
  const classifications = new Set(
    observations.map((observation) => (observation.synthetic ? 'synthetic' : 'live')),
  )
  if (!classifications.has('live')) return { state: 'unsupported', reason: 'synthetic-only' }
  return classifications.size === 1
    ? { state: 'complete' }
    : { state: 'partial', reason: 'mixed-live-synthetic' }
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
      ...(observation.otelProvenance === undefined ||
      request.estateId === undefined ||
      request.estateEnvironment === undefined
        ? {}
        : {
            otelProvenance: {
              ...observation.otelProvenance,
              estateId: request.estateId,
              estateTenantId: request.tenantId,
              estateEnvironment: request.estateEnvironment,
              sourceConnectorId: source.id,
              sourceTenantId: source.tenantId,
              sourceEnvironment: source.environment,
              providerResourceId: source.workspaceId,
              providerAgentId: request.sourceAgentId ?? request.agentId,
            },
          }),
    })),
  })
  return runtimeObservationWindowsSchema.parse({
    baseline: rebindWindow(windows.baseline),
    observed: rebindWindow(windows.observed),
    baselineEvidenceId: boundedId('evidence', windows.baselineEvidenceId),
    observedEvidenceId: boundedId('evidence', windows.observedEvidenceId),
    queriedAt: windows.queriedAt,
    ...(request.estateId === undefined || request.estateEnvironment === undefined
      ? {}
      : {
          provenance: {
            estateId: request.estateId,
            estateTenantId: request.tenantId,
            estateEnvironment: request.estateEnvironment,
            sourceConnectorId: source.id,
            sourceTenantId: source.tenantId,
            sourceEnvironment: source.environment,
            provider: 'azure-monitor-otel',
            providerResourceId: source.workspaceId,
            providerAgentId: request.sourceAgentId ?? request.agentId,
          },
        }),
  })
}

export class MultiAzureMonitorOtelConnector implements RuntimeTelemetryConnector {
  readonly id = 'azure-monitor-otel'
  private readonly sources: TelemetrySourceState[]

  constructor(
    sourcesInput: readonly AzureMonitorOtelSourceConfigInput[],
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
          maxResponseBytes: config.maxResponseBytes,
        },
        credentialFactory(config),
        fetcherFactory(config),
        clock,
      ),
      readiness: 'degraded',
      dataState: undefined,
      checkedAt: undefined,
      reason: 'not-queried',
    }))
  }

  async readObservationWindows(
    request: RuntimeTelemetryRequest,
    options: ConnectorOperationRequest = {},
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
      const windows = await source.connector.readObservationWindows(
        {
          tenantId: source.config.tenantId,
          agentId: sourceAgentId,
        },
        options,
      )
      const rebound = rebindWindows(windows, request, source.config)
      const dataState = runtimeDataState(rebound)
      source.dataState = dataState.state
      source.readiness = dataState.state === 'complete' ? 'ready' : 'degraded'
      source.checkedAt = rebound.queriedAt
      source.reason = dataState.reason
      return rebound
    } catch (error) {
      source.dataState =
        error instanceof AzureMonitorOtelConnectorError && error.reason === 'cancelled'
          ? 'cancelled'
          : 'failed'
      source.readiness = 'unavailable'
      source.checkedAt = new Date().toISOString()
      source.reason = source.dataState === 'cancelled' ? 'cancelled' : 'query-failed'
      throw error
    }
  }

  getConnectorHealth(): ConnectorHealthReport {
    const ready = this.sources.filter(
      (source) => source.readiness === 'ready' && source.dataState === 'complete',
    ).length
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
        ...(source.dataState !== undefined ? { dataState: source.dataState } : {}),
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
      throw new AzureMonitorOtelConfigurationError('AZURE_MONITOR_SOURCES_JSON must be valid JSON.')
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
  if (configured.length !== names.length) {
    const missing = names.filter((name) => !configured.includes(name))
    throw new AzureMonitorOtelConfigurationError(
      `Legacy Azure Monitor configuration requires all of ${names.join(', ')} when any are configured. Missing: ${missing.join(', ')}.`,
    )
  }
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
      maxResponseBytes: numberValue(
        environment,
        'AZURE_MONITOR_MAX_RESPONSE_BYTES',
        4 * 1024 * 1024,
      ),
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
