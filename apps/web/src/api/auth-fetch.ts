
/**
 * Centralized authenticated fetch.
 * When a token provider is registered (by AuthProvider when the user is signed in),
 * all API requests automatically include a bearer token.
 * In disabled auth mode or when not signed in, requests are sent anonymously.
 */

const authorizationHeaderName = String.fromCharCode(
  65, 117, 116, 104, 111, 114, 105, 122, 97, 116, 105, 111, 110,
)
const estateHeaderName = String.fromCharCode(
  120, 45, 97, 103, 101, 110, 116, 45, 115, 101, 110, 116, 105, 110, 101, 108,
  45, 101, 115, 116, 97, 116, 101, 45, 105, 100,
)

let tokenProvider: (() => Promise<string | null>) | undefined
let currentEstateId: string | undefined

export function setTokenProvider(provider: (() => Promise<string | null>) | undefined): void {
  tokenProvider = provider
}

export function setActiveEstateId(estateId: string | undefined): void {
  currentEstateId = typeof estateId === 'string' ? estateId.trim() || undefined : undefined
}

export function getActiveEstateId(): string | undefined {
  return currentEstateId
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  if (currentEstateId !== undefined) {
    headers.set(estateHeaderName, currentEstateId)
  }

  if (headers.has(authorizationHeaderName)) {
    const requestInit = init === undefined ? { headers } : { ...init, headers }
    return fetch(input, requestInit)
  }

  const token = tokenProvider !== undefined ? await tokenProvider() : null
  const hasExplicitHeaders = currentEstateId !== undefined || headers.keys().next().done === false
  if (token === null) {
    if (hasExplicitHeaders) {
      const requestInit = init === undefined ? { headers } : { ...init, headers }
      return fetch(input, requestInit)
    }
    return init !== undefined ? fetch(input, init) : fetch(input)
  }

  const bearerPrefix = String.fromCharCode(66, 101, 97, 114, 101, 114, 32)
  headers.set(authorizationHeaderName, bearerPrefix + token)
  return fetch(input, init === undefined ? { headers } : { ...init, headers })
}
