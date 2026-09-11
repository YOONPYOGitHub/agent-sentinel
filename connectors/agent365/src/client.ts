import type { TokenCredential } from '@azure/core-auth'

import {
  AGENT365_GRAPH_ORIGIN,
  AGENT365_PACKAGES_PATH,
  copilotPackageCollectionSchema,
  type Agent365Limits,
  type CopilotPackage,
} from './schemas.js'

export const AGENT365_TOKEN_SCOPE = 'https://graph.microsoft.com/.default'
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])
const LICENSE_ERROR_CODES = new Set(['licenserequired', 'microsoftagent365licenserequired'])

export type Agent365ErrorCode =
  | 'authentication'
  | 'authorization'
  | 'license-required'
  | 'not-available'
  | 'bounds'
  | 'cancelled'
  | 'timeout'
  | 'malformed-response'
  | 'network'
  | 'request-failed'

export class Agent365ConnectorError extends Error {
  override readonly name = 'Agent365ConnectorError'

  constructor(
    readonly code: Agent365ErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface Agent365ClientOptions {
  fetcher?: typeof fetch
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

export interface Agent365Collection {
  readonly packages: CopilotPackage[]
  readonly pages: number
  readonly records: number
  readonly responseBytes: number
  readonly truncated: boolean
}

export interface Agent365ResponseByteBudget {
  tryConsume(bytes: number): boolean
}

function cancelledError(): Agent365ConnectorError {
  return new Agent365ConnectorError('cancelled', 'Agent 365 collection was cancelled.')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw cancelledError()
}

function throwIfRequestAborted(
  externalSignal: AbortSignal | undefined,
  requestSignal: AbortSignal,
): void {
  if (externalSignal?.aborted === true) throw cancelledError()
  if (requestSignal.aborted) {
    throw new Agent365ConnectorError('timeout', 'Microsoft Graph package request timed out.')
  }
}

function retryAfterMilliseconds(value: string | null, now: number): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

function graphErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const error = (value as Record<string, unknown>)['error']
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return undefined
  const code = (error as Record<string, unknown>)['code']
  return typeof code === 'string' && code.length <= 128 ? code.toLowerCase() : undefined
}

function statusError(status: number, body?: unknown): Agent365ConnectorError {
  if (status === 401) {
    return new Agent365ConnectorError(
      'authentication',
      'Microsoft Graph rejected the Agent 365 connector credential.',
      status,
    )
  }
  if (status === 403) {
    if (LICENSE_ERROR_CODES.has(graphErrorCode(body) ?? '')) {
      return new Agent365ConnectorError(
        'license-required',
        'Microsoft Agent 365 licensing is required for the package catalog.',
        status,
      )
    }
    return new Agent365ConnectorError(
      'authorization',
      'Microsoft Graph CopilotPackages.Read.All authorization is required.',
      status,
    )
  }
  if (status === 404) {
    return new Agent365ConnectorError(
      'not-available',
      'The Microsoft Agent 365 package catalog is not available for this tenant.',
      status,
    )
  }
  return new Agent365ConnectorError(
    'request-failed',
    `Microsoft Graph package catalog request failed with status ${status}.`,
    status,
  )
}

function cancelWithoutWaiting(cancel: () => Promise<void>): void {
  try {
    void cancel().then(
      () => undefined,
      () => undefined,
    )
  } catch {
    // Response cleanup is best-effort and must never mask the request outcome.
  }
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal === undefined) return reader.read()
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      cancelWithoutWaiting(() => reader.cancel())
      reject(
        signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError'),
      )
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(
          error instanceof Error ? error : new Error('Microsoft Graph response body read failed.'),
        )
      },
    )
  })
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
  aggregateBudget?: Agent365ResponseByteBudget,
  signal?: AbortSignal,
): Promise<{ value: unknown; responseBytes: number }> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const parsed = Number(declaredLength)
    if (Number.isFinite(parsed) && parsed > maximumBytes) {
      const body = response.body
      if (body !== null) cancelWithoutWaiting(() => body.cancel())
      throw new Agent365ConnectorError('bounds', 'Microsoft Graph response exceeded byte limits.')
    }
  }
  if (response.body === null) {
    throw new Agent365ConnectorError('malformed-response', 'Microsoft Graph returned no body.')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const next = await readWithAbort(reader, signal)
    if (next.done) break
    length += next.value.byteLength
    const withinAggregateBudget =
      aggregateBudget === undefined || aggregateBudget.tryConsume(next.value.byteLength)
    if (length > maximumBytes || !withinAggregateBudget) {
      cancelWithoutWaiting(() => reader.cancel())
      throw new Agent365ConnectorError('bounds', 'Microsoft Graph response exceeded byte limits.')
    }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return {
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      responseBytes: length,
    }
  } catch {
    throw new Agent365ConnectorError(
      'malformed-response',
      'Microsoft Graph returned malformed JSON.',
    )
  }
}

function tokenTenantId(token: string): string | undefined {
  const parts = token.split('.')
  const payload = parts[1]
  if (parts.length !== 3 || payload === undefined || payload.length > 16_384) return undefined
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const tenantId = (value as Record<string, unknown>)['tid']
    return typeof tenantId === 'string' ? tenantId.toLowerCase() : undefined
  } catch {
    return undefined
  }
}
function continuationUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Agent365ConnectorError('malformed-response', 'Graph returned an invalid nextLink.')
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'graph.microsoft.com' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.pathname !== AGENT365_PACKAGES_PATH ||
    url.hash !== ''
  ) {
    throw new Agent365ConnectorError(
      'malformed-response',
      'Graph returned a nextLink outside the package catalog boundary.',
    )
  }
  return url
}

export class Agent365GraphClient {
  private readonly fetcher: typeof fetch
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  private readonly now: () => number
  private readonly listEndpoint = new URL(AGENT365_PACKAGES_PATH, AGENT365_GRAPH_ORIGIN)

  constructor(
    private readonly limits: Agent365Limits,
    private readonly credential: TokenCredential,
    private readonly expectedTenantId: string,
    options: Agent365ClientOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch
    this.sleep =
      options.sleep ??
      ((milliseconds, signal) =>
        new Promise((resolve, reject) => {
          throwIfAborted(signal)
          const onAbort = (): void => {
            clearTimeout(timer)
            reject(cancelledError())
          }
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
          }, milliseconds)
          signal?.addEventListener('abort', onAbort, { once: true })
        }))
    this.now = options.now ?? Date.now
  }

  async probe(signal?: AbortSignal, aggregateBudget?: Agent365ResponseByteBudget): Promise<void> {
    await this.collectMeasured(1, signal, 1, aggregateBudget)
  }

  async collect(maximum?: number, signal?: AbortSignal): Promise<CopilotPackage[]> {
    return (await this.collectMeasured(maximum, signal)).packages
  }

  collectMeasured(
    maximum?: number,
    signal?: AbortSignal,
    maximumPages?: number,
    aggregateBudget?: Agent365ResponseByteBudget,
  ): Promise<Agent365Collection> {
    throwIfAborted(signal)
    if (
      maximum !== undefined &&
      (!Number.isInteger(maximum) || maximum < 1 || maximum > this.limits.maxItems)
    ) {
      return Promise.reject(
        new Agent365ConnectorError('bounds', 'Collection maximum is outside configured limits.'),
      )
    }
    if (
      maximumPages !== undefined &&
      (!Number.isInteger(maximumPages) || maximumPages < 1 || maximumPages > this.limits.maxPages)
    ) {
      return Promise.reject(
        new Agent365ConnectorError('bounds', 'Page maximum is outside configured limits.'),
      )
    }
    return this.collectPages(maximum, signal, maximumPages, aggregateBudget)
  }

  private async collectPages(
    maximum?: number,
    signal?: AbortSignal,
    maximumPages?: number,
    aggregateBudget?: Agent365ResponseByteBudget,
  ): Promise<Agent365Collection> {
    const packages: CopilotPackage[] = []
    const seenLinks = new Set<string>()
    let nextUrl = this.listEndpoint
    let pages = 0
    let providerItems = 0
    let responseBytes = 0
    const pageLimit = maximumPages ?? this.limits.maxPages
    for (;;) {
      throwIfAborted(signal)
      const response = await this.requestJson(nextUrl, signal, aggregateBudget)
      responseBytes += response.responseBytes
      const parsed = copilotPackageCollectionSchema.safeParse(response.value)
      if (!parsed.success) {
        throw new Agent365ConnectorError(
          'malformed-response',
          'Microsoft Graph returned a response outside the package collection schema.',
        )
      }
      pages += 1
      providerItems += parsed.data.value.length
      if (providerItems > this.limits.maxItems) {
        throw new Agent365ConnectorError('bounds', 'Package catalog exceeded the item limit.')
      }
      packages.push(...parsed.data.value)
      const link = parsed.data['@odata.nextLink']
      const validated = link === undefined ? undefined : continuationUrl(link)
      const canonical = validated?.toString()
      if (canonical !== undefined && seenLinks.has(canonical)) {
        throw new Agent365ConnectorError('bounds', 'Microsoft Graph repeated a nextLink.')
      }
      if (maximum !== undefined && packages.length >= maximum) {
        return {
          packages: packages.slice(0, maximum),
          pages,
          records: Math.min(providerItems, maximum),
          responseBytes,
          truncated: providerItems > maximum || validated !== undefined,
        }
      }
      if (validated === undefined) {
        return { packages, pages, records: providerItems, responseBytes, truncated: false }
      }
      if (pages >= pageLimit) {
        return { packages, pages, records: providerItems, responseBytes, truncated: true }
      }
      seenLinks.add(validated.toString())
      nextUrl = validated
    }
  }

  private async accessToken(externalSignal?: AbortSignal): Promise<string> {
    throwIfAborted(externalSignal)
    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(
          new Agent365ConnectorError('timeout', 'Microsoft Graph token acquisition timed out.'),
        )
      }, this.limits.requestTimeoutMs)
    })
    let removeExternalAbort: (() => void) | undefined
    const cancelled =
      externalSignal === undefined
        ? undefined
        : new Promise<never>((_resolve, reject) => {
            const onAbort = (): void => reject(cancelledError())
            externalSignal.addEventListener('abort', onAbort, { once: true })
            removeExternalAbort = () => externalSignal.removeEventListener('abort', onAbort)
          })
    const signal =
      externalSignal === undefined
        ? controller.signal
        : AbortSignal.any([externalSignal, controller.signal])
    try {
      const result = await Promise.race([
        this.credential.getToken(AGENT365_TOKEN_SCOPE, { abortSignal: signal }),
        timeout,
        ...(cancelled === undefined ? [] : [cancelled]),
      ])
      if (result === null) {
        throw new Agent365ConnectorError(
          'authentication',
          'Azure credential did not return a Microsoft Graph access token.',
        )
      }
      if (tokenTenantId(result.token) !== this.expectedTenantId.toLowerCase()) {
        throw new Agent365ConnectorError(
          'authentication',
          'Microsoft Graph access token did not match the configured source tenant.',
        )
      }
      return result.token
    } catch (error) {
      if (externalSignal?.aborted === true) throw cancelledError()
      if (timedOut || controller.signal.aborted) {
        throw new Agent365ConnectorError('timeout', 'Microsoft Graph token acquisition timed out.')
      }
      if (error instanceof Agent365ConnectorError) throw error
      throw new Agent365ConnectorError(
        'authentication',
        'Microsoft Graph credential acquisition failed.',
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      removeExternalAbort?.()
      controller.abort()
    }
  }

  private async requestJson(
    url: URL,
    externalSignal?: AbortSignal,
    aggregateBudget?: Agent365ResponseByteBudget,
  ): Promise<{ value: unknown; responseBytes: number }> {
    throwIfAborted(externalSignal)
    const token = await this.accessToken(externalSignal)
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.limits.requestTimeoutMs)
      const signal =
        externalSignal === undefined
          ? controller.signal
          : AbortSignal.any([externalSignal, controller.signal])
      try {
        const response = await this.fetcher(url, {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
          signal,
        })
        throwIfRequestAborted(externalSignal, controller.signal)
        if (!response.ok) {
          const retryAfter = retryAfterMilliseconds(response.headers.get('retry-after'), this.now())
          if (
            RETRYABLE_STATUSES.has(response.status) &&
            retryAfter !== undefined &&
            retryAfter <= this.limits.maxRetryAfterMs &&
            attempt < this.limits.maxRetries
          ) {
            clearTimeout(timer)
            const body = response.body
            if (body !== null) cancelWithoutWaiting(() => body.cancel())
            if (externalSignal === undefined) await this.sleep(retryAfter)
            else await this.sleep(retryAfter, externalSignal)
            continue
          }
          let body: unknown
          try {
            body = (
              await readBoundedJson(response, this.limits.maxResponseBytes, aggregateBudget, signal)
            ).value
          } catch (error) {
            throwIfRequestAborted(externalSignal, controller.signal)
            if (error instanceof Agent365ConnectorError && error.code === 'bounds') throw error
          }
          throwIfRequestAborted(externalSignal, controller.signal)
          throw statusError(response.status, body)
        }
        return await readBoundedJson(
          response,
          this.limits.maxResponseBytes,
          aggregateBudget,
          signal,
        )
      } catch (error) {
        if (externalSignal?.aborted === true) throw cancelledError()
        if (controller.signal.aborted) {
          throw new Agent365ConnectorError('timeout', 'Microsoft Graph package request timed out.')
        }
        if (error instanceof Agent365ConnectorError) throw error
        throw new Agent365ConnectorError(
          'network',
          'Microsoft Graph package request failed before a response.',
        )
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
