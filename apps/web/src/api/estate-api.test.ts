import { afterEach, describe, expect, it, vi } from 'vitest'

import * as authFetch from './auth-fetch'
import { estateApi } from './estate-api'

afterEach(() => vi.restoreAllMocks())

describe('estateApi', () => {
  it('returns only strict validated authorized estate contracts', async () => {
    vi.spyOn(authFetch, 'apiFetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          defaultEstateId: 'default-estate',
          estates: [
            {
              id: 'default-estate',
              name: 'Default estate',
              tenantId: 'tenant-a',
              environment: 'production',
              isDefault: true,
            },
          ],
        }),
        { status: 200 },
      ),
    )

    await expect(estateApi.listAuthorized()).resolves.toMatchObject({
      defaultEstateId: 'default-estate',
    })
  })

  it('rejects malformed estate contracts', async () => {
    vi.spyOn(authFetch, 'apiFetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          defaultEstateId: 'default-estate',
          estates: [{ id: 'default-estate', name: 'Default estate' }],
        }),
        { status: 200 },
      ),
    )

    await expect(estateApi.listAuthorized()).rejects.toThrow()
  })
})
