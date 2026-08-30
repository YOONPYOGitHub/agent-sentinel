import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'

import type { DriftAnalysisResult } from '@agent-sentinel/domain'
import { driftAnalysisResultSchema } from '@agent-sentinel/domain'
import { analyzeDrift } from '@agent-sentinel/behavior-engine'
import { computeBaseline } from '@agent-sentinel/behavior-engine'
import { MOCK_BEHAVIOR_WINDOWS } from '@agent-sentinel/mock-connector'
import {
  runtimeObservationWindowsSchema,
  withoutSyntheticObservations,
  type RuntimeTelemetryRequest,
  type RuntimeTelemetryConnector,
} from '@agent-sentinel/connector-sdk'

export interface BehaviorRoutesOptions {
  /** `'mock'` returns synthetic drift results; `'foundry'` uses only injected telemetry. */
  mode: 'mock' | 'foundry'
  defaultTenantId: string
  runtimeTelemetryConnector?: RuntimeTelemetryConnector
  resolveTelemetryRequest?: (agentId: string) => Promise<RuntimeTelemetryRequest | undefined>
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
 * Foundry mode → runs on injected Azure Monitor OTel windows. Missing or
 *                failed providers return typed unknown and never synthetic data.
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
      const tenantId = opts.defaultTenantId

      if (opts.mode === 'foundry') {
        if (opts.runtimeTelemetryConnector !== undefined) {
          try {
            const resolvedRequest = await opts.resolveTelemetryRequest?.(agentId)
            if (opts.resolveTelemetryRequest !== undefined && resolvedRequest === undefined) {
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
                  'No exact runtime telemetry source binding exists for this discovered agent.',
              })
              return reply.status(200).send(result)
            }
            const telemetryRequest = resolvedRequest ?? { tenantId, agentId }
            const windows = withoutSyntheticObservations(
              runtimeObservationWindowsSchema.parse(
                await opts.runtimeTelemetryConnector.readObservationWindows({
                  ...telemetryRequest,
                }),
              ),
            )
            if (windows.observed.tenantId !== tenantId || windows.observed.agentId !== agentId) {
              throw new Error('Runtime telemetry response does not match the API request binding.')
            }
            const baselineResult = computeBaseline(windows.baseline, windows.baselineEvidenceId)
            if ('baseline' in baselineResult) {
              const driftResult = analyzeDrift(baselineResult.baseline, windows.observed, {
                observedEvidenceId: windows.observedEvidenceId,
                clock: () => new Date(windows.queriedAt),
              })
              return reply.status(200).send(driftResult)
            }
            const result: DriftAnalysisResult = driftAnalysisResultSchema.parse({
              analysisId: unavailableAnalysisId('unavailable', agentId),
              tenantId,
              agentId,
              environment: windows.observed.environment,
              source: 'azure-monitor-otel',
              status: baselineResult.error,
              computedAt: windows.queriedAt,
              dimensions: [],
              anyDrift: false,
              unavailableReason: baselineResult.reason,
            })
            return reply.status(200).send(result)
          } catch {
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
                'Runtime telemetry provider query failed or returned data that did not satisfy the connector contract.',
            })
            return reply.status(200).send(result)
          }
        }

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
            'Runtime telemetry connector is not configured. ' +
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
