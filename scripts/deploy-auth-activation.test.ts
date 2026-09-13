import { describe, expect, it, vi } from 'vitest'

import { runAuthActivationDeploymentCli } from './deploy-auth-activation.js'

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
