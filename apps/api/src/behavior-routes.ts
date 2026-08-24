import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'

import type { DriftAnalysisResult } from '@agent-sentinel/domain'
import { driftAnalysisResultSchema } from '@agent-sentinel/domain'
import { analyzeDrift } from '@agent-sentinel/behavior-engine'
import { MOCK_BEHAVIOR_WINDOWS } from '@agent-sentinel/mock-connector'

export interface BehaviorRoutesOptions {
  /** `'mock'` returns synthetic drift results; `'foundry'` returns unavailable. */
  mode: 'mock' | 'foundry'
  defaultTenantId: string
}

function unavailableAnalysisId(kind: 'unavailable' | 'no-data', agentId: string): string {
  const hash = createHash('sha256').update(agentId).digest('hex').slice(0, 16)
  return `drift-${kind}-${hash}`
}

/**
 * GET /api/behavior/agents/:agentId/drift
 *
 * Mock mode  → runs the deterministic drift engine on synthetic observations.
 *              Response carries `source: 'mock-synthetic'`.
 *
 * Foundry mode → telemetry connector is absent; returns `status: 'invalid'`
 *                with an explicit unavailableReason.
 *                Response carries `source: 'azure-monitor-otel'`.
 *
 * There is no POST/ingestion endpoint on this route family.
 */
export function registerBehaviorRoutes(app: FastifyInstance, opts: BehaviorRoutesOptions): void {
  app.get<{ Params: { agentId: string } }>(
    '/api/behavior/agents/:agentId/drift',
    async (request, reply) => {
      const { agentId } = request.params
      if (agentId.length > 200) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: 'agentId must be at most 200 characters.',
        })
      }
      const tenantId = (request.query as Record<string, string>)['tenantId'] ?? opts.defaultTenantId

      if (opts.mode === 'foundry') {
        // OTel connector is not yet implemented.  Return a typed unavailable
        // response — never substitute synthetic data for the real signal.
        const result: DriftAnalysisResult = driftAnalysisResultSchema.parse({
          analysisId: unavailableAnalysisId('unavailable', agentId),
          tenantId,
          agentId,
          environment: 'unknown',
          source: 'azure-monitor-otel',
          status: 'invalid',
          computedAt: new Date().toISOString(),
          dimensions: [],
          anyDrift: false,
          unavailableReason:
            'Runtime telemetry connector is not connected. ' +
            'Connect the azure-monitor-otel connector to unlock behavior baseline and drift analysis.',
        })
        return reply.status(200).send(result)
      }

      // Mock mode — run the deterministic engine on synthetic observations.
      const windows = MOCK_BEHAVIOR_WINDOWS[agentId]
      if (windows === undefined) {
        const result: DriftAnalysisResult = driftAnalysisResultSchema.parse({
          analysisId: unavailableAnalysisId('no-data', agentId),
          tenantId,
          agentId,
          environment: 'demo',
          source: 'mock-synthetic',
          status: 'insufficient-data',
          computedAt: new Date().toISOString(),
          dimensions: [],
          anyDrift: false,
          unavailableReason: 'No synthetic observation windows are defined for this agent.',
        })
        return reply.status(200).send(result)
      }

      const driftResult = analyzeDrift(windows.baseline, windows.observed, {
        observedEvidenceId: windows.observedEvidenceId,
        clock: () => new Date(windows.observed.windowEnd),
      })

      return reply.status(200).send(driftResult)
    },
  )
}
