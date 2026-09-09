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
  agentCorrelationsSchema,
  runtimeOtelProvenanceSchema,
  runtimeObservationSchema,
  sourceProjectIdSchema,
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

import {
  MAX_REPRESENTATIVE_OTEL_OBSERVATIONS,
  MAX_REPRESENTATIVE_OTEL_RECORDS_PER_PAGE,
  normalizeRepresentativeOtelEvidence,
  type RepresentativeOtelWindowBinding,
} from './representative-evidence.js'

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
const MAX_QUERY_ROWS = MAX_REPRESENTATIVE_OTEL_OBSERVATIONS * 2
const MAX_QUERY_HOURS = 24 * 31
const WINDOW_ALIGNMENT_MS = 5 * 60 * 1_000
const SAFE_BINDING = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,199}$/

const bindingSchema = z.string().trim().min(1).max(200).regex(SAFE_BINDING)
const sourceProjectBindingSchema = sourceProjectIdSchema.regex(SAFE_BINDING)

export const azureMonitorOtelConfigSchema = z.strictObject({
  workspaceId: z.uuid(),
  tenantId: bindingSchema,
  sourceProjectId: sourceProjectBindingSchema,
  environment: bindingSchema,
  baselineWindowHours: z.number().int().min(1).max(MAX_QUERY_HOURS).default(168),
  observedWindowHours: z.number().int().min(1).max(168).default(24),
  maximumFreshnessHours: z.number().int().min(1).max(MAX_QUERY_HOURS).default(168),
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
  snapshotGeneratedAt: z.iso.datetime().optional(),
  tenantId: bindingSchema,
  agentId: bindingSchema,
  estateId: bindingSchema.optional(),
  estateEnvironment: bindingSchema.optional(),
  sourceConnectorId: bindingSchema.optional(),
  sourceTenantId: bindingSchema.optional(),
  sourceProjectId: sourceProjectBindingSchema.optional(),
  sourceAgentId: bindingSchema.optional(),
  sourceEnvironment: bindingSchema.optional(),
})

const rowBindingSchema = runtimeTelemetryRequestSchema.extend({
  environment: bindingSchema,
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  provenance: z
    .strictObject({
      snapshotGeneratedAt: z.iso.datetime(),
      estateId: bindingSchema,
      estateTenantId: bindingSchema,
      estateEnvironment: bindingSchema,
      sourceConnectorId: bindingSchema,
      sourceTenantId: bindingSchema,
      sourceProjectId: sourceProjectBindingSchema,
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
  ['SourceProjectId', 'string'],
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
  ObservationId: z.string().trim().max(1_000).nullable(),
  ObservedAt: z.iso.datetime(),
  TenantId: z.string().trim().max(1_000),
  AgentId: z.string().trim().max(1_000),
  Environment: z.string().trim().max(1_000),
  SourceProjectId: sourceProjectIdSchema.or(z.literal('')),
  AgentRunId: z.string().trim().max(200).nullable(),
  CorrelationId: z.string().trim().max(200).nullable(),
  AgentVersion: z.string().trim().max(200).nullable(),
  LatencyMs: z.number().finite().nullable(),
  InputTokens: z.number().finite().nullable(),
  OutputTokens: z.number().finite().nullable(),
  CostUsd: z.number().finite().nullable(),
  Success: z.boolean().nullable(),
  ErrorCode: z.string().max(100).nullable(),
  ToolCallNames: z.string().max(20_000).nullable(),
  Synthetic: z.boolean().nullable(),
  TraceId: z.string().max(64).nullable(),
  SpanId: z.string().max(32).nullable(),
  ItemCount: z.number().finite().nullable(),
})
type ProjectedRow = z.infer<typeof projectedRowSchema>

interface CanonicalAzureMonitorRows {
  rows: ProjectedRow[]
  recordsReceived: number
  duplicatesRemoved: number
  caveats: OtelEvidenceCaveat[]
  duplicateObservationIds: ReadonlySet<string>
  conflictingObservationIds: ReadonlySet<string>
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
  return agentCorrelationsSchema.parse([
    ...(row.AgentRunId ? [{ kind: 'agent-run-id' as const, value: row.AgentRunId }] : []),
    ...(row.CorrelationId ? [{ kind: 'correlation-id' as const, value: row.CorrelationId }] : []),
    ...(row.AgentVersion ? [{ kind: 'agent-version' as const, value: row.AgentVersion }] : []),
  ])
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
  sourceProjectId: string,
  traceId: string,
  spanId: string,
): string[] {
  return invocationClaimNames.map(
    (claim) =>
      `otel-claim-${createHash('sha256')
        .update(`${providerResourceId}\0${sourceProjectId}\0${traceId}\0${spanId}\0${claim}`)
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
    evidenceIds: invocationEvidenceIds(
      provenance.providerResourceId,
      provenance.sourceProjectId,
      row.TraceId,
      row.SpanId,
    ),
  })
}

function parseAzureMonitorRows(
  value: unknown,
  binding: z.input<typeof rowBindingSchema>,
  validateBinding = true,
): { binding: z.infer<typeof rowBindingSchema>; rows: ProjectedRow[] } {
  const expectedBinding = rowBindingSchema.parse(binding)
  const response = azureMonitorLogsQueryResponseSchema.parse(value)
  assertColumns(response)
  const table = response.tables[0]
  if (table === undefined)
    throw new AzureMonitorOtelConnectorError('Azure Monitor returned no table.')
  if (table.rows.length > MAX_QUERY_ROWS + 1) {
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
      row.SourceProjectId !== expectedBinding.sourceProjectId ||
      (validateBinding && row.TenantId !== expectedBinding.tenantId) ||
      (validateBinding &&
        (row.AgentId !== expectedBinding.agentId ||
          row.Environment !== expectedBinding.environment ||
          observedAtMs < startMs ||
          observedAtMs > endMs))
    ) {
      throw new AzureMonitorOtelConnectorError(
        `Azure Monitor row ${index} does not match the requested tenant, project, agent, environment, or time window.`,
      )
    }
    return row
  })
  return { binding: expectedBinding, rows }
}

function canonicalizeAzureMonitorRows(rows: readonly ProjectedRow[]): CanonicalAzureMonitorRows {
  const grouped = new Map<string, Array<{ canonical: string; row: ProjectedRow }>>()
  const canonicalRows: ProjectedRow[] = []
  for (const row of rows) {
    const observationId = row.ObservationId?.trim() ?? ''
    if (observationId === '') {
      canonicalRows.push(row)
      continue
    }
    const group = grouped.get(observationId) ?? []
    group.push({ canonical: JSON.stringify(row), row })
    grouped.set(observationId, group)
  }
  const caveats = new Set<OtelEvidenceCaveat>()
  const duplicateObservationIds = new Set<string>()
  const conflictingObservationIds = new Set<string>()
  let duplicatesRemoved = 0
  for (const [observationId, group] of [...grouped.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const variants = new Set(group.map((item) => item.canonical))
    if (variants.size > 1) {
      duplicatesRemoved += group.length
      caveats.add('conflicting-duplicate')
      conflictingObservationIds.add(observationId)
      continue
    }
    if (group.length > 1) {
      duplicatesRemoved += group.length - 1
      caveats.add('duplicate-record')
      duplicateObservationIds.add(observationId)
    }
    canonicalRows.push(group[0]!.row)
  }
  return {
    rows: canonicalRows,
    recordsReceived: rows.length,
    duplicatesRemoved,
    caveats: [...caveats].sort(),
    duplicateObservationIds,
    conflictingObservationIds,
  }
}

function assertWindowObservationLimit(
  kind: 'baseline' | 'observed',
  rows: readonly ProjectedRow[],
): void {
  if (rows.length > MAX_REPRESENTATIVE_OTEL_OBSERVATIONS) {
    throw new AzureMonitorOtelConnectorError(
      `Azure Monitor ${kind} window returned more than ${MAX_REPRESENTATIVE_OTEL_OBSERVATIONS} canonical observations.`,
    )
  }
}

function runtimeObservationForRow(
  row: ProjectedRow,
  binding: z.infer<typeof rowBindingSchema>,
): RuntimeObservation {
  if (row.ObservationId === null || row.ObservationId.trim() === '' || row.Success === null) {
    throw new AzureMonitorOtelConnectorError(
      'Azure Monitor rows require an explicit observation ID and success value.',
    )
  }
  if (row.Synthetic === null) {
    throw new AzureMonitorOtelConnectorError(
      'Azure Monitor rows require an explicit synthetic classification.',
    )
  }
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

const representativeClaims = [
  { kind: 'invocation', signal: 'trace' },
  { kind: 'latency', signal: 'span' },
  { kind: 'error', signal: 'span' },
  { kind: 'input-tokens', signal: 'metric' },
  { kind: 'output-tokens', signal: 'metric' },
  { kind: 'cost', signal: 'metric' },
] as const

function exactObservationId(value: string | null): string | undefined {
  const normalized = value?.trim()
  return normalized !== undefined && normalized.length > 0 && normalized.length <= 200
    ? normalized
    : undefined
}

function exactInteger(value: number | null, maximum: number): boolean {
  return value !== null && Number.isInteger(value) && value >= 0 && value <= maximum
}

function exactCost(value: number | null): boolean {
  return value !== null && value >= 0 && value <= 10_000
}

function representativeRecordsForRow(
  row: ProjectedRow,
  binding: RepresentativeOtelWindowBinding,
  exactBoundary: boolean,
): unknown[] {
  const observationId = exactObservationId(row.ObservationId)
  const exactTraceId = row.TraceId !== null && /^[0-9a-f]{32}$/.test(row.TraceId)
  const exactSpanId = row.SpanId !== null && /^[0-9a-f]{16}$/.test(row.SpanId)
  const complete =
    exactBoundary &&
    observationId !== undefined &&
    row.TenantId === binding.sourceTenantId &&
    row.AgentId === binding.sourceAgentId &&
    row.SourceProjectId === binding.sourceProjectId &&
    row.Environment === binding.sourceEnvironment &&
    exactTraceId &&
    exactSpanId &&
    row.ItemCount === 1 &&
    exactInteger(row.LatencyMs, 300_000) &&
    exactInteger(row.InputTokens, 1_000_000) &&
    exactInteger(row.OutputTokens, 1_000_000) &&
    exactCost(row.CostUsd) &&
    row.Success !== null &&
    row.Synthetic !== null
  const sampling =
    row.ItemCount === 1
      ? { state: 'complete', rate: 1 }
      : row.ItemCount !== null && Number.isInteger(row.ItemCount) && row.ItemCount > 1
        ? { state: 'sampled', rate: 1 / row.ItemCount }
        : { state: 'unknown' }
  const classification = row.Synthetic === null ? 'unknown' : row.Synthetic ? 'synthetic' : 'live'
  const observationFingerprint = createHash('sha256').update(JSON.stringify(row)).digest('hex')
  const correlations = rowCorrelations(row)
  const toolCallNames = parseToolCallNames(row.ToolCallNames)

  return representativeClaims.map(({ kind, signal }) => {
    const providerRecordId =
      observationId === undefined
        ? ''
        : `otel-provider-${createHash('sha256')
            .update(`${observationId}\0${kind}`)
            .digest('hex')
            .slice(0, 32)}`
    const claim =
      kind === 'invocation'
        ? { kind, value: 1, unit: 'count' }
        : kind === 'latency'
          ? { kind, value: row.LatencyMs, unit: 'ms' }
          : kind === 'error'
            ? {
                kind,
                value: row.Success === null ? null : !row.Success,
                ...(row.Success === false && row.ErrorCode !== null && row.ErrorCode.trim() !== ''
                  ? { errorCode: row.ErrorCode }
                  : {}),
              }
            : kind === 'input-tokens'
              ? { kind, value: row.InputTokens, unit: 'tokens' }
              : kind === 'output-tokens'
                ? { kind, value: row.OutputTokens, unit: 'tokens' }
                : { kind, value: row.CostUsd, unit: 'USD' }
    return {
      providerRecordId,
      ...(observationId === undefined
        ? {}
        : {
            observationId,
            observationFingerprint,
          }),
      snapshotGeneratedAt: exactBoundary ? binding.snapshotGeneratedAt : null,
      estateId: exactBoundary ? binding.estateId : null,
      estateTenantId: exactBoundary ? binding.estateTenantId : null,
      estateEnvironment: exactBoundary ? binding.estateEnvironment : null,
      sourceConnectorId: exactBoundary ? binding.sourceConnectorId : null,
      sourceTenantId: row.TenantId || null,
      sourceProjectId: row.SourceProjectId || null,
      sourceEnvironment: row.Environment || null,
      providerResourceId: binding.providerResourceId,
      sourceAgentId: row.AgentId || null,
      traceId: row.TraceId,
      spanId: row.SpanId,
      signal,
      observedAt: row.ObservedAt,
      classification,
      sampling,
      aggregation: { kind: 'raw' },
      correlations,
      toolCallNames,
      partial: !complete,
      claim,
    }
  })
}

function representativePages(records: readonly unknown[]): unknown[] {
  const pageCount = Math.max(
    1,
    Math.ceil(records.length / MAX_REPRESENTATIVE_OTEL_RECORDS_PER_PAGE),
  )
  return Array.from({ length: pageCount }, (_, index) => {
    const pageNumber = index + 1
    const cursor = index === 0 ? undefined : `page-${pageNumber}`
    const nextCursor = index + 1 < pageCount ? `page-${pageNumber + 1}` : undefined
    return {
      pageNumber,
      ...(cursor === undefined ? {} : { cursor }),
      ...(nextCursor === undefined ? {} : { nextCursor }),
      records: records.slice(
        index * MAX_REPRESENTATIVE_OTEL_RECORDS_PER_PAGE,
        (index + 1) * MAX_REPRESENTATIVE_OTEL_RECORDS_PER_PAGE,
      ),
    }
  })
}

function normalizationDiagnosticsForRows(
  originalRows: readonly ProjectedRow[],
  canonicalRows: readonly ProjectedRow[],
  canonicalization: CanonicalAzureMonitorRows,
) {
  const observationIds = new Set(originalRows.map((row) => row.ObservationId?.trim() ?? ''))
  const caveats: OtelEvidenceCaveat[] = []
  if (
    [...observationIds].some((observationId) =>
      canonicalization.duplicateObservationIds.has(observationId),
    )
  ) {
    caveats.push('duplicate-record')
  }
  if (
    [...observationIds].some((observationId) =>
      canonicalization.conflictingObservationIds.has(observationId),
    )
  ) {
    caveats.push('conflicting-duplicate')
  }
  const removedClaims = (originalRows.length - canonicalRows.length) * representativeClaims.length
  return {
    recordsReceivedOffset: removedClaims,
    duplicatesRemovedOffset: removedClaims,
    caveats,
  }
}

function normalizeAzureMonitorWindow(
  rows: readonly ProjectedRow[],
  originalRows: readonly ProjectedRow[],
  canonicalization: CanonicalAzureMonitorRows,
  binding: RepresentativeOtelWindowBinding,
  exactBoundary: boolean,
) {
  const normalized = normalizeRepresentativeOtelEvidence(
    representativePages(
      rows.flatMap((row) => representativeRecordsForRow(row, binding, exactBoundary)),
    ),
    binding,
    normalizationDiagnosticsForRows(originalRows, rows, canonicalization),
  )
  const rowsByObservationId = new Map<string, ProjectedRow>()
  for (const row of rows) {
    const observationId = exactObservationId(row.ObservationId)
    if (observationId !== undefined && !rowsByObservationId.has(observationId)) {
      rowsByObservationId.set(observationId, row)
    }
  }
  return {
    ...normalized,
    window: {
      ...normalized.window,
      observations: normalized.window.observations.map((observation) => {
        const row = rowsByObservationId.get(observation.id)
        return row === undefined
          ? observation
          : runtimeObservationSchema.parse({
              ...observation,
              correlations: rowCorrelations(row),
              toolCallNames: parseToolCallNames(row.ToolCallNames),
            })
      }),
    },
  }
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
  sourceProjectId: string
  maximumRows?: number
}): string {
  const parsed = z
    .strictObject({
      tenantId: bindingSchema,
      agentId: bindingSchema,
      environment: bindingSchema,
      sourceProjectId: sourceProjectBindingSchema,
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
    '         Environment = tostring(OtelAttributes["deployment.environment.name"]),',
    '         SourceProjectId = tostring(OtelAttributes["agent.sentinel.source_project_id"])',
    `| where TenantId == ${kqlString(parsed.tenantId)}`,
    `| where AgentId == ${kqlString(parsed.agentId)}`,
    `| where Environment == ${kqlString(parsed.environment)}`,
    `| where SourceProjectId == ${kqlString(parsed.sourceProjectId)}`,
    '| project ObservationId = tostring(OtelAttributes["agent.sentinel.observation_id"]),',
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
    '          Synthetic = tobool(OtelAttributes["agent.sentinel.synthetic"]),',
    '          TraceId = tolower(tostring(coalesce(OtelAttributes["trace_id"], OtelAttributes["otel.trace_id"], OperationId))),',
    '          SpanId = tolower(tostring(coalesce(OtelAttributes["span_id"], OtelAttributes["otel.span_id"], extract(@"([0-9a-fA-F]{16})\\|?$", 1, Id), Id))),',
    '          ItemCount = tolong(ItemCount),',
    '          SourceProjectId',
    '| order by ObservedAt asc, ObservationId asc, TraceId asc, SpanId asc',
    `| take ${String(parsed.maximumRows)}`,
  ].join('\n')
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

function windowEvidenceId(kind: 'baseline' | 'observed', normalizedEvidenceId: string): string {
  return `otel-${kind}-${createHash('sha256').update(normalizedEvidenceId).digest('hex').slice(0, 16)}`
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
    request: RuntimeTelemetryRequest,
    options: ConnectorOperationRequest = {},
  ): Promise<RuntimeObservationWindows> {
    const binding = runtimeTelemetryRequestSchema.parse(request)
    const sourceTenantId = binding.sourceTenantId ?? binding.tenantId
    const sourceProjectId = binding.sourceProjectId ?? this.config.sourceProjectId
    const sourceAgentId = binding.sourceAgentId ?? binding.agentId
    const sourceEnvironment = binding.sourceEnvironment ?? this.config.environment
    if (
      sourceTenantId.toLowerCase() !== this.config.tenantId.toLowerCase() ||
      sourceProjectId !== this.config.sourceProjectId ||
      sourceEnvironment !== this.config.environment
    ) {
      throw new AzureMonitorOtelConnectorError(
        'The requested source boundary does not match the configured telemetry source.',
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
            tenantId: sourceTenantId,
            agentId: sourceAgentId,
            environment: sourceEnvironment,
            sourceProjectId,
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

    const parsedRows = parseAzureMonitorRows(
      body,
      {
        tenantId: sourceTenantId,
        agentId: sourceAgentId,
        sourceProjectId,
        environment: sourceEnvironment,
        windowStart: baselineStart,
        windowEnd: observedEnd,
      },
      false,
    )
    const canonicalization = canonicalizeAzureMonitorRows(parsedRows.rows)
    const baselineOriginalRows = parsedRows.rows.filter(
      (row) => new Date(row.ObservedAt).getTime() < new Date(baselineEnd).getTime(),
    )
    const observedOriginalRows = parsedRows.rows.filter(
      (row) => new Date(row.ObservedAt).getTime() >= new Date(observedStart).getTime(),
    )
    const baselineRows = canonicalization.rows.filter(
      (row) => new Date(row.ObservedAt).getTime() < new Date(baselineEnd).getTime(),
    )
    const observedRows = canonicalization.rows.filter(
      (row) => new Date(row.ObservedAt).getTime() >= new Date(observedStart).getTime(),
    )
    assertWindowObservationLimit('baseline', baselineRows)
    assertWindowObservationLimit('observed', observedRows)
    const exactBoundary =
      binding.snapshotGeneratedAt !== undefined &&
      binding.estateId !== undefined &&
      binding.estateEnvironment !== undefined &&
      binding.sourceConnectorId !== undefined &&
      binding.sourceProjectId !== undefined
    const baseBinding = [
      binding.snapshotGeneratedAt ?? observedEnd,
      binding.estateId ?? binding.tenantId,
      binding.tenantId,
      binding.estateEnvironment ?? sourceEnvironment,
      binding.sourceConnectorId ?? 'direct',
      sourceTenantId,
      sourceProjectId,
      sourceEnvironment,
      this.config.workspaceId,
      binding.agentId,
      sourceAgentId,
    ].join('\0')
    const normalizeWindow = (
      kind: 'baseline' | 'observed',
      rows: readonly ProjectedRow[],
      originalRows: readonly ProjectedRow[],
      windowStart: string,
      windowEnd: string,
    ) =>
      normalizeAzureMonitorWindow(
        rows,
        originalRows,
        canonicalization,
        {
          snapshotGeneratedAt: binding.snapshotGeneratedAt ?? observedEnd,
          estateId: binding.estateId ?? binding.tenantId,
          estateTenantId: binding.tenantId,
          estateEnvironment: binding.estateEnvironment ?? sourceEnvironment,
          sourceConnectorId: binding.sourceConnectorId ?? 'direct',
          sourceTenantId,
          sourceProjectId,
          sourceEnvironment,
          providerResourceId: this.config.workspaceId,
          agentId: binding.agentId,
          sourceAgentId,
          windowId: windowId(kind, baseBinding, windowStart, windowEnd),
          windowStart,
          windowEnd,
          queriedAt,
          maximumFreshnessHours: this.config.maximumFreshnessHours,
        },
        exactBoundary,
      )
    const baseline = normalizeWindow(
      'baseline',
      baselineRows,
      baselineOriginalRows,
      baselineStart,
      baselineEnd,
    )
    const observed = normalizeWindow(
      'observed',
      observedRows,
      observedOriginalRows,
      observedStart,
      observedEnd,
    )

    return runtimeObservationWindowsSchema.parse({
      baseline: baseline.window,
      observed: observed.window,
      baselineEvidenceId: windowEvidenceId('baseline', baseline.evidenceId),
      observedEvidenceId: windowEvidenceId('observed', observed.evidenceId),
      queriedAt,
      maximumFreshnessHours: this.config.maximumFreshnessHours,
      ...(exactBoundary
        ? {
            provenance: {
              snapshotGeneratedAt: binding.snapshotGeneratedAt!,
              estateId: binding.estateId!,
              estateTenantId: binding.tenantId,
              estateEnvironment: binding.estateEnvironment!,
              sourceConnectorId: binding.sourceConnectorId!,
              sourceTenantId,
              sourceProjectId,
              sourceEnvironment,
              provider: 'azure-monitor-otel' as const,
              providerResourceId: this.config.workspaceId,
              providerAgentId: sourceAgentId,
            },
          }
        : {}),
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
      nested.snapshotGeneratedAt === provenance.snapshotGeneratedAt &&
      nested.estateTenantId === provenance.estateTenantId &&
      nested.estateEnvironment === provenance.estateEnvironment &&
      nested.sourceConnectorId === provenance.sourceConnectorId &&
      nested.sourceTenantId === provenance.sourceTenantId &&
      nested.sourceProjectId === provenance.sourceProjectId &&
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
          sourceProjectId: config.sourceProjectId,
          environment: config.environment,
          baselineWindowHours: config.baselineWindowHours,
          observedWindowHours: config.observedWindowHours,
          maximumFreshnessHours: config.maximumFreshnessHours,
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
    const sourceProjectId = request.sourceProjectId ?? source.config.sourceProjectId
    const sourceEnvironment = request.sourceEnvironment ?? source.config.environment
    const sourceAgentId = request.sourceAgentId ?? request.agentId
    if (
      sourceTenantId.toLowerCase() !== source.config.tenantId.toLowerCase() ||
      sourceProjectId !== source.config.sourceProjectId ||
      sourceEnvironment !== source.config.environment
    ) {
      throw new AzureMonitorOtelConnectorError(
        'The requested agent source boundary does not match the Azure Monitor source.',
      )
    }
    try {
      const windows = await source.connector.readObservationWindows(
        {
          ...request,
          sourceConnectorId: source.config.id,
          sourceTenantId,
          sourceProjectId,
          sourceAgentId,
          sourceEnvironment,
        },
        options,
      )
      const dataState = runtimeDataState(windows)
      source.dataState = dataState.state
      source.readiness = dataState.state === 'complete' ? 'ready' : 'degraded'
      source.checkedAt = windows.queriedAt
      source.reason = dataState.reason
      return windows
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

function sourceProjectIdFromEndpoint(endpoint: string): string {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new AzureMonitorOtelConfigurationError(
      'FOUNDRY_PROJECT_ENDPOINT must be a valid Foundry project endpoint.',
    )
  }
  const projectId = parsed.pathname.split('/').filter(Boolean).at(-1)
  if (projectId === undefined || !bindingSchema.safeParse(projectId).success) {
    throw new AzureMonitorOtelConfigurationError(
      'FOUNDRY_PROJECT_ENDPOINT must contain an exact Foundry project ID.',
    )
  }
  return projectId
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
  const foundryProjectEndpoint = environment['FOUNDRY_PROJECT_ENDPOINT']?.trim()
  if (foundryProjectEndpoint === undefined || foundryProjectEndpoint === '') {
    throw new AzureMonitorOtelConfigurationError(
      'Legacy Azure Monitor configuration requires FOUNDRY_PROJECT_ENDPOINT for the exact source project ID.',
    )
  }
  return [
    azureMonitorOtelSourceConfigSchema.parse({
      id: 'primary',
      name: 'Primary Foundry project',
      workspaceId: environment.AZURE_MONITOR_WORKSPACE_ID,
      tenantId: environment.AZURE_MONITOR_TENANT_ID,
      sourceProjectId: sourceProjectIdFromEndpoint(foundryProjectEndpoint),
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
