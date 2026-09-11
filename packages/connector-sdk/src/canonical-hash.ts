import { createHash } from 'node:crypto'

import type { EstateSnapshot } from '@agent-sentinel/domain'

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function computeCanonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

export function computeSnapshotEvidenceDigest(snapshot: Pick<EstateSnapshot, 'evidence'>): string {
  return computeCanonicalSha256(snapshot.evidence)
}
