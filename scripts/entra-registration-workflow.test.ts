import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function rootFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

describe('Entra registration bootstrap workflow', () => {
  it('keeps pull requests and the default dispatch in plan mode', () => {
    const workflow = rootFile('.github/workflows/entra-registration-bootstrap.yml')

    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain("default: 'plan'")
    expect(workflow).toContain('--state scripts/test-fixtures/entra-registration-state-empty.json')
    expect(workflow).toContain('Upload sanitized plan artifact')
    expect(workflow).not.toMatch(/\baz\s+ad\b/)
  })

  it('requires OIDC, exact tenant allowlisting, protected approval, and the plan artifact for apply', () => {
    const workflow = rootFile('.github/workflows/entra-registration-bootstrap.yml')

    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('uses: azure/login@v2')
    expect(workflow).toContain('ENTRA_BOOTSTRAP_ALLOWED_TENANT_ID')
    expect(workflow).toContain("'APPROVE_ENTRA_REGISTRATION_BOOTSTRAP'")
    expect(workflow).toContain('environment: entra-registration-bootstrap')
    expect(workflow).toContain(
      '--approved-plan "${RUNNER_TEMP}/approved-plan/entra-registration-plan.json"',
    )
    expect(workflow).toContain('AGENT_SENTINEL_PROTECTED_ENVIRONMENT: entra-registration-bootstrap')
    expect(workflow).toContain('pnpm auth:edge-preflight --')
    expect(workflow).not.toMatch(/client-secret|CLIENT_SECRET|passwordCredentials/i)
  })
})
