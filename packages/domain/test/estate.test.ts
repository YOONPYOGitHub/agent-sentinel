import { describe, expect, it } from 'vitest'

import { estateContextSchema } from '../src/index.js'

describe('estate context', () => {
  it('accepts an opaque ID with an explicit data boundary', () => {
    expect(
      estateContextSchema.parse({
        id: 'korea-production',
        tenantId: 'tenant-data',
        environment: 'production',
      }),
    ).toEqual({
      id: 'korea-production',
      tenantId: 'tenant-data',
      environment: 'production',
    })
  })

  it('rejects path-like estate IDs and unknown fields', () => {
    expect(() =>
      estateContextSchema.parse({
        id: '../other',
        tenantId: 'tenant-data',
        environment: 'production',
      }),
    ).toThrow()
    expect(() =>
      estateContextSchema.parse({
        id: 'other',
        tenantId: 'tenant-data',
        environment: 'production',
        credential: 'secret',
      }),
    ).toThrow()
  })
})
