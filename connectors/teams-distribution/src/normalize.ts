import { createHash } from 'node:crypto'

import {
  assertEstateSnapshot,
  type EstateSnapshot,
  type Evidence,
  type GraphNode,
} from '@agent-sentinel/domain'

import { TeamsDistributionConnectorError } from './client.js'
import type { TeamsApp, TeamsDistributionSourceConfig } from './schemas.js'

function stableNamespace(source: TeamsDistributionSourceConfig, providerId: string): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        'teams-distribution-tenant-app-catalog',
        source.id,
        source.tenantId.toLowerCase(),
        source.environment,
        providerId.toLowerCase(),
      ]),
    )
    .digest('hex')
    .slice(0, 40)
  return `teams-distribution-${hash}`
}

function compactMetadata(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

export function mapTeamsDistributionAppsToSnapshot(
  apps: readonly TeamsApp[],
  source: TeamsDistributionSourceConfig,
  observedAt = new Date().toISOString(),
): EstateSnapshot {
  const nodes: GraphNode[] = []
  const evidence: Evidence[] = []
  const providerIds = new Set<string>()
  for (const app of [...apps].sort((left, right) => left.id.localeCompare(right.id))) {
    const providerId = app.id.toLowerCase()
    if (providerIds.has(providerId)) {
      throw new TeamsDistributionConnectorError(
        'malformed-response',
        'Microsoft Graph returned a duplicate Teams app identifier.',
      )
    }
    providerIds.add(providerId)
    const namespace = stableNamespace(source, app.id)
    const evidenceId = `${namespace}-evidence`
    const provenance = {
      sourceConnector: 'teams-distribution-catalog',
      sourceConnectorId: source.id,
      sourceConnectorName: source.name,
      sourceTenantId: source.tenantId,
      sourceEnvironment: source.environment,
      sourceProviderObjectId: app.id,
    }
    const catalogMetadata = compactMetadata({
      providerTeamsAppId: app.id,
      appDisplayName: app.displayName,
      distributionMethod: app.distributionMethod,
      externalId: app.externalId,
    })
    const metadata = {
      ...provenance,
      ...catalogMetadata,
      observationType: 'tenant-teams-app-catalog',
      attribution: 'unattributed',
    }
    nodes.push({
      id: `${namespace}-control`,
      kind: 'control',
      name: app.displayName ?? app.id,
      description:
        'Direct Microsoft Teams tenant app catalog metadata; catalog presence does not prove an agent, deployment, installation, distribution coverage, trust, tools, entitlement, or access.',
      environment: source.environment,
      evidenceIds: [evidenceId],
      metadata,
    })
    evidence.push({
      id: evidenceId,
      source: `Microsoft Graph v1.0 Teams tenant app catalog · ${source.name}`,
      sourceObjectId: `${source.id}:${app.id}`,
      observedAt,
      freshness: 'live',
      confidence: 1,
      summary:
        'Direct organization catalog observation only; confidence does not indicate agent semantics, deployment, installation, distribution coverage, runtime behavior, trust, tools, entitlement, or access.',
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

export interface TeamsDistributionSourceSnapshot {
  source: TeamsDistributionSourceConfig
  snapshot: EstateSnapshot
}

export function mergeTeamsDistributionSnapshots(
  base: EstateSnapshot,
  additions: readonly TeamsDistributionSourceSnapshot[],
): EstateSnapshot {
  for (const { source, snapshot } of additions) {
    if (
      snapshot.tenantId.toLowerCase() !== source.tenantId.toLowerCase() ||
      snapshot.environment !== source.environment
    ) {
      throw new TeamsDistributionConnectorError(
        'malformed-response',
        'Teams distribution snapshot does not match its configured source boundary.',
      )
    }
  }
  const nodes = [...base.nodes, ...additions.flatMap(({ snapshot }) => snapshot.nodes)]
  const edges = [...base.edges, ...additions.flatMap(({ snapshot }) => snapshot.edges)]
  const evidence = [...base.evidence, ...additions.flatMap(({ snapshot }) => snapshot.evidence)]
  const ids = new Set<string>()
  for (const item of [...nodes, ...edges, ...evidence]) {
    if (ids.has(item.id)) {
      throw new TeamsDistributionConnectorError(
        'malformed-response',
        'Teams distribution composition produced a duplicate aggregate identifier.',
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
