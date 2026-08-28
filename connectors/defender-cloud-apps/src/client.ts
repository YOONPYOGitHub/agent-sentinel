import type { TokenCredential } from '@azure/core-auth'
import type { ZodType } from 'zod'

import {
  DEFENDER_CLOUD_APPS_ACTIVITIES_PATH,
  DEFENDER_CLOUD_APPS_ALERTS_PATH,
  DEFENDER_CLOUD_APPS_RESOURCE_APP_ID,
  defenderCloudAppsActivityCollectionSchema,
  defenderCloudAppsAlertCollectionSchema,
  type DefenderCloudAppsActivity,
  type DefenderCloudAppsAlert,
  type DefenderCloudAppsLimits,
  type DefenderCloudAppsSourceConfig,
} from './schemas.js'

export const DEFENDER_CLOUD_APPS_TOKEN_SCOPE = `${DEFENDER_CLOUD_APPS_RESOURCE_APP_ID}/.default`

export type DefenderCloudAppsErrorCode =
  | 'authentication'
  | 'authorization'
  | 'license-required'
  | 'not-available'
  | 'bounds'
  | 'timeout'
  | 'malformed-response'
  | 'network'
  | 'request-failed'

export class DefenderCloudAppsConnectorError extends Error {
  override readonly name = 'DefenderCloudAppsConnectorError'

  constructor(
    readonly code: DefenderCloudAppsErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export interface DefenderCloudAppsClientOptions {
  fetcher?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
}

export interface DefenderCloudAppsCollection {
  alerts: DefenderCloudAppsAlert[]
  activities: DefenderCloudAppsActivity[]
  observedAt: string
}

function retryAfterMilliseconds(value: string | null, now: number): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

function statusError(status: number): DefenderCloudAppsConnectorError {
  if (status === 401) {
    return new DefenderCloudAppsConnectorError(
      'authentication',
      'Defender for Cloud Apps rejected the connector credential.',
      status,
    )
  }
  if (status === 403) {
    return new DefenderCloudAppsConnectorError(
      'authorization',
      'Defender for Cloud Apps Investigation.Read application authorization is required.',
      status,
    )
  }
  if (status === 404) {
    return new DefenderCloudAppsConnectorError(
      'not-available',
      'Defender for Cloud Apps API is not available at the configured tenant portal.',
      status,
    )
  }
  return new DefenderCloudAppsConnectorError(
    'request-failed',
    `Defender for Cloud Apps request failed with status ${status}.`,
    status,
  )
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const parsed = Number(declaredLength)
    if (Number.isFinite(parsed) && parsed > maximumBytes) {
      await response.body?.cancel()
      throw new DefenderCloudAppsConnectorError(
        'bounds',
        'Defender for Cloud Apps response exceeded byte limits.',
      )
    }
  }
  if (response.body === null) {
    throw new DefenderCloudAppsConnectorError(
      'malformed-response',
      'Defender for Cloud Apps returned no body.',
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
      throw new DefenderCloudAppsConnectorError(
        'bounds',
        'Defender for Cloud Apps response exceeded byte limits.',
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
    throw new DefenderCloudAppsConnectorError(
      'malformed-response',
      'Defender for Cloud Apps returned malformed JSON.',
    )
  }
}

function assertJwtTenant(token: string, expectedTenantId: string): void {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new DefenderCloudAppsConnectorError(
      'authentication',
      'Defender for Cloud Apps access token could not be tenant-bound.',
    )
  }
  const payload = parts[1]
  if (payload === undefined || payload.length > 16_384) {
    throw new DefenderCloudAppsConnectorError(
      'authentication',
      'Defender for Cloud Apps access token could not be tenant-bound.',
    )
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
    const tenantId = (value as Record<string, unknown>)['tid']
    if (typeof tenantId !== 'string' || tenantId.toLowerCase() !== expectedTenantId.toLowerCase()) {
      throw new Error()
    }
  } catch {
    throw new DefenderCloudAppsConnectorError(
      'authentication',
      'Defender for Cloud Apps access token did not match the configured source tenant.',
    )
  }
}

interface CollectionState {
  items: number
  maximum: number
}

export class DefenderCloudAppsClient {
  private readonly fetcher: typeof fetch
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly now: () => number

  constructor(
    private readonly source: DefenderCloudAppsSourceConfig,
    private readonly limits: DefenderCloudAppsLimits,
    private readonly credential: TokenCredential,
    options: DefenderCloudAppsClientOptions = {},
  ) {
    this.fetcher = options.fetcher ?? fetch
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.now = options.now ?? Date.now
  }

  async probe(): Promise<void> {
    const end = this.now()
    for (const [path, schema, resource] of [
      [DEFENDER_CLOUD_APPS_ALERTS_PATH, defenderCloudAppsAlertCollectionSchema, 'alert'],
      [DEFENDER_CLOUD_APPS_ACTIVITIES_PATH, defenderCloudAppsActivityCollectionSchema, 'activity'],
    ] as const) {
      const raw = await this.requestJson(this.listUrl(path, 0, 1, end))
      if (!schema.safeParse(raw).success) {
        throw new DefenderCloudAppsConnectorError(
          'malformed-response',
          `Defender for Cloud Apps returned a response outside the ${resource} collection schema.`,
        )
      }
    }
  }

  collect(maximum = this.limits.maxItems): Promise<DefenderCloudAppsCollection> {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > this.limits.maxItems) {
      return Promise.reject(
        new DefenderCloudAppsConnectorError(
          'bounds',
          'Collection maximum is outside configured limits.',
        ),
      )
    }
    return this.collectPages(maximum)
  }

  private async collectPages(maximum: number): Promise<DefenderCloudAppsCollection> {
    const end = this.now()
    const state: CollectionState = { items: 0, maximum }
    const alerts = await this.collectResource<DefenderCloudAppsAlert>(
      DEFENDER_CLOUD_APPS_ALERTS_PATH,
      defenderCloudAppsAlertCollectionSchema,
      end,
      state,
    )
    const activities = await this.collectResource<DefenderCloudAppsActivity>(
      DEFENDER_CLOUD_APPS_ACTIVITIES_PATH,
      defenderCloudAppsActivityCollectionSchema,
      end,
      state,
    )
    return { alerts, activities, observedAt: new Date(end).toISOString() }
  }

  private async collectResource<T extends { id: string }>(
    path: string,
    schema: ZodType<{ data: T[]; hasNext: boolean }>,
    end: number,
    state: CollectionState,
  ): Promise<T[]> {
    const records: T[] = []
    const seenOffsets = new Set<number>()
    const seenPages = new Set<string>()
    const seenIds = new Set<string>()
    let skip = 0
    let pages = 0
    for (;;) {
      if (pages >= this.limits.maxPages) {
        throw new DefenderCloudAppsConnectorError(
          'bounds',
          'Defender for Cloud Apps resource collection exceeded the page limit.',
        )
      }
      if (seenOffsets.has(skip)) {
        throw new DefenderCloudAppsConnectorError(
          'bounds',
          'Defender for Cloud Apps repeated a collection offset.',
        )
      }
      seenOffsets.add(skip)
      const raw = await this.requestJson(this.listUrl(path, skip, this.limits.pageSize, end))
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        throw new DefenderCloudAppsConnectorError(
          'malformed-response',
          'Defender for Cloud Apps returned a response outside the collection schema.',
        )
      }
      pages += 1
      if (parsed.data.data.length > this.limits.pageSize) {
        throw new DefenderCloudAppsConnectorError(
          'malformed-response',
          'Defender for Cloud Apps exceeded the requested page size.',
        )
      }
      const page = parsed.data.data
      const fingerprint = JSON.stringify(page.map((record) => record.id))
      if (page.length > 0 && seenPages.has(fingerprint)) {
        throw new DefenderCloudAppsConnectorError(
          'bounds',
          'Defender for Cloud Apps repeated a result page.',
        )
      }
      if (page.length > 0) seenPages.add(fingerprint)
      for (const record of page) {
        if (seenIds.has(record.id)) {
          throw new DefenderCloudAppsConnectorError(
            'malformed-response',
            'Defender for Cloud Apps returned a duplicate provider identifier.',
          )
        }
        seenIds.add(record.id)
      }
      state.items += page.length
      if (state.items > state.maximum) {
        throw new DefenderCloudAppsConnectorError(
          'bounds',
          'Defender for Cloud Apps collection exceeded the aggregate item limit.',
        )
      }
      records.push(...page)
      if (!parsed.data.hasNext) return records
      if (page.length === 0) {
        throw new DefenderCloudAppsConnectorError(
          'bounds',
          'Defender for Cloud Apps requested another page without advancing the offset.',
        )
      }
      skip += page.length
      if (!Number.isSafeInteger(skip)) {
        throw new DefenderCloudAppsConnectorError(
          'bounds',
          'Defender for Cloud Apps collection offset exceeded safe bounds.',
        )
      }
    }
  }

  private listUrl(path: string, skip: number, limit: number, end: number): URL {
    const url = new URL(path, this.source.apiBaseUrl)
    const start = Math.max(0, Math.floor(end - this.limits.lookbackHours * 60 * 60 * 1_000))
    url.searchParams.set('filters', JSON.stringify({ date: { gte: start } }))
    url.searchParams.set('sortDirection', 'desc')
    url.searchParams.set('sortField', 'date')
    url.searchParams.set('skip', String(skip))
    url.searchParams.set('limit', String(limit))
    return url
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
          new DefenderCloudAppsConnectorError(
            'timeout',
            'Defender for Cloud Apps token acquisition timed out.',
          ),
        )
      }, this.limits.requestTimeoutMs)
    })
    try {
      const result = await Promise.race([
        this.credential.getToken(DEFENDER_CLOUD_APPS_TOKEN_SCOPE, {
          abortSignal: controller.signal,
        }),
        timeout,
      ])
      if (result === null) {
        throw new DefenderCloudAppsConnectorError(
          'authentication',
          'Azure credential did not return a Defender for Cloud Apps access token.',
        )
      }
      assertJwtTenant(result.token, this.source.tenantId)
      return result.token
    } catch (error) {
      if (error instanceof DefenderCloudAppsConnectorError) throw error
      if (timedOut || controller.signal.aborted) {
        throw new DefenderCloudAppsConnectorError(
          'timeout',
          'Defender for Cloud Apps token acquisition timed out.',
        )
      }
      throw new DefenderCloudAppsConnectorError(
        'authentication',
        'Defender for Cloud Apps credential acquisition failed.',
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
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          signal: controller.signal,
        })
        if (!response.ok) {
          const retryAfter = retryAfterMilliseconds(response.headers.get('retry-after'), this.now())
          if (
            response.status === 429 &&
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
        if (error instanceof DefenderCloudAppsConnectorError) throw error
        if (controller.signal.aborted) {
          throw new DefenderCloudAppsConnectorError(
            'timeout',
            'Defender for Cloud Apps request timed out.',
          )
        }
        throw new DefenderCloudAppsConnectorError(
          'network',
          'Defender for Cloud Apps request failed before a response.',
        )
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
