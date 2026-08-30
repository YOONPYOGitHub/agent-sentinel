import { describe, expect, it } from 'vitest'

import { businessOutcomeEvidenceBundleSchema, businessValueAssessmentSchema } from '../src/index.js'

describe('business value evidence contracts', () => {
  it('accepts a directly sourced outcome claim with exact correlation and cited evidence', () => {
    expect(
      businessValueAssessmentSchema.parse({
        assessmentId: 'business-value-1',
        tenantId: 'tenant-a',
        agentId: 'agent-a',
        environment: 'production',
        status: 'sourced',
        computedAt: '2026-08-31T00:00:00.000Z',
        sourcesChecked: ['business-system'],
        claims: [
          {
            id: 'outcome-1',
            outcomeName: 'Accepted account briefs',
            value: 12,
            unit: 'count',
            source: 'Synthetic CRM outcomes',
            sourceObjectId: 'brief-batch-1',
            observedAt: '2026-08-30T12:00:00.000Z',
            correlation: { kind: 'agent-version', value: 'agent-a:1' },
            evidenceId: 'outcome-evidence-1',
            confidence: 1,
            freshness: 'recent',
            synthetic: true,
          },
        ],
        evidence: [
          {
            id: 'outcome-evidence-1',
            source: 'Synthetic CRM outcomes',
            sourceObjectId: 'brief-batch-1',
            observedAt: '2026-08-30T12:00:00.000Z',
            freshness: 'recent',
            confidence: 1,
            evidenceTypes: ['synthetic_validation'],
            summary: 'Synthetic accepted-account-brief outcome.',
          },
        ],
      }).status,
    ).toBe('sourced')
  })

  it('requires a reason and no success-shaped data when outcome evidence is unknown', () => {
    expect(() =>
      businessValueAssessmentSchema.parse({
        assessmentId: 'business-value-unknown',
        tenantId: 'tenant-a',
        agentId: 'agent-a',
        environment: 'production',
        status: 'unknown',
        computedAt: '2026-08-31T00:00:00.000Z',
        sourcesChecked: [],
        claims: [],
        evidence: [],
      }),
    ).toThrow()
  })

  it('rejects observations whose evidence reference is missing', () => {
    expect(() =>
      businessOutcomeEvidenceBundleSchema.parse({
        queriedAt: '2026-08-31T00:00:00.000Z',
        observations: [
          {
            id: 'outcome-1',
            tenantId: 'tenant-a',
            agentId: 'agent-a',
            environment: 'production',
            source: 'Outcome source',
            sourceObjectId: 'object-1',
            observedAt: '2026-08-30T12:00:00.000Z',
            outcomeName: 'Completed cases',
            value: 3,
            unit: 'count',
            correlation: { kind: 'correlation-id', value: 'correlation-1' },
            evidenceId: 'missing',
            confidence: 1,
            freshness: 'live',
          },
        ],
        evidence: [],
      }),
    ).toThrow('unknown evidence')
  })

  it('requires observed evidence for non-synthetic outcomes', () => {
    expect(() =>
      businessOutcomeEvidenceBundleSchema.parse({
        queriedAt: '2026-08-31T00:00:00.000Z',
        observations: [
          {
            id: 'outcome-1',
            tenantId: 'tenant-a',
            agentId: 'agent-a',
            environment: 'production',
            source: 'Outcome source',
            sourceObjectId: 'object-1',
            observedAt: '2026-08-30T12:00:00.000Z',
            outcomeName: 'Completed cases',
            value: 3,
            unit: 'count',
            correlation: { kind: 'correlation-id', value: 'correlation-1' },
            evidenceId: 'evidence-1',
            confidence: 1,
            freshness: 'live',
            synthetic: false,
          },
        ],
        evidence: [
          {
            id: 'evidence-1',
            source: 'Outcome source',
            sourceObjectId: 'object-1',
            observedAt: '2026-08-30T12:00:00.000Z',
            freshness: 'live',
            confidence: 1,
            evidenceTypes: ['declared_configuration'],
            summary: 'Declared configuration only.',
          },
        ],
      }),
    ).toThrow('observed_runtime')
  })

  it('rejects a claim whose source fields do not match its cited evidence', () => {
    const bundle = {
      queriedAt: '2026-08-31T00:00:00.000Z',
      observations: [
        {
          id: 'outcome-1',
          tenantId: 'tenant-a',
          agentId: 'agent-a',
          environment: 'production',
          source: 'Outcome source A',
          sourceObjectId: 'object-1',
          observedAt: '2026-08-30T12:00:00.000Z',
          outcomeName: 'Completed cases',
          value: 3,
          unit: 'count',
          correlation: { kind: 'correlation-id', value: 'correlation-1' },
          evidenceId: 'evidence-1',
          confidence: 1,
          freshness: 'live',
        },
      ],
      evidence: [
        {
          id: 'evidence-1',
          source: 'Outcome source B',
          sourceObjectId: 'object-1',
          observedAt: '2026-08-30T12:00:00.000Z',
          freshness: 'live',
          confidence: 1,
          evidenceTypes: ['observed_runtime'],
          summary: 'Observed business outcome.',
        },
      ],
    }

    expect(() => businessOutcomeEvidenceBundleSchema.parse(bundle)).toThrow(
      'does not match its cited evidence',
    )
  })

  it('does not accept monetary or invocation-count units', () => {
    const base = {
      id: 'outcome-1',
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      environment: 'production',
      source: 'Outcome source',
      sourceObjectId: 'object-1',
      observedAt: '2026-08-30T12:00:00.000Z',
      outcomeName: 'Business value',
      value: 10,
      correlation: { kind: 'agent-run-id', value: 'run-1' },
      evidenceId: 'evidence-1',
      confidence: 1,
      freshness: 'live',
    }
    for (const unit of ['usd', 'invocations']) {
      expect(() =>
        businessOutcomeEvidenceBundleSchema.parse({
          queriedAt: '2026-08-31T00:00:00.000Z',
          observations: [{ ...base, unit }],
          evidence: [],
        }),
      ).toThrow()
    }
  })
})
