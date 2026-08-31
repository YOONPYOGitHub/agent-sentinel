import { z } from 'zod'

import { agentCorrelationSchema, type AgentCorrelation } from './correlation.js'
import { evidenceSchema } from './evidence.js'

export const businessOutcomeUnitSchema = z.enum([
  'count',
  'minutes',
  'hours',
  'percentage-points',
  'score',
])
export type BusinessOutcomeUnit = z.infer<typeof businessOutcomeUnitSchema>

export const outcomeCorrelationSchema = agentCorrelationSchema
export type OutcomeCorrelation = AgentCorrelation

export const businessOutcomeObservationSchema = z.strictObject({
  id: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200),
  agentId: z.string().min(1).max(200),
  environment: z.string().min(1).max(200),
  source: z.string().min(1).max(200),
  sourceObjectId: z.string().min(1).max(200),
  observedAt: z.iso.datetime(),
  outcomeName: z.string().trim().min(1).max(200),
  value: z.number().finite(),
  unit: businessOutcomeUnitSchema,
  correlation: outcomeCorrelationSchema,
  evidenceId: z.string().min(1).max(200),
  confidence: z.number().min(0).max(1),
  freshness: z.enum(['live', 'recent', 'stale']),
  synthetic: z.boolean().default(false),
})
export type BusinessOutcomeObservation = z.infer<typeof businessOutcomeObservationSchema>

export const businessOutcomeEvidenceBundleSchema = z
  .strictObject({
    observations: z.array(businessOutcomeObservationSchema).max(1000),
    evidence: z.array(evidenceSchema).max(1000),
    queriedAt: z.iso.datetime(),
  })
  .superRefine((bundle, context) => {
    const evidenceIds = new Set(bundle.evidence.map((item) => item.id))
    const evidenceById = new Map(bundle.evidence.map((item) => [item.id, item]))
    if (evidenceIds.size !== bundle.evidence.length) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'Business outcome evidence IDs must be unique.',
      })
    }
    const observationIds = new Set<string>()
    for (const [index, observation] of bundle.observations.entries()) {
      if (!evidenceIds.has(observation.evidenceId)) {
        context.addIssue({
          code: 'custom',
          path: ['observations', index, 'evidenceId'],
          message: `Business outcome observation references unknown evidence ${observation.evidenceId}.`,
        })
      }
      const citedEvidence = evidenceById.get(observation.evidenceId)
      const requiredType = observation.synthetic ? 'synthetic_validation' : 'observed_runtime'
      if (citedEvidence !== undefined && !citedEvidence.evidenceTypes.includes(requiredType)) {
        context.addIssue({
          code: 'custom',
          path: ['observations', index, 'evidenceId'],
          message: `Business outcome evidence must include ${requiredType}.`,
        })
      }
      if (
        citedEvidence !== undefined &&
        (citedEvidence.source !== observation.source ||
          citedEvidence.sourceObjectId !== observation.sourceObjectId ||
          citedEvidence.observedAt !== observation.observedAt ||
          citedEvidence.confidence !== observation.confidence ||
          citedEvidence.freshness !== observation.freshness)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['observations', index, 'evidenceId'],
          message: 'Business outcome observation does not match its cited evidence object.',
        })
      }
      if (observationIds.has(observation.id)) {
        context.addIssue({
          code: 'custom',
          path: ['observations', index, 'id'],
          message: `Duplicate business outcome observation id: ${observation.id}.`,
        })
      }
      observationIds.add(observation.id)
    }
  })
export type BusinessOutcomeEvidenceBundle = z.infer<typeof businessOutcomeEvidenceBundleSchema>

export const businessValueClaimSchema = businessOutcomeObservationSchema.pick({
  id: true,
  outcomeName: true,
  value: true,
  unit: true,
  source: true,
  sourceObjectId: true,
  observedAt: true,
  correlation: true,
  evidenceId: true,
  confidence: true,
  freshness: true,
  synthetic: true,
})
export type BusinessValueClaim = z.infer<typeof businessValueClaimSchema>

export const businessValueAssessmentSchema = z
  .strictObject({
    assessmentId: z.string().min(1).max(200),
    tenantId: z.string().min(1).max(200),
    agentId: z.string().min(1).max(200),
    environment: z.string().min(1).max(200),
    status: z.enum(['sourced', 'unknown']),
    reason: z
      .enum([
        'no-outcome-source-configured',
        'no-outcome-observations',
        'outcome-binding-unavailable',
        'outcome-source-failed',
        'outcome-contract-invalid',
      ])
      .optional(),
    computedAt: z.iso.datetime(),
    sourcesChecked: z.array(z.string().min(1).max(200)).max(50),
    claims: z.array(businessValueClaimSchema).max(1000),
    evidence: z.array(evidenceSchema).max(1000),
  })
  .superRefine((assessment, context) => {
    if (assessment.status === 'sourced' && assessment.claims.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['claims'],
        message: 'A sourced business-value assessment requires at least one outcome claim.',
      })
    }
    if (assessment.status === 'sourced' && assessment.reason !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'A sourced business-value assessment must not include an unavailable reason.',
      })
    }
    if (
      assessment.status === 'unknown' &&
      (assessment.reason === undefined ||
        assessment.claims.length > 0 ||
        assessment.evidence.length > 0)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'An unknown business-value assessment requires a reason and must not contain claims or evidence.',
      })
    }
    const evidenceIds = new Set(assessment.evidence.map((item) => item.id))
    const evidenceById = new Map(assessment.evidence.map((item) => [item.id, item]))
    for (const [index, claim] of assessment.claims.entries()) {
      if (!evidenceIds.has(claim.evidenceId)) {
        context.addIssue({
          code: 'custom',
          path: ['claims', index, 'evidenceId'],
          message: `Business value claim references unknown evidence ${claim.evidenceId}.`,
        })
      }
      const citedEvidence = evidenceById.get(claim.evidenceId)
      if (
        citedEvidence !== undefined &&
        (citedEvidence.source !== claim.source ||
          citedEvidence.sourceObjectId !== claim.sourceObjectId ||
          citedEvidence.observedAt !== claim.observedAt ||
          citedEvidence.confidence !== claim.confidence ||
          citedEvidence.freshness !== claim.freshness)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['claims', index, 'evidenceId'],
          message: 'Business value claim does not match its cited evidence object.',
        })
      }
    }
  })
export type BusinessValueAssessment = z.infer<typeof businessValueAssessmentSchema>
