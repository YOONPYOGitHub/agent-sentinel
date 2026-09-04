/**
 * Centralized authenticated fetch.
 * When a token provider is registered (by AuthProvider when the user is signed in),
 * all API requests automatically include a Bearer token.
 * In disabled auth mode or when not signed in, requests are sent anonymously.
 */

let tokenProvider: (() => Promise<string | null>) | undefined
let estateIdProvider: (() => string | null) | undefined

export function setTokenProvider(provider: (() => Promise<string | null>) | undefined): void {
  tokenProvider = provider
}

export function setEstateIdProvider(provider: (() => string | null) | undefined): void {
  estateIdProvider = provider
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  const requestInit = { ...init, headers }
  const estateId = estateIdProvider?.()
  if (estateId !== null && estateId !== undefined) {
    headers.set('x-agent-sentinel-estate-id', estateId)
  }
  if (headers.has('Authorization')) return fetch(input, requestInit)
  const token = tokenProvider !== undefined ? await tokenProvider() : null
  if (token === null) {
    if (
      (estateId !== null && estateId !== undefined) ||
      input instanceof Request ||
      init?.headers !== undefined
    ) {
      return fetch(input, requestInit)
    }
    return init === undefined ? fetch(input) : fetch(input, init)
  }
  headers.set('Authorization', `Bearer ${token}`)
  return fetch(input, requestInit)
}
