import type { TokenCredential } from '@azure/core-auth'
import {
  FOUNDRY_API_VERSION,
  foundryAgentPageSchema,
  foundryAgentSchema,
  type FoundryAgent,
} from '@agent-sentinel/foundry-connector'

const tokenScope = 'https://ai.azure.com/.default'
const retryableStatuses = new Set([408, 429, 500, 502, 503, 504])
const maximumRetries = 3

export const AGENT_SENTINEL_MANAGED_MARKER = '[managed-by:agent-sentinel]'

export function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (value === undefined || value.length === 0) {
    throw new Error(`Required environment variable is missing: ${name}`)
  }
  return value
}

export function sanitizeFoundryEndpoint(endpoint: string): string {
  let url: URL
  try {
    url = new URL(endpoint.trim())
  } catch {
    throw new Error('FOUNDRY_PROJECT_ENDPOINT must be a valid absolute URL.')
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !url.hostname.toLowerCase().endsWith('.services.ai.azure.com') ||
    !/^\/api\/projects\/[A-Za-z0-9][A-Za-z0-9._-]*\/?$/.test(url.pathname)
  ) {
    throw new Error('FOUNDRY_PROJECT_ENDPOINT is not a valid Azure AI Foundry project endpoint.')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function extractFoundryError(body: unknown): string | undefined {
  if (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'object' &&
    body.error !== null &&
    'message' in body.error &&
    typeof body.error.message === 'string'
  ) {
    return body.error.message
  }
  return undefined
}

export class FoundryHttpClient {
  private readonly endpoint: string
  private retries = 0

  constructor(
    endpoint: string,
    private readonly credential: TokenCredential,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    this.endpoint = sanitizeFoundryEndpoint(endpoint)
  }

  get retryCount(): number {
    return this.retries
  }

  async listAgents(): Promise<FoundryAgent[]> {
    const allAgents: FoundryAgent[] = []
    const agentsUrl = this.url('/agents')
    let nextUrl: URL | undefined = agentsUrl
    while (nextUrl !== undefined) {
      const response = await this.request(nextUrl, 'GET')
      const page = foundryAgentPageSchema.parse(response.body)
      allAgents.push(...(page.data ?? page.value ?? []))
      nextUrl = this.nextPageUrl(
        agentsUrl,
        nextUrl,
        page.nextLink,
        page.continuationToken ??
          response.headers.get('x-ms-continuation') ??
          response.headers.get('x-ms-continuation-token') ??
          undefined,
      )
    }
    return allAgents
  }

  async getAgent(id: string): Promise<FoundryAgent | undefined> {
    const response = await this.request(
      this.url(`/agents/${encodeURIComponent(id)}`),
      'GET',
      undefined,
      true,
    )
    return response === undefined ? undefined : foundryAgentSchema.parse(response.body)
  }

  async createAgent(name: string, body: unknown): Promise<unknown> {
    return (
      await this.request(this.url(`/agents/${encodeURIComponent(name)}/versions`), 'POST', body)
    ).body
  }

  async deleteAgent(id: string): Promise<unknown> {
    return (await this.request(this.url(`/agents/${encodeURIComponent(id)}`), 'DELETE')).body
  }

  private url(path: string): URL {
    const url = new URL(`${this.endpoint}${path}`)
    url.searchParams.set('api-version', FOUNDRY_API_VERSION)
    return url
  }

  private nextPageUrl(
    agentsUrl: URL,
    currentUrl: URL,
    nextLink: string | undefined,
    continuationToken: string | undefined,
  ): URL | undefined {
    if (nextLink !== undefined) {
      const nextUrl = new URL(nextLink, currentUrl)
      if (nextUrl.origin !== agentsUrl.origin || nextUrl.pathname !== agentsUrl.pathname) {
        throw new Error(`Foundry returned an untrusted agents nextLink: ${nextUrl.toString()}`)
      }
      nextUrl.searchParams.set('api-version', FOUNDRY_API_VERSION)
      return nextUrl
    }
    if (continuationToken === undefined || continuationToken.length === 0) return undefined
    const nextUrl = new URL(agentsUrl)
    nextUrl.searchParams.set('continuationToken', continuationToken)
    return nextUrl
  }

  private request(
    url: URL,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
    notFoundIsAbsent?: false,
  ): Promise<{ body: unknown; headers: Headers }>
  private request(
    url: URL,
    method: 'GET' | 'POST' | 'DELETE',
    body: unknown,
    notFoundIsAbsent: true,
  ): Promise<{ body: unknown; headers: Headers } | undefined>
  private async request(
    url: URL,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
    notFoundIsAbsent = false,
  ): Promise<{ body: unknown; headers: Headers } | undefined> {
    const token = await this.credential.getToken(tokenScope)
    if (token === null) throw new Error('Azure credential did not return a Foundry token.')
    const init: RequestInit = {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
    }
    if (body !== undefined) init.body = JSON.stringify(body)

    for (let attempt = 0; attempt <= maximumRetries; attempt += 1) {
      let response: Response
      try {
        response = await fetch(url, init)
      } catch (error: unknown) {
        if (attempt < maximumRetries) {
          this.retries += 1
          await this.sleep(2 ** attempt * 1_000)
          continue
        }
        const detail = error instanceof Error ? error.message : 'unknown network failure'
        throw new Error(
          `Foundry ${method} ${url.toString()} failed after ${maximumRetries} retries (network error: ${detail}).`,
        )
      }
      const text = await response.text()
      if (notFoundIsAbsent && response.status === 404) return undefined
      let parsed: unknown
      try {
        parsed = text.length === 0 ? undefined : JSON.parse(text)
      } catch {
        throw new Error(
          `Foundry ${method} ${url.toString()} returned unreadable status ${response.status}.`,
        )
      }
      if (!response.ok) {
        if (retryableStatuses.has(response.status) && attempt < maximumRetries) {
          this.retries += 1
          await this.sleep(2 ** attempt * 1_000)
          continue
        }
        throw new Error(
          `Foundry ${method} ${url.toString()} failed with status ${response.status}: ${
            extractFoundryError(parsed) ?? response.statusText
          }`,
        )
      }
      return { body: parsed, headers: response.headers }
    }
    throw new Error(`Foundry ${method} ${url.toString()} exhausted its retry loop.`)
  }
}
