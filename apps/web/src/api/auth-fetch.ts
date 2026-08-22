/**
 * Centralized authenticated fetch.
 * When a token provider is registered (by AuthProvider when the user is signed in),
 * all API requests automatically include a Bearer token.
 * In disabled auth mode or when not signed in, requests are sent anonymously.
 */

let tokenProvider: (() => Promise<string | null>) | undefined

export function setTokenProvider(provider: (() => Promise<string | null>) | undefined): void {
  tokenProvider = provider
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  const requestInit = { ...init, headers }
  if (headers.has('Authorization')) return fetch(input, requestInit)
  const token = tokenProvider !== undefined ? await tokenProvider() : null
  if (token === null) return init !== undefined ? fetch(input, init) : fetch(input)
  headers.set('Authorization', `Bearer ${token}`)
  return fetch(input, requestInit)
}
