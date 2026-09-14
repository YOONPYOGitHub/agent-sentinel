import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { assessActiveEdge } from './auth-edge-preflight.js'

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`./test-fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as unknown
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
    expect(report.observations.reviewedMutationRulePresent).toBe(true)
    expect(report.writeActivationAllowed).toBe(true)
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
