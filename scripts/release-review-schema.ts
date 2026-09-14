import { createHash } from 'node:crypto'

import { z } from 'zod'

import { oneRaiHarms } from './onerai-safety-report.js'
import {
  assertReleaseEvidenceContainsNoSensitiveContent,
  buildReleaseEvidence,
  canonicalJson,
  releaseEvidenceInputSchema,
  releaseEvidenceManifestSchema,
  type ReleaseEvidenceManifest,
  type RepositoryState,
} from './release-evidence-schema.js'

export const RELEASE_REVIEW_BUNDLE_SCHEMA_VERSION = '2.0.0' as const
export const RELEASE_REVIEW_WORKFLOW_MODE = 'dry-run-no-submit' as const

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/)
const timestampSchema = z.iso.datetime({ offset: true })
const idSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/)
const oneRaiEvaluationRefSchema = z.string().regex(/^onerai-sha256:[a-f0-9]{64}$/)
const textSchema = z.string().trim().min(1).max(500)
function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
function isLexicallySorted(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || lexicalCompare(values[index - 1]!, value) <= 0,
  )
}
const evidenceRefsSchema = z
  .array(idSchema)
  .max(30)
  .superRefine((values, context) => {
    const seen = new Set<string>()
    values.forEach((value, index) => {
      if (seen.has(value)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'evidence references must be unique',
        })
      }
      seen.add(value)
    })
  })

const evidenceIndexSchema = z
  .array(
    z.strictObject({
      id: idSchema,
      kind: z.enum([
        'command-result',
        'accessibility',
        'onerai-safety',
        'security-review',
        'threat-control',
        'demo-readiness',
        'deployment',
        'live-validation',
        'configuration',
        'decision',
        'known-issue',
      ]),
      label: z.string().trim().min(1).max(120),
    }),
  )
  .max(150)
  .superRefine((items, context) => {
    const seen = new Set<string>()
    items.forEach((item, index) => {
      if (seen.has(item.id))
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'evidence ids must be unique',
        })
      seen.add(item.id)
    })
  })

function addUniqueIdIssues(
  items: readonly { id: string }[],
  context: z.RefinementCtx,
  label: string,
): void {
  const seen = new Set<string>()
  items.forEach((item, index) => {
    if (seen.has(item.id))
      context.addIssue({
        code: 'custom',
        path: [index, 'id'],
        message: `${label} ids must be unique`,
      })
    seen.add(item.id)
  })
}

const checkReferenceInputSchema = z.strictObject({
  lint: evidenceRefsSchema.default([]),
  typecheck: evidenceRefsSchema.default([]),
  test: evidenceRefsSchema.default([]),
  build: evidenceRefsSchema.default([]),
  playwright: evidenceRefsSchema.default([]),
  bicep: evidenceRefsSchema.default([]),
})

const findingSchema = z
  .strictObject({
    id: idSchema,
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    status: z.enum(['open', 'mitigated']),
    summary: textSchema,
    evidenceRefs: evidenceRefsSchema,
  })
  .superRefine((value, context) => {
    if (value.status === 'mitigated' && value.evidenceRefs.length === 0)
      context.addIssue({
        code: 'custom',
        path: ['evidenceRefs'],
        message: 'mitigated findings require evidence references',
      })
  })

const findingsSchema = z
  .array(findingSchema)
  .max(100)
  .superRefine((items, context) => addUniqueIdIssues(items, context, 'security finding'))

const securityReviewSchema = z
  .strictObject({
    outcome: z.enum(['pass', 'fail', 'blocked']),
    reviewedAt: timestampSchema.nullable(),
    evidenceRefs: evidenceRefsSchema,
    findings: findingsSchema,
    summary: textSchema,
  })
  .superRefine((value, context) => {
    if (
      value.outcome !== 'blocked' &&
      (value.reviewedAt === null || value.evidenceRefs.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'evaluated security review requires reviewedAt and evidence references',
      })
    }
    if (value.outcome === 'pass' && value.findings.some((finding) => finding.status === 'open')) {
      context.addIssue({
        code: 'custom',
        message: 'passing security review cannot have open findings',
      })
    }
  })

const securityReviewInputSchema = z.strictObject({
  outcome: z.enum(['pass', 'fail', 'blocked']),
  reviewedAt: timestampSchema.nullable().default(null),
  evidenceRefs: evidenceRefsSchema.default([]),
  findings: findingsSchema.default([]),
  summary: textSchema,
})

const accessibilityIssueSchema = z
  .strictObject({
    ruleId: idSchema,
    impact: z.enum(['critical', 'serious', 'moderate', 'minor', 'unknown']),
    wcagCriteria: z.array(z.string().regex(/^wcag[0-9a-z]+$/)).max(20),
    affectedNodes: z.number().int().min(1).max(10_000),
    summary: textSchema,
  })
  .superRefine((value, context) => {
    if (new Set(value.wcagCriteria).size !== value.wcagCriteria.length)
      context.addIssue({
        code: 'custom',
        path: ['wcagCriteria'],
        message: 'WCAG criteria must be unique',
      })
  })

const accessibilitySurfaceSchema = z
  .strictObject({
    surfaceId: idSchema,
    outcome: z.enum(['pass', 'fail']),
    counts: z.strictObject({
      critical: z.number().int().min(0),
      serious: z.number().int().min(0),
      moderate: z.number().int().min(0),
      minor: z.number().int().min(0),
      unknown: z.number().int().min(0),
    }),
    unresolved: z.array(accessibilityIssueSchema).max(500),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>()
    value.unresolved.forEach((issue, index) => {
      if (seen.has(issue.ruleId))
        context.addIssue({
          code: 'custom',
          path: ['unresolved', index, 'ruleId'],
          message: 'accessibility rule ids must be unique per surface',
        })
      seen.add(issue.ruleId)
    })
  })

export const accessibilityEvidenceSchema = z
  .strictObject({
    outcome: z.enum(['pass', 'fail', 'blocked']),
    artifactSupplied: z.boolean(),
    tool: z.enum(['axe-core', 'playwright-axe', 'other-sanitized']).nullable(),
    observedAt: timestampSchema.nullable(),
    evidenceRefs: evidenceRefsSchema,
    surfaces: z.array(accessibilitySurfaceSchema).max(100),
    summary: textSchema,
  })
  .superRefine((value, context) => {
    const surfaceIds = new Set<string>()
    value.surfaces.forEach((surface, index) => {
      if (surfaceIds.has(surface.surfaceId))
        context.addIssue({
          code: 'custom',
          path: ['surfaces', index, 'surfaceId'],
          message: 'accessibility surface ids must be unique',
        })
      surfaceIds.add(surface.surfaceId)
      const count = Object.values(surface.counts).reduce((total, item) => total + item, 0)
      if (count !== surface.unresolved.length)
        context.addIssue({
          code: 'custom',
          path: ['surfaces', index, 'counts'],
          message: 'counts must equal unresolved issues',
        })
      if ((surface.outcome === 'pass') !== (surface.unresolved.length === 0))
        context.addIssue({
          code: 'custom',
          path: ['surfaces', index, 'outcome'],
          message: 'surface outcome must match unresolved issues',
        })
      surface.unresolved.forEach((issue, issueIndex) => {
        if (!isLexicallySorted(issue.wcagCriteria))
          context.addIssue({
            code: 'custom',
            path: ['surfaces', index, 'unresolved', issueIndex, 'wcagCriteria'],
            message: 'WCAG criteria must use canonical lexical order',
          })
      })
      if (
        canonicalJson(surface.unresolved) !==
        canonicalJson(
          [...surface.unresolved].sort(
            (left, right) =>
              lexicalCompare(left.ruleId, right.ruleId) ||
              lexicalCompare(left.impact, right.impact),
          ),
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['surfaces', index, 'unresolved'],
          message: 'accessibility issues must use canonical rule order',
        })
    })
    if (!isLexicallySorted(value.evidenceRefs))
      context.addIssue({
        code: 'custom',
        path: ['evidenceRefs'],
        message: 'accessibility evidence references must use canonical lexical order',
      })
    if (!isLexicallySorted(value.surfaces.map((surface) => surface.surfaceId)))
      context.addIssue({
        code: 'custom',
        path: ['surfaces'],
        message: 'accessibility surfaces must use canonical lexical order',
      })
    if (
      !value.artifactSupplied &&
      (value.outcome !== 'blocked' ||
        value.tool !== null ||
        value.observedAt !== null ||
        value.evidenceRefs.length !== 0 ||
        value.surfaces.length !== 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'missing accessibility artifacts must remain blocked and unattributed',
      })
    }
    if (value.artifactSupplied && (value.tool === null || value.evidenceRefs.length === 0)) {
      context.addIssue({
        code: 'custom',
        message: 'supplied accessibility artifacts require a tool and evidence reference',
      })
    }
    const expectedOutcome =
      !value.artifactSupplied || value.observedAt === null || value.surfaces.length === 0
        ? 'blocked'
        : value.surfaces.some((surface) => surface.outcome === 'fail')
          ? 'fail'
          : 'pass'
    if (value.outcome !== expectedOutcome)
      context.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'accessibility outcome must be derived from the normalized artifact',
      })
    if (
      value.outcome !== 'blocked' &&
      (!value.artifactSupplied ||
        value.tool === null ||
        value.observedAt === null ||
        value.evidenceRefs.length === 0 ||
        value.surfaces.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'evaluated accessibility evidence requires a dated artifact, tool, references, and surfaces',
      })
    }
    if (value.outcome === 'pass' && value.surfaces.some((surface) => surface.outcome !== 'pass')) {
      context.addIssue({
        code: 'custom',
        message: 'passing accessibility evidence requires every surface to pass',
      })
    }
  })

const oneRaiScenarioSchema = z
  .strictObject({
    scenarioId: idSchema,
    harm: z.enum(oneRaiHarms),
    outcome: z.enum(['pass', 'fail', 'blocked']),
    trials: z.number().int().min(1).max(100),
    defects: z.number().int().min(0).max(100),
    evidenceRefs: evidenceRefsSchema.min(1),
  })
  .superRefine((value, context) => {
    if (value.defects > value.trials)
      context.addIssue({ code: 'custom', message: 'defects cannot exceed trials' })
    if (value.outcome === 'pass' && value.defects !== 0)
      context.addIssue({ code: 'custom', message: 'passing scenario cannot contain defects' })
    if (value.outcome === 'fail' && value.defects === 0)
      context.addIssue({ code: 'custom', message: 'failing scenario must contain a defect' })
    if (value.outcome === 'blocked' && value.defects !== 0)
      context.addIssue({
        code: 'custom',
        message: 'blocked scenario cannot claim evaluated defects',
      })
  })

const oneRaiSafetyInputSchema = z
  .strictObject({
    classification: z.enum(['live', 'synthetic', 'tested']),
    observedAt: timestampSchema,
    deterministic: z.literal(true),
    scenarioResults: z.array(oneRaiScenarioSchema).min(1).max(300),
    evidenceRefs: evidenceRefsSchema.min(1),
    summary: textSchema,
  })
  .superRefine((value, context) => {
    const seen = new Set<string>()
    value.scenarioResults.forEach((scenario, index) => {
      if (seen.has(scenario.scenarioId)) {
        context.addIssue({
          code: 'custom',
          path: ['scenarioResults', index, 'scenarioId'],
          message: 'OneRAI scenario ids must be unique',
        })
      }
      seen.add(scenario.scenarioId)
    })
  })

function deriveOneRaiOutcome(
  scenarioResults: readonly z.infer<typeof oneRaiScenarioSchema>[],
): 'pass' | 'fail' | 'blocked' {
  if (scenarioResults.some((item) => item.outcome === 'fail' || item.defects > 0)) return 'fail'
  const harms = new Set(scenarioResults.map((item) => item.harm))
  if (
    scenarioResults.some((item) => item.outcome === 'blocked') ||
    oneRaiHarms.some((harm) => !harms.has(harm))
  )
    return 'blocked'
  return 'pass'
}

const oneRaiSafetySchema = z
  .strictObject({
    outcome: z.enum(['pass', 'fail', 'blocked']),
    evaluationRef: oneRaiEvaluationRefSchema.nullable(),
    classification: z.enum(['live', 'synthetic', 'tested', 'blocked']),
    observedAt: timestampSchema.nullable(),
    deterministic: z.boolean(),
    scenarioResults: z.array(oneRaiScenarioSchema).max(300),
    scenarioIds: z.array(idSchema).max(300),
    harms: z.array(z.enum(oneRaiHarms)).max(oneRaiHarms.length),
    evidenceRefs: evidenceRefsSchema,
    humanReviewRequired: z.literal(true),
    summary: textSchema,
  })
  .superRefine((value, context) => {
    const scenarioIds = new Set<string>()
    value.scenarioResults.forEach((scenario, index) => {
      if (scenarioIds.has(scenario.scenarioId)) {
        context.addIssue({
          code: 'custom',
          path: ['scenarioResults', index, 'scenarioId'],
          message: 'OneRAI scenario ids must be unique',
        })
      }
      scenarioIds.add(scenario.scenarioId)
    })
    if (value.outcome === 'blocked' && value.classification === 'blocked') {
      if (
        value.evaluationRef !== null ||
        value.observedAt !== null ||
        value.deterministic ||
        value.scenarioResults.length !== 0 ||
        value.scenarioIds.length !== 0 ||
        value.harms.length !== 0 ||
        value.evidenceRefs.length !== 0
      ) {
        context.addIssue({
          code: 'custom',
          message: 'missing OneRAI safety evidence must remain blocked and unattributed',
        })
      }
      return
    }
    if (value.classification === 'blocked') {
      context.addIssue({
        code: 'custom',
        path: ['classification'],
        message: 'blocked classification is reserved for missing OneRAI evidence',
      })
    }
    if (
      value.evaluationRef === null ||
      value.observedAt === null ||
      !value.deterministic ||
      value.scenarioResults.length === 0 ||
      value.evidenceRefs.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'evaluated OneRAI safety evidence requires deterministic dated references and scenarios',
      })
    }
    if (
      value.outcome === 'pass' &&
      value.scenarioResults.some(
        (scenario) => scenario.outcome !== 'pass' || scenario.defects !== 0,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'passing OneRAI safety evidence cannot contain defects or non-passing scenarios',
      })
    }
    if (value.outcome === 'pass' && oneRaiHarms.some((harm) => !value.harms.includes(harm))) {
      context.addIssue({
        code: 'custom',
        message: 'passing OneRAI safety evidence must cover every configured harm',
      })
    }
    if (value.outcome !== deriveOneRaiOutcome(value.scenarioResults))
      context.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'OneRAI outcome must be derived from deterministic scenario results',
      })
  })

export const THREAT_CONTROL_CATALOG = [
  { threatId: 'spoofing', controlId: 'authentication' },
  { threatId: 'tampering', controlId: 'edge-waf' },
  { threatId: 'denial-of-service', controlId: 'resource-bounds' },
  { threatId: 'elevation-of-privilege', controlId: 'managed-identity' },
  { threatId: 'cross-tenant-correlation', controlId: 'tenant-isolation' },
  { threatId: 'unsafe-ai-output', controlId: 'write-gates' },
  { threatId: 'repudiation', controlId: 'evidence-provenance' },
  { threatId: 'information-disclosure', controlId: 'pii-secret-redaction' },
  { threatId: 'tampering', controlId: 'supply-chain' },
] as const

const threatIdSchema = z.enum([
  'spoofing',
  'tampering',
  'repudiation',
  'information-disclosure',
  'denial-of-service',
  'elevation-of-privilege',
  'cross-tenant-correlation',
  'unsafe-ai-output',
])
const controlIdSchema = z.enum(THREAT_CONTROL_CATALOG.map((entry) => entry.controlId))
const threatControlSchema = z.strictObject({
  threatId: threatIdSchema,
  controlId: controlIdSchema,
  state: z.enum(['implemented', 'partial', 'missing', 'unknown']),
  evidenceRefs: evidenceRefsSchema,
  summary: textSchema,
})
const threatControlsInputSchema = z
  .array(threatControlSchema)
  .max(THREAT_CONTROL_CATALOG.length)
  .superRefine((items, context) => {
    const seen = new Set<string>()
    items.forEach((item, index) => {
      if (seen.has(item.controlId))
        context.addIssue({
          code: 'custom',
          path: [index, 'controlId'],
          message: 'threat control ids must be unique',
        })
      seen.add(item.controlId)
      const expected = THREAT_CONTROL_CATALOG.find((entry) => entry.controlId === item.controlId)
      if (expected?.threatId !== item.threatId)
        context.addIssue({
          code: 'custom',
          path: [index, 'threatId'],
          message: 'threat and control must match the versioned catalog',
        })
    })
  })

const demoReadinessSchema = z.strictObject({
  outcome: z.enum(['pass', 'fail', 'blocked', 'unknown']),
  evidenceRefs: evidenceRefsSchema,
  summary: textSchema,
})

const blockerSchema = z
  .strictObject({
    id: idSchema,
    category: z.enum([
      'security',
      'accessibility',
      'onerai',
      'connector',
      'live-validation',
      'demo-readiness',
      'deployment',
      'quality',
      'human-decision',
      'known-issue',
    ]),
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    status: z.enum(['open', 'mitigated']),
    summary: textSchema,
    evidenceRefs: evidenceRefsSchema,
  })
  .superRefine((value, context) => {
    if (value.status === 'mitigated' && value.evidenceRefs.length === 0)
      context.addIssue({
        code: 'custom',
        path: ['evidenceRefs'],
        message: 'mitigated blockers and known issues require evidence references',
      })
  })
const blockersSchema = z
  .array(blockerSchema)
  .max(100)
  .superRefine((items, context) => addUniqueIdIssues(items, context, 'blocker'))

const decisionSchema = z
  .strictObject({
    status: z.enum(['pending', 'approved', 'rejected']),
    decidedAt: timestampSchema.nullable(),
    decisionRef: idSchema.nullable(),
    summary: textSchema,
  })
  .superRefine((value, context) => {
    if (value.status !== 'pending' && (value.decidedAt === null || value.decisionRef === null))
      context.addIssue({
        code: 'custom',
        message: 'completed decisions require decidedAt and decisionRef',
      })
    if (value.status === 'pending' && (value.decidedAt !== null || value.decisionRef !== null))
      context.addIssue({
        code: 'custom',
        message: 'pending decisions cannot include decision evidence',
      })
  })

const decisionInputSchema = z.strictObject({
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  decidedAt: timestampSchema.nullable().default(null),
  decisionRef: idSchema.nullable().default(null),
  summary: textSchema,
})

export const releaseReviewInputSchema = z
  .strictObject({
    releaseEvidence: releaseEvidenceInputSchema.optional(),
    evidenceIndex: evidenceIndexSchema.default([]),
    checkEvidenceRefs: checkReferenceInputSchema.optional(),
    securityReview: securityReviewInputSchema.optional(),
    oneRaiSafety: oneRaiSafetyInputSchema.optional(),
    threatControls: threatControlsInputSchema.optional(),
    demoReadiness: demoReadinessSchema.optional(),
    knownIssues: blockersSchema.default([]),
    blockers: blockersSchema.default([]),
    humanDecisions: z
      .strictObject({
        security: decisionInputSchema.optional(),
        accessibility: decisionInputSchema.optional(),
        oneRai: decisionInputSchema.optional(),
        release: decisionInputSchema.optional(),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    const knownIssueIds = new Set(value.knownIssues.map((item) => item.id))
    value.blockers.forEach((item, index) => {
      if (knownIssueIds.has(item.id))
        context.addIssue({
          code: 'custom',
          path: ['blockers', index, 'id'],
          message: 'known issue and blocker ids must not overlap',
        })
    })
  })

const qualityCheckSchema = z
  .strictObject({
    outcome: z.enum(['pass', 'fail', 'blocked', 'unknown', 'not-run']),
    command: z.string().trim().min(1).max(300).nullable(),
    completedAt: timestampSchema.nullable(),
    evidenceRefs: evidenceRefsSchema,
    summary: textSchema,
  })
  .superRefine((value, context) => {
    if (
      value.outcome === 'pass' &&
      (value.command === null || value.completedAt === null || value.evidenceRefs.length === 0)
    )
      context.addIssue({
        code: 'custom',
        message: 'passing quality checks require command, completion time, and evidence references',
      })
  })
const qualityChecksSchema = z.strictObject({
  lint: qualityCheckSchema,
  typecheck: qualityCheckSchema,
  test: qualityCheckSchema,
  build: qualityCheckSchema,
  playwright: qualityCheckSchema,
  bicep: qualityCheckSchema,
})
const connectorStateSchema = z.strictObject({
  connectorId: z.string().trim().min(1).max(200),
  state: z.enum(['live', 'unknown', 'blocked']),
  evidenceRefs: evidenceRefsSchema,
  summary: textSchema,
})
const gateSchema = z.strictObject({
  status: z.enum(['ready', 'blocked']),
  reasons: z.array(textSchema).max(250),
})
const gateChecksSchema = z.strictObject({
  source: gateSchema,
  quality: gateSchema,
  security: gateSchema,
  accessibility: gateSchema,
  oneRai: gateSchema,
  deployment: gateSchema,
  liveValidation: gateSchema,
  connectors: gateSchema,
  demoReadiness: gateSchema,
  humanDecisions: gateSchema,
  declaredBlockers: gateSchema,
})
const hashSchema = z.strictObject({
  algorithm: z.literal('sha256'),
  scope: z.literal('bundle-excluding-canonicalHash'),
  value: z.string().regex(/^[a-f0-9]{64}$/),
})

const releaseReviewBundleObjectSchema = z.strictObject({
  schemaVersion: z.literal(RELEASE_REVIEW_BUNDLE_SCHEMA_VERSION),
  bundleType: z.literal('sanitized-release-review-evidence'),
  workflow: z.strictObject({
    mode: z.literal(RELEASE_REVIEW_WORKFLOW_MODE),
    externalSubmission: z.literal(false),
    deploymentPerformed: z.literal(false),
  }),
  release: z.strictObject({
    commitSha: shaSchema,
    generatedAt: timestampSchema,
    dirty: z.boolean(),
  }),
  releaseEvidence: releaseEvidenceManifestSchema,
  evidenceIndex: evidenceIndexSchema,
  qualityChecks: qualityChecksSchema,
  securityReview: securityReviewSchema,
  accessibility: accessibilityEvidenceSchema,
  oneRaiSafety: oneRaiSafetySchema,
  threatControls: z.array(threatControlSchema).length(THREAT_CONTROL_CATALOG.length),
  connectors: z.array(connectorStateSchema).max(100),
  demoReadiness: demoReadinessSchema,
  knownIssues: blockersSchema,
  blockers: blockersSchema,
  humanDecisions: z.strictObject({
    security: decisionSchema,
    accessibility: decisionSchema,
    oneRai: decisionSchema,
    release: decisionSchema,
  }),
  gateChecks: gateChecksSchema,
  readinessGate: gateSchema,
  canonicalHash: hashSchema,
})

function allEvidenceReferences(value: z.infer<typeof releaseReviewBundleObjectSchema>): string[] {
  const refs: string[] = []
  Object.values(value.qualityChecks).forEach((check) => refs.push(...check.evidenceRefs))
  refs.push(...value.releaseEvidence.images.deployed.evidenceRefs)
  value.releaseEvidence.liveValidations.forEach((item) => refs.push(...item.evidenceRefs))
  value.releaseEvidence.connectors.forEach((item) => refs.push(...item.evidenceRefs))
  refs.push(
    ...value.releaseEvidence.oneRai.evidenceRefs,
    ...value.securityReview.evidenceRefs,
    ...value.accessibility.evidenceRefs,
    ...value.oneRaiSafety.evidenceRefs,
    ...value.demoReadiness.evidenceRefs,
  )
  value.securityReview.findings.forEach((item) => refs.push(...item.evidenceRefs))
  value.oneRaiSafety.scenarioResults.forEach((item) => refs.push(...item.evidenceRefs))
  value.threatControls.forEach((item) => refs.push(...item.evidenceRefs))
  value.connectors.forEach((item) => refs.push(...item.evidenceRefs))
  value.knownIssues.forEach((item) => refs.push(...item.evidenceRefs))
  value.blockers.forEach((item) => refs.push(...item.evidenceRefs))
  Object.values(value.humanDecisions).forEach((decision) => {
    if (decision.decisionRef !== null) refs.push(decision.decisionRef)
  })
  return refs
}

type GateChecks = z.infer<typeof gateChecksSchema>

function gate(reasons: string[]) {
  return { status: reasons.length === 0 ? ('ready' as const) : ('blocked' as const), reasons }
}
function readinessGate(gates: GateChecks) {
  return gate([...new Set(Object.values(gates).flatMap((item) => item.reasons))])
}

function deriveGateChecks(value: {
  release: { dirty: boolean }
  releaseEvidence: ReleaseEvidenceManifest
  qualityChecks: z.infer<typeof qualityChecksSchema>
  securityReview: z.infer<typeof securityReviewSchema>
  accessibility: AccessibilityEvidence
  oneRaiSafety: z.infer<typeof oneRaiSafetySchema>
  threatControls: z.infer<typeof threatControlSchema>[]
  connectors: z.infer<typeof connectorStateSchema>[]
  demoReadiness: z.infer<typeof demoReadinessSchema>
  blockers: z.infer<typeof blockerSchema>[]
  humanDecisions: Record<
    'security' | 'accessibility' | 'oneRai' | 'release',
    z.infer<typeof decisionSchema>
  >
}): GateChecks {
  const openBlockerReasons = new Map<string, string[]>()
  value.blockers
    .filter((blocker) => blocker.status === 'open')
    .forEach((blocker) => {
      const reasons = openBlockerReasons.get(blocker.category) ?? []
      reasons.push(`Open ${blocker.category} blocker ${blocker.id}.`)
      openBlockerReasons.set(blocker.category, reasons)
    })
  const blockerReasons = (category: string) => openBlockerReasons.get(category) ?? []
  const sourceReasons = value.release.dirty ? ['The release worktree is dirty.'] : []
  const qualityReasons = [
    ...Object.entries(value.qualityChecks)
      .filter(([, check]) => check.outcome !== 'pass' || check.evidenceRefs.length === 0)
      .map(([name]) => `${name} evidence is not passing and complete.`),
    ...blockerReasons('quality'),
  ]
  const securityReasons = [
    ...(value.securityReview.outcome === 'pass'
      ? []
      : ['Security review evidence is not passing.']),
    ...value.threatControls
      .filter((control) => control.state !== 'implemented' || control.evidenceRefs.length === 0)
      .map((control) => `Threat control ${control.controlId} is not fully evidenced.`),
    ...blockerReasons('security'),
  ]
  const accessibilityReasons = [
    ...(value.accessibility.outcome === 'pass' ? [] : ['Accessibility evidence is not passing.']),
    ...blockerReasons('accessibility'),
  ]
  const oneRaiReasons = [
    ...(value.oneRaiSafety.outcome === 'pass'
      ? []
      : ['Deterministic OneRAI safety evidence is not passing.']),
    ...(value.releaseEvidence.oneRai.outcome === 'pass'
      ? []
      : ['Embedded OneRAI release evidence is not passing.']),
    ...blockerReasons('onerai'),
  ]
  const deployed = value.releaseEvidence.images.deployed
  const deploymentReasons = [
    ...(deployed.classification === 'live' ? [] : ['Live deployment evidence is missing.']),
    ...(value.releaseEvidence.configuration.classification === 'tested'
      ? []
      : ['Allow-listed configuration hash evidence is missing.']),
    ...blockerReasons('deployment'),
  ]
  const liveValidationReasons = [
    ...(value.releaseEvidence.liveValidations.length > 0 &&
    value.releaseEvidence.liveValidations.every(
      (item) =>
        item.classification === 'live' && item.outcome === 'pass' && item.freshness === 'fresh',
    )
      ? []
      : ['Fresh passing live-validation evidence is missing or incomplete.']),
    ...blockerReasons('live-validation'),
  ]
  const connectorReasons = [
    ...(value.connectors.length > 0 &&
    value.connectors.every((connector) => connector.state === 'live')
      ? []
      : ['Every required connector must have live ready evidence.']),
    ...blockerReasons('connector'),
  ]
  const demoReasons = [
    ...(value.demoReadiness.outcome === 'pass' && value.demoReadiness.evidenceRefs.length > 0
      ? []
      : ['Demo Readiness evidence is not passing and complete.']),
    ...blockerReasons('demo-readiness'),
  ]
  const decisionReasons = [
    ...Object.entries(value.humanDecisions)
      .filter(([, decision]) => decision.status !== 'approved')
      .map(([name, decision]) => `${name} human decision is ${decision.status}.`),
    ...blockerReasons('human-decision'),
  ]
  const declaredBlockerReasons = value.blockers
    .filter((blocker) => blocker.status === 'open')
    .map((blocker) => `Open ${blocker.category} blocker ${blocker.id}.`)
  return {
    source: gate(sourceReasons),
    quality: gate(qualityReasons),
    security: gate(securityReasons),
    accessibility: gate(accessibilityReasons),
    oneRai: gate(oneRaiReasons),
    deployment: gate(deploymentReasons),
    liveValidation: gate(liveValidationReasons),
    connectors: gate(connectorReasons),
    demoReadiness: gate(demoReasons),
    humanDecisions: gate(decisionReasons),
    declaredBlockers: gate(declaredBlockerReasons),
  }
}

export const releaseReviewBundleSchema = releaseReviewBundleObjectSchema.superRefine(
  (value, context) => {
    const requireCanonicalOrder = (
      values: readonly string[],
      path: (string | number)[],
      label: string,
    ) => {
      if (!isLexicallySorted(values))
        context.addIssue({
          code: 'custom',
          path,
          message: `${label} must use canonical lexical order`,
        })
    }
    requireCanonicalOrder(
      value.evidenceIndex.map((item) => item.id),
      ['evidenceIndex'],
      'evidence index',
    )
    Object.entries(value.qualityChecks).forEach(([name, check]) =>
      requireCanonicalOrder(check.evidenceRefs, ['qualityChecks', name, 'evidenceRefs'], name),
    )
    requireCanonicalOrder(
      value.securityReview.evidenceRefs,
      ['securityReview', 'evidenceRefs'],
      'security review references',
    )
    requireCanonicalOrder(
      value.securityReview.findings.map((item) => item.id),
      ['securityReview', 'findings'],
      'security findings',
    )
    value.securityReview.findings.forEach((item, index) =>
      requireCanonicalOrder(
        item.evidenceRefs,
        ['securityReview', 'findings', index, 'evidenceRefs'],
        'security finding references',
      ),
    )
    requireCanonicalOrder(
      value.oneRaiSafety.evidenceRefs,
      ['oneRaiSafety', 'evidenceRefs'],
      'OneRAI references',
    )
    requireCanonicalOrder(
      value.oneRaiSafety.scenarioResults.map((item) => item.scenarioId),
      ['oneRaiSafety', 'scenarioResults'],
      'OneRAI scenarios',
    )
    value.oneRaiSafety.scenarioResults.forEach((item, index) =>
      requireCanonicalOrder(
        item.evidenceRefs,
        ['oneRaiSafety', 'scenarioResults', index, 'evidenceRefs'],
        'OneRAI scenario references',
      ),
    )
    value.threatControls.forEach((item, index) =>
      requireCanonicalOrder(
        item.evidenceRefs,
        ['threatControls', index, 'evidenceRefs'],
        'threat-control references',
      ),
    )
    requireCanonicalOrder(
      value.demoReadiness.evidenceRefs,
      ['demoReadiness', 'evidenceRefs'],
      'Demo Readiness references',
    )
    for (const [name, items] of [
      ['knownIssues', value.knownIssues],
      ['blockers', value.blockers],
    ] as const) {
      requireCanonicalOrder(
        items.map((item) => item.id),
        [name],
        name === 'knownIssues' ? 'known issues' : 'blockers',
      )
      items.forEach((item, index) =>
        requireCanonicalOrder(
          item.evidenceRefs,
          [name, index, 'evidenceRefs'],
          `${name} references`,
        ),
      )
    }
    const knownIssueIds = new Set(value.knownIssues.map((item) => item.id))
    value.blockers.forEach((item, index) => {
      if (knownIssueIds.has(item.id))
        context.addIssue({
          code: 'custom',
          path: ['blockers', index, 'id'],
          message: 'known issue and blocker ids must not overlap',
        })
    })
    if (value.release.commitSha !== value.releaseEvidence.release.commitSha)
      context.addIssue({
        code: 'custom',
        path: ['releaseEvidence', 'release', 'commitSha'],
        message: 'embedded release evidence SHA must match bundle SHA',
      })
    if (value.release.generatedAt !== value.releaseEvidence.release.generatedAt)
      context.addIssue({
        code: 'custom',
        path: ['releaseEvidence', 'release', 'generatedAt'],
        message: 'embedded release evidence timestamp must match bundle timestamp',
      })
    if (value.release.dirty !== value.releaseEvidence.release.dirty)
      context.addIssue({
        code: 'custom',
        path: ['releaseEvidence', 'release', 'dirty'],
        message: 'embedded release evidence dirty state must match bundle state',
      })
    const ids = new Set(value.evidenceIndex.map((item) => item.id))
    const evidenceKinds = new Map(value.evidenceIndex.map((item) => [item.id, item.kind]))
    allEvidenceReferences(value).forEach((reference) => {
      if (!ids.has(reference))
        context.addIssue({
          code: 'custom',
          path: ['evidenceIndex'],
          message: `evidence reference ${reference} is not declared`,
        })
    })
    const requireEvidenceKind = (
      references: readonly string[],
      kind: z.infer<typeof evidenceIndexSchema>[number]['kind'],
      path: (string | number)[],
    ) => {
      references.forEach((reference) => {
        const actual = evidenceKinds.get(reference)
        if (actual !== undefined && actual !== kind)
          context.addIssue({
            code: 'custom',
            path,
            message: `evidence reference ${reference} must use kind ${kind}`,
          })
      })
    }
    Object.entries(value.qualityChecks).forEach(([name, check]) =>
      requireEvidenceKind(check.evidenceRefs, 'command-result', ['qualityChecks', name]),
    )
    requireEvidenceKind(value.releaseEvidence.images.deployed.evidenceRefs, 'deployment', [
      'releaseEvidence',
      'images',
      'deployed',
    ])
    value.releaseEvidence.liveValidations.forEach((item, index) =>
      requireEvidenceKind(item.evidenceRefs, 'live-validation', [
        'releaseEvidence',
        'liveValidations',
        index,
      ]),
    )
    requireEvidenceKind(value.releaseEvidence.oneRai.evidenceRefs, 'onerai-safety', [
      'releaseEvidence',
      'oneRai',
    ])
    requireEvidenceKind(value.securityReview.evidenceRefs, 'security-review', ['securityReview'])
    value.securityReview.findings.forEach((item, index) =>
      requireEvidenceKind(item.evidenceRefs, 'security-review', [
        'securityReview',
        'findings',
        index,
      ]),
    )
    requireEvidenceKind(value.accessibility.evidenceRefs, 'accessibility', ['accessibility'])
    requireEvidenceKind(value.oneRaiSafety.evidenceRefs, 'onerai-safety', ['oneRaiSafety'])
    value.oneRaiSafety.scenarioResults.forEach((item, index) =>
      requireEvidenceKind(item.evidenceRefs, 'onerai-safety', [
        'oneRaiSafety',
        'scenarioResults',
        index,
      ]),
    )
    value.threatControls.forEach((item, index) =>
      requireEvidenceKind(item.evidenceRefs, 'threat-control', ['threatControls', index]),
    )
    requireEvidenceKind(value.demoReadiness.evidenceRefs, 'demo-readiness', ['demoReadiness'])
    value.knownIssues.forEach((item, index) =>
      requireEvidenceKind(item.evidenceRefs, 'known-issue', ['knownIssues', index]),
    )
    Object.entries(value.humanDecisions).forEach(([name, decision]) => {
      if (decision.decisionRef !== null)
        requireEvidenceKind([decision.decisionRef], 'decision', ['humanDecisions', name])
    })
    THREAT_CONTROL_CATALOG.forEach((expected, index) => {
      const actual = value.threatControls[index]
      if (actual?.threatId !== expected.threatId || actual.controlId !== expected.controlId)
        context.addIssue({
          code: 'custom',
          path: ['threatControls', index],
          message: 'threat controls must match the versioned catalog order and mapping',
        })
    })
    if (value.oneRaiSafety.outcome === 'pass') {
      const embedded = value.releaseEvidence.oneRai
      const trials = value.oneRaiSafety.scenarioResults.reduce(
        (total, item) => total + item.trials,
        0,
      )
      const defects = value.oneRaiSafety.scenarioResults.reduce(
        (total, item) => total + item.defects,
        0,
      )
      if (embedded.outcome !== 'pass' || embedded.cases !== trials || embedded.defects !== defects)
        context.addIssue({
          code: 'custom',
          path: ['oneRaiSafety'],
          message: 'passing OneRAI evidence must match the embedded release summary',
        })
    }
    if (value.oneRaiSafety.evaluationRef !== null && value.oneRaiSafety.observedAt !== null) {
      const expectedReference = deterministicOneRaiEvaluationRef({
        classification: value.oneRaiSafety.classification,
        observedAt: value.oneRaiSafety.observedAt,
        deterministic: value.oneRaiSafety.deterministic,
        scenarioResults: value.oneRaiSafety.scenarioResults,
      })
      if (value.oneRaiSafety.evaluationRef !== expectedReference)
        context.addIssue({
          code: 'custom',
          path: ['oneRaiSafety', 'evaluationRef'],
          message: 'OneRAI evaluation reference does not match deterministic scenario content',
        })
    }
    const scenarioIds = [...value.oneRaiSafety.scenarioResults.map((item) => item.scenarioId)].sort(
      lexicalCompare,
    )
    if (canonicalJson(value.oneRaiSafety.scenarioIds) !== canonicalJson(scenarioIds))
      context.addIssue({
        code: 'custom',
        path: ['oneRaiSafety', 'scenarioIds'],
        message: 'OneRAI scenario ids must be complete and sorted',
      })
    const harms = [...new Set(value.oneRaiSafety.scenarioResults.map((item) => item.harm))].sort(
      lexicalCompare,
    )
    if (canonicalJson(value.oneRaiSafety.harms) !== canonicalJson(harms))
      context.addIssue({
        code: 'custom',
        path: ['oneRaiSafety', 'harms'],
        message: 'OneRAI harms must be complete and sorted',
      })
    const expectedQualityChecks = buildQualityChecks(
      value.releaseEvidence,
      Object.fromEntries(
        Object.entries(value.qualityChecks).map(([name, check]) => [name, check.evidenceRefs]),
      ) as z.infer<typeof checkReferenceInputSchema>,
    )
    if (canonicalJson(value.qualityChecks) !== canonicalJson(expectedQualityChecks))
      context.addIssue({
        code: 'custom',
        path: ['qualityChecks'],
        message: 'quality checks must match embedded release evidence',
      })
    if (canonicalJson(value.connectors) !== canonicalJson(buildConnectors(value.releaseEvidence)))
      context.addIssue({
        code: 'custom',
        path: ['connectors'],
        message: 'connector gates must match embedded release evidence',
      })
    const expectedGateChecks = deriveGateChecks(value)
    if (canonicalJson(value.gateChecks) !== canonicalJson(expectedGateChecks))
      context.addIssue({
        code: 'custom',
        path: ['gateChecks'],
        message: 'gate checks do not match evidence content',
      })
    const expectedReadiness = readinessGate(expectedGateChecks)
    if (canonicalJson(value.readinessGate) !== canonicalJson(expectedReadiness))
      context.addIssue({
        code: 'custom',
        path: ['readinessGate'],
        message: 'readiness gate does not match gate checks',
      })
    if (
      value.humanDecisions.security.status === 'approved' &&
      expectedGateChecks.security.status !== 'ready'
    )
      context.addIssue({
        code: 'custom',
        path: ['humanDecisions', 'security'],
        message: 'Security cannot be approved while its evidence gate is blocked',
      })
    if (
      value.humanDecisions.accessibility.status === 'approved' &&
      expectedGateChecks.accessibility.status !== 'ready'
    )
      context.addIssue({
        code: 'custom',
        path: ['humanDecisions', 'accessibility'],
        message: 'Accessibility cannot be approved while its evidence gate is blocked',
      })
    if (
      value.humanDecisions.oneRai.status === 'approved' &&
      expectedGateChecks.oneRai.status !== 'ready'
    )
      context.addIssue({
        code: 'custom',
        path: ['humanDecisions', 'oneRai'],
        message: 'OneRAI cannot be approved while its evidence gate is blocked',
      })
    if (value.humanDecisions.release.status === 'approved') {
      const prerequisiteGates = Object.entries(expectedGateChecks).filter(
        ([name]) => name !== 'humanDecisions',
      )
      const specialistDecisions = [
        value.humanDecisions.security,
        value.humanDecisions.accessibility,
        value.humanDecisions.oneRai,
      ]
      if (
        prerequisiteGates.some(([, item]) => item.status !== 'ready') ||
        specialistDecisions.some((decision) => decision.status !== 'approved')
      ) {
        context.addIssue({
          code: 'custom',
          path: ['humanDecisions', 'release'],
          message:
            'Release cannot be approved before every evidence gate and specialist decision is ready',
        })
      }
    }
    const generatedAt = Date.parse(value.release.generatedAt)
    ;[
      value.securityReview.reviewedAt,
      value.accessibility.observedAt,
      value.oneRaiSafety.observedAt,
      ...Object.values(value.humanDecisions).map((decision) => decision.decidedAt),
    ].forEach((timestamp, index) => {
      if (timestamp !== null && Date.parse(timestamp) > generatedAt)
        context.addIssue({
          code: 'custom',
          path: ['release'],
          message: `review timestamp ${index} is after generation`,
        })
    })
    const withoutHash = { ...value, canonicalHash: undefined }
    delete (withoutHash as { canonicalHash?: unknown }).canonicalHash
    const expected = createHash('sha256').update(canonicalJson(withoutHash)).digest('hex')
    if (value.canonicalHash.value !== expected)
      context.addIssue({
        code: 'custom',
        path: ['canonicalHash', 'value'],
        message: 'canonical hash does not match bundle content',
      })
  },
)

export type ReleaseReviewBundle = z.infer<typeof releaseReviewBundleSchema>
export type AccessibilityEvidence = z.infer<typeof accessibilityEvidenceSchema>

const privateValuePatterns = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /(?:^|[^A-Za-z0-9])\/(?:home|Users|var|etc|mnt|root|opt|srv|tmp)\//,
  /\b[A-Za-z]:\\(?:Users|Windows|Program Files|ProgramData|Temp)\\/i,
  /\/subscriptions\/[^/\s]+(?:\/|$)/i,
  /\b[A-Za-z0-9-]+\.onmicrosoft\.com\b/i,
  /\b(?:tenant|subscription)(?:[-_ ]?(?:id|identifier))?\s*[:=]\s*["']?[A-Za-z0-9._:-]{6,}/i,
]
const privateFieldPatterns = [
  /^(?:email|mail|upn|userprincipalname)$/,
  /^(?:tenant|subscription)(?:id|identifier)?$/,
  /^(?:raw|rawdata|rawpayload|providerpayload|responsepayload|requestpayload)$/,
  /^(?:absolutepath|filepath|localpath|userpath)$/,
]
function safePath(path: readonly string[]): string {
  if (path.length === 0) return '<root>'
  return path
    .map((segment) => (/^(?:[A-Za-z][A-Za-z0-9_-]*|[0-9]+)$/.test(segment) ? segment : '<field>'))
    .join('.')
}
function inspectPrivateValues(value: unknown, path: readonly string[] = []): void {
  if (typeof value === 'string') {
    if (privateValuePatterns.some((pattern) => pattern.test(value)))
      throw new Error(
        `Release review contains private or identifying content at ${safePath(path)}.`,
      )
    return
  }
  if (Array.isArray(value))
    return value.forEach((item, index) => inspectPrivateValues(item, [...path, String(index)]))
  if (value === null || typeof value !== 'object') return
  Object.entries(value).forEach(([key, child]) => {
    if (privateValuePatterns.some((pattern) => pattern.test(key)))
      throw new Error(
        `Release review contains a private or identifying field at ${safePath(path)}.`,
      )
    const normalized = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()
    if (privateFieldPatterns.some((pattern) => pattern.test(normalized)))
      throw new Error(
        `Release review contains a forbidden identifying field at ${safePath([...path, key])}.`,
      )
    inspectPrivateValues(child, [...path, key])
  })
}
export function assertReleaseReviewContainsNoSensitiveContent(raw: unknown): void {
  inspectPrivateValues(raw)
  try {
    assertReleaseEvidenceContainsNoSensitiveContent(raw)
  } catch {
    throw new Error('Release review contains forbidden or secret-shaped content.')
  }
}

function missingDecision(label: string) {
  return {
    status: 'pending' as const,
    decidedAt: null,
    decisionRef: null,
    summary: `${label} human decision is required and has not been recorded.`,
  }
}
function sortedEvidenceRefs(refs: readonly string[]): string[] {
  return [...refs].sort(lexicalCompare)
}
function sortedBlockers<T extends z.infer<typeof blockerSchema>>(items: readonly T[]): T[] {
  return [...items]
    .map((item) => ({ ...item, evidenceRefs: sortedEvidenceRefs(item.evidenceRefs) }))
    .sort((left, right) => lexicalCompare(left.id, right.id))
}
function buildQualityChecks(
  releaseEvidence: ReleaseEvidenceManifest,
  refs: z.infer<typeof checkReferenceInputSchema> | undefined,
) {
  const references = refs ?? {
    lint: [],
    typecheck: [],
    test: [],
    build: [],
    playwright: [],
    bicep: [],
  }
  const map = {
    lint: 'lint',
    typecheck: 'typecheck',
    test: 'test',
    build: 'build',
    playwright: 'e2e',
    bicep: 'bicep',
  } as const
  return Object.fromEntries(
    Object.entries(map).map(([name, source]) => {
      const check = releaseEvidence.checks[source]
      return [
        name,
        {
          outcome: check.outcome,
          command: check.command,
          completedAt: check.completedAt,
          evidenceRefs: sortedEvidenceRefs(references[name as keyof typeof references]),
          summary: check.summary,
        },
      ]
    }),
  ) as z.infer<typeof qualityChecksSchema>
}
function buildThreatControls(input: z.infer<typeof threatControlSchema>[] | undefined) {
  const byControl = new Map((input ?? []).map((item) => [item.controlId, item]))
  return THREAT_CONTROL_CATALOG.map((expected) => {
    const supplied = byControl.get(expected.controlId)
    return supplied === undefined
      ? {
          ...expected,
          state: 'unknown' as const,
          evidenceRefs: [],
          summary: 'No sanitized threat-control evidence was supplied.',
        }
      : { ...supplied, evidenceRefs: sortedEvidenceRefs(supplied.evidenceRefs) }
  })
}
function buildOneRaiSafety(input: z.infer<typeof oneRaiSafetyInputSchema> | undefined) {
  if (input === undefined)
    return {
      outcome: 'blocked' as const,
      evaluationRef: null,
      classification: 'blocked' as const,
      observedAt: null,
      deterministic: false,
      scenarioResults: [],
      scenarioIds: [],
      harms: [],
      evidenceRefs: [],
      humanReviewRequired: true as const,
      summary: 'No deterministic sanitized OneRAI safety evaluation was supplied.',
    }
  const scenarioResults = input.scenarioResults
    .map((scenario) => ({
      ...scenario,
      evidenceRefs: sortedEvidenceRefs(scenario.evidenceRefs),
    }))
    .sort((left, right) => lexicalCompare(left.scenarioId, right.scenarioId))
  const scenarioIds = scenarioResults.map((item) => item.scenarioId)
  const harms = [...new Set(scenarioResults.map((item) => item.harm))].sort(lexicalCompare)
  const outcome = deriveOneRaiOutcome(scenarioResults)
  const evaluationRef = deterministicOneRaiEvaluationRef({ ...input, scenarioResults })
  return {
    ...input,
    evidenceRefs: sortedEvidenceRefs(input.evidenceRefs),
    outcome,
    evaluationRef,
    scenarioResults,
    scenarioIds,
    harms,
    humanReviewRequired: true as const,
  }
}
function buildConnectors(releaseEvidence: ReleaseEvidenceManifest) {
  return releaseEvidence.connectors
    .map((connector) => ({
      connectorId: connector.connectorId,
      state:
        connector.classification === 'live' && connector.readiness === 'ready'
          ? ('live' as const)
          : connector.classification === 'blocked' || connector.readiness === 'blocked'
            ? ('blocked' as const)
            : ('unknown' as const),
      evidenceRefs: sortedEvidenceRefs(connector.evidenceRefs),
      summary: connector.summary,
    }))
    .sort((left, right) => lexicalCompare(left.connectorId, right.connectorId))
}
export function deterministicOneRaiEvaluationRef(input: {
  classification: 'live' | 'synthetic' | 'tested' | 'blocked'
  observedAt: string
  deterministic: boolean
  scenarioResults: z.infer<typeof oneRaiScenarioSchema>[]
}): string {
  const scenarioResults = [...input.scenarioResults]
    .map((scenario) => ({
      ...scenario,
      evidenceRefs: [...scenario.evidenceRefs].sort(lexicalCompare),
    }))
    .sort((left, right) => lexicalCompare(left.scenarioId, right.scenarioId))
  return `onerai-sha256:${createHash('sha256')
    .update(
      canonicalJson({
        classification: input.classification,
        observedAt: input.observedAt,
        deterministic: input.deterministic,
        scenarioResults,
      }),
    )
    .digest('hex')}`
}

export function buildReleaseReviewBundle(
  repository: RepositoryState,
  rawInput: unknown,
  accessibility: AccessibilityEvidence,
  generatedAt: string,
): ReleaseReviewBundle {
  assertReleaseReviewContainsNoSensitiveContent(rawInput)
  assertReleaseReviewContainsNoSensitiveContent(accessibility)
  const input = releaseReviewInputSchema.parse(rawInput)
  const releaseEvidence = buildReleaseEvidence(repository, input.releaseEvidence ?? {}, generatedAt)
  const qualityChecks = buildQualityChecks(releaseEvidence, input.checkEvidenceRefs)
  const parsedSecurityReview = securityReviewSchema.parse(
    input.securityReview ?? {
      outcome: 'blocked',
      reviewedAt: null,
      evidenceRefs: [],
      findings: [],
      summary: 'No sanitized security review was supplied.',
    },
  )
  const securityReview = {
    ...parsedSecurityReview,
    evidenceRefs: sortedEvidenceRefs(parsedSecurityReview.evidenceRefs),
    findings: [...parsedSecurityReview.findings]
      .map((finding) => ({
        ...finding,
        evidenceRefs: sortedEvidenceRefs(finding.evidenceRefs),
      }))
      .sort((left, right) => lexicalCompare(left.id, right.id)),
  }
  const oneRaiSafety = buildOneRaiSafety(input.oneRaiSafety)
  const threatControls = buildThreatControls(input.threatControls)
  const connectors = buildConnectors(releaseEvidence)
  const blockers = sortedBlockers(input.blockers)
  const knownIssues = sortedBlockers(input.knownIssues)
  const demoReadiness =
    input.demoReadiness === undefined
      ? {
          outcome: 'blocked' as const,
          evidenceRefs: [],
          summary: 'No sanitized Demo Readiness result was supplied.',
        }
      : {
          ...input.demoReadiness,
          evidenceRefs: sortedEvidenceRefs(input.demoReadiness.evidenceRefs),
        }
  const humanDecisions = {
    security: decisionSchema.parse(input.humanDecisions?.security ?? missingDecision('Security')),
    accessibility: decisionSchema.parse(
      input.humanDecisions?.accessibility ?? missingDecision('Accessibility'),
    ),
    oneRai: decisionSchema.parse(input.humanDecisions?.oneRai ?? missingDecision('OneRAI')),
    release: decisionSchema.parse(input.humanDecisions?.release ?? missingDecision('Release')),
  }
  const evidence = {
    release: { commitSha: repository.commitSha, generatedAt, dirty: repository.dirty },
    releaseEvidence,
    qualityChecks,
    securityReview,
    accessibility,
    oneRaiSafety,
    threatControls,
    connectors,
    demoReadiness,
    blockers,
    humanDecisions,
  }
  const gateChecks = deriveGateChecks(evidence)
  const unsigned = {
    schemaVersion: RELEASE_REVIEW_BUNDLE_SCHEMA_VERSION,
    bundleType: 'sanitized-release-review-evidence' as const,
    workflow: {
      mode: RELEASE_REVIEW_WORKFLOW_MODE,
      externalSubmission: false as const,
      deploymentPerformed: false as const,
    },
    ...evidence,
    evidenceIndex: [...input.evidenceIndex].sort((left, right) =>
      lexicalCompare(left.id, right.id),
    ),
    knownIssues,
    readinessGate: readinessGate(gateChecks),
    gateChecks,
  }
  const canonicalHash = {
    algorithm: 'sha256' as const,
    scope: 'bundle-excluding-canonicalHash' as const,
    value: createHash('sha256').update(canonicalJson(unsigned)).digest('hex'),
  }
  const bundle = releaseReviewBundleSchema.parse({ ...unsigned, canonicalHash })
  assertReleaseReviewContainsNoSensitiveContent(bundle)
  return bundle
}

export function generateReleaseReviewInputJsonSchema() {
  return {
    $id: 'https://agent-sentinel.example/schemas/release-review/v2/input.schema.json',
    title: 'Agent Sentinel sanitized release review input',
    description:
      'Strict allow-listed input for an offline exact-SHA release review evidence bundle.',
    ...z.toJSONSchema(releaseReviewInputSchema, { target: 'draft-2020-12', reused: 'ref' }),
  }
}
export function generateReleaseReviewBundleJsonSchema() {
  return {
    $id: 'https://agent-sentinel.example/schemas/release-review/v2/bundle.schema.json',
    title: 'Agent Sentinel sanitized exact-SHA release review bundle',
    description:
      'Strict versioned release gate bundle; repository validation also enforces cross-field rules and canonical hash.',
    ...z.toJSONSchema(releaseReviewBundleSchema, { target: 'draft-2020-12', reused: 'ref' }),
  }
}
