import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/app.js'
import type { AuthConfig } from '../src/auth.js'

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}))

const jwtConfig: AuthConfig = {
  mode: 'jwt',
  tenantId: 'tenant-id',
  audience: 'api://11111111-1111-4111-8111-111111111111',
  issuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
  jwksUri: 'https://login.microsoftonline.com/tenant-id/discovery/v2.0/keys',
  allowedScopes: {
    read: ['AgentSentinel.Read'],
    write: ['AgentSentinel.Write'],
  },
  spaConfig: {
    tenantId: 'tenant-id',
    clientId: '11111111-1111-4111-8111-111111111111',
    authority: 'https://login.microsoftonline.com/tenant-id',
    scopes: ['api://11111111-1111-4111-8111-111111111111/AgentSentinel.Read'],
    redirectUri: 'https://sentinel.example/auth-redirect.html',
    postLogoutRedirectUri: 'https://sentinel.example/',
  },
}

const contract = JSON.parse(
  readFileSync(
    new URL(
      '../../../infra/auth/frontdoor-authenticated-mutation-guard.contract.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  rules: Array<{
    methods: Array<'POST' | 'PUT' | 'PATCH' | 'DELETE'>
    examplePaths: string[]
  }>
}

afterEach(() => {
  delete process.env['AGENT_SENTINEL_WRITE_ENABLED']
})

describe('anonymous mutation boundary', () => {
  it('denies every reviewed public mutation path even when the application write switch is true', async () => {
    process.env['AGENT_SENTINEL_WRITE_ENABLED'] = 'true'
    const app = await createApp(undefined, jwtConfig)

    try {
      for (const rule of contract.rules) {
        for (const path of rule.examplePaths) {
          for (const method of rule.methods) {
            const response = await app.inject({ method, url: path })
            expect(response.statusCode, `${method} ${path} must deny an anonymous caller`).toBe(401)
          }
        }
      }
    } finally {
      await app.close()
    }
  })
})
