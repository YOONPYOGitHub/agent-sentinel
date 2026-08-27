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

interface CollectionBudget {
  pages: number
  items: number
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

  async probeStableInventory(): Promise<void> {
    const url = this.stableServicePrincipalsUrl()
    url.searchParams.set('$top', '1')
    this.parsePage(servicePrincipalPageSchema, await this.requestJson(url))
  }

  listServicePrincipals(): Promise<EntraServicePrincipal[]> {
    return this.collect<EntraServicePrincipal>(
      this.stableServicePrincipalsUrl(),
      servicePrincipalPageSchema,
    )
  }

  async listOwners(
    servicePrincipals: readonly EntraServicePrincipal[],
  ): Promise<Map<string, EntraDirectoryOwner[]>> {
    const budget = this.newBudget()
    const owners = new Map<string, EntraDirectoryOwner[]>()
    for (const principal of servicePrincipals) {
      const url = new URL(
        `/v1.0/servicePrincipals/${encodeURIComponent(principal.id)}/owners`,
        this.config.graphBaseUrl,
      )
      url.searchParams.set('$select', 'id,displayName,userPrincipalName')
      owners.set(
        principal.id,
        await this.collect<EntraDirectoryOwner>(url, directoryOwnerPageSchema, budget),
      )
    }
    return owners
  }

  async listAppRoleAssignments(
    servicePrincipals: readonly EntraServicePrincipal[],
  ): Promise<Map<string, EntraAppRoleAssignment[]>> {
    const budget = this.newBudget()
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
        budget,
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

  listAgentIdentitiesPreview(): Promise<AgentIdentityPreview[]> {
    const url = new URL(
      '/beta/servicePrincipals/microsoft.graph.agentIdentity',
      this.config.graphBaseUrl,
    )
    url.searchParams.set(
      '$select',
      'id,appId,displayName,accountEnabled,agentIdentityBlueprintId,createdByAppId,createdDateTime,managerApplications,servicePrincipalType,tags',
    )
    return this.collect<AgentIdentityPreview>(url, agentIdentityPreviewPageSchema)
  }

  private stableServicePrincipalsUrl(): URL {
    const url = new URL('/v1.0/servicePrincipals', this.config.graphBaseUrl)
    url.searchParams.set(
      '$select',
      'id,appId,displayName,description,servicePrincipalType,accountEnabled,appOwnerOrganizationId,tags',
    )
    return url
  }

  private newBudget(): CollectionBudget {
    return { pages: 0, items: 0 }
  }

  private async collect<T>(
    initial: URL,
    schema: PageParser<T>,
    budget: CollectionBudget = this.newBudget(),
  ): Promise<T[]> {
    const values: T[] = []
    let next: URL | undefined = new URL(initial)
    while (next !== undefined) {
      if (budget.pages >= this.config.limits.maxPages) {
        throw new EntraGraphError('bounds', 'Microsoft Graph pagination exceeded the page limit.')
      }
      const page: Page<T> = this.parsePage<T>(schema, await this.requestJson(next))
      budget.pages += 1
      budget.items += page.value.length
      if (budget.items > this.config.limits.maxItems) {
        throw new EntraGraphError('bounds', 'Microsoft Graph pagination exceeded the item limit.')
      }
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

  private async requestJson(url: URL): Promise<unknown> {
    let token: string
    try {
      const accessToken = await this.credential.getToken(GRAPH_SCOPE)
      if (accessToken === null) {
        throw new EntraGraphError(
          'authentication',
          'Azure credential did not return a Microsoft Graph access token.',
        )
      }
      token = accessToken.token
    } catch (error) {
      if (error instanceof EntraGraphError) throw error
      throw new EntraGraphError('authentication', 'Microsoft Graph credential acquisition failed.')
    }

    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.config.limits.requestTimeoutMs)
      let response: Response
      try {
        response = await this.fetcher(url, {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
          signal: controller.signal,
        })
      } catch {
        if (controller.signal.aborted) {
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
          await this.sleep(delay)
          continue
        }
        throw statusError(response.status)
      }

      const bodyTimer = setTimeout(() => controller.abort(), this.config.limits.requestTimeoutMs)
      try {
        return await response.json()
      } catch {
        if (controller.signal.aborted) {
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
}
