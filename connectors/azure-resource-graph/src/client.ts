import type { TokenCredential } from '@azure/core-auth'

import {
  AZURE_RESOURCE_GRAPH_API_VERSION,
  AZURE_RESOURCE_GRAPH_ORIGIN,
  AZURE_RESOURCE_GRAPH_PATH,
  AZURE_RESOURCE_GRAPH_QUERY,
  azureResourceGraphResponseSchema,
  type AzureResourceGraphLimits,
  type AzureResourceGraphResource,
  type AzureResourceGraphSourceConfig,
} from './schemas.js'

export const AZURE_RESOURCE_GRAPH_TOKEN_SCOPE = 'https://management.azure.com/.default'
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

export type AzureResourceGraphErrorCode =
  | 'authentication'
  | 'authorization'
  | 'not-available'
  | 'bounds'
  | 'timeout'
  | 'malformed-response'
  | 'network'
  | 'request-failed'

export class AzureResourceGraphConnectorError extends Error {
  override readonly name = 'AzureResourceGraphConnectorError'

  constructor(
    readonly code: AzureResourceGraphErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface AzureResourceGraphClientOptions {
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

function statusError(status: number): AzureResourceGraphConnectorError {
  if (status === 401) {
    return new AzureResourceGraphConnectorError(
      'authentication',
      'Azure Resource Graph rejected the connector credential.',
      status,
    )
  }
  if (status === 403) {
    return new AzureResourceGraphConnectorError(
      'authorization',
      'Azure Reader authorization is required for the configured subscription scope.',
      status,
    )
  }
  if (status === 404) {
    return new AzureResourceGraphConnectorError(
      'not-available',
      'Azure Resource Graph is not available for the configured scope.',
      status,
    )
  }
  return new AzureResourceGraphConnectorError(
    'request-failed',
    `Azure Resource Graph request failed with status ${status}.`,
    status,
  )
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const parsed = Number(declaredLength)
    if (Number.isFinite(parsed) && parsed > maximumBytes) {
      await response.body?.cancel()
      throw new AzureResourceGraphConnectorError(
        'bounds',
        'Azure Resource Graph response exceeded byte limits.',
      )
    }
  }
  if (response.body === null) {
    throw new AzureResourceGraphConnectorError(
      'malformed-response',
      'Azure Resource Graph returned no body.',
    )
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
      throw new AzureResourceGraphConnectorError(
        'bounds',
        'Azure Resource Graph response exceeded byte limits.',
      )
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
    throw new AzureResourceGraphConnectorError(
      'malformed-response',
      'Azure Resource Graph returned malformed JSON.',
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

export class AzureResourceGraphClient {
  private readonly fetcher: typeof fetch
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly now: () => number
  private readonly endpoint = new URL(
    `${AZURE_RESOURCE_GRAPH_PATH}?api-version=${AZURE_RESOURCE_GRAPH_API_VERSION}`,
    AZURE_RESOURCE_GRAPH_ORIGIN,
  )

  constructor(
    private readonly source: AzureResourceGraphSourceConfig,
    private readonly limits: AzureResourceGraphLimits,
    private readonly credential: TokenCredential,
    options: AzureResourceGraphClientOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.now = options.now ?? Date.now
  }

  async probe(): Promise<void> {
    await this.requestPage(await this.accessToken(), undefined, 1)
  }

  async collect(maximum = this.limits.maxItems): Promise<AzureResourceGraphResource[]> {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > this.limits.maxItems) {
      throw new AzureResourceGraphConnectorError(
        'bounds',
        'Collection maximum is outside configured limits.',
      )
    }
    const token = await this.accessToken()
    const resources: AzureResourceGraphResource[] = []
    const seenIds = new Set<string>()
    const seenTokens = new Set<string>()
    let expectedTotal: number | undefined
    let skipToken: string | undefined
    let pages = 0
    for (;;) {
      if (pages >= this.limits.maxPages) {
        throw new AzureResourceGraphConnectorError(
          'bounds',
          'Azure Resource Graph exceeded the page limit.',
        )
      }
      const page = await this.requestPage(
        token,
        skipToken,
        Math.min(this.limits.pageSize, maximum - resources.length),
      )
      pages += 1
      if (expectedTotal === undefined) {
        expectedTotal = page.totalRecords
        if (expectedTotal > maximum) {
          throw new AzureResourceGraphConnectorError(
            'bounds',
            'Azure Resource Graph total exceeded the aggregate item limit.',
          )
        }
      } else if (page.totalRecords !== expectedTotal) {
        throw new AzureResourceGraphConnectorError(
          'malformed-response',
          'Azure Resource Graph total changed between pages.',
        )
      }
      if (resources.length + page.data.length > maximum) {
        throw new AzureResourceGraphConnectorError(
          'bounds',
          'Azure Resource Graph page exceeded the remaining aggregate item limit.',
        )
      }
      for (const resource of page.data) {
        const id = resource.id.toLowerCase()
        if (seenIds.has(id)) {
          throw new AzureResourceGraphConnectorError(
            'malformed-response',
            'Azure Resource Graph returned a duplicate resource identifier.',
          )
        }
        if (
          !this.source.subscriptions.some(
            (item) => item.toLowerCase() === resource.subscriptionId.toLowerCase(),
          )
        ) {
          throw new AzureResourceGraphConnectorError(
            'malformed-response',
            'Azure Resource Graph returned a resource outside the configured subscription boundary.',
          )
        }
        seenIds.add(id)
        resources.push(resource)
      }
      const next = page['$skipToken']
      if (next === undefined) {
        if (resources.length !== expectedTotal) {
          throw new AzureResourceGraphConnectorError(
            'malformed-response',
            'Azure Resource Graph final item count did not match totalRecords.',
          )
        }
        return resources
      }
      if (resources.length >= maximum) {
        throw new AzureResourceGraphConnectorError(
          'bounds',
          'Azure Resource Graph requires more items than the aggregate limit.',
        )
      }
      if (seenTokens.has(next)) {
        throw new AzureResourceGraphConnectorError(
          'bounds',
          'Azure Resource Graph repeated a skip token.',
        )
      }
      seenTokens.add(next)
      skipToken = next
    }
  }

  private async accessToken(): Promise<string> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(
          new AzureResourceGraphConnectorError(
            'timeout',
            'Azure Resource Graph token acquisition timed out.',
          ),
        )
      }, this.limits.requestTimeoutMs)
    })
    try {
      const result = await Promise.race([
        this.credential.getToken(AZURE_RESOURCE_GRAPH_TOKEN_SCOPE, {
          abortSignal: controller.signal,
        }),
        timeout,
      ])
      if (result === null) {
        throw new AzureResourceGraphConnectorError(
          'authentication',
          'Azure credential did not return a Resource Graph token.',
        )
      }
      if (tokenTenantId(result.token) !== this.source.tenantId.toLowerCase()) {
        throw new AzureResourceGraphConnectorError(
          'authentication',
          'Azure Resource Graph access token did not match the configured tenant.',
        )
      }
      return result.token
    } catch (error) {
      if (error instanceof AzureResourceGraphConnectorError) throw error
      if (timedOut || controller.signal.aborted) {
        throw new AzureResourceGraphConnectorError(
          'timeout',
          'Azure Resource Graph token acquisition timed out.',
        )
      }
      throw new AzureResourceGraphConnectorError(
        'authentication',
        'Azure Resource Graph credential acquisition failed.',
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      controller.abort()
    }
  }

  private async requestPage(token: string, skipToken: string | undefined, top: number) {
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.limits.requestTimeoutMs)
      try {
        const response = await this.fetcher(this.endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            subscriptions: this.source.subscriptions,
            query: AZURE_RESOURCE_GRAPH_QUERY,
            options: {
              resultFormat: 'objectArray',
              $top: top,
              ...(skipToken !== undefined ? { $skipToken: skipToken } : {}),
            },
          }),
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
        const parsed = azureResourceGraphResponseSchema.safeParse(
          await readBoundedJson(response, this.limits.maxResponseBytes),
        )
        if (!parsed.success) {
          throw new AzureResourceGraphConnectorError(
            'malformed-response',
            'Azure Resource Graph returned a response outside the query schema.',
          )
        }
        if (parsed.data.count !== parsed.data.data.length) {
          throw new AzureResourceGraphConnectorError(
            'malformed-response',
            'Azure Resource Graph count did not match the returned data.',
          )
        }
        if (parsed.data.data.length > top) {
          throw new AzureResourceGraphConnectorError(
            'bounds',
            'Azure Resource Graph returned more rows than the requested page size.',
          )
        }
        if (parsed.data.resultTruncated === true || parsed.data.resultTruncated === 'true') {
          throw new AzureResourceGraphConnectorError(
            'bounds',
            'Azure Resource Graph reported provider-truncated results.',
          )
        }
        return parsed.data
      } catch (error) {
        if (error instanceof AzureResourceGraphConnectorError) throw error
        if (controller.signal.aborted) {
          throw new AzureResourceGraphConnectorError(
            'timeout',
            'Azure Resource Graph request timed out.',
          )
        }
        throw new AzureResourceGraphConnectorError(
          'network',
          'Azure Resource Graph request failed before a response.',
        )
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
