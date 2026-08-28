import { createHash } from 'node:crypto'

import {
  assertEstateSnapshot,
  type EstateSnapshot,
  type Evidence,
  type GraphNode,
} from '@agent-sentinel/domain'

import { Agent365ConnectorError } from './client.js'
import type { Agent365SourceConfig, CopilotPackage } from './schemas.js'

function compactMetadata(
  values: Record<string, string | null | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== null,
    ),
  )
}

function stablePackageNamespace(source: Agent365SourceConfig, item: CopilotPackage): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        'agent365-package-catalog',
        source.id,
        source.tenantId.toLowerCase(),
        source.environment,
        item.id,
      ]),
    )
    .digest('hex')
    .slice(0, 40)
  return `agent365-${hash}`
}

function containsIgnoreCase(values: readonly string[] | undefined, expected: string): boolean {
  return values?.some((value) => value.toLowerCase() === expected.toLowerCase()) === true
}

export function isAgentPackage(item: CopilotPackage): boolean {
  return (
    containsIgnoreCase(item.supportedHosts, 'copilot') ||
    ['bot', 'bots', 'declarativeagent', 'customengineagent'].some((type) =>
      containsIgnoreCase(item.elementTypes, type),
    )
  )
}

export function mapAgent365PackagesToSnapshot(
  packages: readonly CopilotPackage[],
  source: Agent365SourceConfig,
  observedAt = new Date().toISOString(),
): EstateSnapshot {
  const nodes: GraphNode[] = []
  const evidence: Evidence[] = []
  const providerIds = new Set<string>()
  const aggregateIds = new Set<string>()
  for (const item of [...packages].sort((left, right) => left.id.localeCompare(right.id))) {
    if (providerIds.has(item.id)) {
      throw new Agent365ConnectorError(
        'malformed-response',
        'Microsoft Graph returned a duplicate package identifier.',
      )
    }
    providerIds.add(item.id)
    const namespace = stablePackageNamespace(source, item)
    const nodeId = `${namespace}-package`
    const evidenceId = `${namespace}-evidence`
    if (aggregateIds.has(nodeId) || aggregateIds.has(evidenceId)) {
      throw new Agent365ConnectorError(
        'malformed-response',
        'Package mapping produced an aggregate identifier collision.',
      )
    }
    aggregateIds.add(nodeId)
    aggregateIds.add(evidenceId)
    const agent = isAgentPackage(item)
    const provenance = {
      sourceConnector: 'agent365-package-catalog',
      sourceConnectorId: source.id,
      sourceConnectorName: source.name,
      sourceTenantId: source.tenantId,
      sourceEnvironment: source.environment,
      sourceProviderObjectId: item.id,
    }
    const metadata = {
      platform: 'Microsoft Agent 365 package catalog',
      sourceOfTruth: 'true',
      providerPackageId: item.id,
      inventoryEntityType: agent ? 'agent-package' : 'extension-package',
      ...provenance,
      ...compactMetadata({
        packageType: item.type,
        packagePlatform: item.platform,
        supportedHosts:
          item.supportedHosts === undefined ? undefined : JSON.stringify(item.supportedHosts),
        elementTypes:
          item.elementTypes === undefined ? undefined : JSON.stringify(item.elementTypes),
        packageStatus:
          item.isBlocked === undefined ? undefined : item.isBlocked ? 'blocked' : 'unblocked',
        isBlocked: item.isBlocked === undefined ? undefined : String(item.isBlocked),
        availableTo: item.availableTo,
        deployedTo: item.deployedTo,
        version: item.version,
        manifestVersion: item.manifestVersion,
        manifestId: item.manifestId,
        providerApplicationId: item.appId,
        assetId: item.assetId,
        publisher: item.publisher,
        lastModifiedDateTime: item.lastModifiedDateTime,
      }),
    }
    nodes.push({
      id: nodeId,
      kind: agent ? 'agent' : 'control',
      name: item.displayName,
      description:
        item.shortDescription ??
        (agent
          ? 'Authoritative Microsoft Agent 365 package catalog agent record.'
          : 'Authoritative Microsoft Agent 365 package catalog extension record.'),
      environment: source.environment,
      evidenceIds: [evidenceId],
      metadata,
    })
    evidence.push({
      id: evidenceId,
      source: `Microsoft Graph v1.0 Agent 365 package catalog · ${source.name}`,
      sourceObjectId: `${source.id}:${item.id}`,
      observedAt,
      freshness: 'live',
      confidence: 1,
      summary: agent
        ? `Authoritative package catalog record for ${item.displayName}; agent-package classification uses documented host and element types, while runtime behavior, trust, tools, identity, entitlement, and access are not inferred.`
        : `Authoritative non-agent extension package record for ${item.displayName}; no agent semantics, runtime behavior, trust, tools, identity, entitlement, or access is inferred.`,
      metadata: {
        ...provenance,
        providerPackageId: item.id,
        inventoryEntityType: agent ? 'agent-package' : 'extension-package',
      },
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

export interface Agent365SourceSnapshot {
  source: Agent365SourceConfig
  snapshot: EstateSnapshot
}

export function mergeAgent365Snapshots(
  base: EstateSnapshot,
  additions: readonly Agent365SourceSnapshot[],
): EstateSnapshot {
  for (const { source, snapshot } of additions) {
    if (
      snapshot.tenantId.toLowerCase() !== source.tenantId.toLowerCase() ||
      snapshot.environment !== source.environment
    ) {
      throw new Agent365ConnectorError(
        'malformed-response',
        'Agent 365 snapshot does not match its configured source boundary.',
      )
    }
  }
  const nodes = [...base.nodes, ...additions.flatMap(({ snapshot }) => snapshot.nodes)]
  const edges = [...base.edges, ...additions.flatMap(({ snapshot }) => snapshot.edges)]
  const evidence = [...base.evidence, ...additions.flatMap(({ snapshot }) => snapshot.evidence)]
  const ids = new Set<string>()
  for (const item of [...nodes, ...edges, ...evidence]) {
    if (ids.has(item.id)) {
      throw new Agent365ConnectorError(
        'malformed-response',
        'Agent 365 composition produced a duplicate aggregate identifier.',
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
