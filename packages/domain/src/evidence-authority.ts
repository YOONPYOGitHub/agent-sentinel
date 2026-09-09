import { z } from 'zod'

import { estateIdSchema } from './estate.js'

const scopedSourceIdSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^(foundry|entra):[A-Za-z0-9][A-Za-z0-9._:-]*$/)

const azureGuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

export const evidenceAuthoritySchema = z
  .strictObject({
    estateId: estateIdSchema,
    sourceId: scopedSourceIdSchema,
    tenantId: z.string().trim().min(1).max(128),
    environment: z.string().trim().min(1).max(128),
    provider: z.enum(['azure-ai-foundry-agent-service', 'microsoft-entra']),
    sourceObjectId: z.string().trim().min(1).max(500),
    providerObjectId: z.string().trim().min(1).max(500),
    snapshotGeneratedAt: z.iso.datetime(),
    sourceRelease: z.string().trim().min(1).max(100),
  })
  .superRefine((authority, context) => {
    const requiredPrefix =
      authority.provider === 'azure-ai-foundry-agent-service' ? 'foundry:' : 'entra:'
    if (!authority.sourceId.startsWith(requiredPrefix)) {
      context.addIssue({
        code: 'custom',
        path: ['sourceId'],
        message: `Authority sourceId must use the ${requiredPrefix} provider scope.`,
      })
    }
    if (
      authority.provider === 'microsoft-entra' &&
      !azureGuidSchema.safeParse(authority.providerObjectId).success
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Microsoft Entra authority requires exact GUID source and object identifiers.',
      })
    }
  })

export type EvidenceAuthority = z.infer<typeof evidenceAuthoritySchema>

export const runsAsBindingSchema = z
  .strictObject({
    agent: evidenceAuthoritySchema,
    identity: evidenceAuthoritySchema,
    identifier: z.strictObject({
      kind: z.enum(['object-id', 'application-id', 'agent-identity-id']),
      value: azureGuidSchema,
    }),
  })
  .superRefine((binding, context) => {
    if (binding.agent.estateId !== binding.identity.estateId) {
      context.addIssue({
        code: 'custom',
        message: 'RUNS_AS endpoint authorities must share an estate.',
      })
    }
    if (
      binding.agent.provider !== 'azure-ai-foundry-agent-service' ||
      binding.identity.provider !== 'microsoft-entra'
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'RUNS_AS requires a Foundry agent endpoint and a Microsoft Entra identity endpoint.',
      })
    }
  })

export type RunsAsBinding = z.infer<typeof runsAsBindingSchema>
