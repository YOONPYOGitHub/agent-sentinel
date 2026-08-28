import type { TokenCredential } from '@azure/core-auth'

import {
  PURVIEW_GRAPH_ORIGIN,
  PURVIEW_SENSITIVITY_LABELS_PATH,
  purviewSensitivityLabelCollectionSchema,
  type PurviewLimits,
  type PurviewSensitivityLabel,
} from './schemas.js'

export const PURVIEW_TOKEN_SCOPE = 'https://graph.microsoft.com/.default'
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

export type PurviewErrorCode =
  | 'authentication'
  | 'authorization'
  | 'not-available'
  | 'bounds'
  | 'timeout'
  | 'malformed-response'
  | 'network'
  | 'request-failed'

export class PurviewConnectorError extends Error {
  override readonly name = 'PurviewConnectorError'

  constructor(
    readonly code: PurviewErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface PurviewClientOptions {
  fetcher?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
}

function retryAfterMilliseconds(value: string | null, now: number): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

function statusError(status: number): PurviewConnectorError {
  if (status === 401) {
    return new PurviewConnectorError(
      'authentication',
      'Microsoft Graph rejected the Purview connector credential.',
      status,
    )
  }
  if (status === 403) {
    return new PurviewConnectorError(
      'authorization',
      'Microsoft Graph SensitivityLabel.Read application authorization is required.',
      status,
    )
  }
  if (status === 404) {
    return new PurviewConnectorError(
      'not-available',
      'The Purview sensitivity-label catalog is not available for this tenant.',
      status,
    )
  }
  return new PurviewConnectorError(
    'request-failed',
    `Microsoft Graph sensitivity-label request failed with status ${status}.`,
    status,
  )
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const parsed = Number(declaredLength)
    if (Number.isFinite(parsed) && parsed > maximumBytes) {
      await response.body?.cancel()
      throw new PurviewConnectorError('bounds', 'Microsoft Graph response exceeded byte limits.')
    }
  }
  if (response.body === null) {
    throw new PurviewConnectorError('malformed-response', 'Microsoft Graph returned no body.')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    length += next.value.byteLength
    if (length > maximumBytes) {
      await reader.cancel()
      throw new PurviewConnectorError('bounds', 'Microsoft Graph response exceeded byte limits.')
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new PurviewConnectorError(
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
    throw new PurviewConnectorError('malformed-response', 'Graph returned an invalid nextLink.')
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== PURVIEW_GRAPH_ORIGIN ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.pathname !== PURVIEW_SENSITIVITY_LABELS_PATH ||
    url.hash !== ''
  ) {
    throw new PurviewConnectorError(
      'malformed-response',
      'Graph returned a nextLink outside the sensitivity-label catalog boundary.',
    )
  }
  return url
}

function flattenLabels(
  roots: readonly PurviewSensitivityLabel[],
  seenIds: Set<string>,
  maximum: number,
): PurviewSensitivityLabel[] {
  const flattened: PurviewSensitivityLabel[] = []
  const stack = [...roots].reverse().map((label) => ({ label, depth: 0 }))
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.depth > 8) {
      throw new PurviewConnectorError(
        'bounds',
        'Sensitivity-label hierarchy exceeded the depth limit.',
      )
    }
    const id = current.label.id.toLowerCase()
    if (seenIds.has(id)) {
      throw new PurviewConnectorError(
        'malformed-response',
        'Microsoft Graph returned a duplicate sensitivity-label identifier.',
      )
    }
    seenIds.add(id)
    if (flattened.length >= maximum) {
      throw new PurviewConnectorError(
        'bounds',
        'Sensitivity-label catalog exceeded the aggregate item limit.',
      )
    }
    const { sublabels, ...label } = current.label
    flattened.push(label)
    for (const child of [...(sublabels ?? [])].reverse()) {
      stack.push({ label: child, depth: current.depth + 1 })
    }
  }
  return flattened
}

export class PurviewGraphClient {
  private readonly fetcher: typeof fetch
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly now: () => number
  private readonly listEndpoint = new URL(PURVIEW_SENSITIVITY_LABELS_PATH, PURVIEW_GRAPH_ORIGIN)

  constructor(
    private readonly limits: PurviewLimits,
    private readonly credential: TokenCredential,
    private readonly expectedTenantId: string,
    options: PurviewClientOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.now = options.now ?? Date.now
  }

  async probe(): Promise<void> {
    const raw = await this.requestJson(this.listEndpoint)
    if (!purviewSensitivityLabelCollectionSchema.safeParse(raw).success) {
      throw new PurviewConnectorError(
        'malformed-response',
        'Microsoft Graph returned a response outside the sensitivity-label collection schema.',
      )
    }
  }

  collect(maximum = this.limits.maxItems): Promise<PurviewSensitivityLabel[]> {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > this.limits.maxItems) {
      return Promise.reject(
        new PurviewConnectorError('bounds', 'Collection maximum is outside configured limits.'),
      )
    }
    return this.collectPages(maximum)
  }

  private async collectPages(maximum: number): Promise<PurviewSensitivityLabel[]> {
    const labels: PurviewSensitivityLabel[] = []
    const seenLinks = new Set<string>()
    const seenIds = new Set<string>()
    let nextUrl = this.listEndpoint
    let pages = 0
    for (;;) {
      if (pages >= this.limits.maxPages) {
        throw new PurviewConnectorError(
          'bounds',
          'Sensitivity-label catalog exceeded the page limit.',
        )
      }
      const raw = await this.requestJson(nextUrl)
      const parsed = purviewSensitivityLabelCollectionSchema.safeParse(raw)
      if (!parsed.success) {
        throw new PurviewConnectorError(
          'malformed-response',
          'Microsoft Graph returned a response outside the sensitivity-label collection schema.',
        )
      }
      pages += 1
      labels.push(...flattenLabels(parsed.data.value, seenIds, maximum - labels.length))
      const link = parsed.data['@odata.nextLink']
      if (link === undefined) return labels
      if (labels.length >= maximum) {
        throw new PurviewConnectorError(
          'bounds',
          'Sensitivity-label catalog requires more items than the aggregate limit.',
        )
      }

      const validated = continuationUrl(link)
      const canonical = validated.toString()
      if (seenLinks.has(canonical)) {
        throw new PurviewConnectorError('bounds', 'Microsoft Graph repeated a nextLink.')
      }
      seenLinks.add(canonical)
      nextUrl = validated
    }
  }

  private async accessToken(): Promise<string> {
    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(new PurviewConnectorError('timeout', 'Microsoft Graph token acquisition timed out.'))
      }, this.limits.requestTimeoutMs)
    })
    try {
      const result = await Promise.race([
        this.credential.getToken(PURVIEW_TOKEN_SCOPE, { abortSignal: controller.signal }),
        timeout,
      ])
      if (result === null) {
        throw new PurviewConnectorError(
          'authentication',
          'Azure credential did not return a Microsoft Graph access token.',
        )
      }
      if (tokenTenantId(result.token) !== this.expectedTenantId.toLowerCase()) {
        throw new PurviewConnectorError(
          'authentication',
          'Microsoft Graph access token did not match the configured source tenant.',
        )
      }
      return result.token
    } catch (error) {
      if (error instanceof PurviewConnectorError) throw error
      if (timedOut || controller.signal.aborted) {
        throw new PurviewConnectorError('timeout', 'Microsoft Graph token acquisition timed out.')
      }
      throw new PurviewConnectorError(
        'authentication',
        'Microsoft Graph credential acquisition failed.',
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      controller.abort()
    }
  }

  private async requestJson(url: URL): Promise<unknown> {
    const token = await this.accessToken()
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.limits.requestTimeoutMs)
      try {
        const response = await this.fetcher(url, {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
          signal: controller.signal,
        })
        if (!response.ok) {
          const retryAfter = retryAfterMilliseconds(response.headers.get('retry-after'), this.now())
          if (
            RETRYABLE_STATUSES.has(response.status) &&
            retryAfter !== undefined &&
            retryAfter <= this.limits.maxRetryAfterMs &&
            attempt < this.limits.maxRetries
          ) {
            clearTimeout(timer)
            await response.body?.cancel()
            await this.sleep(retryAfter)
            continue
          }
          await response.body?.cancel()
          throw statusError(response.status)
        }
        return await readBoundedJson(response, this.limits.maxResponseBytes)
      } catch (error) {
        if (error instanceof PurviewConnectorError) throw error
        if (controller.signal.aborted) {
          throw new PurviewConnectorError(
            'timeout',
            'Microsoft Graph sensitivity-label request timed out.',
          )
        }
        throw new PurviewConnectorError(
          'network',
          'Microsoft Graph sensitivity-label request failed before a response.',
        )
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
