import { createHash } from 'node:crypto'

import {
  assertEstateSnapshot,
  type EstateSnapshot,
  type Evidence,
  type GraphNode,
} from '@agent-sentinel/domain'

import { PowerPlatformConnectorError } from './client.js'
import type { PowerPlatformResourceItem, PowerPlatformSourceConfig } from './schemas.js'

function compactMetadata(
  values: Record<string, string | null | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== null,
    ),
  )
}

function stableResourceNamespace(
  source: PowerPlatformSourceConfig,
  resource: PowerPlatformResourceItem,
): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        'power-platform',
        source.id,
        source.tenantId.toLowerCase(),
        source.environment,
        resource.type.toLowerCase(),
        resource.name.toLowerCase(),
      ]),
    )
    .digest('hex')
    .slice(0, 32)
  return `power-platform-${hash}`
}

export function mapPowerPlatformAgentsToSnapshot(
  resources: readonly PowerPlatformResourceItem[],
  source: PowerPlatformSourceConfig,
  observedAt = new Date().toISOString(),
): EstateSnapshot {
  const nodes: GraphNode[] = []
  const evidence: Evidence[] = []
  const ids = new Set<string>()
  for (const resource of [...resources].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const resourceEnvironment = resource.environmentId ?? resource.properties.environmentId
    if (
      resource.tenantId.toLowerCase() !== source.tenantId.toLowerCase() ||
      resourceEnvironment !== source.environment
    ) {
      throw new PowerPlatformConnectorError(
        'malformed-response',
        'Power Platform resource does not match its configured source boundary.',
      )
    }
    const namespace = stableResourceNamespace(source, resource)
    const nodeId = `${namespace}-agent`
    const evidenceId = `${namespace}-evidence`
    if (ids.has(nodeId) || ids.has(evidenceId)) {
      throw new PowerPlatformConnectorError(
        'malformed-response',
        'Power Platform returned a duplicate provider object.',
      )
    }
    ids.add(nodeId)
    ids.add(evidenceId)
    const properties = resource.properties
    const environmentId = resourceEnvironment
    const identity = compactMetadata({
      entraAppId: properties.entraAppId,
      entraAgentId: properties.entraAgentId,
      entraAgentIdentityId: properties.entraAgentId,
      entraAgentBlueprintId: properties.entraAgentBlueprintId,
      agentIdentityBlueprintId: properties.entraAgentBlueprintId,
    })
    const provenance = {
      sourceConnector: 'power-platform',
      sourceConnectorId: source.id,
      sourceConnectorName: source.name,
      sourceTenantId: source.tenantId,
      sourceEnvironment: source.environment,
      sourceEnvironmentId: environmentId,
      sourceProviderType: resource.type,
      sourceProviderObjectId: resource.name,
    }
    nodes.push({
      id: nodeId,
      kind: 'agent',
      name: properties.displayName ?? properties.name ?? resource.name,
      description:
        'Authoritative Copilot Studio or Microsoft 365 Copilot Agent Builder inventory record.',
      environment: source.environment,
      evidenceIds: [evidenceId],
      metadata: {
        platform: 'Microsoft Power Platform ResourceQuery',
        sourceOfTruth: 'true',
        providerObjectId: resource.name,
        providerType: resource.type,
        environmentId,
        ...provenance,
        ...compactMetadata({
          location: resource.location,
          environmentName: resource.environmentName,
          environmentDisplayName: resource.environmentDisplayName,
          agentName: properties.name,
          createdAt: properties.createdAt,
          createdBy: properties.createdBy,
          ownerId: properties.ownerId,
          lastPublishedAt: properties.lastPublishedAt,
          createdIn: properties.createdIn,
          schemaName: properties.schemaName,
        }),
        ...identity,
      },
    })
    evidence.push({
      id: evidenceId,
      source: `Microsoft Power Platform ResourceQuery · ${source.name}`,
      sourceObjectId: `${source.id}:${resource.name}`,
      observedAt,
      freshness: 'live',
      confidence: 1,
      summary: `Authoritative core agent inventory record for ${properties.displayName ?? resource.name}; no runtime, tool, channel, authentication, or entitlement behavior is inferred.`,
      metadata: {
        ...provenance,
        providerObjectId: resource.name,
        environmentId,
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

export interface PowerPlatformSourceSnapshot {
  source: PowerPlatformSourceConfig
  snapshot: EstateSnapshot
}

export function mergePowerPlatformSnapshots(
  base: EstateSnapshot,
  additions: readonly PowerPlatformSourceSnapshot[],
): EstateSnapshot {
  for (const { source, snapshot } of additions) {
    if (snapshot.tenantId.toLowerCase() !== source.tenantId.toLowerCase()) {
      throw new PowerPlatformConnectorError(
        'malformed-response',
        'Power Platform snapshot does not match its configured tenant boundary.',
      )
    }
    if (snapshot.environment !== source.environment) {
      throw new PowerPlatformConnectorError(
        'malformed-response',
        'Power Platform snapshot does not match its configured environment boundary.',
      )
    }
  }
  const nodes = [...base.nodes, ...additions.flatMap(({ snapshot }) => snapshot.nodes)]
  const edges = [...base.edges, ...additions.flatMap(({ snapshot }) => snapshot.edges)]
  const evidence = [...base.evidence, ...additions.flatMap(({ snapshot }) => snapshot.evidence)]
  const ids = new Set<string>()
  for (const item of [...nodes, ...edges, ...evidence]) {
    if (ids.has(item.id)) {
      throw new PowerPlatformConnectorError(
        'malformed-response',
        'Power Platform composition produced a duplicate aggregate ID.',
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
