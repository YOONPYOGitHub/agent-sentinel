import type { TokenCredential } from '@azure/core-auth'

import {
  POWER_PLATFORM_API_ORIGIN,
  POWER_PLATFORM_API_VERSION,
  POWER_PLATFORM_RESOURCE_TYPE,
  powerPlatformResourceQueryResponseSchema,
  type PowerPlatformLimits,
  type PowerPlatformResourceItem,
  type PowerPlatformResourceQueryResponse,
  type PowerPlatformSourceConfig,
} from './schemas.js'

export const POWER_PLATFORM_TOKEN_SCOPE = 'https://api.powerplatform.com/.default'
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

export type PowerPlatformErrorCode =
  | 'authentication'
  | 'authorization'
  | 'bounds'
  | 'malformed-response'
  | 'network'
  | 'request-failed'
  | 'timeout'

export class PowerPlatformConnectorError extends Error {
  override readonly name = 'PowerPlatformConnectorError'

  constructor(
    readonly code: PowerPlatformErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface PowerPlatformClientOptions {
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

function statusError(status: number): PowerPlatformConnectorError {
  if (status === 401) {
    return new PowerPlatformConnectorError(
      'authentication',
      'Power Platform rejected the connector credential.',
      status,
    )
  }
  if (status === 403) {
    return new PowerPlatformConnectorError(
      'authorization',
      'Power Platform ResourceQuery read authorization is required.',
      status,
    )
  }
  return new PowerPlatformConnectorError(
    'request-failed',
    `Power Platform ResourceQuery request failed with status ${status}.`,
    status,
  )
}

function kqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function queryBody(
  pageSize: number,
  environmentId: string,
  skipToken?: string,
): Record<string, unknown> {
  return {
    TableName: 'PowerPlatformResources',
    Clauses: [
      {
        $type: 'where',
        FieldName: 'type',
        Operator: '==',
        Values: [`'${POWER_PLATFORM_RESOURCE_TYPE}'`],
      },
      {
        $type: 'where',
        FieldName: 'properties.environmentId',
        Operator: '==',
        Values: [kqlString(environmentId)],
      },
    ],
    Options:
      skipToken === undefined
        ? { Top: pageSize, Skip: 0 }
        : { Top: pageSize, SkipToken: skipToken },
  }
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const parsed = Number(declaredLength)
    if (Number.isFinite(parsed) && parsed > maximumBytes) {
      throw new PowerPlatformConnectorError(
        'bounds',
        'Power Platform response exceeded the byte limit.',
      )
    }
  }
  if (response.body === null) {
    throw new PowerPlatformConnectorError(
      'malformed-response',
      'Power Platform returned an empty response.',
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
      throw new PowerPlatformConnectorError(
        'bounds',
        'Power Platform response exceeded the byte limit.',
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
    throw new PowerPlatformConnectorError(
      'malformed-response',
      'Power Platform returned malformed JSON.',
    )
  }
}

export class PowerPlatformResourceQueryClient {
  private readonly fetcher: typeof fetch
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly now: () => number
  private readonly endpoint: URL

  constructor(
    private readonly source: PowerPlatformSourceConfig,
    private readonly limits: PowerPlatformLimits,
    private readonly credential: TokenCredential,
    options: PowerPlatformClientOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.now = options.now ?? Date.now
    this.endpoint = new URL('/resourcequery/resources/query', POWER_PLATFORM_API_ORIGIN)
    this.endpoint.searchParams.set('api-version', POWER_PLATFORM_API_VERSION)
  }

  async probe(): Promise<void> {
    const response = this.parsePage(
      await this.requestJson(queryBody(1, this.source.environment)),
      1,
    )
    if (
      response.data.some(
        (resource) => resource.tenantId.toLowerCase() !== this.source.tenantId.toLowerCase(),
      )
    ) {
      throw new PowerPlatformConnectorError(
        'malformed-response',
        'Power Platform returned a resource outside the source tenant boundary.',
      )
    }
  }

  collect(maximum?: number): Promise<PowerPlatformResourceItem[]> {
    if (
      maximum !== undefined &&
      (!Number.isInteger(maximum) || maximum < 1 || maximum > this.limits.maxItems)
    ) {
      return Promise.reject(
        new PowerPlatformConnectorError(
          'bounds',
          'Power Platform collection maximum is outside configured limits.',
        ),
      )
    }
    return this.collectPages(maximum)
  }

  private async collectPages(maximum?: number): Promise<PowerPlatformResourceItem[]> {
    const resources: PowerPlatformResourceItem[] = []
    const seenTokens = new Set<string>()
    let skipToken: string | undefined
    let pages = 0
    let providerItems = 0
    const requestPageSize =
      maximum === undefined ? this.limits.pageSize : Math.min(maximum, this.limits.pageSize)
    for (;;) {
      if (pages >= this.limits.maxPages) {
        throw new PowerPlatformConnectorError(
          'bounds',
          'Power Platform ResourceQuery exceeded the page limit.',
        )
      }
      const response = this.parsePage(
        await this.requestJson(queryBody(requestPageSize, this.source.environment, skipToken)),
        requestPageSize,
      )
      pages += 1
      providerItems += response.data.length
      if (providerItems > this.limits.maxItems) {
        throw new PowerPlatformConnectorError(
          'bounds',
          'Power Platform ResourceQuery exceeded the item limit.',
        )
      }
      for (const resource of response.data) {
        if (resource.tenantId.toLowerCase() !== this.source.tenantId.toLowerCase()) {
          throw new PowerPlatformConnectorError(
            'malformed-response',
            'Power Platform returned a resource outside the source tenant boundary.',
          )
        }
        const environmentId = resource.environmentId ?? resource.properties.environmentId
        if (environmentId !== this.source.environment) {
          throw new PowerPlatformConnectorError(
            'malformed-response',
            'Power Platform returned a resource outside the source environment boundary.',
          )
        }
        resources.push(resource)
        if (maximum !== undefined && resources.length >= maximum) {
          return resources.slice(0, maximum)
        }
      }
      if (response.resultTruncated === 1) return resources
      if (response.skipToken === undefined) {
        throw new PowerPlatformConnectorError(
          'malformed-response',
          'Power Platform truncated a response without a continuation token.',
        )
      }
      if (seenTokens.has(response.skipToken)) {
        throw new PowerPlatformConnectorError(
          'bounds',
          'Power Platform repeated a continuation token.',
        )
      }
      seenTokens.add(response.skipToken)
      skipToken = response.skipToken
    }
  }

  private parsePage(value: unknown, requestPageSize: number): PowerPlatformResourceQueryResponse {
    const parsed = powerPlatformResourceQueryResponseSchema.safeParse(value)
    if (!parsed.success) {
      throw new PowerPlatformConnectorError(
        'malformed-response',
        'Power Platform returned a response outside the ResourceQuery schema.',
      )
    }
    const page = parsed.data
    if (
      page.count !== page.data.length ||
      page.count > requestPageSize ||
      page.totalRecords < page.count
    ) {
      throw new PowerPlatformConnectorError(
        'malformed-response',
        'Power Platform returned inconsistent ResourceQuery counts.',
      )
    }
    return page
  }

  private async accessToken(): Promise<string> {
    try {
      const result = await this.credential.getToken(POWER_PLATFORM_TOKEN_SCOPE)
      if (result === null) {
        throw new PowerPlatformConnectorError(
          'authentication',
          'Azure credential did not return a Power Platform access token.',
        )
      }
      return result.token
    } catch (error) {
      if (error instanceof PowerPlatformConnectorError) throw error
      throw new PowerPlatformConnectorError(
        'authentication',
        'Power Platform credential acquisition failed.',
      )
    }
  }

  private async requestJson(body: Record<string, unknown>): Promise<unknown> {
    const token = await this.accessToken()
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.limits.requestTimeoutMs)
      let response: Response
      try {
        response = await this.fetcher(this.endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: ['Bearer', token].join(' '),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (!response.ok) {
          const delay = retryAfterMilliseconds(response.headers.get('retry-after'), this.now())
          if (
            RETRYABLE_STATUSES.has(response.status) &&
            delay !== undefined &&
            delay <= this.limits.maxRetryAfterMs &&
            attempt < this.limits.maxRetries
          ) {
            clearTimeout(timer)
            await this.sleep(delay)
            continue
          }
          throw statusError(response.status)
        }
        return await readBoundedJson(response, this.limits.maxResponseBytes)
      } catch (error) {
        if (error instanceof PowerPlatformConnectorError) throw error
        if (controller.signal.aborted) {
          throw new PowerPlatformConnectorError(
            'timeout',
            'Power Platform ResourceQuery request timed out.',
          )
        }
        throw new PowerPlatformConnectorError(
          'network',
          'Power Platform ResourceQuery failed before a response.',
        )
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
