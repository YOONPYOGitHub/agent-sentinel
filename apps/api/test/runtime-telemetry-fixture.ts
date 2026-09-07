import { runtimeObservationWindowsSchema } from '@agent-sentinel/connector-sdk'
import type {
  RuntimeObservationWindows,
  RuntimeTelemetryConnector,
  RuntimeTelemetryRequest,
} from '@agent-sentinel/connector-sdk'
import type { ObservationWindow, RuntimeObservation } from '@agent-sentinel/domain'

const QUERIED_AT = '2026-08-24T12:00:00.000Z'

function observations(
  request: RuntimeTelemetryRequest,
  environment: string,
  kind: 'baseline' | 'observed',
): RuntimeObservation[] {
  return Array.from({ length: 10 }, (_, index) => {
    const observedAt =
      kind === 'baseline'
        ? `2026-08-22T${String(index).padStart(2, '0')}:00:00.000Z`
        : `2026-08-24T${String(index).padStart(2, '0')}:00:00.000Z`
    const evidencePrefix = `${kind}-${index}`
    return {
      id: evidencePrefix,
      tenantId: request.tenantId,
      agentId: request.agentId,
      environment,
      source: 'azure-monitor-otel',
      synthetic: false,
      observedAt,
      latencyMs: kind === 'baseline' ? 800 + index : 1_200 + index,
      inputTokens: kind === 'baseline' ? 300 + index : 600 + index,
      outputTokens: kind === 'baseline' ? 100 + index : 180 + index,
      costUsd: kind === 'baseline' ? 0.01 + index / 10_000 : 0.03 + index / 10_000,
      success: kind === 'baseline' || index > 1,
      ...(kind === 'observed' && index <= 1 ? { errorCode: 'timeout' } : {}),
      toolCallNames: kind === 'baseline' ? ['knowledge_search'] : ['knowledge_search', 'answer'],
      otelProvenance: {
        estateId: request.estateId ?? `estate-${request.tenantId}`,
        estateTenantId: request.tenantId,
        estateEnvironment: request.estateEnvironment ?? environment,
        sourceConnectorId: request.sourceConnectorId ?? 'primary',
        sourceTenantId: request.sourceTenantId ?? request.tenantId,
        sourceEnvironment: request.sourceEnvironment ?? environment,
        provider: 'azure-monitor-otel',
        providerResourceId: '/subscriptions/example/resource',
        providerAgentId: request.sourceAgentId ?? request.agentId,
        traceId: `${kind === 'baseline' ? '1' : '2'}${index.toString(16).padStart(31, '0')}`,
        spanId: index.toString(16).padStart(16, '0'),
        observedAt,
        classification: 'live',
        sampling: { state: 'complete', rate: 1 },
        aggregation: { kind: 'raw' },
        partial: false,
        evidenceIds: [
          `${evidencePrefix}-invocation`,
          `${evidencePrefix}-latency`,
          `${evidencePrefix}-error`,
          `${evidencePrefix}-input`,
          `${evidencePrefix}-output`,
          `${evidencePrefix}-cost`,
        ],
      },
    }
  })
}

function window(
  request: RuntimeTelemetryRequest,
  environment: string,
  kind: 'baseline' | 'observed',
): ObservationWindow {
  return {
    windowId: `${kind}-window`,
    tenantId: request.tenantId,
    agentId: request.agentId,
    environment,
    source: 'azure-monitor-otel',
    windowStart: kind === 'baseline' ? '2026-08-21T12:00:00.000Z' : '2026-08-23T12:00:00.000Z',
    windowEnd: kind === 'baseline' ? '2026-08-23T12:00:00.000Z' : '2026-08-24T12:00:00.000Z',
    observations: observations(request, environment, kind),
    otelQuality: {
      status: 'available',
      classification: 'live',
      caveats: [],
      recordsReceived: 60,
      recordsAccepted: 60,
      duplicatesRemoved: 0,
      pagesProcessed: 1,
    },
  }
}

export function createRuntimeTelemetryFixture(
  environment = 'production',
): RuntimeTelemetryConnector {
  return {
    id: 'azure-monitor-otel',
    readObservationWindows(request: RuntimeTelemetryRequest): Promise<RuntimeObservationWindows> {
      return Promise.resolve(
        runtimeObservationWindowsSchema.parse({
          baseline: window(request, environment, 'baseline'),
          observed: window(request, environment, 'observed'),
          baselineEvidenceId: 'otel-baseline-evidence',
          observedEvidenceId: 'otel-observed-evidence',
          queriedAt: QUERIED_AT,
          provenance: {
            estateId: request.estateId ?? `estate-${request.tenantId}`,
            estateTenantId: request.tenantId,
            estateEnvironment: request.estateEnvironment ?? environment,
            sourceConnectorId: request.sourceConnectorId ?? 'primary',
            sourceTenantId: request.sourceTenantId ?? request.tenantId,
            sourceEnvironment: request.sourceEnvironment ?? environment,
            provider: 'azure-monitor-otel',
            providerResourceId: '/subscriptions/example/resource',
            providerAgentId: request.sourceAgentId ?? request.agentId,
          },
        }),
      )
    },
  }
}

export function createFailingRuntimeTelemetryFixture(): RuntimeTelemetryConnector {
  return {
    id: 'azure-monitor-otel',
    readObservationWindows(): Promise<RuntimeObservationWindows> {
      return Promise.reject(new Error('provider details must not escape'))
    },
  }
}

export function createSyntheticCanaryTelemetryFixture(
  environment = 'production',
): RuntimeTelemetryConnector {
  const connector = createRuntimeTelemetryFixture(environment)
  return {
    id: 'azure-monitor-otel',
    async readObservationWindows(request): Promise<RuntimeObservationWindows> {
      const windows = await connector.readObservationWindows(request)
      return runtimeObservationWindowsSchema.parse({
        ...windows,
        baseline: {
          ...windows.baseline,
          observations: windows.baseline.observations.map((observation) => ({
            ...observation,
            synthetic: true,
            otelProvenance:
              observation.otelProvenance === undefined
                ? undefined
                : { ...observation.otelProvenance, classification: 'synthetic' as const },
          })),
        },
        observed: {
          ...windows.observed,
          observations: windows.observed.observations.map((observation) => ({
            ...observation,
            synthetic: true,
            otelProvenance:
              observation.otelProvenance === undefined
                ? undefined
                : { ...observation.otelProvenance, classification: 'synthetic' as const },
          })),
        },
      })
    },
  }
}

export function createMixedRuntimeTelemetryFixture(
  environment = 'production',
): RuntimeTelemetryConnector {
  const connector = createRuntimeTelemetryFixture(environment)
  return {
    id: 'azure-monitor-otel',
    async readObservationWindows(request): Promise<RuntimeObservationWindows> {
      const windows = await connector.readObservationWindows(request)
      const mixedWindow = (source: ObservationWindow): ObservationWindow => ({
        ...source,
        observations: [
          ...source.observations,
          ...source.observations.map((observation, index) => ({
            ...structuredClone(observation),
            id: `${observation.id}-synthetic`,
            synthetic: true,
            otelProvenance: {
              ...observation.otelProvenance!,
              traceId: `f${index.toString(16).padStart(31, '0')}`,
              spanId: `f${index.toString(16).padStart(15, '0')}`,
              classification: 'synthetic' as const,
              evidenceIds: observation.otelProvenance!.evidenceIds.map((id) => `${id}-synthetic`),
            },
          })),
        ],
        otelQuality: {
          status: 'degraded',
          classification: 'mixed',
          caveats: ['mixed-classification'],
          recordsReceived: source.observations.length * 12,
          recordsAccepted: source.observations.length * 12,
          duplicatesRemoved: 0,
          pagesProcessed: 1,
        },
      })
      return runtimeObservationWindowsSchema.parse({
        ...windows,
        baseline: mixedWindow(windows.baseline),
        observed: mixedWindow(windows.observed),
      })
    },
  }
}

export function createSyntheticRuntimeTelemetryFixture(): RuntimeTelemetryConnector {
  const connector = createRuntimeTelemetryFixture()
  return {
    id: 'invalid-synthetic-runtime',
    async readObservationWindows(request): Promise<RuntimeObservationWindows> {
      const windows = await connector.readObservationWindows(request)
      return {
        ...windows,
        baseline: {
          ...windows.baseline,
          source: 'mock-synthetic',
          observations: windows.baseline.observations.map((observation) => ({
            ...observation,
            source: 'mock-synthetic',
            synthetic: true,
          })),
        },
        observed: {
          ...windows.observed,
          source: 'mock-synthetic',
          observations: windows.observed.observations.map((observation) => ({
            ...observation,
            source: 'mock-synthetic',
            synthetic: true,
          })),
        },
      } as unknown as RuntimeObservationWindows
    },
  }
}
