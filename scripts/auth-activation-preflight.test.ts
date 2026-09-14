import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  assessAuthActivation,
  readAuthActivationInput,
  type AuthActivationPreflightReport,
} from './auth-activation-preflight.js'

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`./test-fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as unknown
}

describe('assessAuthActivation', () => {
  it('produces a bounded deployment plan for the ready fixture', async () => {
    const report = assessAuthActivation(await fixture('auth-activation-ready'))

    expect(report.status).toBe('ready')
    expect(report.safeToDeploy).toBe(true)
    expect(report.derived).toEqual({
      authority: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111',
      issuer: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0',
      jwksUri:
        'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/discovery/v2.0/keys',
    })
    expect(report.deploymentPlan?.sequence.map((step) => step.target)).toEqual(['api', 'web'])
    expect(report.deploymentPlan?.sequence[0].settings).toMatchObject({
      AUTH_MODE: 'jwt',
      AUTH_SPA_REDIRECT_URI: 'https://sentinel-replacement.example.com/auth-redirect.html',
      AUTH_SPA_POST_LOGOUT_REDIRECT_URI: 'https://sentinel-replacement.example.com/',
      AGENT_SENTINEL_WRITE_ENABLED: 'false',
    })
    expect(JSON.stringify(report)).not.toContain('do-not-print-this')
  })

  it('reports fixture violations without returning a deployment plan', async () => {
    const report = assessAuthActivation(await fixture('auth-activation-blocked'))

    expect(report.status).toBe('blocked')
    expect(report.safeToDeploy).toBe(false)
    expect(report.deploymentPlan).toBeUndefined()
    expect(report.checks.map((check) => check.path)).toEqual(
      expect.arrayContaining([
        '$.frontDoorOrigin',
        '$.redirectUri',
        '$.postLogoutRedirectUri',
        '$.spaClientId',
        '$.audience',
        '$.scopes',
        '$.scopes.spa',
        '$.roles',
        '$.estateGrants.0',
        '$.estateGrants',
      ]),
    )
  })

  it('blocks write enablement before producing a deployment plan', async () => {
    const ready = (await fixture('auth-activation-ready')) as Record<string, unknown>
    const report = assessAuthActivation({ ...ready, writesEnabled: true })

    expect(report.status).toBe('blocked')
    expect(report.checks).toContainEqual(
      expect.objectContaining({ path: '$.writesEnabled', status: 'block' }),
    )
    expect(report.deploymentPlan).toBeUndefined()
  })

  it('rejects secret-shaped fields without reflecting their values', async () => {
    const ready = (await fixture('auth-activation-ready')) as Record<string, unknown>
    const report = assessAuthActivation({ ...ready, clientSecret: 'do-not-print-this' })

    expect(report.status).toBe('blocked')
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: 'secret-material-forbidden', path: '$.clientSecret' }),
    )
    expect(JSON.stringify(report)).not.toContain('do-not-print-this')
  })
})

describe('readAuthActivationInput', () => {
  it('accepts equivalent sanitized CLI options', async () => {
    const ready = (await fixture('auth-activation-ready')) as Required<Record<string, unknown>>
    const scopes = ready['scopes'] as { read: string[]; write: string[]; spa: string[] }
    const deployment = ready['deployment'] as {
      commitSha: string
      apiImageDigest: string
      webImageDigest: string
    }
    const waf = ready['waf'] as Record<string, string | boolean>
    const args = [
      '--environment',
      String(ready['environment']),
      '--production',
      'true',
      '--tenant-id',
      String(ready['tenantId']),
      '--api-client-id',
      String(ready['apiClientId']),
      '--spa-client-id',
      String(ready['spaClientId']),
      '--audience',
      String(ready['audience']),
      '--front-door-origin',
      String(ready['frontDoorOrigin']),
      '--redirect-uri',
      String(ready['redirectUri']),
      '--post-logout-redirect-uri',
      String(ready['postLogoutRedirectUri']),
      '--read-scope',
      scopes.read[0] ?? '',
      '--write-scope',
      scopes.write[0] ?? '',
      '--spa-scope',
      scopes.spa[0] ?? '',
      ...(ready['roles'] as string[]).flatMap((role) => ['--role', role]),
      '--estate-grants-json',
      JSON.stringify(ready['estateGrants']),
      '--writes-enabled',
      'false',
      '--waf-policy-mode',
      String(waf['policyMode']),
      '--waf-contract-digest',
      String(waf['mutationGuardContractDigest']),
      '--waf-guard-deployment',
      String(waf['mutationGuardDeployment']),
      '--waf-guard-enabled',
      'false',
      '--waf-unchanged',
      'true',
      '--commit-sha',
      deployment.commitSha,
      '--api-image-digest',
      deployment.apiImageDigest,
      '--web-image-digest',
      deployment.webImageDigest,
    ]

    const parsed = await readAuthActivationInput(args)
    const report: AuthActivationPreflightReport = assessAuthActivation(parsed.input)
    expect(report.status).toBe('ready')
  })
})
