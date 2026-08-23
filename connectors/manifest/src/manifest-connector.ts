import type {
  AgentConnector,
  ConnectionTestResult,
  ConnectorDescriptor,
  ManifestEnvelope,
  ManifestValidationIssue,
  SourceProvenance,
} from '@agent-sentinel/connector-sdk'
import { MANIFEST_SCHEMA_VERSION } from '@agent-sentinel/connector-sdk'
import type { EstateSnapshot, Evidence } from '@agent-sentinel/domain'

import { type ManifestConnectorConfig } from './manifest-schema.js'
import { normalizeManifest, type NormalizedManifest } from './normalizer.js'
import {
  acceptManifest,
  ManifestValidationError,
  parseManifestConnectorConfig,
  readConfiguredManifest,
} from './validator.js'

export const MANIFEST_CONNECTOR_ID = 'custom-manifest-adapter'

interface AcceptedSnapshot extends NormalizedManifest {
  readonly envelope: ManifestEnvelope
}

export type ManifestReader = (config: ManifestConnectorConfig) => Promise<unknown>

function describeErrors(errors: readonly ManifestValidationIssue[]): string {
  return errors
    .map((error) => (error.path === '' ? error.message : `${error.path}: ${error.message}`))
    .join('; ')
}

/**
 * Read-only adapter for operator-supplied agent manifests.
 *
 * Deliberate boundaries:
 * - no network access; the only input is an in-memory object or a local file,
 * - no `execute()` implementation, so remediation can never be routed here,
 * - every claim is non-authoritative and confidence-capped,
 * - tenant and environment are verified before anything is normalized.
 */
export class ManifestConnector implements AgentConnector {
  readonly descriptor: ConnectorDescriptor = {
    id: MANIFEST_CONNECTOR_ID,
    name: 'Custom Manifest / API Adapter',
    apiVersion: MANIFEST_SCHEMA_VERSION,
    releaseStatus: 'preview',
    capabilities: ['discovery', 'evidence'],
    requiredPermissions: ['Local read access to the operator-supplied manifest file'],
    blindSpots: [
      'Adapter-supplied evidence is non-authoritative and is never a source of truth.',
      'Declared configuration does not prove observed runtime behavior.',
      'No live API ingestion; the manifest is only as fresh as the operator made it.',
      'Remediation execution is not supported by this connector.',
    ],
  }

  private readonly config: ManifestConnectorConfig
  private cache: AcceptedSnapshot | undefined
  private generation = 0
  private inFlight:
    | {
        readonly generation: number
        readonly promise: Promise<AcceptedSnapshot>
      }
    | undefined

  constructor(
    config: ManifestConnectorConfig,
    private readonly readManifest: ManifestReader = readConfiguredManifest,
  ) {
    this.config = parseManifestConnectorConfig(config)
  }

  /** Validate configuration, load the manifest, and verify tenant and environment. */
  async testConnection(): Promise<ConnectionTestResult> {
    const checkedAt = new Date().toISOString()
    try {
      const { envelope, hash } = await this.load()
      return {
        ok: true,
        checkedAt,
        message: `Manifest ${envelope.manifestId} accepted (schema ${envelope.schemaVersion}, hash ${hash.slice(0, 12)}). Evidence is non-authoritative.`,
      }
    } catch (error: unknown) {
      return {
        ok: false,
        checkedAt,
        message: error instanceof Error ? error.message : 'Unknown manifest adapter error.',
      }
    }
  }

  /** Full normalized estate snapshot derived from the manifest. */
  async discover(): Promise<EstateSnapshot> {
    const { snapshot } = await this.load()
    return structuredClone(snapshot)
  }

  /** Evidence lookup by normalized evidence id. */
  async getEvidence(evidenceId: string): Promise<Evidence> {
    const { snapshot } = await this.load()
    const item = snapshot.evidence.find((candidate) => candidate.id === evidenceId)
    if (item === undefined)
      throw new ManifestValidationError(`Manifest evidence was not found: ${evidenceId}`, [])
    return structuredClone(item)
  }

  /** Every evidence record produced from the manifest. */
  async listEvidence(): Promise<Evidence[]> {
    const { snapshot } = await this.load()
    return structuredClone(snapshot.evidence)
  }

  /** Non-authoritative provenance descriptor; `sourceOfTruth` is always false. */
  async getProvenance(): Promise<SourceProvenance> {
    const { provenance } = await this.load()
    return structuredClone(provenance)
  }

  /** Deterministic manifest hash, usable as an ingestion idempotency key. */
  async getManifestHash(): Promise<string> {
    return (await this.load()).hash
  }

  /** Validated envelope, exposed for callers that need declaration-level detail. */
  async getEnvelope(): Promise<ManifestEnvelope> {
    return structuredClone((await this.load()).envelope)
  }

  private async load(): Promise<AcceptedSnapshot> {
    if (this.cache !== undefined) return this.cache

    const generation = this.generation
    if (this.inFlight?.generation === generation) return this.inFlight.promise

    const promise = this.loadFresh()
    this.inFlight = { generation, promise }
    try {
      const accepted = await promise
      if (this.generation === generation) {
        this.cache ??= accepted
        return this.cache
      }
      return accepted
    } finally {
      if (this.inFlight?.promise === promise) this.inFlight = undefined
    }
  }

  private async loadFresh(): Promise<AcceptedSnapshot> {
    const raw = await this.readManifest(this.config)
    const scope = {
      tenantId: this.config.tenantId,
      ...(this.config.environmentId !== undefined
        ? { environmentId: this.config.environmentId }
        : {}),
    }
    const result = acceptManifest(raw, scope)
    if (!result.ok)
      throw new ManifestValidationError(
        `Manifest rejected: ${describeErrors(result.errors)}`,
        result.errors,
      )

    const { envelope } = result.accepted
    return { ...normalizeManifest(envelope, scope), envelope }
  }

  /** Drop the cached manifest so the next call re-reads and re-validates it. */
  reset(): void {
    this.generation += 1
    this.cache = undefined
    this.inFlight = undefined
  }
}
