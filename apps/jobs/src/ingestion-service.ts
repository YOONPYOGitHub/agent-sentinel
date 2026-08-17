import { randomUUID } from 'node:crypto'

import type { AgentConnector } from '@agent-sentinel/connector-sdk'
import type {
  EstateSnapshot,
  ExposureFinding,
  ExposureFindingRepository,
  SnapshotRepository,
} from '@agent-sentinel/domain'
import { evaluateAllExposurePolicies } from '@agent-sentinel/policy-engine'

export interface IngestionServiceOptions {
  tenantId: string
  sourceMode: 'mock' | 'foundry'
  logger?: Logger
  clock?: () => Date
  correlationIdFactory?: () => string
}

export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export interface IngestionResult {
  correlationId: string
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

    const discovered = await this.connector.discover()
    const snapshot: EstateSnapshot = {
      ...discovered,
      tenantId: this.options.tenantId,
    }
    const snapshotId = snapshotIdFor(snapshot)
    await this.snapshots.save(snapshot)
    logger.info('ingestion.snapshot.saved', { correlationId, snapshotId })

    const evaluated = evaluateAllExposurePolicies(snapshot)
    const findings: ExposureFinding[] = evaluated.map((finding) => ({
      ...finding,
      sourceMode: this.options.sourceMode,
      tenantId: this.options.tenantId,
      snapshotId,
    }))

    const newFindings: ExposureFinding[] = []
    for (const finding of findings) {
      const existing = await this.exposures.findById(finding.id, this.options.tenantId)
      const upserted = await this.exposures.upsert(finding)
      if (existing === null) newFindings.push(upserted)
    }
    const presentIds = findings.map((finding) => finding.id)
    const resolvedFindings = await this.exposures.resolveAbsent(this.options.tenantId, presentIds)

    logger.info('ingestion.complete', {
      correlationId,
      snapshotId,
      total: findings.length,
      new: newFindings.length,
      resolved: resolvedFindings.length,
    })

    return {
      correlationId,
      snapshot,
      snapshotId,
      findings,
      newFindings,
      resolvedFindings,
    }
  }
}
