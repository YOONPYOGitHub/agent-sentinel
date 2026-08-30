import { createHash } from 'node:crypto'

import {
  assertEstateSnapshot,
  type EstateSnapshot,
  type Evidence,
  type GraphNode,
} from '@agent-sentinel/domain'

import { AzureResourceGraphConnectorError } from './client.js'
import type { AzureResourceGraphResource, AzureResourceGraphSourceConfig } from './schemas.js'

function stableNamespace(source: AzureResourceGraphSourceConfig, resourceId: string): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        'azure-resource-graph-inventory',
        source.id,
        source.tenantId.toLowerCase(),
        source.environment,
        resourceId.toLowerCase(),
      ]),
    )
    .digest('hex')
    .slice(0, 40)
  return `arg-${hash}`
}

function compactMetadata(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

export function mapAzureResourcesToSnapshot(
  resources: readonly AzureResourceGraphResource[],
  source: AzureResourceGraphSourceConfig,
  observedAt = new Date().toISOString(),
): EstateSnapshot {
  const nodes: GraphNode[] = []
  const evidence: Evidence[] = []
  const providerIds = new Set<string>()
  for (const resource of [...resources].sort((left, right) => left.id.localeCompare(right.id))) {
    const providerId = resource.id.toLowerCase()
    if (providerIds.has(providerId)) {
      throw new AzureResourceGraphConnectorError(
        'malformed-response',
        'Azure Resource Graph returned a duplicate resource identifier.',
      )
    }
    if (
      !source.subscriptions.some(
        (subscription) => subscription.toLowerCase() === resource.subscriptionId.toLowerCase(),
      )
    ) {
      throw new AzureResourceGraphConnectorError(
        'malformed-response',
        'Azure resource does not match the configured subscription boundary.',
      )
    }
    providerIds.add(providerId)
    const namespace = stableNamespace(source, resource.id)
    const evidenceId = `${namespace}-evidence`
    const metadata = compactMetadata({
      sourceConnector: 'azure-resource-graph',
      sourceConnectorId: source.id,
      sourceConnectorName: source.name,
      sourceTenantId: source.tenantId,
      sourceEnvironment: source.environment,
      sourceProviderObjectId: resource.id,
      providerResourceId: resource.id,
      providerResourceType: resource.type,
      subscriptionId: resource.subscriptionId,
      resourceGroup: resource.resourceGroup,
      location: resource.location,
      resourceKind: resource.resourceKind,
      skuName: resource.skuName,
      identityType: resource.identityType,
      observationType: 'azure-resource-inventory',
      attribution: 'unattributed',
    })
    nodes.push({
      id: `${namespace}-control`,
      kind: 'control',
      name: resource.name,
      description:
        'Direct Azure Resource Graph inventory observation. Resource presence does not identify an AI agent, runtime behavior, ownership, health, trust, or compliance.',
      environment: source.environment,
      evidenceIds: [evidenceId],
      metadata,
    })
    evidence.push({
      id: evidenceId,
      source: `Azure Resource Graph ${AZURE_RESOURCE_GRAPH_API_LABEL} · ${source.name}`,
      sourceObjectId: `${source.id}:${resource.id}`,
      observedAt,
      freshness: 'live',
      confidence: 1,
      evidenceTypes: ['declared_configuration'],
      summary:
        'Direct Azure resource inventory only; confidence does not indicate agent classification, runtime activity, ownership, health, trust, or compliance.',
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

const AZURE_RESOURCE_GRAPH_API_LABEL = 'REST 2022-10-01'

export interface AzureResourceGraphSourceSnapshot {
  source: AzureResourceGraphSourceConfig
  snapshot: EstateSnapshot
}

export function mergeAzureResourceGraphSnapshots(
  base: EstateSnapshot,
  additions: readonly AzureResourceGraphSourceSnapshot[],
): EstateSnapshot {
  for (const { source, snapshot } of additions) {
    if (
      snapshot.tenantId.toLowerCase() !== source.tenantId.toLowerCase() ||
      snapshot.environment !== source.environment
    ) {
      throw new AzureResourceGraphConnectorError(
        'malformed-response',
        'Azure Resource Graph snapshot does not match its configured source boundary.',
      )
    }
  }
  const nodes = [...base.nodes, ...additions.flatMap(({ snapshot }) => snapshot.nodes)]
  const edges = [...base.edges, ...additions.flatMap(({ snapshot }) => snapshot.edges)]
  const evidence = [...base.evidence, ...additions.flatMap(({ snapshot }) => snapshot.evidence)]
  const ids = new Set<string>()
  for (const item of [...nodes, ...edges, ...evidence]) {
    if (ids.has(item.id)) {
      throw new AzureResourceGraphConnectorError(
        'malformed-response',
        'Azure Resource Graph composition produced a duplicate aggregate identifier.',
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
