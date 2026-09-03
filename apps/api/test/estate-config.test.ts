import { describe, expect, it } from 'vitest'

import { buildEstateRegistry } from '../src/estate-config.js'

const fallback = {
  id: 'default',
  tenantId: 'data-tenant',
  environment: 'production',
  authTenantId: 'auth-tenant',
}

describe('estate registry', () => {
  it('preserves the current single-estate deployment when JSON is absent', () => {
    const registry = buildEstateRegistry({}, fallback)
    expect(registry.defaultEstate).toMatchObject({
      id: 'default',
      tenantId: 'data-tenant',
      environment: 'production',
      allowedAuthTenantIds: ['auth-tenant'],
    })
    expect(registry.authorizedFor('auth-tenant')).toHaveLength(1)
    expect(registry.authorizedFor('other')).toHaveLength(0)
  })

  it('accepts multiple data estates for the configured authentication tenant', () => {
    const registry = buildEstateRegistry(
      {
        AGENT_SENTINEL_ESTATES_JSON: JSON.stringify([
          {
            id: 'korea',
            name: 'Korea',
            tenantId: 'data-korea',
            environment: 'production',
            isDefault: true,
            allowedAuthTenantIds: ['auth-tenant'],
          },
          {
            id: 'lab',
            name: 'Lab',
            tenantId: 'data-lab',
            environment: 'validation',
            isDefault: false,
            allowedAuthTenantIds: ['auth-tenant'],
          },
        ]),
      },
      fallback,
    )
    expect(registry.authorizedFor('auth-tenant').map((estate) => estate.id)).toEqual([
      'korea',
      'lab',
    ])
    expect(registry.authorizedFor('other')).toHaveLength(0)
  })

  it('rejects authentication tenants that the configured JWT issuer cannot validate', () => {
    expect(() =>
      buildEstateRegistry(
        {
          AGENT_SENTINEL_ESTATES_JSON: JSON.stringify([
            {
              id: 'default',
              name: 'Default',
              tenantId: 'data-default',
              environment: 'production',
              isDefault: true,
              allowedAuthTenantIds: ['other-auth-tenant'],
            },
          ]),
        },
        fallback,
      ),
    ).toThrow('must match AUTH_TENANT_ID')
  })

  it('rejects ambiguous defaults and same-tenant environments until persistence is scoped', () => {
    expect(() =>
      buildEstateRegistry(
        {
          AGENT_SENTINEL_ESTATES_JSON: JSON.stringify([
            {
              id: 'one',
              name: 'One',
              tenantId: 'shared',
              environment: 'production',
              isDefault: true,
              allowedAuthTenantIds: [],
            },
            {
              id: 'two',
              name: 'Two',
              tenantId: 'shared',
              environment: 'validation',
              isDefault: true,
              allowedAuthTenantIds: [],
            },
          ]),
        },
        fallback,
      ),
    ).toThrow()
  })
})
