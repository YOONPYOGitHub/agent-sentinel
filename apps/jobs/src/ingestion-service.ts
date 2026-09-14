import { randomUUID } from 'node:crypto'

import type {
  AgentConnector,
  ConnectorHealthReport,
  ConnectorHealthRepository,
  LiveAggregationLimits,
  ManifestIngestionRecord,
  ManifestIngestionRepository,
  RuntimeObservationWindows,
  RuntimeTelemetryConnector,
} from '@agent-sentinel/connector-sdk'
import {
  aggregateLiveSources,
  computeSnapshotEvidenceDigest,
  projectRuntimeEvidence,
  runtimeObservationWindowsSchema,
  runtimeTelemetryRequestForAgent,
  validateRuntimeTelemetryProvenance,
} from '@agent-sentinel/connector-sdk'
import { ADAPTER_SOURCE_ID, mergeManifestSnapshots } from '@agent-sentinel/manifest-connector'
import type {
  EstateContext,
  EstateSnapshot,
  ExposureFinding,
  ExposureFindingRepository,
  SnapshotRepository,
} from '@agent-sentinel/domain'
import {
  createLiveGraphTraversalContextForSnapshot,
  trustedMockGraphTraversalContext,
} from '@agent-sentinel/graph-engine'
import { evaluateAllExposurePolicies } from '@agent-sentinel/policy-engine'

export interface IngestionServiceOptions {
  estate: EstateContext
  sourceMode: 'mock' | 'foundry'
  logger?: Logger
  clock?: () => Date
  correlationIdFactory?: () => string
  manifestIngestions?: ManifestIngestionRepository
  connectorHealthRepository?: ConnectorHealthRepository
  runtimeTelemetryConnector?: RuntimeTelemetryConnector
  runtimeTelemetryLimits?: Partial<
    Pick<LiveAggregationLimits, 'maxSources' | 'maxConcurrency' | 'maxDurationMs'>
  >
}

export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export interface IngestionResult {
  correlationId: string
  outcome: 'succeeded' | 'partially-succeeded'
  persisted: boolean
  connectorHealth?: ConnectorHealthReport
  manifestIngestion: {
    status: 'disabled' | 'available' | 'degraded'
    count: number
    reason?: 'repository-unavailable' | 'composition-failed'
  }
  snapshot: EstateSnapshot
  snapshotId: string
  findings: ExposureFinding[]
  newFindings: ExposureFinding[]
  resolvedFindings: ExposureFinding[]
}

export const defaultLogger: Logger = {
  info: (message, extra) =>
    console.log(JSON.stringify({ level: 'info', msg: message, ...(extra ?? {}) })),
  warn: (message, extra) =>
    console.log(JSON.stringify({ level: 'warn', msg: message, ...(extra ?? {}) })),
  error: (message, extra) =>
    console.error(JSON.stringify({ level: 'error', msg: message, ...(extra ?? {}) })),
}

export const JOBS_RUNTIME_TELEMETRY_LIMITS: LiveAggregationLimits = {
  maxSources: 1_000,
  maxConcurrency: 4,
  maxDurationMs: 60_000,
  maxPagesPerSource: 1,
  maxRecordsPerSource: 10_000,
}

function jobsRuntimeTelemetryLimits(
  overrides: IngestionServiceOptions['runtimeTelemetryLimits'],
): LiveAggregationLimits {
  return {
    ...JOBS_RUNTIME_TELEMETRY_LIMITS,
    ...(overrides?.maxSources === undefined
      ? {}
      : { maxSources: Math.min(overrides.maxSources, JOBS_RUNTIME_TELEMETRY_LIMITS.maxSources) }),
    ...(overrides?.maxConcurrency === undefined
      ? {}
      : {
          maxConcurrency: Math.min(
            overrides.maxConcurrency,
            JOBS_RUNTIME_TELEMETRY_LIMITS.maxConcurrency,
          ),
        }),
    ...(overrides?.maxDurationMs === undefined
      ? {}
      : {
          maxDurationMs: Math.min(
            overrides.maxDurationMs,
            JOBS_RUNTIME_TELEMETRY_LIMITS.maxDurationMs,
          ),
        }),
  }
}

function composeRuntimeTelemetryHealth(
  discovery: ConnectorHealthReport | undefined,
  runtime: ConnectorHealthReport | undefined,
): ConnectorHealthReport | undefined {
  if (runtime === undefined) return discovery
  if (discovery === undefined) return runtime
  return {
    overall:
      discovery.overall === 'unavailable'
        ? 'unavailable'
        : discovery.overall === 'degraded' || runtime.overall !== 'ready'
          ? 'degraded'
          : 'ready',
    partial: discovery.partial || runtime.partial,
    ...(discovery.sourceSetFingerprint === undefined
      ? {}
      : { sourceSetFingerprint: discovery.sourceSetFingerprint }),
    sources: [...discovery.sources, ...runtime.sources],
  }
}

function snapshotIdFor(snapshot: EstateSnapshot): string {
  return `${snapshot.tenantId}-${snapshot.environment}-${snapshot.generatedAt}`
}

export class IngestionService {
  constructor(
    private readonly connector: AgentConnector,
    private readonly snapshots: SnapshotRepository,
    private readonly exposures: ExposureFindingRepository,
    private readonly options: IngestionServiceOptions,
  ) {}

  async run(): Promise<IngestionResult> {
    const logger = this.options.logger ?? defaultLogger
    const correlationId = this.options.correlationIdFactory?.() ?? randomUUID()
    logger.info('ingestion.start', { correlationId, sourceMode: this.options.sourceMode })

    let discovered: EstateSnapshot
    try {
      discovered = await this.connector.discover()
    } catch (error) {
      await this.persistConnectorHealth(this.connector.getConnectorHealth?.())
      throw error
    }
    if (discovered.tenantId !== this.options.estate.tenantId) {
      throw new Error('Discovered snapshot tenant does not match the configured ingestion tenant.')
    }
    if (discovered.environment !== this.options.estate.environment) {
      throw new Error(
        'Discovered snapshot environment does not match the configured ingestion estate.',
      )
    }
    let connectorHealth = this.connector.getConnectorHealth?.()
    const connectorPartial = connectorHealth?.partial === true
    let snapshot: EstateSnapshot = discovered
    let manifestIngestion: IngestionResult['manifestIngestion'] =
      this.options.manifestIngestions === undefined
        ? { status: 'disabled', count: 0 }
        : { status: 'available', count: 0 }
    if (!connectorPartial && this.options.manifestIngestions !== undefined) {
      let manifestRecords: ManifestIngestionRecord[] | undefined
      try {
        manifestRecords = await this.options.manifestIngestions.listLatest(discovered.environment)
      } catch {
        manifestIngestion = {
          status: 'degraded',
          count: 0,
          reason: 'repository-unavailable',
        }
      }
      if (manifestRecords !== undefined) {
        try {
          snapshot = mergeManifestSnapshots(
            discovered,
            manifestRecords.map((record) => record.snapshot),
          )
          manifestIngestion = { status: 'available', count: manifestRecords.length }
        } catch {
          manifestIngestion = {
            status: 'degraded',
            count: 0,
            reason: 'composition-failed',
          }
        }
      }
    }
    let runtimeTelemetryDegraded = false
    if (this.options.runtimeTelemetryConnector !== undefined) {
      const limits = jobsRuntimeTelemetryLimits(this.options.runtimeTelemetryLimits)
      const eligible = snapshot.nodes
        .filter((node) => node.kind === 'agent')
        .flatMap((agent) => {
          const request = runtimeTelemetryRequestForAgent(snapshot, agent, this.options.estate)
          return request === undefined ? [] : [{ id: agent.id, agent, request }]
        })
      const selected = eligible.slice(0, limits.maxSources)
      for (const { agent } of eligible.slice(limits.maxSources)) {
        runtimeTelemetryDegraded = true
        logger.warn('ingestion.runtime-evidence.degraded', {
          correlationId,
          agentId: agent.id,
          reason: 'source-limit-exceeded',
        })
      }
      const aggregation =
        selected.length === 0
          ? undefined
          : await aggregateLiveSources<(typeof selected)[number], RuntimeObservationWindows>({
              sources: selected,
              limits,
              execute: async (source, context) => {
                const windows = validateRuntimeTelemetryProvenance(
                  source.request,
                  runtimeObservationWindowsSchema.parse(
                    await this.options.runtimeTelemetryConnector!.readObservationWindows(
                      source.request,
                      {
                        signal: context.signal,
                        maxPages: context.maxPages,
                        maxRecords: context.maxRecords,
                      },
                    ),
                  ),
                )
                const observations = [
                  ...windows.baseline.observations,
                  ...windows.observed.observations,
                ]
                return {
                  state: observations.length === 0 ? ('empty' as const) : ('complete' as const),
                  value: windows,
                  pages: windows.queryDiagnostics?.providerPages ?? 1,
                  records: windows.queryDiagnostics?.rawRows ?? observations.length,
                  evidenceIds:
                    observations.length === 0
                      ? []
                      : [windows.baselineEvidenceId, windows.observedEvidenceId],
                  ...(observations.length === 0 ? { reason: 'empty' } : {}),
                }
              },
              failureReason: () => 'query-or-provenance-failed',
            })
      for (const outcome of aggregation?.outcomes ?? []) {
        const { agent, request } = outcome.source
        if (
          outcome.state === 'failed' ||
          outcome.state === 'cancelled' ||
          outcome.value === undefined
        ) {
          runtimeTelemetryDegraded = true
          logger.warn('ingestion.runtime-evidence.degraded', {
            correlationId,
            agentId: agent.id,
            reason: outcome.reason ?? 'query-or-provenance-failed',
          })
          continue
        }
        try {
          const projection = projectRuntimeEvidence(snapshot, outcome.value, request)
          snapshot = projection.snapshot
          if (outcome.state !== 'complete' || projection.dataState.state !== 'complete') {
            runtimeTelemetryDegraded = true
          }
        } catch {
          runtimeTelemetryDegraded = true
          logger.warn('ingestion.runtime-evidence.degraded', {
            correlationId,
            agentId: agent.id,
            reason: 'projection-failed',
          })
        }
      }
      connectorHealth = composeRuntimeTelemetryHealth(
        connectorHealth,
        this.options.runtimeTelemetryConnector.getConnectorHealth?.(),
      )
      if (connectorHealth !== undefined && connectorHealth.overall !== 'ready') {
        runtimeTelemetryDegraded = true
      }
    }
    const connectorDegraded = connectorHealth !== undefined && connectorHealth.overall !== 'ready'
    const outcome =
      connectorDegraded || manifestIngestion.status === 'degraded' || runtimeTelemetryDegraded
        ? 'partially-succeeded'
        : 'succeeded'
    const snapshotId = snapshotIdFor(snapshot)
    const traversalContext =
      this.options.sourceMode === 'mock'
        ? trustedMockGraphTraversalContext
        : createLiveGraphTraversalContextForSnapshot(snapshot, {
            estate: this.options.estate,
            ...(this.options.clock === undefined ? {} : { clock: this.options.clock }),
          })
    const evaluated = evaluateAllExposurePolicies(snapshot, traversalContext)
    const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]))
    const findings: ExposureFinding[] = evaluated.map((finding) => {
      const sourceMode =
        nodeById.get(finding.affectedAgentId)?.metadata['source'] === ADAPTER_SOURCE_ID
          ? 'manifest'
          : this.options.sourceMode
      return {
        ...finding,
        sourceMode,
        tenantId: this.options.estate.tenantId,
        snapshotId,
      }
    })

    if (connectorPartial) {
      await this.persistConnectorHealth(connectorHealth)
      const sources = connectorHealth?.sources
        .filter((source) => source.readiness !== 'ready' && source.readiness !== 'disabled')
        .map((source) => ({
          id: source.id,
          readiness: source.readiness,
          ...(source.reason !== undefined ? { reason: source.reason } : {}),
        }))
      logger.warn('ingestion.enrichment.degraded', { correlationId, sources })
      logger.info('ingestion.partial.complete', {
        correlationId,
        snapshotId,
        total: findings.length,
        persisted: false,
      })
      return {
        correlationId,
        outcome,
        persisted: false,
        ...(connectorHealth ? { connectorHealth } : {}),
        manifestIngestion,
        snapshot,
        snapshotId,
        findings,
        newFindings: [],
        resolvedFindings: [],
      }
    }
    if (manifestIngestion.status === 'degraded') {
      logger.warn('ingestion.manifest.degraded', {
        correlationId,
        reason: manifestIngestion.reason,
      })
    }

    await this.snapshots.save(this.options.estate, snapshot)
    logger.info('ingestion.snapshot.saved', { correlationId, snapshotId })
    await this.persistConnectorHealth(connectorHealth, snapshot)
    if (connectorDegraded) {
      const sources = connectorHealth?.sources
        .filter((source) => source.readiness !== 'ready' && source.readiness !== 'disabled')
        .map((source) => ({
          id: source.id,
          readiness: source.readiness,
          ...(source.reason !== undefined ? { reason: source.reason } : {}),
        }))
      logger.warn('ingestion.enrichment.degraded', {
        correlationId,
        persisted: true,
        sources,
      })
    }

    const newFindings: ExposureFinding[] = []
    for (const finding of findings) {
      const existing = await this.exposures.findById(finding.id, this.options.estate)
      const upserted = await this.exposures.upsert(this.options.estate, finding)
      if (existing === null) newFindings.push(upserted)
    }
    const presentIds = findings.map((finding) => finding.id)
    const resolvedFindings = await this.exposures.resolveAbsent(
      this.options.estate,
      presentIds,
      manifestIngestion.status === 'degraded' ? [this.options.sourceMode] : undefined,
    )

    logger.info('ingestion.complete', {
      correlationId,
      snapshotId,
      total: findings.length,
      manifestCount: manifestIngestion.count,
      new: newFindings.length,
      resolved: resolvedFindings.length,
    })

    return {
      correlationId,
      outcome,
      persisted: true,
      ...(connectorHealth ? { connectorHealth } : {}),
      manifestIngestion,
      snapshot,
      snapshotId,
      findings,
      newFindings,
      resolvedFindings,
    }
  }

  private async persistConnectorHealth(
    connectorHealth: ConnectorHealthReport | undefined,
    snapshot?: EstateSnapshot,
  ): Promise<ConnectorHealthReport | undefined> {
    if (connectorHealth === undefined || this.options.connectorHealthRepository === undefined) {
      return connectorHealth
    }
    const measuredAt = (this.options.clock?.() ?? new Date()).toISOString()
    await this.options.connectorHealthRepository.save(this.options.estate, {
      estateId: this.options.estate.id,
      tenantId: this.options.estate.tenantId,
      environment: this.options.estate.environment,
      connectorId: this.connector.descriptor.id,
      ...(connectorHealth.sourceSetFingerprint === undefined
        ? {}
        : { sourceSetFingerprint: connectorHealth.sourceSetFingerprint }),
      ...(snapshot === undefined
        ? {}
        : {
            snapshotBinding: {
              snapshotGeneratedAt: snapshot.generatedAt,
              evidenceDigest: computeSnapshotEvidenceDigest(snapshot),
            },
          }),
      measuredAt,
      health: connectorHealth,
    })
    return connectorHealth
  }
}
