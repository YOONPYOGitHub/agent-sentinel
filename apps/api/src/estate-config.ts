import { z } from 'zod'

import { estateContextSchema, type EstateContext } from '@agent-sentinel/domain'

const estateDefinitionSchema = estateContextSchema
  .extend({
    name: z.string().trim().min(1).max(100),
    isDefault: z.boolean(),
    allowedAuthTenantIds: z.array(z.string().trim().min(1).max(128)).max(20),
  })
  .strict()

const estateDefinitionsSchema = z
  .array(estateDefinitionSchema)
  .min(1)
  .max(50)
  .superRefine((estates, context) => {
    const ids = new Set<string>()
    const tenantIds = new Set<string>()
    let defaultCount = 0
    for (const [index, estate] of estates.entries()) {
      if (ids.has(estate.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate estate ID: ${estate.id}`,
          path: [index, 'id'],
        })
      }
      ids.add(estate.id)
      if (tenantIds.has(estate.tenantId)) {
        context.addIssue({
          code: 'custom',
          message:
            'Multiple environments in one tenant require estate-scoped persistence and are not enabled yet.',
          path: [index, 'tenantId'],
        })
      }
      tenantIds.add(estate.tenantId)
      if (estate.isDefault) defaultCount += 1
      if (new Set(estate.allowedAuthTenantIds).size !== estate.allowedAuthTenantIds.length) {
        context.addIssue({
          code: 'custom',
          message: `Estate ${estate.id} contains duplicate authentication tenant IDs.`,
          path: [index, 'allowedAuthTenantIds'],
        })
      }
    }
    if (defaultCount !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Exactly one estate must be configured as the default.',
      })
    }
  })

export type EstateDefinition = z.infer<typeof estateDefinitionSchema>

export interface EstateRegistry {
  estates: readonly EstateDefinition[]
  defaultEstate: EstateDefinition
  findById(id: string): EstateDefinition | undefined
  authorizedFor(authTenantId: string): EstateDefinition[]
}

export interface DefaultEstateInput extends EstateContext {
  authTenantId?: string
}

function parseConfiguredEstates(value: string): EstateDefinition[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('AGENT_SENTINEL_ESTATES_JSON must contain valid JSON.')
  }
  return estateDefinitionsSchema.parse(parsed)
}

export function buildEstateRegistry(
  environment: NodeJS.ProcessEnv,
  fallback: DefaultEstateInput,
): EstateRegistry {
  const configured = environment['AGENT_SENTINEL_ESTATES_JSON']?.trim()
  const estates =
    configured === undefined || configured.length === 0
      ? estateDefinitionsSchema.parse([
          {
            id: fallback.id,
            name: 'Default estate',
            tenantId: fallback.tenantId,
            environment: fallback.environment,
            isDefault: true,
            allowedAuthTenantIds:
              fallback.authTenantId === undefined ? [] : [fallback.authTenantId],
          },
        ])
      : parseConfiguredEstates(configured)
  const defaultEstate = estates.find((estate) => estate.isDefault)
  if (defaultEstate === undefined) {
    throw new Error('Estate registry validation did not produce a default estate.')
  }
  if (
    fallback.authTenantId !== undefined &&
    estates.some((estate) =>
      estate.allowedAuthTenantIds.some((tenantId) => tenantId !== fallback.authTenantId),
    )
  ) {
    throw new Error(
      'Configured estate authentication tenants must match AUTH_TENANT_ID until multi-issuer authentication is enabled.',
    )
  }
  const byId = new Map(estates.map((estate) => [estate.id, estate]))
  return {
    estates,
    defaultEstate,
    findById: (id) => byId.get(id),
    authorizedFor: (authTenantId) =>
      estates.filter((estate) => estate.allowedAuthTenantIds.includes(authTenantId)),
  }
}
