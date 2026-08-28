import { createHash } from 'node:crypto'

import {
  assertEstateSnapshot,
  type EstateSnapshot,
  type Evidence,
  type GraphNode,
} from '@agent-sentinel/domain'

import { DefenderCloudAppsConnectorError, type DefenderCloudAppsCollection } from './client.js'
import type {
  DefenderCloudAppsActivity,
  DefenderCloudAppsAlert,
  DefenderCloudAppsSourceConfig,
} from './schemas.js'

const ALERT_SEVERITY = ['low', 'medium', 'high', 'informational'] as const
const ALERT_READ_STATUS = ['unread', 'read', 'archived'] as const
const ALERT_RESOLUTION_STATUS = [
  'open',
  'dismissed',
  'resolved',
  'false-positive',
  'benign',
  'true-positive',
] as const

function stableNamespace(
  source: DefenderCloudAppsSourceConfig,
  kind: 'alert' | 'activity',
  providerId: string,
): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        'defender-cloud-apps',
        source.id,
        source.tenantId.toLowerCase(),
        source.environment,
        source.apiBaseUrl,
        kind,
        providerId,
      ]),
    )
    .digest('hex')
    .slice(0, 40)
  return `mdca-${hash}`
}

function compactMetadata(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

function provenance(
  source: DefenderCloudAppsSourceConfig,
  kind: 'alert' | 'activity',
  providerId: string,
): Record<string, string> {
  return {
    sourceConnector: 'defender-for-cloud-apps',
    sourceConnectorId: source.id,
    sourceConnectorName: source.name,
    sourceTenantId: source.tenantId,
    sourceEnvironment: source.environment,
    sourceApiBaseUrl: source.apiBaseUrl,
    sourceProviderObjectId: providerId,
    securityRecordKind: kind,
  }
}

function eventTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString()
}

function alertMetadata(alert: DefenderCloudAppsAlert): Record<string, string> {
  return compactMetadata({
    providerRecordId: alert.id,
    eventTimestamp: eventTimestamp(alert.timestamp),
    severity: alert.severityValue === undefined ? undefined : ALERT_SEVERITY[alert.severityValue],
    readStatus: alert.statusValue === undefined ? undefined : ALERT_READ_STATUS[alert.statusValue],
    resolutionStatus:
      alert.resolutionStatusValue === undefined
        ? undefined
        : ALERT_RESOLUTION_STATUS[alert.resolutionStatusValue],
    categories: alert.stories === undefined ? undefined : JSON.stringify(alert.stories),
    killChainIntents: alert.intent === undefined ? undefined : JSON.stringify(alert.intent),
    serviceId: alert.serviceId,
    policyId: alert.policyId,
    policyType: alert.policyType,
  })
}

function activityMetadata(activity: DefenderCloudAppsActivity): Record<string, string> {
  return compactMetadata({
    providerRecordId: activity.id,
    eventTimestamp: eventTimestamp(activity.timestamp),
    actionType: activity.actionType,
    eventActionType: activity.eventActionType,
    takenAction: activity.takenAction,
    administrative:
      activity.administrative === undefined ? undefined : String(activity.administrative),
    serviceId: activity.serviceId,
    policyId: activity.policyId,
  })
}

function mapRecord(
  source: DefenderCloudAppsSourceConfig,
  kind: 'alert' | 'activity',
  record: DefenderCloudAppsAlert | DefenderCloudAppsActivity,
  observedAt: string,
): { node: GraphNode; evidence: Evidence } {
  const namespace = stableNamespace(source, kind, record.id)
  const evidenceId = `${namespace}-evidence`
  const recordMetadata = kind === 'alert' ? alertMetadata(record) : activityMetadata(record)
  const metadata = {
    ...provenance(source, kind, record.id),
    ...recordMetadata,
    attribution: 'unattributed',
  }
  return {
    node: {
      id: `${namespace}-control`,
      kind: 'control',
      name: `Unattributed Defender for Cloud Apps ${kind} evidence`,
      description:
        'Direct tenant-level Microsoft Defender for Cloud Apps security evidence; no agent attribution or correlation is inferred.',
      environment: source.environment,
      evidenceIds: [evidenceId],
      metadata,
    },
    evidence: {
      id: evidenceId,
      source: `Microsoft Defender for Cloud Apps ${kind} list · ${source.name}`,
      sourceObjectId: `${source.id}:${kind}:${record.id}`,
      observedAt,
      freshness: 'live',
      confidence: 1,
      summary: `Direct, unattributed Defender for Cloud Apps ${kind} observation; confidence reflects provider observation only and does not indicate agent attribution.`,
      metadata,
    },
  }
}

export function mapDefenderCloudAppsCollectionToSnapshot(
  collection: DefenderCloudAppsCollection,
  source: DefenderCloudAppsSourceConfig,
): EstateSnapshot {
  const nodes: GraphNode[] = []
  const evidence: Evidence[] = []
  const ids = new Set<string>()
  for (const [kind, records] of [
    ['alert', collection.alerts],
    ['activity', collection.activities],
  ] as const) {
    for (const record of [...records].sort((left, right) => left.id.localeCompare(right.id))) {
      const mapped = mapRecord(source, kind, record, collection.observedAt)
      for (const id of [mapped.node.id, mapped.evidence.id]) {
        if (ids.has(id)) {
          throw new DefenderCloudAppsConnectorError(
            'malformed-response',
            'Defender for Cloud Apps mapping produced an aggregate identifier collision.',
          )
        }
        ids.add(id)
      }
      nodes.push(mapped.node)
      evidence.push(mapped.evidence)
    }
  }
  return assertEstateSnapshot({
    tenantId: source.tenantId,
    environment: source.environment,
    generatedAt: collection.observedAt,
    nodes,
    edges: [],
    evidence,
  })
}

export interface DefenderCloudAppsSourceSnapshot {
  source: DefenderCloudAppsSourceConfig
  snapshot: EstateSnapshot
}

export function mergeDefenderCloudAppsSnapshots(
  base: EstateSnapshot,
  additions: readonly DefenderCloudAppsSourceSnapshot[],
): EstateSnapshot {
  for (const { source, snapshot } of additions) {
    if (
      snapshot.tenantId.toLowerCase() !== source.tenantId.toLowerCase() ||
      snapshot.environment !== source.environment
    ) {
      throw new DefenderCloudAppsConnectorError(
        'malformed-response',
        'Defender for Cloud Apps snapshot does not match its configured source boundary.',
      )
    }
  }
  const nodes = [...base.nodes, ...additions.flatMap(({ snapshot }) => snapshot.nodes)]
  const edges = [...base.edges, ...additions.flatMap(({ snapshot }) => snapshot.edges)]
  const evidence = [...base.evidence, ...additions.flatMap(({ snapshot }) => snapshot.evidence)]
  const ids = new Set<string>()
  for (const item of [...nodes, ...edges, ...evidence]) {
    if (ids.has(item.id)) {
      throw new DefenderCloudAppsConnectorError(
        'malformed-response',
        'Defender for Cloud Apps composition produced a duplicate aggregate identifier.',
      )
    }
    ids.add(item.id)
  }
  return assertEstateSnapshot({
    tenantId: base.tenantId,
    environment: base.environment,
    generatedAt: [base.generatedAt, ...additions.map(({ snapshot }) => snapshot.generatedAt)]
      .sort()
      .at(-1)!,
    nodes,
    edges,
    evidence,
  })
}
