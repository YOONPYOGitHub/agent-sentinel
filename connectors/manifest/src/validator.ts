import {
  computeManifestHash,
  isProhibitedActionDepth,
  isSupportedManifestVersion,
  UnsupportedManifestVersionError,
  validateManifest,
  type ManifestEnvelope,
  type ManifestValidationIssue,
} from '@agent-sentinel/connector-sdk'

import { loadManifestFile } from './file-loader.js'
import { manifestConnectorConfigSchema, type ManifestConnectorConfig } from './manifest-schema.js'

export class ManifestValidationError extends Error {
  override readonly name = 'ManifestValidationError'
  constructor(
    message: string,
    readonly errors: readonly ManifestValidationIssue[],
  ) {
    super(message)
  }
}

export interface AcceptedManifest {
  readonly envelope: ManifestEnvelope
  readonly hash: string
}

export type ManifestAcceptanceResult =
  | { readonly ok: true; readonly accepted: AcceptedManifest }
  | { readonly ok: false; readonly errors: readonly ManifestValidationIssue[] }

function fail(path: string, message: string): ManifestAcceptanceResult {
  return { ok: false, errors: [{ path, message }] }
}

/**
 * Full fail-closed acceptance pipeline for a raw manifest.
 *
 * Order matters: schema version, then structure and cross-references, then the
 * connector-level trust boundaries (action depth, tenant, environment). Nothing
 * is normalized until every gate passes.
 */
export function acceptManifest(
  raw: unknown,
  config: Pick<ManifestConnectorConfig, 'tenantId' | 'environmentId'>,
): ManifestAcceptanceResult {
  const version =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['schemaVersion']
      : undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return fail('', 'Manifest must be a JSON object.')
  if (!isSupportedManifestVersion(version))
    return fail('schemaVersion', new UnsupportedManifestVersionError(version).message)

  const validated = validateManifest(raw)
  if (!validated.ok) return { ok: false, errors: validated.errors }

  const { envelope } = validated

  if (isProhibitedActionDepth(envelope.capabilities.supportsActions))
    return fail(
      'capabilities.supportsActions',
      'Adapter action depth "execute" is never permitted by the manifest connector.',
    )

  if (envelope.tenantId !== config.tenantId)
    return fail(
      'tenantId',
      `Manifest tenantId ${envelope.tenantId} does not match the configured tenant.`,
    )

  if (config.environmentId !== undefined && envelope.environmentId !== config.environmentId)
    return fail(
      'environmentId',
      `Manifest environmentId ${envelope.environmentId ?? '(absent)'} does not match the configured environment ${config.environmentId}.`,
    )

  if (config.environmentId !== undefined) {
    const declarations = [
      ['agents', envelope.agents],
      ['tools', envelope.tools],
      ['identities', envelope.identities],
      ['dataSources', envelope.dataSources],
      ['mcpDependencies', envelope.mcpDependencies ?? []],
    ] as const
    for (const [kind, entries] of declarations) {
      const mismatchIndex = entries.findIndex(
        (entry) => entry.environment !== undefined && entry.environment !== config.environmentId,
      )
      if (mismatchIndex >= 0) {
        return fail(
          `${kind}.${mismatchIndex}.environment`,
          `Entity environment does not match the configured environment ${config.environmentId}.`,
        )
      }
    }
  }

  return { ok: true, accepted: { envelope, hash: computeManifestHash(envelope) } }
}

/** Resolve the configured manifest source without ever leaving the local filesystem. */
export async function readConfiguredManifest(config: ManifestConnectorConfig): Promise<unknown> {
  if (config.manifestPath !== undefined) return loadManifestFile(config.manifestPath)
  return config.manifestContent
}

/** Parse connector configuration, enforcing the manifest-source exclusivity rule. */
export function parseManifestConnectorConfig(value: unknown): ManifestConnectorConfig {
  return manifestConnectorConfigSchema.parse(value)
}
