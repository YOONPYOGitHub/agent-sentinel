import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { assessActiveEdge } from './auth-edge-preflight.js'

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`./test-fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as unknown
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('assessActiveEdge', () => {
  it('models write-disabled API state as the safe fallback when active Front Door has no mutation rule', async () => {
    const report = assessActiveEdge(
      await fixture('active-edge-input-read-only'),
      await fixture('active-edge-snapshot-no-rule'),
    )

    expect(report.status).toBe('ready')
    expect(report.safeReadOnlyPolicy).toBe('api-writes-disabled-no-write-activation')
    expect(report.observations.frontDoorMutationRulePresent).toBe(false)
    expect(report.writeActivationAllowed).toBe(false)
  })

  it('recognizes an associated active Front Door mutation rule', async () => {
    const report = assessActiveEdge(
      await fixture('active-edge-input-read-only'),
      await fixture('active-edge-snapshot-rule'),
    )

    expect(report.status).toBe('ready')
    expect(report.safeReadOnlyPolicy).toBe('front-door-mutation-rule')
    expect(report.observations.frontDoorMutationRulePresent).toBe(true)
  })

  it('blocks write-stage readiness without the reviewed active-edge rule', async () => {
    const report = assessActiveEdge(
      await fixture('active-edge-input-write'),
      await fixture('active-edge-snapshot-no-rule'),
    )

    expect(report.status).toBe('blocked')
    expect(report.writeActivationAllowed).toBe(false)
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: 'write-stage-jwt-and-reviewed-edge', status: 'block' }),
    )
  })

  it('allows write-stage readiness only with JWT, writes disabled, and the exact reviewed rule', async () => {
    const report = assessActiveEdge(
      await fixture('active-edge-input-write'),
      await fixture('active-edge-snapshot-rule'),
    )

    expect(report.status).toBe('ready')
    expect(report.observations.jwtActive).toBe(true)
    expect(report.observations.exactMutationRuleContractPresent).toBe(true)
    expect(report.observations.mutationContractDigestMatches).toBe(true)
    expect(report.writeActivationAllowed).toBe(true)
    expect(report.activationOrder).toEqual([
      'validate-jwt-reads-with-writes-disabled',
      'deploy-and-verify-front-door-anonymous-mutation-guard',
      'separately-approve-write-switch',
    ])
    expect(report.rollbackOrder[0]).toBe('restore-write-switch-false')
  })

  it('fails closed on missing or ambiguous WAF policy associations', async () => {
    const input = await fixture('active-edge-input-write')
    const ready = (await fixture('active-edge-snapshot-rule')) as {
      frontDoor: {
        associatedSecurityPolicyIds: string[]
        associatedWafPolicyIds: string[]
        wafPolicyId: string | null
      }
    }
    const missing = copy(ready)
    missing.frontDoor.associatedWafPolicyIds = []
    missing.frontDoor.wafPolicyId = null
    expect(assessActiveEdge(input, missing).status).toBe('blocked')

    const ambiguous = copy(ready)
    ambiguous.frontDoor.associatedSecurityPolicyIds.push(
      `${ambiguous.frontDoor.associatedSecurityPolicyIds[0] ?? 'security-policy'}-duplicate`,
    )
    ambiguous.frontDoor.associatedWafPolicyIds.push(
      `${ambiguous.frontDoor.associatedWafPolicyIds[0] ?? 'waf-policy'}-duplicate`,
    )
    ambiguous.frontDoor.wafPolicyId = null
    const report = assessActiveEdge(input, ambiguous)
    expect(report.status).toBe('blocked')
    expect(report.observations.wafPolicyUnambiguous).toBe(false)
  })

  it('fails closed on duplicate rules, contract drift, and API Allow rules', async () => {
    const input = await fixture('active-edge-input-write')
    const ready = (await fixture('active-edge-snapshot-rule')) as {
      frontDoor: {
        wafPolicyContractDigest: string | null
        mutationRules: Array<Record<string, unknown>>
      }
    }

    const duplicate = copy(ready)
    duplicate.frontDoor.mutationRules.push(copy(duplicate.frontDoor.mutationRules[0] ?? {}))
    expect(assessActiveEdge(input, duplicate).status).toBe('blocked')

    const drifted = copy(ready)
    drifted.frontDoor.wafPolicyContractDigest =
      'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    expect(assessActiveEdge(input, drifted).status).toBe('blocked')

    const allowed = copy(ready)
    allowed.frontDoor.mutationRules.push({
      name: 'AllowAllApi',
      priority: 50,
      enabled: true,
      action: 'Allow',
      pathOperator: 'RegEx',
      pathValues: ['^/api/.*'],
      pathTransforms: ['Lowercase'],
      methodOperator: 'Equal',
      methods: ['POST'],
      authorizationBoundaryMatches: false,
    })
    const report = assessActiveEdge(input, allowed)
    expect(report.status).toBe('blocked')
    expect(report.observations.apiAllowRulePresent).toBe(true)
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: 'no-api-allow-rule', status: 'block' }),
    )
  })

  it('rejects non-HTTPS and mismatched-origin inputs', async () => {
    const input = (await fixture('active-edge-input-read-only')) as Record<string, unknown>
    const snapshot = await fixture('active-edge-snapshot-rule')
    expect(() =>
      assessActiveEdge(
        { ...input, frontDoorOrigin: 'http://sentinel-replacement.example.com' },
        snapshot,
      ),
    ).toThrow('HTTPS')
  })
})
