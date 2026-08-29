import type { TokenCredential } from '@azure/core-auth'

import {
  TEAMS_DISTRIBUTION_APPS_PATH,
  TEAMS_DISTRIBUTION_GRAPH_ORIGIN,
  TEAMS_DISTRIBUTION_ORGANIZATION_FILTER,
  TEAMS_DISTRIBUTION_SELECT,
  teamsAppCollectionSchema,
  type TeamsApp,
  type TeamsDistributionLimits,
} from './schemas.js'

export const TEAMS_DISTRIBUTION_TOKEN_SCOPE = 'https://graph.microsoft.com/.default'
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

export type TeamsDistributionErrorCode =
  | 'authentication'
  | 'authorization'
  | 'not-available'
  | 'bounds'
  | 'timeout'
  | 'malformed-response'
  | 'network'
  | 'request-failed'

export class TeamsDistributionConnectorError extends Error {
  override readonly name = 'TeamsDistributionConnectorError'

  constructor(
    readonly code: TeamsDistributionErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface TeamsDistributionClientOptions {
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

function statusError(status: number): TeamsDistributionConnectorError {
  if (status === 401) {
    return new TeamsDistributionConnectorError(
      'authentication',
      'Microsoft Graph rejected the Teams distribution connector credential.',
      status,
    )
  }
  if (status === 403) {
    return new TeamsDistributionConnectorError(
      'authorization',
      'Microsoft Graph AppCatalog.Read.All application authorization is required.',
      status,
    )
  }
  if (status === 404) {
    return new TeamsDistributionConnectorError(
      'not-available',
      'The Microsoft Teams tenant app catalog is unavailable for this tenant.',
      status,
    )
  }
  return new TeamsDistributionConnectorError(
    'request-failed',
    `Microsoft Graph Teams app catalog request failed with status ${status}.`,
    status,
  )
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const parsed = Number(declaredLength)
    if (Number.isFinite(parsed) && parsed > maximumBytes) {
      await response.body?.cancel()
      throw new TeamsDistributionConnectorError(
        'bounds',
        'Microsoft Graph response exceeded byte limits.',
      )
    }
  }
  if (response.body === null) {
    throw new TeamsDistributionConnectorError(
      'malformed-response',
      'Microsoft Graph returned no body.',
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
      throw new TeamsDistributionConnectorError(
        'bounds',
        'Microsoft Graph response exceeded byte limits.',
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
    throw new TeamsDistributionConnectorError(
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
    throw new TeamsDistributionConnectorError(
      'malformed-response',
      'Graph returned an invalid nextLink.',
    )
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== TEAMS_DISTRIBUTION_GRAPH_ORIGIN ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.pathname !== TEAMS_DISTRIBUTION_APPS_PATH ||
    url.hash !== ''
  ) {
    throw new TeamsDistributionConnectorError(
      'malformed-response',
      'Graph returned a nextLink outside the Teams tenant app catalog boundary.',
    )
  }
  return url
}

function listEndpoint(): URL {
  return new URL(
    `${TEAMS_DISTRIBUTION_APPS_PATH}?$filter=${encodeURIComponent(
      TEAMS_DISTRIBUTION_ORGANIZATION_FILTER,
    )}&$select=${TEAMS_DISTRIBUTION_SELECT}`,
    TEAMS_DISTRIBUTION_GRAPH_ORIGIN,
  )
}

export class TeamsDistributionGraphClient {
  private readonly fetcher: typeof fetch
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly now: () => number
  private readonly endpoint = listEndpoint()

  constructor(
    private readonly limits: TeamsDistributionLimits,
    private readonly credential: TokenCredential,
    private readonly expectedTenantId: string,
    options: TeamsDistributionClientOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.now = options.now ?? Date.now
  }

  async probe(): Promise<void> {
    const parsed = teamsAppCollectionSchema.safeParse(await this.requestJson(this.endpoint))
    if (!parsed.success) {
      throw new TeamsDistributionConnectorError(
        'malformed-response',
        'Microsoft Graph returned a response outside the Teams app collection schema.',
      )
    }
  }

  collect(maximum = this.limits.maxItems): Promise<TeamsApp[]> {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > this.limits.maxItems) {
      return Promise.reject(
        new TeamsDistributionConnectorError(
          'bounds',
          'Collection maximum is outside configured limits.',
        ),
      )
    }
    return this.collectPages(maximum)
  }

  private async collectPages(maximum: number): Promise<TeamsApp[]> {
    const apps: TeamsApp[] = []
    const seenLinks = new Set<string>()
    const seenIds = new Set<string>()
    let nextUrl = this.endpoint
    let pages = 0
    for (;;) {
      if (pages >= this.limits.maxPages) {
        throw new TeamsDistributionConnectorError(
          'bounds',
          'Teams tenant app catalog exceeded the page limit.',
        )
      }
      const parsed = teamsAppCollectionSchema.safeParse(await this.requestJson(nextUrl))
      if (!parsed.success) {
        throw new TeamsDistributionConnectorError(
          'malformed-response',
          'Microsoft Graph returned a response outside the Teams app collection schema.',
        )
      }
      pages += 1
      if (apps.length + parsed.data.value.length > maximum) {
        throw new TeamsDistributionConnectorError(
          'bounds',
          'Teams tenant app catalog exceeded the aggregate item limit.',
        )
      }
      for (const app of parsed.data.value) {
        const id = app.id.toLowerCase()
        if (seenIds.has(id)) {
          throw new TeamsDistributionConnectorError(
            'malformed-response',
            'Microsoft Graph returned a duplicate Teams app identifier.',
          )
        }
        seenIds.add(id)
        apps.push(app)
      }
      const link = parsed.data['@odata.nextLink']
      if (link === undefined) return apps
      if (apps.length >= maximum) {
        throw new TeamsDistributionConnectorError(
          'bounds',
          'Teams tenant app catalog requires more items than the aggregate limit.',
        )
      }
      const validated = continuationUrl(link)
      const canonical = validated.toString()
      if (seenLinks.has(canonical)) {
        throw new TeamsDistributionConnectorError('bounds', 'Microsoft Graph repeated a nextLink.')
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
        reject(
          new TeamsDistributionConnectorError(
            'timeout',
            'Microsoft Graph token acquisition timed out.',
          ),
        )
      }, this.limits.requestTimeoutMs)
    })
    try {
      const result = await Promise.race([
        this.credential.getToken(TEAMS_DISTRIBUTION_TOKEN_SCOPE, {
          abortSignal: controller.signal,
        }),
        timeout,
      ])
      if (result === null) {
        throw new TeamsDistributionConnectorError(
          'authentication',
          'Azure credential did not return a Microsoft Graph access token.',
        )
      }
      if (tokenTenantId(result.token) !== this.expectedTenantId.toLowerCase()) {
        throw new TeamsDistributionConnectorError(
          'authentication',
          'Microsoft Graph access token did not match the configured source tenant.',
        )
      }
      return result.token
    } catch (error) {
      if (error instanceof TeamsDistributionConnectorError) throw error
      if (timedOut || controller.signal.aborted) {
        throw new TeamsDistributionConnectorError(
          'timeout',
          'Microsoft Graph token acquisition timed out.',
        )
      }
      throw new TeamsDistributionConnectorError(
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
          headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
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
        if (error instanceof TeamsDistributionConnectorError) throw error
        if (controller.signal.aborted) {
          throw new TeamsDistributionConnectorError(
            'timeout',
            'Microsoft Graph Teams app catalog request timed out.',
          )
        }
        throw new TeamsDistributionConnectorError(
          'network',
          'Microsoft Graph Teams app catalog request failed before a response.',
        )
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
