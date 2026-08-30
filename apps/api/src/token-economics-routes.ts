import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import type {
  EstateSnapshot,
  TokenEconomicsAttribution,
  TokenEconomicsReport,
} from '@agent-sentinel/domain'
import { tokenEconomicsAttributionSchema, tokenEconomicsReportSchema } from '@agent-sentinel/domain'
import { analyzeTokenEconomics } from '@agent-sentinel/behavior-engine'
import { computeBaseline } from '@agent-sentinel/behavior-engine'
import { MOCK_TOKEN_ECONOMICS_WINDOWS } from '@agent-sentinel/mock-connector'
import {
  runtimeObservationWindowsSchema,
  withoutSyntheticObservations,
  type RuntimeTelemetryRequest,
  type RuntimeTelemetryConnector,
} from '@agent-sentinel/connector-sdk'

export interface TokenEconomicsRoutesOptions {
  mode: 'mock' | 'foundry'
  defaultTenantId: string
  runtimeTelemetryConnector?: RuntimeTelemetryConnector
  resolveTelemetryRequest?: (agentId: string) => Promise<RuntimeTelemetryRequest | undefined>
  resolveAttribution?: (agentId: string) => Promise<TokenEconomicsAttribution | undefined>
}

function unavailableReportId(agentId: string): string {
  return 'te-unavail-' + createHash('sha256').update(agentId).digest('hex').slice(0, 12)
}

function unknownAttribution(
  reason: Extract<TokenEconomicsAttribution['reason'], string>,
): TokenEconomicsAttribution {
  return tokenEconomicsAttributionSchema.parse({ status: 'unknown', reason })
}

async function resolvedAttribution(
  opts: TokenEconomicsRoutesOptions,
  agentId: string,
): Promise<TokenEconomicsAttribution> {
  if (opts.resolveAttribution === undefined) return unknownAttribution('resolver-not-configured')
  try {
    const attribution = await opts.resolveAttribution(agentId)
    return attribution === undefined
      ? unknownAttribution('agent-not-found')
      : tokenEconomicsAttributionSchema.parse(attribution)
  } catch {
    return unknownAttribution('source-resolution-failed')
  }
}

export function tokenEconomicsAttributionForAgent(
  snapshot: EstateSnapshot | null | undefined,
  agentId: string,
): TokenEconomicsAttribution {
  if (snapshot === undefined || snapshot === null)
    return unknownAttribution('source-snapshot-unavailable')
  const agent = snapshot.nodes.find((node) => node.kind === 'agent' && node.id === agentId)
  if (agent === undefined) return unknownAttribution('agent-not-found')
  if (
    agent.metadata['sourceOfTruth'] === 'false' ||
    agent.metadata['isNonAuthoritative'] === 'true'
  ) {
    return unknownAttribution('non-authoritative-agent')
  }
  const evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
  const evidenceIds = agent.evidenceIds.filter(
    (id) => evidenceById.get(id)?.evidenceTypes.includes('declared_configuration') === true,
  )
  if (evidenceIds.length === 0) return unknownAttribution('source-evidence-unavailable')

  const owner = agent.owner?.trim()
  const businessUnit = agent.metadata['businessUnit']?.trim()
  if (!owner && !businessUnit) return unknownAttribution('source-values-unavailable')
  const value = (entry: string) => ({ value: entry, evidenceIds })
  return tokenEconomicsAttributionSchema.parse({
    status: owner && businessUnit ? 'sourced' : 'partial',
    ...(owner ? { owner: value(owner) } : {}),
    ...(businessUnit ? { businessUnit: value(businessUnit) } : {}),
    ...(!owner || !businessUnit ? { reason: 'source-value-unavailable' as const } : {}),
  })
}

function attachAttribution(
  report: TokenEconomicsReport,
  attribution: TokenEconomicsAttribution,
): TokenEconomicsReport {
  return tokenEconomicsReportSchema.parse({ ...report, attribution })
}

/**
 * GET /api/token-economics/agents/:agentId
 *
 * Mock mode  - runs the deterministic token-economics engine on synthetic
 *              measured observations. Response carries source: 'mock-synthetic'.
 *              Known agents return a 'ready' report.
 *              Unknown agents return 'insufficient-data', not invented success.
 *
 * Foundry mode - runs on injected Azure Monitor OTel windows. Missing or
 *                failed providers return typed unknown. Never falls back to
 *                synthetic data.
 *
 * There is no POST/ingestion endpoint on this route family.
 */
export function registerTokenEconomicsRoutes(
  app: FastifyInstance,
  opts: TokenEconomicsRoutesOptions,
): void {
  app.get<{ Params: { agentId: string } }>(
    '/api/token-economics/agents/:agentId',
    async (request, reply) => {
      const { agentId } = request.params
      const tenantId = opts.defaultTenantId
      const attribution = await resolvedAttribution(opts, agentId)

      if (opts.mode === 'foundry') {
        if (opts.runtimeTelemetryConnector !== undefined) {
          try {
            const resolvedRequest = await opts.resolveTelemetryRequest?.(agentId)
            if (opts.resolveTelemetryRequest !== undefined && resolvedRequest === undefined) {
              const now = new Date().toISOString()
              const result: TokenEconomicsReport = tokenEconomicsReportSchema.parse({
                reportId: unavailableReportId(agentId),
                tenantId,
                agentId,
                environment: 'unknown',
                source: 'azure-monitor-otel',
                windowStart: new Date(0).toISOString(),
                windowEnd: now,
                computedAt: now,
                status: 'unavailable',
                unavailableReason:
                  'No exact runtime telemetry source binding exists for this discovered agent.',
              })
              return reply.status(200).send(attachAttribution(result, attribution))
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
              const result = analyzeTokenEconomics(windows.observed, baselineResult.baseline, {
                clock: () => new Date(windows.queriedAt),
                observedEvidenceId: windows.observedEvidenceId,
              })
              return reply.status(200).send(attachAttribution(result, attribution))
            }
            const result: TokenEconomicsReport = tokenEconomicsReportSchema.parse({
              reportId: unavailableReportId(agentId),
              tenantId,
              agentId,
              environment: windows.observed.environment,
              source: 'azure-monitor-otel',
              windowStart: windows.observed.windowStart,
              windowEnd: windows.observed.windowEnd,
              computedAt: windows.queriedAt,
              status:
                baselineResult.error === 'insufficient-data' ? 'insufficient-data' : 'unavailable',
              unavailableReason: baselineResult.reason,
            })
            return reply.status(200).send(attachAttribution(result, attribution))
          } catch {
            const now = new Date().toISOString()
            const result: TokenEconomicsReport = tokenEconomicsReportSchema.parse({
              reportId: unavailableReportId(agentId),
              tenantId,
              agentId,
              environment: 'unknown',
              source: 'azure-monitor-otel',
              windowStart: new Date(0).toISOString(),
              windowEnd: now,
              computedAt: now,
              status: 'unavailable',
              unavailableReason:
                'Runtime telemetry provider query failed or returned data that did not satisfy the connector contract.',
            })
            return reply.status(200).send(attachAttribution(result, attribution))
          }
        }

        const result: TokenEconomicsReport = tokenEconomicsReportSchema.parse({
          reportId: unavailableReportId(agentId),
          tenantId,
          agentId,
          environment: 'unknown',
          source: 'azure-monitor-otel',
          windowStart: new Date(0).toISOString(),
          windowEnd: new Date().toISOString(),
          computedAt: new Date().toISOString(),
          status: 'connector-not-connected',
          unavailableReason:
            'Runtime telemetry connector is not configured. ' +
            'Connect the azure-monitor-otel connector to unlock token economics analysis.',
        })
        return reply.status(200).send(attachAttribution(result, attribution))
      }

      // Mock mode
      const windows = MOCK_TOKEN_ECONOMICS_WINDOWS[agentId]
      if (windows === undefined) {
        const result: TokenEconomicsReport = tokenEconomicsReportSchema.parse({
          reportId: unavailableReportId(agentId),
          tenantId,
          agentId,
          environment: 'demo',
          source: 'mock-synthetic',
          windowStart: new Date(0).toISOString(),
          windowEnd: new Date().toISOString(),
          computedAt: new Date().toISOString(),
          status: 'insufficient-data',
          unavailableReason: 'No synthetic observation windows are defined for this agent.',
        })
        return reply.status(200).send(attachAttribution(result, attribution))
      }

      const report = analyzeTokenEconomics(windows.observed, windows.baseline, {
        clock: windows.clock,
        observedEvidenceId: windows.observedEvidenceId,
      })
      return reply.status(200).send(attachAttribution(report, attribution))
    },
  )
}
