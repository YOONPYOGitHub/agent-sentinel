import { readFile } from 'node:fs/promises'

import { describe, expect, it, vi } from 'vitest'

import { authActivationInputSchema } from './auth-activation-preflight.js'
import { runAuthActivationDeploymentCli, verifyPublicAuthConfig } from './deploy-auth-activation.js'

async function activationInput() {
  return authActivationInputSchema.parse(
    JSON.parse(
      await readFile(
        new URL('./test-fixtures/auth-activation-ready.json', import.meta.url),
        'utf8',
      ),
    ),
  )
}

function publicConfig(input: Awaited<ReturnType<typeof activationInput>>): Record<string, unknown> {
  return {
    enabled: true,
    tenantId: input.tenantId.toLowerCase(),
    clientId: input.spaClientId.toLowerCase(),
    authority: `https://login.microsoftonline.com/${input.tenantId.toLowerCase()}`,
    scopes: input.scopes.spa,
    redirectUri: input.redirectUri,
    postLogoutRedirectUri: input.postLogoutRedirectUri,
  }
}

describe('verifyPublicAuthConfig', () => {
  it('accepts only the exact sanitized activation configuration', async () => {
    const input = await activationInput()
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(publicConfig(input)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(verifyPublicAuthConfig(input, fetchMock)).resolves.toBeUndefined()
  })

  it('rejects authority, scope, and extra-field drift from the approved input', async () => {
    const input = await activationInput()
    for (const drift of [
      { authority: 'https://login.microsoftonline.com/organizations' },
      { scopes: [`${input.audience}/AgentSentinel.Write`] },
      { rawToken: 'must-not-be-present' },
    ]) {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ ...publicConfig(input), ...drift }), { status: 200 }),
        )
      await expect(verifyPublicAuthConfig(input, fetchMock)).rejects.toThrow()
    }
  })
})

describe('runAuthActivationDeploymentCli', () => {
  it('is a non-mutating dry-run unless apply and approval are both explicit', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const result = await runAuthActivationDeploymentCli([
      '--input',
      'test-fixtures/auth-activation-ready.json',
      '--resource-group',
      'rg-agent-sentinel',
      '--api-app',
      'api-as-260814',
      '--web-app',
      'web-as-260814',
      '--acr-login-server',
      'acrm098047.azurecr.io',
    ])

    expect(result).toBe(0)
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"mode": "dry-run"'))
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"target": "api"'))
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"target": "web"'))
    output.mockRestore()
  })

  it('rejects apply without the protected approval phrase before any Azure call', async () => {
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const result = await runAuthActivationDeploymentCli([
      '--input',
      'test-fixtures/auth-activation-ready.json',
      '--resource-group',
      'rg-agent-sentinel',
      '--api-app',
      'api-as-260814',
      '--web-app',
      'web-as-260814',
      '--acr-login-server',
      'acrm098047.azurecr.io',
      '--rollback-output',
      'rollback.json',
      '--apply',
      '--approval',
      'NOT_APPROVED',
    ])

    expect(result).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Apply requires'))
    error.mockRestore()
  })

  it('rejects an activation plan for a different checked-out commit', async () => {
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const result = await runAuthActivationDeploymentCli([
      '--input',
      'test-fixtures/auth-activation-ready.json',
      '--resource-group',
      'rg-agent-sentinel',
      '--api-app',
      'api-as-260814',
      '--web-app',
      'web-as-260814',
      '--acr-login-server',
      'acrm098047.azurecr.io',
      '--expected-commit-sha',
      'dddddddddddddddddddddddddddddddddddddddd',
    ])

    expect(result).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('checked-out workflow SHA'))
    error.mockRestore()
  })
})
