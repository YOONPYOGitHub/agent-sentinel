export { ManifestConnector, MANIFEST_CONNECTOR_ID } from './manifest-connector.js'

export {
  FORBIDDEN_PATH_FRAGMENTS,
  manifestConnectorConfigSchema,
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
} from './manifest-schema.js'
export type { ManifestConnectorConfig } from './manifest-schema.js'

export {
  assertSafeManifestPath,
  loadManifestFile,
  ManifestFileLoadError,
  MAX_MANIFEST_BYTES,
} from './file-loader.js'

export {
  acceptManifest,
  ManifestValidationError,
  parseManifestConnectorConfig,
  readConfiguredManifest,
} from './validator.js'
export type { AcceptedManifest, ManifestAcceptanceResult } from './validator.js'

export {
  ADAPTER_SOURCE_ID,
  effectiveEvidence,
  mergeManifestSnapshots,
  normalizeManifest,
} from './normalizer.js'
export type {
  EffectiveEvidence,
  NormalizedManifest,
  NormalizeManifestOptions,
} from './normalizer.js'
