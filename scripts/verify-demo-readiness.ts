import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  assessDemoReadiness,
  parseConnectorsCollectionResponse,
  type DemoReadinessAssessment,
} from '@agent-sentinel/connector-sdk/demo-readiness'
import { agentSentinelStateSchema, connectorSourceReadModelSchema } from '@agent-sentinel/domain'
import { z } from 'zod'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 60_000
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/i)
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/i)
const deploymentStatusSchema = z.strictObject({
  status: z.literal('ok'),
  service: z.literal('agent-sentinel-api'),
  observedAt: z.iso.datetime(),
  revision: z.string().optional(),
  security: z.strictObject({
    authMode: z.enum(['disabled', 'jwt', 'unknown']),
    writeEnabled: z.boolean().nullable(),
  }),
  components: z.strictObject({
    web: z.strictObject({ sha: shaSchema.optional(), digest: digestSchema.optional() }),
    api: z.strictObject({ sha: shaSchema.optional(), digest: digestSchema.optional() }),
    jobs: z.strictObject({ sha: shaSchema.optional(), digest: digestSchema.optional() }),
  }),
})
const authConfigSchema = z.union([
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    tenantId: z.string().uuid(),
    clientId: z.string().uuid(),
    authority: z.url(),
    scopes: z.array(z.string().min(1)).min(1),
    redirectUri: z.url(),
    postLogoutRedirectUri: z.url(),
  }),
])
const healthSchema = z.strictObject({
  status: z.literal('ok'),
  service: z.literal('agent-sentinel-api'),
  timestamp: z.iso.datetime(),
})

export interface VerifyDemoArgs {
  readonly baseUrl: string
  readonly outputPath?: string
  readonly tokenEnvironment?: string
  readonly timeoutMs: number
  readonly maxResponseBytes: number
  readonly expected: {
    readonly webSha?: string
    readonly apiSha?: string
    readonly jobsSha?: string
    readonly webDigest?: string
    readonly apiDigest?: string
    readonly jobsDigest?: string
  }
}

interface RequestObservation {
  readonly path: string
  readonly status: number | null
  readonly durationMs: number
  readonly bytes: number
  readonly outcome:
    'ok' | 'http-error' | 'timeout' | 'response-too-large' | 'invalid-json' | 'network-error'
  readonly message?: string
}

export interface DemoVerificationReport {
  readonly schemaVersion: '1.0.0'
  readonly generatedAt: string
  readonly baseOrigin: string
  readonly overall: DemoReadinessAssessment['status']
  readonly summary: string
  readonly readiness?: DemoReadinessAssessment
  readonly web: {
    readonly status: DemoReadinessAssessment['status']
    readonly httpStatus: number | null
    readonly contentType?: string
  }
  readonly api: {
    readonly health: {
      readonly status: DemoReadinessAssessment['status']
      readonly observedAt?: string
    }
    readonly authentication: {
      readonly status: DemoReadinessAssessment['status']
      readonly enabled?: boolean
      readonly scopeCount?: number
      readonly sameOriginRedirects?: boolean
    }
  }
  readonly version: {
    readonly status: DemoReadinessAssessment['status']
    readonly endpointAvailable: boolean
    readonly apiHeadersObserved: boolean
    readonly apiHeadersMatchStatus?: boolean
    readonly revision?: string
    readonly components: Record<
      'web' | 'api' | 'jobs',
      {
        readonly observedSha?: string
        readonly observedDigest?: string
        readonly expectedSha?: string
        readonly expectedDigest?: string
        readonly shaMatches?: boolean
        readonly digestMatches?: boolean
      }
    >
  }
  readonly requests: readonly RequestObservation[]
  readonly notes: readonly string[]
}

export type FetchImplementation = typeof fetch

class UsageError extends Error {
  override readonly name = 'UsageError'
}

class BoundedRequestError extends Error {
  constructor(
    readonly outcome: RequestObservation['outcome'],
    message: string,
  ) {
    super(message)
  }
}

function requiredValue(input: readonly string[], index: number, option: string): string {
  const value = input[index + 1]
  if (value === undefined || value.trim() === '' || value.startsWith('--')) {
    throw new UsageError(`${option} requires a non-empty value.`)
  }
  return value
}

function parsePositiveInteger(value: string, option: string, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new UsageError(`${option} must be an integer between 1 and ${maximum}.`)
  }
  return parsed
}

function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new UsageError('--url must be an absolute HTTP or HTTPS URL.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
    throw new UsageError('--url must be an absolute HTTP or HTTPS URL without credentials.')
  }
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

export function parseVerifyDemoArgs(input: readonly string[]): VerifyDemoArgs {
  let baseUrl: string | undefined
  let outputPath: string | undefined
  let timeoutMs = DEFAULT_TIMEOUT_MS
  let tokenEnvironment: string | undefined
  let maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
  const expected: Record<string, string> = {}
  const seen = new Set<string>()
  const allowed = new Set([
    '--url',
    '--output',
    '--timeout-ms',
    '--max-response-bytes',
    '--token-env',
    '--expected-web-sha',
    '--expected-api-sha',
    '--expected-jobs-sha',
    '--expected-web-digest',
    '--expected-api-digest',
    '--expected-jobs-digest',
  ])
  for (let index = 0; index < input.length; index += 1) {
    const option = input[index]
    if (option === undefined || option === '--') continue
    if (!allowed.has(option)) throw new UsageError(`Unknown option ${option}.`)
    if (seen.has(option)) throw new UsageError(`${option} may be provided only once.`)
    seen.add(option)
    const value = requiredValue(input, index, option)
    if (option === '--url') baseUrl = normalizeBaseUrl(value)
    else if (option === '--output') outputPath = value
    else if (option === '--token-env') {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) {
        throw new UsageError('--token-env must name an uppercase environment variable.')
      }
      tokenEnvironment = value
    } else if (option === '--timeout-ms') {
      timeoutMs = parsePositiveInteger(value, option, MAX_TIMEOUT_MS)
    } else if (option === '--max-response-bytes') {
      maxResponseBytes = parsePositiveInteger(value, option, MAX_RESPONSE_BYTES)
    } else if (option.endsWith('-sha')) {
      expected[option.slice('--expected-'.length).replace('-', '')] = shaSchema.parse(value)
    } else {
      expected[option.slice('--expected-'.length).replace('-', '')] = digestSchema.parse(value)
    }
    index += 1
  }
  if (baseUrl === undefined) throw new UsageError('--url is required.')
  return {
    baseUrl,
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(tokenEnvironment === undefined ? {} : { tokenEnvironment }),
    timeoutMs,
    maxResponseBytes,
    expected: {
      ...(expected['websha'] === undefined ? {} : { webSha: expected['websha'] }),
      ...(expected['apisha'] === undefined ? {} : { apiSha: expected['apisha'] }),
      ...(expected['jobssha'] === undefined ? {} : { jobsSha: expected['jobssha'] }),
      ...(expected['webdigest'] === undefined ? {} : { webDigest: expected['webdigest'] }),
      ...(expected['apidigest'] === undefined ? {} : { apiDigest: expected['apidigest'] }),
      ...(expected['jobsdigest'] === undefined ? {} : { jobsDigest: expected['jobsdigest'] }),
    },
  }
}

async function readBoundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    throw new BoundedRequestError('response-too-large', `Response exceeded ${maximum} bytes.`)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maximum) {
      await reader.cancel().catch(() => undefined)
      throw new BoundedRequestError('response-too-large', `Response exceeded ${maximum} bytes.`)
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

async function request(
  args: VerifyDemoArgs,
  path: string,
  fetchImplementation: FetchImplementation,
  observations: RequestObservation[],
): Promise<{ readonly response: Response; readonly body: Uint8Array } | undefined> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeoutMs)
  try {
    const bearerToken =
      args.tokenEnvironment === undefined ? undefined : process.env[args.tokenEnvironment]?.trim()
    const requiresAuthentication =
      path.startsWith('/api/') && !['/api/health', '/api/status', '/api/auth/config'].includes(path)
    if (requiresAuthentication && args.tokenEnvironment !== undefined && !bearerToken) {
      throw new BoundedRequestError(
        'network-error',
        `Authentication environment variable ${args.tokenEnvironment} is not set.`,
      )
    }
    const response = await fetchImplementation(new URL(path, `${args.baseUrl}/`), {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/html;q=0.9, text/plain;q=0.8',
        ...(bearerToken === undefined || !requiresAuthentication
          ? {}
          : { Authorization: `Bearer ${bearerToken}` }),
      },
    })
    const body = await readBoundedBody(response, args.maxResponseBytes)
    observations.push({
      path,
      status: response.status,
      durationMs: Date.now() - startedAt,
      bytes: body.byteLength,
      outcome: response.ok ? 'ok' : 'http-error',
    })
    return { response, body }
  } catch (error: unknown) {
    const outcome =
      error instanceof BoundedRequestError
        ? error.outcome
        : controller.signal.aborted
          ? 'timeout'
          : 'network-error'
    observations.push({
      path,
      status: null,
      durationMs: Date.now() - startedAt,
      bytes: 0,
      outcome,
      message: error instanceof Error ? error.message : 'Request failed.',
    })
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

function markInvalidJson(observations: RequestObservation[], path: string): void {
  const index = observations.findIndex((item) => item.path === path)
  const current = observations[index]
  if (index < 0 || current === undefined) return
  observations[index] = {
    ...current,
    outcome: 'invalid-json',
    message: 'Response did not match the documented JSON contract.',
  }
}

function parseJson<T>(
  observation: { readonly response: Response; readonly body: Uint8Array } | undefined,
  schema: z.ZodType<T>,
  path: string,
  observations: RequestObservation[],
): T | undefined {
  if (observation === undefined || !observation.response.ok) return undefined
  try {
    return schema.parse(JSON.parse(new TextDecoder().decode(observation.body)) as unknown)
  } catch {
    markInvalidJson(observations, path)
    return undefined
  }
}

function mergeOverall(
  statuses: readonly DemoReadinessAssessment['status'][],
): DemoReadinessAssessment['status'] {
  if (statuses.includes('blocked')) return 'blocked'
  if (statuses.includes('unavailable')) return 'unavailable'
  if (statuses.includes('partial')) return 'partial'
  return 'ready'
}

function compareVersions(
  status: z.infer<typeof deploymentStatusSchema> | undefined,
  expected: VerifyDemoArgs['expected'],
  response: Response | undefined,
): DemoVerificationReport['version'] {
  const components = Object.fromEntries(
    (['web', 'api', 'jobs'] as const).map((name) => {
      const observed = status?.components[name]
      const expectedSha = expected[`${name}Sha`]
      const expectedDigest = expected[`${name}Digest`]
      return [
        name,
        {
          ...(observed?.sha === undefined ? {} : { observedSha: observed.sha }),
          ...(observed?.digest === undefined ? {} : { observedDigest: observed.digest }),
          ...(expectedSha === undefined ? {} : { expectedSha }),
          ...(expectedDigest === undefined ? {} : { expectedDigest }),
          ...(expectedSha === undefined || observed?.sha === undefined
            ? {}
            : { shaMatches: observed.sha === expectedSha.toLowerCase() }),
          ...(expectedDigest === undefined || observed?.digest === undefined
            ? {}
            : { digestMatches: observed.digest === expectedDigest.toLowerCase() }),
        },
      ]
    }),
  ) as DemoVerificationReport['version']['components']
  const expectations = Object.values(components).flatMap((component) => [
    component.shaMatches,
    component.digestMatches,
  ])
  const mismatch = expectations.includes(false)
  const apiHeaderSha = response?.headers.get('x-agent-sentinel-api-sha')?.toLowerCase()
  const apiHeaderDigest = response?.headers.get('x-agent-sentinel-api-image-digest')?.toLowerCase()
  const apiHeadersObserved = apiHeaderSha !== undefined || apiHeaderDigest !== undefined
  const apiHeadersMatchStatus = !apiHeadersObserved
    ? undefined
    : (apiHeaderSha === undefined || apiHeaderSha === status?.components.api.sha) &&
      (apiHeaderDigest === undefined || apiHeaderDigest === status?.components.api.digest)
  const missingExpected = (['web', 'api', 'jobs'] as const).some((name) => {
    const component = components[name]
    return (
      (component.expectedSha !== undefined && component.observedSha === undefined) ||
      (component.expectedDigest !== undefined && component.observedDigest === undefined)
    )
  })
  const hasExpectations = Object.keys(expected).length > 0
  return {
    status:
      status === undefined
        ? hasExpectations
          ? 'unavailable'
          : 'partial'
        : mismatch || apiHeadersMatchStatus === false
          ? 'blocked'
          : missingExpected
            ? 'partial'
            : 'ready',
    endpointAvailable: status !== undefined,
    apiHeadersObserved,
    ...(apiHeadersMatchStatus === undefined ? {} : { apiHeadersMatchStatus }),
    ...(status?.revision === undefined ? {} : { revision: status.revision }),
    components,
  }
}

export async function verifyDemoReadiness(
  args: VerifyDemoArgs,
  fetchImplementation: FetchImplementation = fetch,
): Promise<DemoVerificationReport> {
  const observations: RequestObservation[] = []
  const [
    webResponse,
    apiHealthResponse,
    authResponse,
    statusResponse,
    connectorsResponse,
    sourcesResponse,
    stateResponse,
  ] = await Promise.all([
    request(args, '/', fetchImplementation, observations),
    request(args, '/api/health', fetchImplementation, observations),
    request(args, '/api/auth/config', fetchImplementation, observations),
    request(args, '/api/status', fetchImplementation, observations),
    request(args, '/api/connectors', fetchImplementation, observations),
    request(args, '/api/connector-sources?limit=50', fetchImplementation, observations),
    request(args, '/api/demo/state', fetchImplementation, observations),
  ])

  const webContentType = webResponse?.response.headers.get('content-type') ?? undefined
  const webStatus: DemoReadinessAssessment['status'] =
    webResponse === undefined
      ? 'unavailable'
      : webResponse.response.ok &&
          webResponse.body.byteLength > 0 &&
          webContentType?.toLowerCase().includes('text/html') === true
        ? 'ready'
        : 'blocked'
  const health = parseJson(apiHealthResponse, healthSchema, '/api/health', observations)
  const auth = parseJson(authResponse, authConfigSchema, '/api/auth/config', observations)
  const deployment = parseJson(statusResponse, deploymentStatusSchema, '/api/status', observations)
  const connectors = (() => {
    if (connectorsResponse === undefined || !connectorsResponse.response.ok) return undefined
    try {
      return parseConnectorsCollectionResponse(
        JSON.parse(new TextDecoder().decode(connectorsResponse.body)) as unknown,
      )
    } catch {
      markInvalidJson(observations, '/api/connectors')
      return undefined
    }
  })()
  const sourcePage = parseJson(
    sourcesResponse,
    z.strictObject({
      items: z.array(connectorSourceReadModelSchema),
      page: z.strictObject({ limit: z.number().int(), nextCursor: z.string().nullable() }),
      mutationPolicy: z.unknown(),
    }),
    '/api/connector-sources?limit=50',
    observations,
  )
  const state = parseJson(stateResponse, agentSentinelStateSchema, '/api/demo/state', observations)
  const readiness =
    connectors === undefined || sourcePage === undefined || state === undefined
      ? undefined
      : assessDemoReadiness({
          state,
          connectors,
          connectorSources: sourcePage.items,
        })
  const baseOrigin = new URL(args.baseUrl).origin
  const sameOriginRedirects =
    auth?.enabled === true
      ? new URL(auth.redirectUri).origin === new URL(auth.postLogoutRedirectUri).origin
      : undefined
  const authenticationStatus: DemoReadinessAssessment['status'] =
    auth === undefined
      ? 'unavailable'
      : !auth.enabled
        ? 'partial'
        : sameOriginRedirects
          ? 'ready'
          : 'blocked'
  const version = compareVersions(deployment, args.expected, statusResponse?.response)
  const overall = mergeOverall([
    webStatus,
    health === undefined ? 'unavailable' : 'ready',
    authenticationStatus,
    version.status,
    readiness?.status ?? 'unavailable',
  ])
  const notes: string[] = []
  if (auth?.enabled === false)
    notes.push('Authentication is disabled; protected API evidence may be unavailable.')
  if (readiness === undefined)
    notes.push('Protected deployment evidence could not be parsed or retrieved.')
  if (sourcePage?.page.nextCursor !== null) {
    notes.push(
      'Connector-source verification is bounded to the first 50 sources; a matching source was not inferred from later pages.',
    )
  }
  return {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    baseOrigin,
    overall,
    summary:
      overall === 'ready'
        ? 'Hackathon demo readiness verified from bounded live deployment evidence.'
        : overall === 'partial'
          ? 'Deployment is reachable, but one or more explicitly identified evidence gates are incomplete.'
          : overall === 'blocked'
            ? 'Deployment evidence contains a blocked demo-readiness gate.'
            : 'Deployment evidence is unavailable or could not be validated.',
    ...(readiness === undefined ? {} : { readiness }),
    web: {
      status: webStatus,
      httpStatus: webResponse?.response.status ?? null,
      ...(webContentType === undefined ? {} : { contentType: webContentType }),
    },
    api: {
      health: {
        status: health === undefined ? 'unavailable' : 'ready',
        ...(health === undefined ? {} : { observedAt: health.timestamp }),
      },
      authentication: {
        status: authenticationStatus,
        ...(auth === undefined ? {} : { enabled: auth.enabled }),
        ...(auth?.enabled !== true
          ? {}
          : {
              scopeCount: auth.scopes.length,
              sameOriginRedirects: sameOriginRedirects === true,
            }),
      },
    },
    version,
    requests: observations.toSorted((left, right) => left.path.localeCompare(right.path)),
    notes,
  }
}

export function consoleSummary(report: DemoVerificationReport): string {
  const readiness = report.readiness
  const parts = [
    `demo readiness: ${report.overall.toUpperCase()}`,
    readiness === undefined ? 'evidence unavailable' : `Agent365 ${readiness.agent365.status}`,
    readiness === undefined ? 'RUNS_AS unavailable' : `RUNS_AS ${readiness.runsAs.exactEdgeCount}`,
    readiness === undefined
      ? 'OTel unavailable'
      : `OTel ${readiness.otel.liveInvocationCount}/${readiness.otel.acceptedRecordCount}`,
    `version ${report.version.status}`,
  ]
  return parts.join(' | ')
}

export async function runVerifyDemoCommand(input: readonly string[]): Promise<number> {
  try {
    const args = parseVerifyDemoArgs(input)
    const report = await verifyDemoReadiness(args)
    const json = `${JSON.stringify(report, null, 2)}\n`
    if (args.outputPath === undefined || args.outputPath === '-') process.stdout.write(json)
    else await writeFile(resolve(args.outputPath), json)
    process.stderr.write(`${consoleSummary(report)}\n`)
    return report.overall === 'ready' ? 0 : report.overall === 'partial' ? 3 : 1
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Verification failed.'}\n`)
    return error instanceof UsageError ? 2 : 1
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) process.exitCode = await runVerifyDemoCommand(process.argv.slice(2))
