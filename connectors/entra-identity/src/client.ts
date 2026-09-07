import type { TokenCredential } from '@azure/core-auth'

import {
  agentIdentityPreviewPageSchema,
  appRoleAssignmentPageSchema,
  directoryOwnerPageSchema,
  servicePrincipalPageSchema,
  type AgentIdentityPreview,
  type EntraAppRoleAssignment,
  type EntraDirectoryOwner,
  type EntraIdentityConnectorConfig,
  type EntraServicePrincipal,
} from './schemas.js'

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default'
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

export type EntraGraphErrorCode =
  | 'authentication'
  | 'authorization'
  | 'bounds'
  | 'cancelled'
  | 'malformed-response'
  | 'network'
  | 'request-failed'
  | 'timeout'
  | 'untrusted-next-link'

export class EntraGraphError extends Error {
  override readonly name = 'EntraGraphError'

  constructor(
    readonly code: EntraGraphErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface EntraGraphClientOptions {
  fetcher?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
}

export interface EntraGraphOperationOptions {
  signal?: AbortSignal
  maxPages?: number
  maxRecords?: number
}

export interface EntraGraphOperationMeasurement {
  pages: number
  records: number
}

export interface EntraGraphOperationContext {
  readonly signal?: AbortSignal
  readonly maxPages: number
  readonly maxRecords: number
  readonly measurement: EntraGraphOperationMeasurement
}

interface Page<T> {
  '@odata.nextLink'?: string | undefined
  value: T[]
}

interface PageParser<T> {
  safeParse(value: unknown): { success: true; data: Page<T> } | { success: false }
}

function retryAfterMilliseconds(value: string | null, now: number): number | undefined {
  if (value === null) return undefined
  const normalized = value.trim()
  if (normalized === '') return undefined
  const seconds = Number(normalized)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const date = Date.parse(normalized)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}

function statusError(status: number): EntraGraphError {
  if (status === 401)
    return new EntraGraphError(
      'authentication',
      'Microsoft Graph rejected the connector credential (status 401).',
      status,
    )
  if (status === 403)
    return new EntraGraphError(
      'authorization',
      'Microsoft Graph authorization is required for this read-only connector (status 403).',
      status,
    )
  return new EntraGraphError(
    'request-failed',
    `Microsoft Graph request failed with status ${status}.`,
    status,
  )
}

function signalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw new Error('Microsoft Graph response body read was aborted.')
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      void reader.cancel(signal.reason).catch(() => undefined)
      reject(new Error('Microsoft Graph response body read was aborted.'))
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
      throw new EntraGraphError(
        'malformed-response',
        'Microsoft Graph returned an invalid content-length header.',
      )
    }
    if (Number(declaredLength) > maximumBytes) {
      void response.body?.cancel().catch(() => undefined)
      throw new EntraGraphError(
        'bounds',
        `Microsoft Graph response exceeded the ${maximumBytes} byte response limit.`,
      )
    }
  }
  if (response.body === null) {
    throw new EntraGraphError('malformed-response', 'Microsoft Graph returned no response body.')
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
      throw new EntraGraphError(
        'bounds',
        `Microsoft Graph response exceeded the ${maximumBytes} byte response limit.`,
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
    throw new EntraGraphError('malformed-response', 'Microsoft Graph returned a non-JSON response.')
  }
}

export class EntraGraphClient {
  private readonly fetcher: typeof fetch
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly now: () => number

  constructor(
    private readonly config: EntraIdentityConnectorConfig,
    private readonly credential: TokenCredential,
    options: EntraGraphClientOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.now = options.now ?? Date.now
  }

  createOperation(options: EntraGraphOperationOptions = {}): EntraGraphOperationContext {
    const maxPages = Math.min(
      options.maxPages ?? this.config.limits.maxPages,
      this.config.limits.maxPages,
    )
    const maxRecords = Math.min(
      options.maxRecords ?? this.config.limits.maxItems,
      this.config.limits.maxItems,
    )
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      throw new EntraGraphError('bounds', 'Microsoft Graph page limit must be a positive integer.')
    }
    if (!Number.isInteger(maxRecords) || maxRecords < 1) {
      throw new EntraGraphError(
        'bounds',
        'Microsoft Graph record limit must be a positive integer.',
      )
    }
    return {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      maxPages,
      maxRecords,
      measurement: { pages: 0, records: 0 },
    }
  }

  async probeStableInventory(
    options: EntraGraphOperationOptions | EntraGraphOperationContext = {},
  ): Promise<EntraGraphOperationMeasurement> {
    const operation = this.operation(options)
    const url = this.stableServicePrincipalsUrl()
    url.searchParams.set('$top', '1')
    this.assertPageBudget(operation)
    const page = this.parsePage(
      servicePrincipalPageSchema,
      await this.requestJson(url, operation.signal),
    )
    this.recordPage(operation, page.value.length)
    return { ...operation.measurement }
  }

  listServicePrincipals(
    options: EntraGraphOperationOptions | EntraGraphOperationContext = {},
  ): Promise<EntraServicePrincipal[]> {
    return this.collect<EntraServicePrincipal>(
      this.stableServicePrincipalsUrl(),
      servicePrincipalPageSchema,
      this.operation(options),
    )
  }

  async listOwners(
    servicePrincipals: readonly EntraServicePrincipal[],
    options: EntraGraphOperationOptions | EntraGraphOperationContext = {},
  ): Promise<Map<string, EntraDirectoryOwner[]>> {
    const operation = this.operation(options)
    const owners = new Map<string, EntraDirectoryOwner[]>()
    for (const principal of servicePrincipals) {
      const url = new URL(
        `/v1.0/servicePrincipals/${encodeURIComponent(principal.id)}/owners`,
        this.config.graphBaseUrl,
      )
      url.searchParams.set('$select', 'id,displayName,userPrincipalName')
      owners.set(
        principal.id,
        await this.collect<EntraDirectoryOwner>(url, directoryOwnerPageSchema, operation),
      )
    }
    return owners
  }

  async listAppRoleAssignments(
    servicePrincipals: readonly EntraServicePrincipal[],
    options: EntraGraphOperationOptions | EntraGraphOperationContext = {},
  ): Promise<Map<string, EntraAppRoleAssignment[]>> {
    const operation = this.operation(options)
    const assignments = new Map<string, EntraAppRoleAssignment[]>()
    for (const principal of servicePrincipals) {
      const url = new URL(
        `/v1.0/servicePrincipals/${encodeURIComponent(principal.id)}/appRoleAssignments`,
        this.config.graphBaseUrl,
      )
      url.searchParams.set(
        '$select',
        'id,appRoleId,principalId,resourceId,principalDisplayName,principalType,resourceDisplayName,createdDateTime',
      )
      const values = await this.collect<EntraAppRoleAssignment>(
        url,
        appRoleAssignmentPageSchema,
        operation,
      )
      if (values.some((assignment) => assignment.principalId !== principal.id)) {
        throw new EntraGraphError(
          'malformed-response',
          'Microsoft Graph returned an app-role assignment outside the requested principal boundary.',
        )
      }
      assignments.set(principal.id, values)
    }
    return assignments
  }

  listAgentIdentitiesPreview(
    options: EntraGraphOperationOptions | EntraGraphOperationContext = {},
  ): Promise<AgentIdentityPreview[]> {
    const url = new URL(
      '/beta/servicePrincipals/microsoft.graph.agentIdentity',
      this.config.graphBaseUrl,
    )
    url.searchParams.set(
      '$select',
      'id,appId,displayName,accountEnabled,agentIdentityBlueprintId,createdByAppId,createdDateTime,managerApplications,servicePrincipalType,tags',
    )
    return this.collect<AgentIdentityPreview>(
      url,
      agentIdentityPreviewPageSchema,
      this.operation(options),
    )
  }

  private stableServicePrincipalsUrl(): URL {
    const url = new URL('/v1.0/servicePrincipals', this.config.graphBaseUrl)
    url.searchParams.set(
      '$select',
      'id,appId,displayName,description,servicePrincipalType,accountEnabled,appOwnerOrganizationId,tags',
    )
    return url
  }

  private operation(
    options: EntraGraphOperationOptions | EntraGraphOperationContext,
  ): EntraGraphOperationContext {
    return 'measurement' in options ? options : this.createOperation(options)
  }

  private assertPageBudget(operation: EntraGraphOperationContext): void {
    if (operation.measurement.pages >= operation.maxPages) {
      throw new EntraGraphError('bounds', 'Microsoft Graph pagination exceeded the page limit.')
    }
  }

  private recordPage(operation: EntraGraphOperationContext, records: number): void {
    operation.measurement.pages += 1
    operation.measurement.records += records
    if (operation.measurement.records > operation.maxRecords) {
      throw new EntraGraphError('bounds', 'Microsoft Graph pagination exceeded the item limit.')
    }
  }

  private async collect<T>(
    initial: URL,
    schema: PageParser<T>,
    operation: EntraGraphOperationContext,
  ): Promise<T[]> {
    const values: T[] = []
    let next: URL | undefined = new URL(initial)
    while (next !== undefined) {
      this.assertPageBudget(operation)
      const page: Page<T> = this.parsePage<T>(
        schema,
        await this.requestJson(next, operation.signal),
      )
      this.recordPage(operation, page.value.length)
      values.push(...page.value)
      next =
        page['@odata.nextLink'] === undefined
          ? undefined
          : this.validateNextLink(page['@odata.nextLink'], initial)
    }
    return values
  }

  private parsePage<T>(schema: PageParser<T>, body: unknown): Page<T> {
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      throw new EntraGraphError(
        'malformed-response',
        'Microsoft Graph returned a response that does not match the projected schema.',
      )
    }
    return parsed.data
  }

  private validateNextLink(value: string, initial: URL): URL {
    let candidate: URL
    try {
      candidate = new URL(value)
    } catch {
      throw new EntraGraphError(
        'untrusted-next-link',
        'Microsoft Graph returned an invalid nextLink.',
      )
    }
    if (
      candidate.protocol !== 'https:' ||
      candidate.hostname.toLowerCase() !== 'graph.microsoft.com' ||
      candidate.username !== '' ||
      candidate.password !== '' ||
      candidate.port !== '' ||
      candidate.origin !== new URL(this.config.graphBaseUrl).origin ||
      candidate.pathname !== initial.pathname ||
      candidate.hash !== ''
    ) {
      throw new EntraGraphError(
        'untrusted-next-link',
        'Microsoft Graph returned an untrusted nextLink.',
      )
    }
    return candidate
  }

  private async requestJson(url: URL, externalSignal?: AbortSignal): Promise<unknown> {
    if (signalAborted(externalSignal)) {
      throw new EntraGraphError('cancelled', 'Microsoft Graph request was cancelled.')
    }
    let token: string
    try {
      const accessToken = await this.credential.getToken(
        GRAPH_SCOPE,
        externalSignal === undefined ? undefined : { abortSignal: externalSignal },
      )
      if (accessToken === null) {
        throw new EntraGraphError(
          'authentication',
          'Azure credential did not return a Microsoft Graph access token.',
        )
      }
      token = accessToken.token
    } catch (error) {
      if (error instanceof EntraGraphError) throw error
      if (signalAborted(externalSignal)) {
        throw new EntraGraphError('cancelled', 'Microsoft Graph request was cancelled.')
      }
      throw new EntraGraphError('authentication', 'Microsoft Graph credential acquisition failed.')
    }

    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, this.config.limits.requestTimeoutMs)
      const signal =
        externalSignal === undefined
          ? controller.signal
          : AbortSignal.any([externalSignal, controller.signal])
      let response: Response
      try {
        response = await this.fetcher(url, {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
          signal,
        })
      } catch {
        if (signalAborted(externalSignal)) {
          throw new EntraGraphError('cancelled', 'Microsoft Graph request was cancelled.')
        }
        if (timedOut) {
          throw new EntraGraphError('timeout', 'Microsoft Graph request timed out.')
        }
        throw new EntraGraphError('network', 'Microsoft Graph request failed before a response.')
      } finally {
        clearTimeout(timer)
      }

      if (!response.ok) {
        const delay = retryAfterMilliseconds(response.headers.get('retry-after'), this.now())
        if (
          RETRYABLE_STATUSES.has(response.status) &&
          delay !== undefined &&
          delay <= this.config.limits.maxRetryAfterMs &&
          attempt < this.config.limits.maxRetries
        ) {
          await this.sleepWithSignal(delay, externalSignal)
          continue
        }
        throw statusError(response.status)
      }

      let bodyTimedOut = false
      const bodyTimer = setTimeout(() => {
        bodyTimedOut = true
        controller.abort()
      }, this.config.limits.requestTimeoutMs)
      try {
        return await readBoundedJson(response, this.config.limits.maxResponseBytes, signal)
      } catch (error) {
        if (error instanceof EntraGraphError) throw error
        if (signalAborted(externalSignal)) {
          throw new EntraGraphError('cancelled', 'Microsoft Graph request was cancelled.')
        }
        if (bodyTimedOut) {
          throw new EntraGraphError('timeout', 'Microsoft Graph response body timed out.')
        }
        throw new EntraGraphError(
          'malformed-response',
          'Microsoft Graph returned a non-JSON response.',
        )
      } finally {
        clearTimeout(bodyTimer)
      }
    }
  }

  private async sleepWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal === undefined) {
      await this.sleep(milliseconds)
      return
    }
    if (signal.aborted) {
      throw new EntraGraphError('cancelled', 'Microsoft Graph request was cancelled.')
    }
    let removeAbortListener = (): void => undefined
    try {
      await Promise.race([
        this.sleep(milliseconds),
        new Promise<never>((_, reject) => {
          const onAbort = (): void =>
            reject(new EntraGraphError('cancelled', 'Microsoft Graph request was cancelled.'))
          signal.addEventListener('abort', onAbort, { once: true })
          removeAbortListener = () => signal.removeEventListener('abort', onAbort)
        }),
      ])
    } finally {
      removeAbortListener()
    }
  }
}
