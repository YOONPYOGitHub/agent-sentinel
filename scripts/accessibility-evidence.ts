import { readFile } from 'node:fs/promises'

import {
  assertReleaseReviewContainsNoSensitiveContent,
  accessibilityEvidenceSchema,
  type AccessibilityEvidence,
} from './release-review-schema.js'
import { isDuplicateJsonKeyError, parseJsonRejectingDuplicateKeys } from './strict-json.js'

interface AxeViolation {
  id?: unknown
  impact?: unknown
  tags?: unknown
  nodes?: unknown
  affectedNodes?: unknown
}
interface AxeSurface {
  surfaceId?: unknown
  surface?: unknown
  name?: unknown
  title?: unknown
  url?: unknown
  violations?: unknown
  timestamp?: unknown
  observedAt?: unknown
  generatedAt?: unknown
}

const rootKeys = new Set([
  'tool',
  'observedAt',
  'timestamp',
  'generatedAt',
  'results',
  'testResults',
  'surfaces',
])
const surfaceKeys = new Set([
  'surfaceId',
  'surface',
  'name',
  'title',
  'url',
  'violations',
  'timestamp',
  'observedAt',
  'generatedAt',
])
const violationKeys = new Set(['id', 'impact', 'tags', 'nodes', 'affectedNodes'])

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error(`${label} contains fields outside the sanitized allow-list.`)
}
function validateViolation(value: unknown): asserts value is AxeViolation {
  const item = record(value)
  if (item === undefined) throw new Error('Accessibility violations must be JSON objects.')
  assertAllowedKeys(item, violationKeys, 'Accessibility violation')
  if (typeof item.id !== 'string' || item.id.trim() === '')
    throw new Error('Accessibility violations require a non-empty rule id.')
  if (
    item.impact !== undefined &&
    !['critical', 'serious', 'moderate', 'minor', null].includes(item.impact as string | null)
  )
    throw new Error('Accessibility violation impact is not supported.')
  if (
    item.tags !== undefined &&
    (!Array.isArray(item.tags) ||
      item.tags.length > 20 ||
      item.tags.some((tag) => typeof tag !== 'string'))
  )
    throw new Error('Accessibility violation tags must be a bounded string array.')
  if (item.nodes !== undefined) {
    if (
      !Array.isArray(item.nodes) ||
      item.nodes.length === 0 ||
      item.nodes.length > 10_000 ||
      item.nodes.some((node) => {
        const nodeRecord = record(node)
        return nodeRecord === undefined || Object.keys(nodeRecord).length !== 0
      })
    )
      throw new Error('Accessibility nodes must be sanitized empty placeholders.')
  }
  if (
    item.affectedNodes !== undefined &&
    (!Number.isInteger(item.affectedNodes) ||
      (item.affectedNodes as number) < 1 ||
      (item.affectedNodes as number) > 10_000)
  )
    throw new Error('Accessibility affectedNodes must be an integer from 1 through 10000.')
  if ((item.nodes === undefined) === (item.affectedNodes === undefined))
    throw new Error('Accessibility violations require exactly one sanitized node count source.')
}
function validateSurface(
  value: unknown,
  allowed: ReadonlySet<string> = surfaceKeys,
): asserts value is AxeSurface {
  const item = record(value)
  if (item === undefined) throw new Error('Accessibility surfaces must be JSON objects.')
  assertAllowedKeys(item, allowed, 'Accessibility surface')
  const identifiers = [item.surfaceId, item.surface, item.name, item.title, item.url]
  if (!identifiers.some((candidate) => typeof candidate === 'string' && candidate.trim() !== ''))
    throw new Error('Accessibility surfaces require a sanitized surface identifier.')
  if (identifiers.some((candidate) => candidate !== undefined && typeof candidate !== 'string'))
    throw new Error('Accessibility surface identifiers must be strings.')
  for (const timestamp of [item.timestamp, item.observedAt, item.generatedAt]) {
    if (timestamp !== undefined && typeof timestamp !== 'string')
      throw new Error('Accessibility observation timestamps must be strings.')
  }
  if (!Array.isArray(item.violations))
    throw new Error('Accessibility surfaces require an explicit violations array.')
  if (item.violations.length > 500)
    throw new Error('Accessibility surfaces may contain at most 500 violations.')
  item.violations.forEach(validateViolation)
}
function validatedSurfaces(raw: unknown): AxeSurface[] {
  if (Array.isArray(raw)) {
    if (raw.length > 100)
      throw new Error('Accessibility artifacts may contain at most 100 surfaces.')
    raw.forEach((surface) => validateSurface(surface))
    return raw as AxeSurface[]
  }
  const root = record(raw)
  if (root === undefined) throw new Error('Accessibility artifact must be a JSON object or array.')
  const collectionKeys = ['results', 'testResults', 'surfaces'].filter(
    (key) => root[key] !== undefined,
  )
  if (collectionKeys.length > 1)
    throw new Error('Accessibility artifact must use exactly one supported surface collection.')
  if (collectionKeys.length === 0) {
    validateSurface(root, new Set([...rootKeys, ...surfaceKeys]))
    return [root]
  }
  assertAllowedKeys(root, rootKeys, 'Accessibility artifact')
  for (const timestamp of [root.timestamp, root.observedAt, root.generatedAt]) {
    if (timestamp !== undefined && typeof timestamp !== 'string')
      throw new Error('Accessibility observation timestamps must be strings.')
  }
  const collection = root[collectionKeys[0] as string]
  if (!Array.isArray(collection))
    throw new Error('Accessibility surface collection must be an array.')
  if (collection.length > 100)
    throw new Error('Accessibility artifacts may contain at most 100 surfaces.')
  collection.forEach((surface) => validateSurface(surface))
  return collection as AxeSurface[]
}
function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
  return normalized.slice(0, 100) || 'surface'
}
function surfaceId(value: AxeSurface): string {
  for (const candidate of [value.surfaceId, value.surface, value.name, value.title]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return slug(candidate)
  }
  if (typeof value.url === 'string') {
    try {
      const parsed = new URL(value.url)
      return slug(parsed.pathname === '/' ? 'root' : parsed.pathname)
    } catch {
      return slug(value.url)
    }
  }
  throw new Error('Accessibility surfaces require a sanitized surface identifier.')
}
function impact(value: unknown): 'critical' | 'serious' | 'moderate' | 'minor' | 'unknown' {
  return value === 'critical' || value === 'serious' || value === 'moderate' || value === 'minor'
    ? value
    : 'unknown'
}
function artifactTimestamp(
  raw: unknown,
  normalized: AxeSurface[],
  override?: string,
): string | null {
  const root =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  const timestamps = [
    root.observedAt,
    root.timestamp,
    root.generatedAt,
    ...normalized.flatMap((item) => [item.observedAt, item.timestamp, item.generatedAt]),
  ].filter((candidate): candidate is string => typeof candidate === 'string')
  const unique = [...new Set(timestamps)]
  if (unique.length > 1)
    throw new Error('Accessibility artifact contains conflicting observation timestamps.')
  if (override !== undefined && unique[0] !== undefined && override !== unique[0])
    throw new Error('Accessibility timestamp override conflicts with the artifact timestamp.')
  return override ?? unique[0] ?? null
}
function artifactTool(raw: unknown): 'axe-core' | 'playwright-axe' | 'other-sanitized' {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const candidate = (raw as Record<string, unknown>).tool
    if (
      candidate === 'axe-core' ||
      candidate === 'playwright-axe' ||
      candidate === 'other-sanitized'
    )
      return candidate
    if (candidate !== undefined) throw new Error('Accessibility tool is not supported.')
  }
  return 'axe-core'
}

export function normalizeAccessibilityArtifact(
  raw: unknown,
  evidenceRef: string,
  observedAtOverride?: string,
): AccessibilityEvidence {
  assertReleaseReviewContainsNoSensitiveContent(raw)
  const rawSurfaces = validatedSurfaces(raw)
  const normalizedCandidates = rawSurfaces.map((surface) => {
    const violations = surface.violations as AxeViolation[]
    const unresolved = violations
      .map((violation) => {
        const ruleId = slug(violation.id as string)
        const severity = impact(violation.impact)
        const tags = Array.isArray(violation.tags)
          ? violation.tags
              .filter(
                (tag): tag is string => typeof tag === 'string' && /^wcag[0-9a-z]+$/i.test(tag),
              )
              .map((tag) => tag.toLowerCase())
          : []
        const affectedNodes = Array.isArray(violation.nodes)
          ? violation.nodes.length
          : (violation.affectedNodes as number)
        return {
          ruleId,
          impact: severity,
          wcagCriteria: [...new Set(tags)].sort(lexicalCompare),
          affectedNodes,
          summary: `${affectedNodes} node(s) remain affected by ${ruleId}.`,
        }
      })
      .sort((left, right) => {
        const byRule = lexicalCompare(left.ruleId, right.ruleId)
        if (byRule !== 0) return byRule
        return lexicalCompare(left.impact, right.impact)
      })
    const counts = { critical: 0, serious: 0, moderate: 0, minor: 0, unknown: 0 }
    unresolved.forEach((issue) => {
      counts[issue.impact] += 1
    })
    return {
      baseSurfaceId: surfaceId(surface),
      outcome: unresolved.length === 0 ? ('pass' as const) : ('fail' as const),
      counts,
      unresolved,
    }
  })
  normalizedCandidates.sort((left, right) => {
    const byId = lexicalCompare(left.baseSurfaceId, right.baseSurfaceId)
    if (byId !== 0) return byId
    return lexicalCompare(JSON.stringify(left.unresolved), JSON.stringify(right.unresolved))
  })
  const usedSurfaceIds = new Set<string>()
  const normalizedSurfaces = normalizedCandidates.map(({ baseSurfaceId, ...surface }) => {
    const candidate = baseSurfaceId
    let uniqueId = candidate
    let suffix = 2
    while (usedSurfaceIds.has(uniqueId)) {
      uniqueId = `${candidate.slice(0, Math.max(1, 100 - String(suffix).length - 1))}-${suffix}`
      suffix += 1
    }
    usedSurfaceIds.add(uniqueId)
    return {
      surfaceId: uniqueId,
      ...surface,
    }
  })
  const observedAt = artifactTimestamp(raw, rawSurfaces, observedAtOverride)
  const outcome =
    normalizedSurfaces.length === 0 || observedAt === null
      ? ('blocked' as const)
      : normalizedSurfaces.some((surface) => surface.outcome === 'fail')
        ? ('fail' as const)
        : ('pass' as const)
  const evidence = accessibilityEvidenceSchema.parse({
    outcome,
    artifactSupplied: true,
    tool: artifactTool(raw),
    observedAt,
    evidenceRefs: [evidenceRef],
    surfaces: normalizedSurfaces,
    summary:
      normalizedSurfaces.length === 0
        ? 'The supplied accessibility artifact contained no supported surface results.'
        : observedAt === null
          ? 'The accessibility artifact had no sanitized observation timestamp; Accessibility remains blocked.'
          : `${normalizedSurfaces.length} accessibility surface(s) normalized; ${normalizedSurfaces.reduce((total, surface) => total + surface.unresolved.length, 0)} unresolved rule(s).`,
  })
  assertReleaseReviewContainsNoSensitiveContent(evidence)
  return evidence
}

export async function readAccessibilityArtifact(
  path: string,
  evidenceRef: string,
  observedAtOverride?: string,
): Promise<AccessibilityEvidence> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new Error('Could not read the accessibility artifact.')
  }
  let raw: unknown
  try {
    raw = parseJsonRejectingDuplicateKeys(text)
  } catch (error: unknown) {
    if (isDuplicateJsonKeyError(error))
      throw new Error('Accessibility artifact contains duplicate JSON object keys.')
    throw new Error('Accessibility artifact is not valid JSON.')
  }
  assertReleaseReviewContainsNoSensitiveContent(raw)
  return normalizeAccessibilityArtifact(raw, evidenceRef, observedAtOverride)
}

export function missingAccessibilityEvidence(): AccessibilityEvidence {
  return accessibilityEvidenceSchema.parse({
    outcome: 'blocked',
    artifactSupplied: false,
    tool: null,
    observedAt: null,
    evidenceRefs: [],
    surfaces: [],
    summary:
      'No real Playwright or axe-style accessibility artifact was supplied; Accessibility remains blocked.',
  })
}
