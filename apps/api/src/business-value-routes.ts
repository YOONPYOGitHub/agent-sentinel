import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import type {
  BusinessOutcomeConnector,
  BusinessOutcomeRequest,
} from '@agent-sentinel/connector-sdk'
import {
  businessOutcomeEvidenceBundleSchema,
  businessValueAssessmentSchema,
  type BusinessValueAssessment,
} from '@agent-sentinel/domain'

export interface BusinessValueRoutesOptions {
  mode: 'mock' | 'foundry'
  defaultTenantId: string
  connector?: BusinessOutcomeConnector
  resolveRequest?: (agentId: string) => Promise<BusinessOutcomeRequest | undefined>
}

function assessmentId(agentId: string, computedAt: string): string {
  return `business-value-${createHash('sha256')
    .update(`${agentId}\0${computedAt}`)
    .digest('hex')
    .slice(0, 16)}`
}

function unknownAssessment(
  opts: BusinessValueRoutesOptions,
  agentId: string,
  reason: NonNullable<BusinessValueAssessment['reason']>,
  computedAt = new Date().toISOString(),
  environment = 'unknown',
): BusinessValueAssessment {
  return businessValueAssessmentSchema.parse({
    assessmentId: assessmentId(agentId, computedAt),
    tenantId: opts.defaultTenantId,
    agentId,
    environment,
    status: 'unknown',
    reason,
    computedAt,
    sourcesChecked: opts.connector === undefined ? [] : [opts.connector.id],
    claims: [],
    evidence: [],
  })
}

export function registerBusinessValueRoutes(
  app: FastifyInstance,
  opts: BusinessValueRoutesOptions,
): void {
  app.get<{ Params: { agentId: string } }>(
    '/api/business-value/agents/:agentId',
    async (request, reply) => {
      const { agentId } = request.params
      if (agentId.length > 200) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: 'agentId must be at most 200 characters.',
        })
      }
      if (opts.connector === undefined) {
        return reply
          .status(200)
          .send(unknownAssessment(opts, agentId, 'no-outcome-source-configured'))
      }
      let outcomeRequest: BusinessOutcomeRequest | undefined
      try {
        outcomeRequest = await opts.resolveRequest?.(agentId)
      } catch {
        return reply
          .status(200)
          .send(unknownAssessment(opts, agentId, 'outcome-binding-unavailable'))
      }
      if (opts.resolveRequest !== undefined && outcomeRequest === undefined) {
        return reply.status(200).send(unknownAssessment(opts, agentId, 'no-outcome-observations'))
      }
      const boundRequest = outcomeRequest ?? {
        tenantId: opts.defaultTenantId,
        agentId,
        environment: 'unknown',
        acceptedCorrelations: [],
      }
      if (boundRequest.acceptedCorrelations.length === 0) {
        return reply
          .status(200)
          .send(
            unknownAssessment(
              opts,
              agentId,
              'no-outcome-observations',
              undefined,
              boundRequest.environment,
            ),
          )
      }
      let rawBundle: unknown
      try {
        rawBundle = await opts.connector.readBusinessOutcomes(boundRequest)
      } catch {
        return reply
          .status(200)
          .send(
            unknownAssessment(
              opts,
              agentId,
              'outcome-source-failed',
              undefined,
              boundRequest.environment,
            ),
          )
      }
      const parsedBundle = businessOutcomeEvidenceBundleSchema.safeParse(rawBundle)
      if (!parsedBundle.success) {
        return reply
          .status(200)
          .send(
            unknownAssessment(
              opts,
              agentId,
              'outcome-contract-invalid',
              undefined,
              boundRequest.environment,
            ),
          )
      }
      const bundle = parsedBundle.data
      if (
        bundle.observations.some(
          (observation) =>
            observation.tenantId !== boundRequest.tenantId ||
            observation.agentId !== boundRequest.agentId ||
            observation.environment !== boundRequest.environment ||
            !boundRequest.acceptedCorrelations.some(
              (correlation) =>
                correlation.kind === observation.correlation.kind &&
                correlation.value === observation.correlation.value,
            ) ||
            (opts.mode === 'foundry' && observation.synthetic),
        )
      ) {
        return reply
          .status(200)
          .send(
            unknownAssessment(
              opts,
              agentId,
              'outcome-contract-invalid',
              bundle.queriedAt,
              boundRequest.environment,
            ),
          )
      }
      if (bundle.observations.length === 0) {
        return reply
          .status(200)
          .send(
            unknownAssessment(
              opts,
              agentId,
              'no-outcome-observations',
              bundle.queriedAt,
              boundRequest.environment,
            ),
          )
      }
      return reply.status(200).send(
        businessValueAssessmentSchema.parse({
          assessmentId: assessmentId(agentId, bundle.queriedAt),
          tenantId: boundRequest.tenantId,
          agentId,
          environment: boundRequest.environment,
          status: 'sourced',
          computedAt: bundle.queriedAt,
          sourcesChecked: [opts.connector.id],
          claims: bundle.observations
            .map((observation) => ({
              id: observation.id,
              outcomeName: observation.outcomeName,
              value: observation.value,
              unit: observation.unit,
              source: observation.source,
              sourceObjectId: observation.sourceObjectId,
              observedAt: observation.observedAt,
              correlation: observation.correlation,
              evidenceId: observation.evidenceId,
              confidence: observation.confidence,
              freshness: observation.freshness,
              synthetic: observation.synthetic,
            }))
            .sort(
              (left, right) =>
                right.observedAt.localeCompare(left.observedAt) || left.id.localeCompare(right.id),
            ),
          evidence: bundle.evidence,
        }),
      )
    },
  )
}
