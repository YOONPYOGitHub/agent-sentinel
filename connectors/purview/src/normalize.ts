import { createHash } from 'node:crypto'

import {
  assertEstateSnapshot,
  type EstateSnapshot,
  type Evidence,
  type GraphNode,
} from '@agent-sentinel/domain'

import { PurviewConnectorError } from './client.js'
import type { PurviewSensitivityLabel, PurviewSourceConfig } from './schemas.js'

function stableNamespace(source: PurviewSourceConfig, providerId: string): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        'purview-sensitivity-label-catalog',
        source.id,
        source.tenantId.toLowerCase(),
        source.environment,
        providerId.toLowerCase(),
      ]),
    )
    .digest('hex')
    .slice(0, 40)
  return `purview-${hash}`
}

function compactMetadata(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

export function mapPurviewLabelsToSnapshot(
  labels: readonly PurviewSensitivityLabel[],
  source: PurviewSourceConfig,
  observedAt = new Date().toISOString(),
): EstateSnapshot {
  const nodes: GraphNode[] = []
  const evidence: Evidence[] = []
  const providerIds = new Set<string>()
  for (const label of [...labels].sort((left, right) => left.id.localeCompare(right.id))) {
    const providerId = label.id.toLowerCase()
    if (providerIds.has(providerId)) {
      throw new PurviewConnectorError(
        'malformed-response',
        'Microsoft Graph returned a duplicate sensitivity-label identifier.',
      )
    }
    providerIds.add(providerId)
    const namespace = stableNamespace(source, label.id)
    const evidenceId = `${namespace}-evidence`
    const provenance = {
      sourceConnector: 'purview-sensitivity-labels',
      sourceConnectorId: source.id,
      sourceConnectorName: source.name,
      sourceTenantId: source.tenantId,
      sourceEnvironment: source.environment,
      sourceProviderObjectId: label.id,
    }
    const labelMetadata = compactMetadata({
      providerLabelId: label.id,
      labelDisplayName: label.displayName,
      labelName: label.name,
      color: label.color,
      sensitivity: label.sensitivity === undefined ? undefined : String(label.sensitivity),
      priority: label.priority === undefined ? undefined : String(label.priority),
      applicableTo: label.applicableTo,
      labelStatus:
        label.isEnabled === undefined ? undefined : label.isEnabled ? 'enabled' : 'disabled',
    })
    const metadata = {
      ...provenance,
      ...labelMetadata,
      observationType: 'tenant-label-catalog',
      attribution: 'unattributed',
    }
    nodes.push({
      id: `${namespace}-control`,
      kind: 'control',
      name: label.displayName ?? label.name ?? label.id,
      description:
        'Direct Microsoft Purview tenant sensitivity-label catalog definition; no labeled content, usage, user, activity, agent relationship, or compliance outcome is observed.',
      environment: source.environment,
      evidenceIds: [evidenceId],
      metadata,
    })
    evidence.push({
      id: evidenceId,
      source: `Microsoft Graph v1.0 Purview sensitivity-label catalog · ${source.name}`,
      sourceObjectId: `${source.id}:${label.id}`,
      observedAt,
      freshness: 'live',
      confidence: 1,
      evidenceTypes: ['declared_configuration'],
      summary:
        'Direct tenant sensitivity-label catalog observation only; confidence does not indicate label usage, content classification, agent attribution, trust, or compliance.',
      metadata,
    })
  }
  return assertEstateSnapshot({
    tenantId: source.tenantId,
    environment: source.environment,
    generatedAt: observedAt,
    nodes,
    edges: [],
    evidence,
  })
}

export interface PurviewSourceSnapshot {
  source: PurviewSourceConfig
  snapshot: EstateSnapshot
}

export function mergePurviewSnapshots(
  base: EstateSnapshot,
  additions: readonly PurviewSourceSnapshot[],
): EstateSnapshot {
  for (const { source, snapshot } of additions) {
    if (
      snapshot.tenantId.toLowerCase() !== source.tenantId.toLowerCase() ||
      snapshot.environment !== source.environment
    ) {
      throw new PurviewConnectorError(
        'malformed-response',
        'Purview snapshot does not match its configured source boundary.',
      )
    }
  }
  const nodes = [...base.nodes, ...additions.flatMap(({ snapshot }) => snapshot.nodes)]
  const edges = [...base.edges, ...additions.flatMap(({ snapshot }) => snapshot.edges)]
  const evidence = [...base.evidence, ...additions.flatMap(({ snapshot }) => snapshot.evidence)]
  const ids = new Set<string>()
  for (const item of [...nodes, ...edges, ...evidence]) {
    if (ids.has(item.id)) {
      throw new PurviewConnectorError(
        'malformed-response',
        'Purview composition produced a duplicate aggregate identifier.',
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
