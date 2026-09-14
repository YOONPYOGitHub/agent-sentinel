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
  MAX_RUNTIME_OTEL_OBSERVATIONS,
  assessRuntimeOtelQuality,
  agentCorrelationsSchema,
  azureApplicationInsightsResourceIdSchema,
  observationWindowSchema,
  otelSpanIdSchema,
  otelTraceIdSchema,
  runtimeOtelProvenanceSchema,
  runtimeObservationSchema,
  sourceProjectIdSchema,
  type ObservationWindow,
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
const MAX_QUERY_ROWS_PER_PAGE = MAX_REPRESENTATIVE_OTEL_OBSERVATIONS + 1
const MAX_INITIAL_QUERY_ROWS = MAX_REPRESENTATIVE_OTEL_OBSERVATIONS * 2 + 1
const MAX_QUERY_PAGES = 20
const MAX_WINDOW_OBSERVATIONS = MAX_RUNTIME_OTEL_OBSERVATIONS
const MAX_QUERY_HOURS = 24 * 31
const WINDOW_ALIGNMENT_MS = 5 * 60 * 1_000
const SAFE_BINDING = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,199}$/

const bindingSchema = z.string().trim().min(1).max(200).regex(SAFE_BINDING)
const sourceProjectBindingSchema = sourceProjectIdSchema.regex(SAFE_BINDING)
const applicationRoleNameSchema = z.string().trim().min(1).max(200)
const requestNameSchema = z.literal('agent.invoke').default('agent.invoke')

export const azureMonitorOtelConfigSchema = z.strictObject({
  workspaceId: z.uuid(),
  providerResourceId: azureApplicationInsightsResourceIdSchema,
  applicationRoleName: applicationRoleNameSchema,
  requestName: requestNameSchema,
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

export function computeAzureMonitorOtelSourceSetFingerprint(
  sourcesInput: readonly AzureMonitorOtelSourceConfigInput[],
): string {
  const canonical = azureMonitorOtelSourcesConfigSchema
    .parse(sourcesInput)
    .map((source) => ({
      id: source.id,
      name: source.name,
      workspaceId: source.workspaceId,
      providerResourceId: source.providerResourceId,
      applicationRoleName: source.applicationRoleName,
      requestName: source.requestName,
      tenantId: source.tenantId.toLowerCase(),
      sourceProjectId: source.sourceProjectId,
      environment: source.environment,
      baselineWindowHours: source.baselineWindowHours,
      observedWindowHours: source.observedWindowHours,
      maximumFreshnessHours: source.maximumFreshnessHours,
      requestTimeoutMs: source.requestTimeoutMs,
      maxResponseBytes: source.maxResponseBytes,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
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
): Promise<{ body: unknown; bytesRead: number }> {
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
    return {
      body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      bytesRead,
    }
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
  sourceSetFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
})

const rowBindingSchema = runtimeTelemetryRequestSchema.extend({
  environment: bindingSchema,
  providerResourceId: azureApplicationInsightsResourceIdSchema,
  applicationRoleName: applicationRoleNameSchema,
  requestName: requestNameSchema,
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
      providerResourceId: azureApplicationInsightsResourceIdSchema,
      providerAgentId: bindingSchema,
      sourceSetFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      measuredAt: z.iso.datetime(),
      contract: z.strictObject({
        version: z.literal(1),
        recordType: z.literal('agent_invocation'),
        applicationRoleName: applicationRoleNameSchema,
        requestName: requestNameSchema,
      }),
    })
    .optional(),
})

const expectedColumns = [
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
  rows: z.array(z.array(z.unknown()).length(expectedColumns.length)).max(MAX_INITIAL_QUERY_ROWS),
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
      | 'cancelled'
      | 'timeout'
      | 'authorization-required'
      | 'query-failed'
      | 'page-limit-exceeded'
      | 'record-limit-exceeded'
      | 'response-too-large' = 'query-failed',
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
  ProviderInvocationId: z.string().trim().max(200).nullable(),
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
  ResourceId: azureApplicationInsightsResourceIdSchema,
  ProviderResourceId: azureApplicationInsightsResourceIdSchema,
  ApplicationRoleName: applicationRoleNameSchema,
  RequestName: requestNameSchema,
  ContractVersion: z.number().int(),
  RecordType: z.string().trim().min(1).max(100),
  SourceConnectorId: bindingSchema,
  EstateId: bindingSchema,
  EstateTenantId: bindingSchema,
  EstateEnvironment: bindingSchema,
  SourceTenantId: bindingSchema,
  SourceEnvironment: bindingSchema,
  ProviderAgentId: bindingSchema,
  Outcome: z.enum(['success', 'error']),
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
  sourceSetFingerprint: string,
  applicationRoleName: string,
  requestName: string,
  providerInvocationId: string,
  traceId: string,
  spanId: string,
): string[] {
  return invocationClaimNames.map(
    (claim) =>
      `otel-claim-${createHash('sha256')
        .update(
          `${providerResourceId}\0${sourceProjectId}\0${sourceSetFingerprint}\0${applicationRoleName}\0${requestName}\0${providerInvocationId}\0${traceId}\0${spanId}\0${claim}`,
        )
        .digest('hex')
        .slice(0, 32)}`,
  )
}

function rowOtelProvenance(row: ProjectedRow, binding: z.infer<typeof rowBindingSchema>) {
  const provenance = binding.provenance
  if (
    provenance === undefined ||
    row.ProviderInvocationId === null ||
    row.TraceId === null ||
    row.SpanId === null ||
    !otelTraceIdSchema.safeParse(row.TraceId).success ||
    !otelSpanIdSchema.safeParse(row.SpanId).success ||
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
    providerInvocationId: row.ProviderInvocationId,
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
    contract: {
      version: row.ContractVersion,
      recordType: row.RecordType,
      applicationRoleName: row.ApplicationRoleName,
      requestName: row.RequestName,
      outcome: row.Outcome,
    },
    partial: false,
    evidenceIds: invocationEvidenceIds(
      provenance.providerResourceId,
      provenance.sourceProjectId,
      provenance.sourceSetFingerprint,
      provenance.contract.applicationRoleName,
      provenance.contract.requestName,
      row.ProviderInvocationId,
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
  if (table.rows.length > MAX_INITIAL_QUERY_ROWS) {
    throw new AzureMonitorOtelConnectorError(
      `Azure Monitor returned more than ${MAX_INITIAL_QUERY_ROWS - 1} rows for one bounded query page.`,
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
      row.ResourceId !== expectedBinding.providerResourceId ||
      row.ProviderResourceId !== expectedBinding.providerResourceId ||
      row.ApplicationRoleName !== expectedBinding.applicationRoleName ||
      row.RequestName !== expectedBinding.requestName ||
      row.ContractVersion !== 1 ||
      row.RecordType !== 'agent_invocation' ||
      expectedBinding.sourceConnectorId === undefined ||
      row.SourceConnectorId !== expectedBinding.sourceConnectorId ||
      expectedBinding.estateId === undefined ||
      row.EstateId !== expectedBinding.estateId ||
      row.EstateTenantId !== expectedBinding.tenantId ||
      expectedBinding.estateEnvironment === undefined ||
      row.EstateEnvironment !== expectedBinding.estateEnvironment ||
      row.SourceTenantId !== (expectedBinding.sourceTenantId ?? expectedBinding.tenantId) ||
      row.SourceEnvironment !==
        (expectedBinding.sourceEnvironment ?? expectedBinding.environment) ||
      row.ProviderAgentId !== (expectedBinding.sourceAgentId ?? expectedBinding.agentId) ||
      row.AgentId !== row.ProviderAgentId ||
      row.TenantId !== row.SourceTenantId ||
      row.Environment !== row.SourceEnvironment ||
      row.Synthetic !== false ||
      row.Outcome !== (row.Success === true ? 'success' : row.Success === false ? 'error' : '') ||
      (validateBinding && (observedAtMs < startMs || observedAtMs >= endMs))
    ) {
      throw new AzureMonitorOtelConnectorError(
        `Azure Monitor row ${index} does not match the requested native resource, role, name, contract, estate, tenant, project, source, agent, outcome, or time window.`,
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
    const observationId = row.ProviderInvocationId?.trim() ?? ''
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
) {
  if (rows.length > MAX_WINDOW_OBSERVATIONS) {
    throw new AzureMonitorOtelConnectorError(
      `Azure Monitor ${kind} window returned more than ${MAX_WINDOW_OBSERVATIONS} canonical observations.`,
    )
  }
}

function runtimeObservationForRow(
  row: ProjectedRow,
  binding: z.infer<typeof rowBindingSchema>,
): RuntimeObservation {
  if (
    row.ProviderInvocationId === null ||
    row.ProviderInvocationId.trim() === '' ||
    row.Success === null
  ) {
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
    id: row.ProviderInvocationId,
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
  const observationId = exactObservationId(row.ProviderInvocationId)
  const exactTraceId = row.TraceId !== null && otelTraceIdSchema.safeParse(row.TraceId).success
  const exactSpanId = row.SpanId !== null && otelSpanIdSchema.safeParse(row.SpanId).success
  const complete =
    exactBoundary &&
    observationId !== undefined &&
    row.TenantId === binding.sourceTenantId &&
    row.AgentId === binding.sourceAgentId &&
    row.SourceProjectId === binding.sourceProjectId &&
    row.Environment === binding.sourceEnvironment &&
    row.ResourceId === binding.providerResourceId &&
    row.ProviderResourceId === binding.providerResourceId &&
    row.ApplicationRoleName === binding.contract.applicationRoleName &&
    row.RequestName === binding.contract.requestName &&
    row.ContractVersion === binding.contract.version &&
    row.RecordType === binding.contract.recordType &&
    row.SourceConnectorId === binding.sourceConnectorId &&
    row.EstateId === binding.estateId &&
    row.EstateTenantId === binding.estateTenantId &&
    row.EstateEnvironment === binding.estateEnvironment &&
    row.SourceTenantId === binding.sourceTenantId &&
    row.SourceEnvironment === binding.sourceEnvironment &&
    row.ProviderAgentId === binding.sourceAgentId &&
    row.Outcome === (row.Success === true ? 'success' : 'error') &&
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
      providerInvocationId: observationId ?? null,
      sourceSetFingerprint: binding.sourceSetFingerprint,
      measuredAt: binding.measuredAt,
      traceId: row.TraceId,
      spanId: row.SpanId,
      signal,
      observedAt: row.ObservedAt,
      classification,
      sampling,
      aggregation: { kind: 'raw' },
      contract: {
        version: row.ContractVersion,
        recordType: row.RecordType,
        applicationRoleName: row.ApplicationRoleName,
        requestName: row.RequestName,
        outcome: row.Outcome,
      },
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
  const observationIds = new Set(originalRows.map((row) => row.ProviderInvocationId?.trim() ?? ''))
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
  const batches =
    rows.length === 0
      ? [[]]
      : Array.from(
          { length: Math.ceil(rows.length / MAX_REPRESENTATIVE_OTEL_OBSERVATIONS) },
          (_, index) =>
            rows.slice(
              index * MAX_REPRESENTATIVE_OTEL_OBSERVATIONS,
              (index + 1) * MAX_REPRESENTATIVE_OTEL_OBSERVATIONS,
            ),
        )
  const diagnostics = normalizationDiagnosticsForRows(originalRows, rows, canonicalization)
  const normalizedBatches = batches.map((batch, index) =>
    normalizeRepresentativeOtelEvidence(
      representativePages(
        batch.flatMap((row) => representativeRecordsForRow(row, binding, exactBoundary)),
      ),
      binding,
      index === 0 ? diagnostics : {},
    ),
  )
  const evidence = normalizedBatches.flatMap((normalized) => normalized.evidence)
  const observations = normalizedBatches.flatMap((normalized) => normalized.window.observations)
  const caveats = [...new Set(normalizedBatches.flatMap((normalized) => normalized.caveats))].sort()
  const classifications = new Set(
    normalizedBatches
      .map((normalized) => normalized.window.otelQuality?.classification)
      .filter((value) => value !== undefined && value !== 'unknown'),
  )
  const classification =
    classifications.size === 0
      ? 'unknown'
      : classifications.size === 1
        ? [...classifications][0]!
        : 'mixed'
  if (classification === 'mixed' && !caveats.includes('mixed-classification')) {
    caveats.push('mixed-classification')
    caveats.sort()
  }
  const quality: NonNullable<ObservationWindow['otelQuality']> = {
    status: originalRows.length === 0 ? 'unknown' : caveats.length === 0 ? 'available' : 'degraded',
    classification,
    caveats,
    recordsReceived: normalizedBatches.reduce(
      (total, normalized) => total + (normalized.window.otelQuality?.recordsReceived ?? 0),
      0,
    ),
    recordsAccepted: normalizedBatches.reduce(
      (total, normalized) => total + (normalized.window.otelQuality?.recordsAccepted ?? 0),
      0,
    ),
    duplicatesRemoved: normalizedBatches.reduce(
      (total, normalized) => total + (normalized.window.otelQuality?.duplicatesRemoved ?? 0),
      0,
    ),
    pagesProcessed: normalizedBatches.reduce(
      (total, normalized) => total + (normalized.window.otelQuality?.pagesProcessed ?? 0),
      0,
    ),
  }
  const { queriedAt, ...stableBinding } = binding
  void queriedAt
  const rowsByObservationId = new Map<string, ProjectedRow>()
  for (const row of rows) {
    const observationId = exactObservationId(row.ProviderInvocationId)
    if (observationId !== undefined && !rowsByObservationId.has(observationId)) {
      rowsByObservationId.set(observationId, row)
    }
  }
  return {
    evidenceId: `otel-evidence-${createHash('sha256')
      .update(
        JSON.stringify({
          binding: stableBinding,
          quality,
          evidence: evidence.map((item) => item.id),
          observations: observations.map((item) => item.id),
        }),
      )
      .digest('hex')
      .slice(0, 32)}`,
    status: quality.status,
    liveReadiness:
      quality.status === 'available' && quality.classification === 'live' && observations.length > 0
        ? ('live-ready' as const)
        : quality.status === 'available' &&
            quality.classification === 'synthetic' &&
            observations.length > 0
          ? ('synthetic-only' as const)
          : ('insufficient-data' as const),
    caveats,
    evidence,
    window: observationWindowSchema.parse({
      windowId: binding.windowId,
      tenantId: binding.estateTenantId,
      agentId: binding.agentId,
      environment: binding.sourceEnvironment,
      source: 'azure-monitor-otel',
      windowStart: binding.windowStart,
      windowEnd: binding.windowEnd,
      observations: observations.map((observation) => {
        const row = rowsByObservationId.get(observation.id)
        return row === undefined
          ? observation
          : runtimeObservationSchema.parse({
              ...observation,
              correlations: rowCorrelations(row),
              toolCallNames: parseToolCallNames(row.ToolCallNames),
            })
      }),
      otelQuality: quality,
    }),
  }
}

function kqlString(value: string): string {
  return `'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')}'`
}

/**
 * Fixed, read-only query over AppRequests. Caller input is used only after
 * strict binding validation and literal escaping; no table/operator is configurable.
 */
export function buildAzureMonitorOtelQuery(binding: {
  tenantId: string
  agentId: string
  environment: string
  sourceConnectorId: string
  estateId: string
  estateTenantId: string
  estateEnvironment: string
  sourceTenantId: string
  sourceProjectId: string
  providerResourceId: string
  applicationRoleName: string
  requestName: string
  windowStart: string
  windowEnd: string
  maximumRows?: number
}): string {
  const parsed = z
    .strictObject({
      tenantId: bindingSchema,
      agentId: bindingSchema,
      environment: bindingSchema,
      sourceConnectorId: bindingSchema,
      estateId: bindingSchema,
      estateTenantId: bindingSchema,
      estateEnvironment: bindingSchema,
      sourceTenantId: bindingSchema,
      sourceProjectId: sourceProjectBindingSchema,
      providerResourceId: azureApplicationInsightsResourceIdSchema,
      applicationRoleName: applicationRoleNameSchema,
      requestName: requestNameSchema,
      windowStart: z.iso.datetime(),
      windowEnd: z.iso.datetime(),
      maximumRows: z
        .number()
        .int()
        .min(1)
        .max(MAX_INITIAL_QUERY_ROWS)
        .default(MAX_INITIAL_QUERY_ROWS),
    })
    .superRefine((value, context) => {
      if (Date.parse(value.windowEnd) <= Date.parse(value.windowStart)) {
        context.addIssue({
          code: 'custom',
          path: ['windowEnd'],
          message: 'Azure Monitor query windows must be ordered and half-open.',
        })
      }
    })
    .parse(binding)
  return [
    'AppRequests',
    '| extend OtelAttributes = Properties',
    '| where tolower(tostring(_ResourceId)) == ' + kqlString(parsed.providerResourceId),
    '| where AppRoleName == ' + kqlString(parsed.applicationRoleName),
    '| where Name == ' + kqlString(parsed.requestName),
    '| extend TenantId = tostring(OtelAttributes["agent.sentinel.tenant_id"]),',
    '         AgentId = tostring(OtelAttributes["gen_ai.agent.id"]),',
    '         Environment = tostring(OtelAttributes["deployment.environment.name"]),',
    '         SourceProjectId = tostring(OtelAttributes["agent.sentinel.source_project_id"]),',
    '         ContractVersion = tolong(OtelAttributes["agent.sentinel.contract_version"]),',
    '         RecordType = tostring(OtelAttributes["agent.sentinel.record_type"]),',
    '         SourceConnectorId = tostring(OtelAttributes["agent.sentinel.source_connector_id"]),',
    '         EstateId = tostring(OtelAttributes["agent.sentinel.estate_id"]),',
    '         EstateTenantId = tostring(OtelAttributes["agent.sentinel.estate_tenant_id"]),',
    '         EstateEnvironment = tostring(OtelAttributes["agent.sentinel.estate_environment"]),',
    '         SourceTenantId = tostring(OtelAttributes["agent.sentinel.source_tenant_id"]),',
    '         SourceEnvironment = tostring(OtelAttributes["agent.sentinel.source_environment"]),',
    '         ProviderAgentId = tostring(OtelAttributes["agent.sentinel.provider_agent_id"]),',
    '         ProviderResourceId = tolower(tostring(OtelAttributes["agent.sentinel.provider_resource_id"])),',
    '         Outcome = tostring(OtelAttributes["agent.sentinel.outcome"]),',
    '         Synthetic = tobool(OtelAttributes["agent.sentinel.synthetic"])',
    `| where TimeGenerated >= datetime(${parsed.windowStart})`,
    `| where TimeGenerated < datetime(${parsed.windowEnd})`,
    '| where ContractVersion == 1',
    "| where RecordType == 'agent_invocation'",
    `| where TenantId == ${kqlString(parsed.tenantId)}`,
    `| where AgentId == ${kqlString(parsed.agentId)}`,
    `| where Environment == ${kqlString(parsed.environment)}`,
    `| where SourceProjectId == ${kqlString(parsed.sourceProjectId)}`,
    `| where SourceConnectorId == ${kqlString(parsed.sourceConnectorId)}`,
    `| where EstateId == ${kqlString(parsed.estateId)}`,
    `| where EstateTenantId == ${kqlString(parsed.estateTenantId)}`,
    `| where EstateEnvironment == ${kqlString(parsed.estateEnvironment)}`,
    `| where SourceTenantId == ${kqlString(parsed.sourceTenantId)}`,
    `| where SourceEnvironment == ${kqlString(parsed.environment)}`,
    `| where ProviderAgentId == ${kqlString(parsed.agentId)}`,
    `| where ProviderResourceId == ${kqlString(parsed.providerResourceId)}`,
    '| where isnotnull(Success) and isnotnull(Synthetic)',
    '| where Synthetic == false',
    '| where (Success == true and Outcome == "success") or (Success == false and Outcome == "error")',
    '| project ProviderInvocationId = tostring(OtelAttributes["agent.sentinel.provider_invocation_id"]),',
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
    '          Synthetic,',
    '          TraceId = tostring(OperationId),',
    '          SpanId = tostring(Id),',
    '          ItemCount = tolong(ItemCount),',
    '          SourceProjectId,',
    '          ResourceId = tolower(tostring(_ResourceId)),',
    '          ProviderResourceId,',
    '          ApplicationRoleName = tostring(AppRoleName),',
    '          RequestName = tostring(Name),',
    '          ContractVersion, RecordType, SourceConnectorId, EstateId, EstateTenantId,',
    '          EstateEnvironment, SourceTenantId, SourceEnvironment, ProviderAgentId, Outcome',
    '| order by ObservedAt asc, ProviderInvocationId asc, TraceId asc, SpanId asc',
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
  readonly sourceSetFingerprint: string
  private readonly config: AzureMonitorOtelConfig

  constructor(
    config: z.input<typeof azureMonitorOtelConfigSchema>,
    private readonly credential: TokenCredential,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
    sourceSetFingerprint?: string,
  ) {
    this.config = azureMonitorOtelConfigSchema.parse(config)
    this.sourceSetFingerprint =
      sourceSetFingerprint ?? createHash('sha256').update(JSON.stringify(this.config)).digest('hex')
  }

  async readObservationWindows(
    request: RuntimeTelemetryRequest,
    options: ConnectorOperationRequest = {},
  ): Promise<RuntimeObservationWindows> {
    const binding = runtimeTelemetryRequestSchema.parse(request)
    const operationLimits = z
      .strictObject({
        maxPages: z.number().int().min(1).max(MAX_QUERY_PAGES).default(MAX_QUERY_PAGES),
        maxRecords: z
          .number()
          .int()
          .min(1)
          .max(1_000_000)
          .default(MAX_WINDOW_OBSERVATIONS * 2),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(this.config.maxResponseBytes)
          .default(this.config.maxResponseBytes),
        deadlineAt: z.iso.datetime().optional(),
      })
      .parse({
        maxPages: options.maxPages,
        maxRecords: options.maxRecords,
        maxBytes: options.maxBytes,
        deadlineAt: options.deadlineAt,
      })
    if (
      binding.snapshotGeneratedAt === undefined ||
      binding.estateId === undefined ||
      binding.estateEnvironment === undefined ||
      binding.sourceConnectorId === undefined ||
      binding.sourceTenantId === undefined ||
      binding.sourceProjectId === undefined ||
      binding.sourceAgentId === undefined ||
      binding.sourceEnvironment === undefined
    ) {
      throw new AzureMonitorOtelConnectorError(
        'Azure Monitor runtime reads require exact snapshot, estate, source, project, environment, and provider-agent identity.',
      )
    }
    const sourceTenantId = binding.sourceTenantId
    const sourceProjectId = binding.sourceProjectId
    const sourceAgentId = binding.sourceAgentId
    const sourceEnvironment = binding.sourceEnvironment
    const sourceConnectorId = binding.sourceConnectorId
    const sourceSetFingerprint = binding.sourceSetFingerprint ?? this.sourceSetFingerprint
    const estateId = binding.estateId
    const estateEnvironment = binding.estateEnvironment
    if (
      sourceTenantId.toLowerCase() !== this.config.tenantId.toLowerCase() ||
      sourceProjectId !== this.config.sourceProjectId ||
      sourceEnvironment !== this.config.environment ||
      (binding.sourceSetFingerprint !== undefined &&
        binding.sourceSetFingerprint !== this.sourceSetFingerprint)
    ) {
      throw new AzureMonitorOtelConnectorError(
        'The requested source boundary does not match the configured telemetry source.',
      )
    }

    const queryTime = this.clock()
    const deadlineMs =
      operationLimits.deadlineAt === undefined
        ? Number.POSITIVE_INFINITY
        : Date.parse(operationLimits.deadlineAt) - queryTime.getTime()
    if (deadlineMs <= 0) {
      throw new AzureMonitorOtelConnectorError(
        'Azure Monitor Logs query deadline has expired.',
        'timeout',
      )
    }
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
    const timeoutSignal = AbortSignal.timeout(
      Math.max(1, Math.min(this.config.requestTimeoutMs, deadlineMs)),
    )
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
        'authorization-required',
      )
    }
    if (token === null) {
      throw new AzureMonitorOtelConnectorError(
        'Azure credential did not return an Azure Monitor Logs access token.',
        'authorization-required',
      )
    }

    const url = new URL(`/v1/workspaces/${this.config.workspaceId}/query`, LOGS_ORIGIN)
    let pagesRead = 0
    let bytesRead = 0
    let rawRowsRead = 0
    const queryPage = async (
      windowStart: string,
      windowEnd: string,
      maximumRows: number,
    ): Promise<ProjectedRow[]> => {
      if (pagesRead >= operationLimits.maxPages) {
        throw new AzureMonitorOtelConnectorError(
          `Azure Monitor Logs exceeded the ${operationLimits.maxPages}-page query limit.`,
          'page-limit-exceeded',
        )
      }
      pagesRead += 1
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
              sourceConnectorId,
              estateId,
              estateTenantId: binding.tenantId,
              estateEnvironment,
              sourceTenantId,
              sourceProjectId,
              providerResourceId: this.config.providerResourceId,
              applicationRoleName: this.config.applicationRoleName,
              requestName: this.config.requestName,
              windowStart,
              windowEnd,
              maximumRows: Math.min(maximumRows, operationLimits.maxRecords - rawRowsRead + 1),
            }),
            timespan: `${windowStart}/${windowEnd}`,
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
        const remainingBytes = operationLimits.maxBytes - bytesRead
        if (remainingBytes <= 0) {
          throw new AzureMonitorOtelConnectorError(
            `Azure Monitor Logs responses exceeded the ${operationLimits.maxBytes} byte operation limit.`,
            'response-too-large',
          )
        }
        const bounded = await readBoundedJson(response, remainingBytes, signal)
        body = bounded.body
        bytesRead += bounded.bytesRead
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
          tenantId: binding.tenantId,
          agentId: binding.agentId,
          sourceProjectId,
          environment: sourceEnvironment,
          sourceConnectorId,
          estateId,
          estateEnvironment,
          sourceTenantId,
          sourceAgentId,
          sourceSetFingerprint,
          providerResourceId: this.config.providerResourceId,
          applicationRoleName: this.config.applicationRoleName,
          requestName: this.config.requestName,
          windowStart,
          windowEnd,
        },
        false,
      ).rows
      rawRowsRead += parsedRows.length
      if (rawRowsRead > operationLimits.maxRecords) {
        throw new AzureMonitorOtelConnectorError(
          `Azure Monitor Logs exceeded the ${operationLimits.maxRecords}-record operation limit.`,
          'record-limit-exceeded',
        )
      }
      return parsedRows
    }

    const readPartition = async (
      kind: 'baseline' | 'observed',
      windowStart: string,
      windowEnd: string,
    ): Promise<ProjectedRow[]> => {
      const parsedRows = await queryPage(windowStart, windowEnd, MAX_QUERY_ROWS_PER_PAGE)
      if (parsedRows.length <= MAX_REPRESENTATIVE_OTEL_OBSERVATIONS) return parsedRows

      const startMs = Date.parse(windowStart)
      const endMs = Date.parse(windowEnd)
      const midpointMs = Math.floor((startMs + endMs) / 2)
      if (midpointMs <= startMs || midpointMs >= endMs) {
        throw new AzureMonitorOtelConnectorError(
          `Azure Monitor ${kind} window cannot be partitioned below the 500-observation validation bound.`,
        )
      }
      const midpoint = new Date(midpointMs).toISOString()
      return [
        ...(await readPartition(kind, windowStart, midpoint)),
        ...(await readPartition(kind, midpoint, windowEnd)),
      ]
    }

    const initialRows = await queryPage(baselineStart, observedEnd, MAX_INITIAL_QUERY_ROWS)
    const initialBaselineRows = initialRows.filter(
      (row) => new Date(row.ObservedAt).getTime() < new Date(baselineEnd).getTime(),
    )
    const initialObservedRows = initialRows.filter(
      (row) => new Date(row.ObservedAt).getTime() >= new Date(observedStart).getTime(),
    )
    const initialPageTruncated = initialRows.length === MAX_INITIAL_QUERY_ROWS
    const baselineOriginalRows =
      initialPageTruncated || initialBaselineRows.length > MAX_REPRESENTATIVE_OTEL_OBSERVATIONS
        ? await readPartition('baseline', baselineStart, baselineEnd)
        : initialBaselineRows
    const observedOriginalRows =
      initialPageTruncated || initialObservedRows.length > MAX_REPRESENTATIVE_OTEL_OBSERVATIONS
        ? await readPartition('observed', observedStart, observedEnd)
        : initialObservedRows
    const parsedRows = [...baselineOriginalRows, ...observedOriginalRows]
    const canonicalization = canonicalizeAzureMonitorRows(parsedRows)
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
      this.config.providerResourceId,
      binding.agentId,
      sourceAgentId,
      sourceSetFingerprint,
      this.config.applicationRoleName,
      this.config.requestName,
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
          providerResourceId: this.config.providerResourceId,
          agentId: binding.agentId,
          sourceAgentId,
          sourceSetFingerprint,
          measuredAt: queriedAt,
          contract: {
            version: 1 as const,
            recordType: 'agent_invocation' as const,
            applicationRoleName: this.config.applicationRoleName,
            requestName: this.config.requestName,
          },
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
      queryDiagnostics: {
        providerRequests: pagesRead,
        providerPages: pagesRead,
        rawRows: rawRowsRead,
        canonicalRows: canonicalization.rows.length,
        acceptedInvocations:
          baseline.window.observations.length + observed.window.observations.length,
        responseBytes: bytesRead,
      },
      ...(exactBoundary
        ? {
            provenance: {
              snapshotGeneratedAt: binding.snapshotGeneratedAt,
              estateId: binding.estateId,
              estateTenantId: binding.tenantId,
              estateEnvironment: binding.estateEnvironment,
              sourceConnectorId: binding.sourceConnectorId,
              sourceTenantId,
              sourceProjectId,
              sourceEnvironment,
              provider: 'azure-monitor-otel' as const,
              providerResourceId: this.config.providerResourceId,
              providerAgentId: sourceAgentId,
              sourceSetFingerprint,
              measuredAt: queriedAt,
              contract: {
                version: 1,
                recordType: 'agent_invocation',
                applicationRoleName: this.config.applicationRoleName,
                requestName: this.config.requestName,
              },
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
  measurementKey: string | undefined
}

const telemetryReadinessRank = { ready: 0, degraded: 1, unavailable: 2 } as const
const telemetryDataStateRank: Record<LiveSourceDataState, number> = {
  complete: 0,
  empty: 1,
  unsupported: 2,
  partial: 3,
  stale: 4,
  cancelled: 5,
  failed: 6,
}

function updateTelemetrySourceState(
  source: TelemetrySourceState,
  measurementKey: string,
  update: Pick<TelemetrySourceState, 'readiness' | 'dataState' | 'checkedAt' | 'reason'>,
): void {
  const reset = source.measurementKey !== measurementKey
  if (reset) {
    source.readiness = update.readiness
    source.dataState = update.dataState
    source.checkedAt = update.checkedAt
    source.reason = update.reason
    source.measurementKey = measurementKey
    return
  }
  const currentDataRank =
    source.dataState === undefined ? -1 : telemetryDataStateRank[source.dataState]
  const updateDataRank =
    update.dataState === undefined ? -1 : telemetryDataStateRank[update.dataState]
  if (
    telemetryReadinessRank[update.readiness] > telemetryReadinessRank[source.readiness] ||
    (telemetryReadinessRank[update.readiness] === telemetryReadinessRank[source.readiness] &&
      updateDataRank > currentDataRank)
  ) {
    source.readiness = update.readiness
    source.dataState = update.dataState
    source.reason = update.reason
  }
  source.checkedAt =
    source.checkedAt === undefined || update.checkedAt === undefined
      ? (update.checkedAt ?? source.checkedAt)
      : source.checkedAt > update.checkedAt
        ? source.checkedAt
        : update.checkedAt
  source.measurementKey = measurementKey
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
      nested.providerAgentId === provenance.providerAgentId &&
      nested.providerInvocationId === observation.id &&
      nested.sourceSetFingerprint === provenance.sourceSetFingerprint &&
      nested.measuredAt === provenance.measuredAt &&
      nested.contract !== undefined &&
      provenance.contract !== undefined &&
      nested.contract.version === provenance.contract.version &&
      nested.contract.recordType === provenance.contract.recordType &&
      nested.contract.applicationRoleName === provenance.contract.applicationRoleName &&
      nested.contract.requestName === provenance.contract.requestName &&
      nested.contract.outcome === (observation.success ? 'success' : 'error')
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
  readonly sourceSetFingerprint: string
  private readonly sources: TelemetrySourceState[]

  constructor(
    sourcesInput: readonly AzureMonitorOtelSourceConfigInput[],
    credentialFactory: AzureMonitorCredentialFactory = createTelemetrySourceCredential,
    fetcherFactory: (source: AzureMonitorOtelSourceConfig) => typeof fetch = () => fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {
    const sources = azureMonitorOtelSourcesConfigSchema.parse(sourcesInput)
    this.sourceSetFingerprint = computeAzureMonitorOtelSourceSetFingerprint(sources)
    this.sources = sources.map((config) => ({
      config,
      connector: new AzureMonitorOtelConnector(
        {
          workspaceId: config.workspaceId,
          providerResourceId: config.providerResourceId,
          applicationRoleName: config.applicationRoleName,
          requestName: config.requestName,
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
        this.sourceSetFingerprint,
      ),
      readiness: 'degraded',
      dataState: undefined,
      checkedAt: undefined,
      reason: 'not-queried',
      measurementKey: undefined,
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
      sourceEnvironment !== source.config.environment ||
      (request.sourceSetFingerprint !== undefined &&
        request.sourceSetFingerprint !== this.sourceSetFingerprint)
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
          sourceSetFingerprint: this.sourceSetFingerprint,
        },
        options,
      )
      const dataState = runtimeDataState(windows)
      updateTelemetrySourceState(source, request.snapshotGeneratedAt ?? windows.queriedAt, {
        dataState: dataState.state,
        readiness: dataState.state === 'complete' ? 'ready' : 'degraded',
        checkedAt: windows.queriedAt,
        reason: dataState.reason,
      })
      return windows
    } catch (error) {
      const dataState =
        error instanceof AzureMonitorOtelConnectorError && error.reason === 'cancelled'
          ? 'cancelled'
          : 'failed'
      const checkedAt = this.clock().toISOString()
      updateTelemetrySourceState(source, request.snapshotGeneratedAt ?? checkedAt, {
        dataState,
        readiness: 'unavailable',
        checkedAt,
        reason: dataState === 'cancelled' ? 'cancelled' : 'query-failed',
      })
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
      sourceSetFingerprint: this.sourceSetFingerprint,
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
    'AZURE_MONITOR_PROVIDER_RESOURCE_ID',
    'AZURE_MONITOR_APPLICATION_ROLE_NAME',
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
      providerResourceId: environment.AZURE_MONITOR_PROVIDER_RESOURCE_ID,
      applicationRoleName: environment.AZURE_MONITOR_APPLICATION_ROLE_NAME,
      requestName: 'agent.invoke',
      tenantId: environment.AZURE_MONITOR_TENANT_ID,
      sourceProjectId: sourceProjectIdFromEndpoint(foundryProjectEndpoint),
      environment: environment.AZURE_MONITOR_ENVIRONMENT,
      baselineWindowHours: numberValue(environment, 'AZURE_MONITOR_BASELINE_WINDOW_HOURS', 168),
      observedWindowHours: numberValue(environment, 'AZURE_MONITOR_OBSERVED_WINDOW_HOURS', 24),
      maximumFreshnessHours: numberValue(environment, 'AZURE_MONITOR_MAXIMUM_FRESHNESS_HOURS', 168),
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
