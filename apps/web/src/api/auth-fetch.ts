/**
 * Centralized authenticated fetch.
 * When a token provider is registered (by AuthProvider when the user is signed in),
 * all API requests automatically include a Bearer token.
 * In disabled auth mode or when not signed in, requests are sent anonymously.
 */

let tokenProvider: (() => Promise<string | null>) | undefined
let estateScope: { id: string; controller: AbortController } | undefined

const ESTATE_HEADER = 'x-agent-sentinel-estate-id'

export function setTokenProvider(provider: (() => Promise<string | null>) | undefined): void {
  tokenProvider = provider
}

export function setActiveEstateId(estateId: string | undefined): void {
  if (estateScope?.id === estateId) return
  estateScope?.controller.abort()
  estateScope =
    estateId === undefined ? undefined : { id: estateId, controller: new AbortController() }
}

export function getActiveEstateId(): string | undefined {
  return estateScope?.id
}

function requestSignal(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  scope: typeof estateScope,
): AbortSignal | undefined {
  const signals: AbortSignal[] = []
  if (input instanceof Request) signals.push(input.signal)
  if (init?.signal != null && !signals.includes(init.signal)) signals.push(init.signal)
  if (scope !== undefined) signals.push(scope.controller.signal)
  if (signals.length === 0) return undefined
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  const scope = estateScope
  if (scope !== undefined) headers.set(ESTATE_HEADER, scope.id)
  if (!headers.has('Authorization')) {
    const token = tokenProvider !== undefined ? await tokenProvider() : null
    if (token === null && scope === undefined) {
      return init !== undefined ? fetch(input, init) : fetch(input)
    }
    if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  }
  const signal = requestSignal(input, init, scope)
  const requestInit: RequestInit = {
    ...init,
    headers,
    ...(signal === undefined ? {} : { signal }),
  }
  return fetch(input, requestInit)
}
