import type { EvidenceType } from '@agent-sentinel/domain'

export const evidenceTypeLabels: Record<EvidenceType, string> = {
  declared_configuration: 'Declared configuration',
  observed_runtime: 'Observed runtime',
  synthetic_validation: 'Synthetic validation',
  unknown: 'Legacy or unclassified',
}

export function formatEvidenceTypes(types: readonly EvidenceType[]): string {
  return types.map((type) => evidenceTypeLabels[type]).join(' · ')
}
