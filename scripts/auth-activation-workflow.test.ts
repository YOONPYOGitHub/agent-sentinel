import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function rootFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

describe('read-only authentication activation workflow', () => {
  it('defaults to dry-run and requires protected approval for a surgical apply', () => {
    const workflow = rootFile('.github/workflows/auth-activation.yml')

    expect(workflow).toContain("default: 'plan'")
    expect(workflow).toContain("'APPROVE_READ_ONLY_AUTH_ACTIVATION'")
    expect(workflow).toContain('environment: ${{ inputs.targetEnvironment }}')
    expect(workflow).toContain('pnpm auth:deploy --')
    expect(workflow).toContain('--apply')
    expect(workflow).not.toContain('infra/platform.bicep')
    expect(workflow).not.toContain('az deployment group')
    expect(workflow).not.toMatch(/\baz\s+ad\b/)
    expect(workflow).not.toContain('BlockApiMutationPreAuth=')
  })

  it('implements API-before-web ordering and rollback capture in the deployment script', () => {
    const deployment = rootFile('scripts/deploy-auth-activation.ts')
    const preflight = rootFile('scripts/auth-activation-preflight.ts')
    const apiUpdate = deployment.indexOf("'agent-sentinel-api',\n          apiImage")
    const webUpdate = deployment.indexOf("'agent-sentinel-web',\n          webImage")

    expect(apiUpdate).toBeGreaterThan(0)
    expect(webUpdate).toBeGreaterThan(apiUpdate)
    expect(deployment).toContain('captureRollback(options)')
    expect(preflight).toContain("restoreOrder: ['web', 'api']")
    expect(preflight).toContain("AGENT_SENTINEL_WRITE_ENABLED: 'false'")
  })
})
