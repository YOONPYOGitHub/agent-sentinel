import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { z } from 'zod'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const RULE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,89}$/

const mutationGuardRuleSchema = z.strictObject({
  name: z.string().regex(RULE_NAME_PATTERN),
  priority: z.number().int().min(1).max(1000),
  pathOperator: z.literal('RegEx'),
  pathValues: z.array(z.string().min(1).max(256)).min(1).max(4),
  methods: z
    .array(z.enum(['POST', 'PUT', 'PATCH', 'DELETE']))
    .min(1)
    .max(4),
  examplePaths: z
    .array(z.string().regex(/^\/api\/(?!\*|.*\*$).+/))
    .min(1)
    .max(4),
})

const mutationGuardContractSchema = z
  .strictObject({
    schemaVersion: z.literal('1.0.0'),
    contractId: z.literal('frontdoor-authenticated-mutation-guard-v1'),
    contractDigest: z.string().regex(DIGEST_PATTERN),
    authorizationBoundary: z.strictObject({
      matchVariable: z.literal('RequestHeader'),
      selector: z.literal('Authorization'),
      operator: z.literal('RegEx'),
      negateCondition: z.literal(true),
      matchValues: z
        .array(z.string())
        .length(1)
        .refine((values) => values.every((value) => !/[()]/.test(value)), {
          message: 'Authorization regex must not contain unsupported capturing groups.',
        }),
      transforms: z.tuple([z.literal('Trim')]),
    }),
    rules: z.array(mutationGuardRuleSchema).min(1).max(20),
  })
  .superRefine((contract, context) => {
    const names = contract.rules.map((rule) => rule.name)
    const priorities = contract.rules.map((rule) => rule.priority)
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: 'custom', path: ['rules'], message: 'Rule names must be unique.' })
    }
    if (new Set(priorities).size !== priorities.length) {
      context.addIssue({
        code: 'custom',
        path: ['rules'],
        message: 'Rule priorities must be unique.',
      })
    }
    for (const [index, rule] of contract.rules.entries()) {
      if (
        rule.pathValues.some(
          (path) => path === '/api/*' || path === '^/api/.*' || path === '^/api/.*$',
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['rules', index, 'pathValues'],
          message: 'A broad /api/* mutation rule is forbidden.',
        })
      }
      if (rule.pathValues.some((path) => /[()]/.test(path))) {
        context.addIssue({
          code: 'custom',
          path: ['rules', index, 'pathValues'],
          message: 'Front Door regex values must not contain unsupported capturing groups.',
        })
      }
      if (new Set(rule.methods).size !== rule.methods.length) {
        context.addIssue({
          code: 'custom',
          path: ['rules', index, 'methods'],
          message: 'Rule methods must be unique.',
        })
      }
    }
  })

export type FrontDoorMutationGuardContract = z.infer<typeof mutationGuardContractSchema>
export type FrontDoorMutationGuardRule = FrontDoorMutationGuardContract['rules'][number]

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object' || value === null) return JSON.stringify(value)
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`
}

export function mutationGuardContractDigest(
  contract: Omit<FrontDoorMutationGuardContract, 'contractDigest'>,
): string {
  return `sha256:${createHash('sha256').update(canonicalJson(contract)).digest('hex')}`
}

export function parseMutationGuardContract(raw: unknown): FrontDoorMutationGuardContract {
  const contract = mutationGuardContractSchema.parse(raw)
  const { contractDigest, ...digestInput } = contract
  if (mutationGuardContractDigest(digestInput) !== contractDigest) {
    throw new Error('Front Door mutation guard contract digest does not match its content.')
  }
  return contract
}

export const frontDoorMutationGuardContract = parseMutationGuardContract(
  JSON.parse(
    readFileSync(
      new URL(
        '../infra/auth/frontdoor-authenticated-mutation-guard.contract.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as unknown,
)
