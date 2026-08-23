import {
  adapterCapabilityDeclarationSchema,
  agentDeclarationSchema,
  dataSourceDeclarationSchema,
  edgeDeclarationSchema,
  edgeEndpointSchema,
  evidenceDeclarationSchema,
  identityDeclarationSchema,
  manifestEntityKindSchema,
  manifestEnvelopeSchema,
  manifestEvidenceTypeSchema,
  manifestProducerSchema,
  manifestSchemaVersionSchema,
  mcpDependencyDeclarationSchema,
  sourceProvenanceSchema,
  toolDeclarationSchema,
} from '@agent-sentinel/connector-sdk'
import { z } from 'zod'

/**
 * The manifest envelope contract is owned by `@agent-sentinel/connector-sdk` so
 * that producers and consumers validate against exactly one definition. This
 * module re-exports it and adds the connector-local configuration contract.
 */
export {
  adapterCapabilityDeclarationSchema,
  agentDeclarationSchema,
  dataSourceDeclarationSchema,
  edgeDeclarationSchema,
  edgeEndpointSchema,
  evidenceDeclarationSchema,
  identityDeclarationSchema,
  manifestEntityKindSchema,
  manifestEnvelopeSchema,
  manifestEvidenceTypeSchema,
  manifestProducerSchema,
  manifestSchemaVersionSchema,
  mcpDependencyDeclarationSchema,
  sourceProvenanceSchema,
  toolDeclarationSchema,
}

/** Strings that would turn a local path into a network or protocol reference. */
export const FORBIDDEN_PATH_FRAGMENTS = ['://'] as const

function looksRemote(value: string): boolean {
  const candidate = value.trim()
  return candidate.includes('://') || candidate.startsWith('//') || candidate.startsWith('\\\\')
}

/**
 * Connector configuration. Exactly one manifest source must be supplied:
 * an already-parsed object, or an absolute local file path.
 */
export const manifestConnectorConfigSchema = z
  .strictObject({
    manifestContent: z.unknown().optional(),
    manifestPath: z
      .string()
      .min(1)
      .refine((value) => !looksRemote(value), {
        message:
          'manifestPath must be a local absolute path. URLs and protocol-relative paths are rejected.',
      })
      .optional(),
    tenantId: z.string().min(1),
    environmentId: z.string().min(1).optional(),
  })
  .superRefine((config, context) => {
    const hasContent = config.manifestContent !== undefined
    const hasPath = config.manifestPath !== undefined
    if (hasContent && hasPath) {
      context.addIssue({
        code: 'custom',
        message: 'Provide either manifestContent or manifestPath, not both.',
        path: ['manifestPath'],
      })
    }
    if (!hasContent && !hasPath) {
      context.addIssue({
        code: 'custom',
        message: 'Provide exactly one of manifestContent or manifestPath.',
        path: ['manifestContent'],
      })
    }
  })

export type ManifestConnectorConfig = z.infer<typeof manifestConnectorConfigSchema>
