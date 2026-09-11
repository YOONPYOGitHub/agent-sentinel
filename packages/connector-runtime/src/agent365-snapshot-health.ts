import {
  computeSnapshotEvidenceDigest,
  type ConnectorHealthReport,
  type ConnectorHealthSnapshotBinding,
} from '@agent-sentinel/connector-sdk'
import {
  assertEstateSnapshot,
  hydratePersistedEstateSnapshot,
  type EstateContext,
  type EstateSnapshot,
  type Evidence,
  type SnapshotRepository,
} from '@agent-sentinel/domain'

const AGENT365_SOURCE = 'agent365-package-catalog'
const AGENT365_PROVIDER = 'microsoft-graph-agent365-package-catalog'

function isAgent365Evidence(evidence: Evidence): boolean {
  return evidence.metadata?.['sourceConnector'] === AGENT365_SOURCE
}

function exactSourceHealth(
  snapshot: EstateSnapshot,
  evidence: Evidence,
  health: ConnectorHealthReport,
): ConnectorHealthReport['sources'][number] | undefined {
  const metadata = evidence.metadata
  const sourceId = metadata?.['sourceConnectorId']
  const sourceTenantId = metadata?.['sourceTenantId']
  const sourceEnvironment = metadata?.['sourceEnvironment']
  if (sourceId === undefined || sourceTenantId === undefined || sourceEnvironment === undefined) {
    return undefined
  }
  const matches = health.sources.filter(
    (source) =>
      source.id === `agent365:${sourceId}` &&
      source.provenance?.provider === AGENT365_PROVIDER &&
      source.provenance.sourceConnectorId === sourceId &&
      source.provenance.sourceTenantId.toLowerCase() === sourceTenantId.toLowerCase() &&
      source.provenance.sourceEnvironment === sourceEnvironment &&
      source.provenance.estateTenantId.toLowerCase() === snapshot.tenantId.toLowerCase() &&
      source.provenance.estateEnvironment === snapshot.environment,
  )
  return matches.length === 1 ? matches[0] : undefined
}

function withUnknownEvidenceType(evidence: Evidence): Evidence['evidenceTypes'] {
  return evidence.evidenceTypes.includes('unknown')
    ? evidence.evidenceTypes
    : [...evidence.evidenceTypes, 'unknown']
}

export function projectAgent365SnapshotHealth(
  snapshot: EstateSnapshot,
  health: ConnectorHealthReport,
  snapshotBinding?: ConnectorHealthSnapshotBinding,
): EstateSnapshot {
  const bindingStatus =
    snapshotBinding === undefined
      ? 'unbound'
      : snapshotBinding.snapshotGeneratedAt === snapshot.generatedAt &&
          snapshotBinding.evidenceDigest === computeSnapshotEvidenceDigest(snapshot)
        ? 'matches'
        : 'mismatch'
  const evidence = snapshot.evidence.map((item): Evidence => {
    if (!isAgent365Evidence(item)) return item
    const sourceId = item.metadata?.['sourceConnectorId']
    if (sourceId === undefined) {
      return {
        ...item,
        freshness: 'stale',
        confidence: 0,
        evidenceTypes: withUnknownEvidenceType(item),
        sourceStatus: {
          status: 'unknown',
          sourceId: 'unattributed',
          readiness: 'unavailable',
          reason: 'source-health-unavailable',
        },
      }
    }
    const source = exactSourceHealth(snapshot, item, health)
    if (source === undefined) {
      return {
        ...item,
        freshness: 'stale',
        confidence: 0,
        evidenceTypes: withUnknownEvidenceType(item),
        sourceStatus: {
          status: 'unknown',
          sourceId,
          readiness: 'unavailable',
          reason: 'source-health-unavailable',
        },
      }
    }
    if (source.readiness === 'ready' && source.dataState === 'complete') {
      if (bindingStatus !== 'matches') {
        return {
          ...item,
          freshness: 'stale',
          confidence: 0,
          evidenceTypes: withUnknownEvidenceType(item),
          sourceStatus: {
            status: 'unknown',
            sourceId,
            readiness: 'unavailable',
            reason:
              bindingStatus === 'unbound'
                ? 'source-health-unbound'
                : 'source-health-snapshot-mismatch',
          },
        }
      }
      return {
        ...item,
        freshness: 'live',
        sourceStatus: {
          status: 'live',
          sourceId,
          readiness: source.readiness,
          dataState: source.dataState,
          ...(source.checkedAt === undefined ? {} : { checkedAt: source.checkedAt }),
        },
      }
    }
    return {
      ...item,
      freshness: 'stale',
      evidenceTypes: withUnknownEvidenceType(item),
      sourceStatus: {
        status: 'stale',
        sourceId,
        readiness: source.readiness,
        ...(source.dataState === undefined ? {} : { dataState: source.dataState }),
        ...(source.checkedAt === undefined ? {} : { checkedAt: source.checkedAt }),
        ...(source.reason === undefined ? {} : { reason: source.reason }),
      },
    }
  })
  return assertEstateSnapshot({ ...snapshot, evidence })
}

export interface Agent365SnapshotHealthState {
  readonly health: ConnectorHealthReport
  readonly snapshotBinding?: ConnectorHealthSnapshotBinding
}

export type Agent365HealthResolver = (estate: EstateContext) => Promise<Agent365SnapshotHealthState>

export class Agent365HealthAwareSnapshotRepository implements SnapshotRepository {
  constructor(
    private readonly repository: SnapshotRepository,
    private readonly resolveHealth: Agent365HealthResolver,
  ) {}

  save(estate: EstateContext, snapshot: EstateSnapshot): Promise<void> {
    return this.repository.save(estate, snapshot)
  }

  async findLatest(estate: EstateContext): Promise<EstateSnapshot | null> {
    return this.project(await this.repository.findLatest(estate), estate)
  }

  async findById(id: string, estate: EstateContext): Promise<EstateSnapshot | null> {
    return this.project(await this.repository.findById(id, estate), estate)
  }

  async list(estate: EstateContext, limit?: number): Promise<EstateSnapshot[]> {
    const state = await this.resolveHealth(estate)
    return (await this.repository.list(estate, limit)).map((snapshot) =>
      projectAgent365SnapshotHealth(
        hydratePersistedEstateSnapshot(snapshot, estate.id),
        state.health,
        state.snapshotBinding,
      ),
    )
  }

  private async project(
    snapshot: EstateSnapshot | null,
    estate: EstateContext,
  ): Promise<EstateSnapshot | null> {
    if (snapshot === null) return null
    const state = await this.resolveHealth(estate)
    return projectAgent365SnapshotHealth(
      hydratePersistedEstateSnapshot(snapshot, estate.id),
      state.health,
      state.snapshotBinding,
    )
  }
}
