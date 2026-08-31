import { describe, expect, it } from 'vitest'

import {
  outcomeCorrelationSchema,
  runtimeObservationSchema,
  tokenEconomicsCoverageSchema,
} from '../src/index.js'

const observation = {
  id: 'observation-1',
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  environment: 'production',
  source: 'azure-monitor-otel' as const,
  observedAt: '2026-08-31T00:00:00.000Z',
  success: true,
  toolCallNames: [],
  synthetic: false,
}

describe('agent correlation contract', () => {
  it('shares one bounded correlation vocabulary across runtime and outcome evidence', () => {
    const correlations = [
      { kind: 'agent-run-id' as const, value: 'run-1' },
      { kind: 'correlation-id' as const, value: 'correlation-1' },
      { kind: 'agent-version' as const, value: '17' },
    ]

    expect(runtimeObservationSchema.parse({ ...observation, correlations }).correlations).toEqual(
      correlations,
    )
    expect(outcomeCorrelationSchema.parse(correlations[0])).toEqual(correlations[0])
  })

  it('rejects duplicate correlation kinds on one runtime observation', () => {
    expect(
      runtimeObservationSchema.safeParse({
        ...observation,
        correlations: [
          { kind: 'correlation-id', value: 'correlation-1' },
          { kind: 'correlation-id', value: 'correlation-2' },
        ],
      }).success,
    ).toBe(false)
  })

  it('requires exact-correlation coverage to reconcile with the measured population', () => {
    expect(
      tokenEconomicsCoverageSchema.safeParse({
        totalObservations: 10,
        deduplicatedObservations: 10,
        duplicatesRemoved: 0,
        successCount: 10,
        measuredSuccessCount: 10,
        inputTokenMeasuredCount: 10,
        outputTokenMeasuredCount: 10,
        totalTokenMeasuredCount: 10,
        costMeasuredCount: 10,
        costCoverage: 1,
        exactCorrelationCount: 6,
        exactCorrelationCoverage: 0.7,
      }).success,
    ).toBe(false)
  })
})
