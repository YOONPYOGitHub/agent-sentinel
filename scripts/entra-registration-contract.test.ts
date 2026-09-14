import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  SnapshotEntraGraphClient,
  buildEntraRegistrationPlan,
  entraRegistrationInputSchema,
  entraRegistrationPlanSchema,
  entraRegistrationStateSchema,
} from './entra-registration-bootstrap.js'

async function rootJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8')) as unknown
}

describe('Entra registration JSON contracts', () => {
  it('keeps input and plan schemas closed to extra top-level fields', async () => {
    const inputSchema = (await rootJson(
      'infra/auth/entra-registration-bootstrap-input.schema.json',
    )) as Record<string, unknown>
    const planSchema = (await rootJson(
      'infra/auth/entra-registration-bootstrap-plan.schema.json',
    )) as Record<string, unknown>

    expect(inputSchema['additionalProperties']).toBe(false)
    expect(planSchema['additionalProperties']).toBe(false)
  })

  it('validates the fixture input and generated plan with strict runtime schemas', async () => {
    const input = entraRegistrationInputSchema.parse(
      await rootJson('scripts/test-fixtures/entra-registration-input.json'),
    )
    const state = entraRegistrationStateSchema.parse(
      await rootJson('scripts/test-fixtures/entra-registration-state-empty.json'),
    )
    const plan = await buildEntraRegistrationPlan(input, new SnapshotEntraGraphClient(state))

    expect(() => entraRegistrationPlanSchema.parse(plan)).not.toThrow()
    expect(() => entraRegistrationInputSchema.parse({ ...input, unexpected: true })).toThrow()
    expect(() => entraRegistrationPlanSchema.parse({ ...plan, unexpected: true })).toThrow()
  })

  it('keeps checked-in templates and schemas free of secret-bearing fields', async () => {
    const files = [
      'infra/auth/entra-registration-bootstrap-input.schema.json',
      'infra/auth/entra-registration-bootstrap-plan.schema.json',
      'infra/auth/replacement-entra-registration-bootstrap.template.json',
      'infra/auth/active-edge-preflight-input.schema.json',
      'infra/auth/replacement-active-edge-preflight.template.json',
    ]
    for (const file of files) {
      const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
      expect(text).not.toMatch(
        /clientSecret|passwordCredentials|keyCredentials|accessToken|refreshToken/i,
      )
    }
  })
})
