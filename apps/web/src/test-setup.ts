import { beforeEach, vi } from 'vitest'

import { setActiveEstateId, setTokenProvider } from './api/auth-fetch'

class ResizeObserverMock implements ResizeObserver {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  writable: true,
  value: ResizeObserverMock,
})

beforeEach(() => {
  setActiveEstateId(undefined)
  setTokenProvider(undefined)
  const nativeFetch = globalThis.fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === '/api/auth/config') {
      return Promise.resolve(
        new Response(JSON.stringify({ enabled: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }
    if (input === '/api/estates') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            defaultEstateId: 'default',
            estates: [
              {
                id: 'default',
                name: 'Default estate',
                tenantId: 'test',
                environment: 'test',
                isDefault: true,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }
    return nativeFetch(input, init)
  })
})
