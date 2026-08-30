import type {
  BusinessOutcomeConnector,
  BusinessOutcomeRequest,
} from '@agent-sentinel/connector-sdk'
import {
  businessOutcomeEvidenceBundleSchema,
  type BusinessOutcomeEvidenceBundle,
  type BusinessOutcomeObservation,
} from '@agent-sentinel/domain'

const queriedAt = '2026-08-23T23:59:59.000Z'

const outcomes: Record<
  string,
  Pick<
    BusinessOutcomeObservation,
    'outcomeName' | 'value' | 'unit' | 'sourceObjectId' | 'correlation'
  >
> = {
  'sales-research-agent': {
    outcomeName: 'Accepted account briefs',
    value: 12,
    unit: 'count',
    sourceObjectId: 'synthetic-sales-brief-batch-17',
    correlation: { kind: 'agent-version', value: '17' },
  },
  'hr-policy-agent': {
    outcomeName: 'Resolved policy inquiries',
    value: 18,
    unit: 'count',
    sourceObjectId: 'synthetic-hr-resolution-batch-12',
    correlation: { kind: 'agent-version', value: '12' },
  },
  'code-review-copilot': {
    outcomeName: 'Accepted review suggestions',
    value: 27,
    unit: 'count',
    sourceObjectId: 'synthetic-review-batch-3',
    correlation: { kind: 'agent-version', value: '3' },
  },
}

export class MockBusinessOutcomeConnector implements BusinessOutcomeConnector {
  readonly id = 'mock-business-outcomes'

  readBusinessOutcomes(request: BusinessOutcomeRequest): Promise<BusinessOutcomeEvidenceBundle> {
    const outcome = outcomes[request.agentId]
    const correlationAccepted =
      outcome !== undefined &&
      request.acceptedCorrelations.some(
        (correlation) =>
          correlation.kind === outcome.correlation.kind &&
          correlation.value === outcome.correlation.value,
      )
    if (outcome === undefined || !correlationAccepted) {
      return Promise.resolve(
        businessOutcomeEvidenceBundleSchema.parse({
          observations: [],
          evidence: [],
          queriedAt,
        }),
      )
    }
    const evidenceId = `mock-business-outcome-evidence-${request.agentId}`
    return Promise.resolve(
      businessOutcomeEvidenceBundleSchema.parse({
        queriedAt,
        observations: [
          {
            id: `mock-business-outcome-${request.agentId}`,
            tenantId: request.tenantId,
            agentId: request.agentId,
            environment: request.environment,
            source: 'Synthetic business outcome fixture',
            sourceObjectId: outcome.sourceObjectId,
            observedAt: queriedAt,
            outcomeName: outcome.outcomeName,
            value: outcome.value,
            unit: outcome.unit,
            correlation: outcome.correlation,
            evidenceId,
            confidence: 1,
            freshness: 'recent',
            synthetic: true,
          },
        ],
        evidence: [
          {
            id: evidenceId,
            source: 'Synthetic business outcome fixture',
            sourceObjectId: outcome.sourceObjectId,
            observedAt: queriedAt,
            freshness: 'recent',
            confidence: 1,
            evidenceTypes: ['synthetic_validation'],
            summary: `${outcome.value} ${outcome.unit} for ${outcome.outcomeName}; synthetic demonstration only.`,
          },
        ],
      }),
    )
  }
}
