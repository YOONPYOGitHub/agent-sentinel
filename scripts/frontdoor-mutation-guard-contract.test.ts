import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  frontDoorMutationGuardContract,
  mutationGuardContractDigest,
} from './frontdoor-mutation-guard-contract.js'

function rootFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

describe('Front Door authenticated mutation guard contract', () => {
  it('has an immutable digest and only exact Block rules', () => {
    const { contractDigest, ...digestInput } = frontDoorMutationGuardContract

    expect(mutationGuardContractDigest(digestInput)).toBe(contractDigest)
    expect(frontDoorMutationGuardContract.rules).toHaveLength(9)
    expect(
      frontDoorMutationGuardContract.rules.every((rule) => rule.name.startsWith('BlockAnon')),
    ).toBe(true)
    expect(
      frontDoorMutationGuardContract.rules.some((rule) =>
        rule.pathValues.some((path) => path.includes('/api/*') || path === '^/api/.*'),
      ),
    ).toBe(false)
    expect(
      frontDoorMutationGuardContract.rules.some((rule) =>
        rule.pathValues.some((path) => /[()]/.test(path)),
      ),
    ).toBe(false)
    const authorizationShape = new RegExp(
      frontDoorMutationGuardContract.authorizationBoundary.matchValues[0] ?? '',
    )
    expect(authorizationShape.test('')).toBe(false)
    expect(authorizationShape.test('Bearer malformed')).toBe(false)
    expect(authorizationShape.test('Bearer aaa.bbb.ccc')).toBe(true)
  })

  it('keeps IaC disabled by default and generates no API Allow rule', () => {
    const frontDoor = rootFile('infra/modules/frontdoor.bicep')
    const platform = rootFile('infra/platform.bicep')

    expect(frontDoor).toContain('param authenticatedMutationGuardEnabled bool = false')
    expect(platform).toContain('param frontDoorAuthenticatedMutationGuardEnabled bool = false')
    expect(frontDoor).toContain("action: 'Block'")
    expect(frontDoor).not.toContain("action: 'Allow'")
    expect(frontDoorMutationGuardContract.authorizationBoundary.operator).toBe('RegEx')
    expect(frontDoor).not.toContain("matchValue: ['/api/")
    expect(frontDoor).toContain(
      "'agent-sentinel-auth-mutation-contract': mutationGuardContract.contractDigest",
    )
  })
})
