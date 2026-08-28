import type {
  CatalogConnectorEntry,
  ConnectorsCollectionResponse,
  ConnectorHealthReport,
} from '@agent-sentinel/connector-sdk'

/**
 * Static catalog of all approved and planned agent data connectors.
 * Lifecycle states are honest: only mutate per active connector mode.
 */
const BASE_CATALOG: readonly CatalogConnectorEntry[] = [
  {
    id: 'azure-ai-foundry',
    name: 'Azure AI Foundry',
    description:
      'Discovers declared agent and function-tool configuration from Azure AI Foundry Agent Service. Runtime behavior is not collected by this connector.',
    lifecycleState: 'available-to-configure',
    capabilities: ['discovery'],
    sourceOfTruth: true,
    ownershipModel: 'consumes',
    prerequisiteNote:
      'Supports one or more tenant/project sources. Legacy FOUNDRY_PROJECT_ENDPOINT settings remain valid; FOUNDRY_SOURCES_JSON adds sources with independent default or secretless federated-app credentials.',
    unlocksScorecard: ['security', 'governance', 'lifecycle'],
  },
  {
    id: 'm365-agent-registry',
    name: 'Microsoft Agent 365',
    description:
      'Reads the official Microsoft Graph v1.0 Agent 365 package catalog foundation as authoritative package inventory. This connector is read-only and never calls package management write operations.',
    lifecycleState: 'authorization-required',
    capabilities: ['discovery'],
    sourceOfTruth: true,
    ownershipModel: 'consumes',
    prerequisiteNote:
      'Implemented read-only and disabled by default. Activation remains authorization-required until Microsoft Agent 365 licensing and tenant-admin CopilotPackages.Read.All application consent are separately approved; only the Global service is supported.',
    unlocksScorecard: ['governance', 'lifecycle'],
  },
  {
    id: 'entra-agent-id',
    name: 'Microsoft Entra Agent ID & Entitlements',
    description:
      'Reads authoritative Microsoft Entra service-principal inventory from Microsoft Graph v1.0, with bounded optional owner and app-role enrichment. Preview Agent Identity classification is separately gated and disabled by default.',
    lifecycleState: 'authorization-required',
    capabilities: ['identity', 'entitlement'],
    sourceOfTruth: true,
    ownershipModel: 'consumes',
    prerequisiteNote:
      'Implemented read-only multi-source foundation. Each Entra source id must match a Foundry source and requires tenant-admin Application.Read.All consent plus a default or secretless federated-app credential. AgentIdentity.Read.All remains separate and preview-only.',
    unlocksScorecard: ['security', 'governance'],
  },
  {
    id: 'copilot-studio',
    name: 'Microsoft Copilot Studio',
    description:
      'Reads Power Platform ResourceQuery core inventory for Microsoft Copilot Studio and Microsoft 365 Copilot Agent Builder agents. The Copilot Studio resource schema is preview overall; connectors, channels, authentication, and runtime behavior are not authoritative in this increment.',
    lifecycleState: 'authorization-required',
    capabilities: ['discovery'],
    sourceOfTruth: true,
    ownershipModel: 'consumes',
    prerequisiteNote:
      'Implemented read-only and disabled by default. Each intended tenant scope requires Power Platform Reader (or approved least-privilege ResourceQuery read RBAC); no Graph application permission or RBAC assignment is created by Agent Sentinel.',
    unlocksScorecard: ['security', 'lifecycle'],
  },
  {
    id: 'm365-sharepoint-agents',
    name: 'Microsoft 365 & SharePoint Agents',
    description:
      'Discovers agents embedded in SharePoint sites and Microsoft 365 workloads, including declarative agents published via the Microsoft 365 admin center.',
    lifecycleState: 'planned',
    capabilities: ['discovery', 'data-governance'],
    sourceOfTruth: true,
    ownershipModel: 'consumes',
    unlocksScorecard: ['governance'],
  },
  {
    id: 'teams-distribution',
    name: 'Microsoft Teams Distribution',
    description:
      'Discovers agents distributed through Microsoft Teams app catalog and sideloaded app packages, providing deployment scope and installation coverage evidence.',
    lifecycleState: 'planned',
    capabilities: ['discovery', 'lifecycle-admin'],
    sourceOfTruth: true,
    ownershipModel: 'consumes',
    unlocksScorecard: ['lifecycle'],
  },
  {
    id: 'defender-for-cloud-apps',
    name: 'Microsoft Defender for Cloud Apps',
    description:
      'Supplies security alerts, anomalous behavior signals, and session-level evidence for agent activity. Unlocks evidence-backed exposure findings.',
    lifecycleState: 'planned',
    capabilities: ['security-alerts', 'runtime-telemetry'],
    sourceOfTruth: true,
    ownershipModel: 'consumes',
    unlocksScorecard: ['security', 'reliability'],
  },
  {
    id: 'purview',
    name: 'Microsoft Purview',
    description:
      'Provides data classification, sensitivity labels, and data governance policy signals to enrich agent data access graphs and compliance posture.',
    lifecycleState: 'planned',
    capabilities: ['data-governance'],
    sourceOfTruth: true,
    ownershipModel: 'consumes',
    unlocksScorecard: ['governance'],
  },
  {
    id: 'azure-monitor-otel',
    name: 'Azure Monitor & OpenTelemetry',
    description:
      'Queries OpenTelemetry-compatible agent request spans from Azure Monitor Logs. ' +
      'When configured, it feeds measured windows to deterministic behavior drift and token economics. ' +
      'Until configured, runtime analysis remains typed unknown and no synthetic data is shown in live mode.',
    lifecycleState: 'available-to-configure',
    capabilities: ['runtime-telemetry'],
    sourceOfTruth: true,
    ownershipModel: 'consumes',
    prerequisiteNote:
      'Supports one workspace source per Foundry source id through AZURE_MONITOR_SOURCES_JSON. ' +
      'Each source requires read-only Log Analytics query permission and instrumented spans with the documented OTel attributes.',
    unlocksScorecard: ['cost'],
  },
  {
    id: 'custom-manifest-adapter',
    name: 'Custom Manifest / API Adapter',
    description:
      'Ingests an operator-supplied, read-only agent manifest for custom-built agents that no first-party connector covers. Claims are non-authoritative declared configuration and never override first-party evidence.',
    lifecycleState: 'available-to-configure',
    capabilities: ['discovery'],
    sourceOfTruth: false,
    ownershipModel: 'consumes',
    prerequisiteNote:
      'Local/operator-supplied read-only manifest, non-authoritative evidence, no live API ingestion. Manifests are loaded from an absolute local path or supplied inline; remote URLs are rejected and the adapter performs no actions.',
    unlocksScorecard: ['security', 'governance', 'lifecycle'],
  },
]

/** Derive the Azure AI Foundry lifecycle state from the active connector mode. */
function foundryStateForMode(mode: 'mock' | 'foundry'): 'connected' | 'available-to-configure' {
  return mode === 'foundry' ? 'connected' : 'available-to-configure'
}

/** Build the full connectors collection response from the active connector state. */
export function buildConnectorsCollection(
  mode: 'mock' | 'foundry',
  opts: {
    connectorId: string
    connectionOk?: boolean
    writeEnabled?: boolean
    projectEndpoint?: string
    runtimeTelemetryConfigured?: boolean
    runtimeTelemetryHealth?: ConnectorHealthReport
    connectorHealth?: ConnectorHealthReport
  },
): ConnectorsCollectionResponse {
  const connectionOk = opts.connectionOk !== false
  const discoverySources = opts.connectorHealth?.sources.filter(
    (source) =>
      source.role === 'discovery' &&
      !source.id.startsWith('power-platform:') &&
      !source.id.startsWith('agent365:'),
  )
  const readyDiscoverySources =
    discoverySources?.filter((source) => source.readiness === 'ready').length ?? 0
  const foundryLifecycle =
    mode !== 'foundry'
      ? foundryStateForMode(mode)
      : discoverySources !== undefined &&
          discoverySources.length > 0 &&
          readyDiscoverySources < discoverySources.length &&
          readyDiscoverySources > 0
        ? 'degraded'
        : !connectionOk ||
            (discoverySources !== undefined &&
              discoverySources.length > 0 &&
              readyDiscoverySources === 0)
          ? 'unavailable'
          : 'connected'
  const entraSources = opts.connectorHealth?.sources.filter(
    (source) =>
      source.role === 'enrichment' &&
      (source.id === 'microsoft-entra-service-principals' || source.id.startsWith('entra:')),
  )
  const enabledEntraSources = entraSources?.filter((source) => source.enabled) ?? []
  const enabledPowerPlatformSources =
    opts.connectorHealth?.sources.filter(
      (source) => source.id.startsWith('power-platform:') && source.enabled,
    ) ?? []
  const enabledAgent365Sources =
    opts.connectorHealth?.sources.filter(
      (source) => source.id.startsWith('agent365:') && source.enabled,
    ) ?? []
  const catalog: CatalogConnectorEntry[] = BASE_CATALOG.map((entry) => {
    if (entry.id === 'azure-ai-foundry') {
      return { ...entry, lifecycleState: foundryLifecycle }
    }
    if (entry.id === 'entra-agent-id' && enabledEntraSources.length > 0) {
      const ready = enabledEntraSources.filter((source) => source.readiness === 'ready').length
      return {
        ...entry,
        lifecycleState:
          ready === enabledEntraSources.length
            ? 'connected'
            : ready > 0
              ? 'degraded'
              : 'unavailable',
      }
    }
    if (entry.id === 'copilot-studio' && enabledPowerPlatformSources.length > 0) {
      const ready = enabledPowerPlatformSources.filter(
        (source) => source.readiness === 'ready',
      ).length
      const authorizationRequired = enabledPowerPlatformSources.some(
        (source) => source.readiness === 'authorization-required',
      )
      return {
        ...entry,
        lifecycleState:
          ready === enabledPowerPlatformSources.length
            ? 'connected'
            : ready > 0 ||
                enabledPowerPlatformSources.some((source) => source.readiness === 'degraded')
              ? 'degraded'
              : authorizationRequired
                ? 'authorization-required'
                : 'unavailable',
      }
    }
    if (entry.id === 'm365-agent-registry' && enabledAgent365Sources.length > 0) {
      const ready = enabledAgent365Sources.filter((source) => source.readiness === 'ready').length
      const authorizationRequired = enabledAgent365Sources.some(
        (source) => source.readiness === 'authorization-required',
      )
      return {
        ...entry,
        lifecycleState:
          ready === enabledAgent365Sources.length
            ? 'connected'
            : ready > 0 || enabledAgent365Sources.some((source) => source.readiness === 'degraded')
              ? 'degraded'
              : authorizationRequired
                ? 'authorization-required'
                : 'unavailable',
      }
    }
    if (entry.id === 'azure-monitor-otel' && opts.runtimeTelemetryConfigured === true) {
      const sources = opts.runtimeTelemetryHealth?.sources ?? []
      const ready = sources.filter((source) => source.readiness === 'ready').length
      return {
        ...entry,
        lifecycleState:
          sources.length === 0 || ready === sources.length
            ? 'connected'
            : ready > 0 || sources.some((source) => source.readiness === 'degraded')
              ? 'degraded'
              : 'unavailable',
      }
    }
    return { ...entry }
  })

  const healthSources = [
    ...(opts.connectorHealth?.sources ?? []),
    ...(opts.runtimeTelemetryHealth?.sources ?? []),
  ]
  const combinedHealth =
    healthSources.length === 0
      ? undefined
      : {
          overall:
            opts.connectorHealth?.overall === 'unavailable'
              ? ('unavailable' as const)
              : opts.connectorHealth?.overall === 'degraded' ||
                  (opts.runtimeTelemetryHealth !== undefined &&
                    opts.runtimeTelemetryHealth.overall !== 'ready')
                ? ('degraded' as const)
                : ('ready' as const),
          partial:
            opts.connectorHealth?.partial === true || opts.runtimeTelemetryHealth?.partial === true,
          sources: healthSources,
        }
  return {
    active: {
      id: opts.connectorId,
      mode,
      source: mode,
      lifecycleState:
        opts.connectorHealth?.overall === 'degraded'
          ? 'degraded'
          : connectionOk
            ? 'connected'
            : 'unavailable',
      ...(opts.writeEnabled !== undefined ? { writeEnabled: opts.writeEnabled } : {}),
      ...(opts.projectEndpoint !== undefined ? { projectEndpoint: opts.projectEndpoint } : {}),
    },
    catalog,
    ...(combinedHealth ? { health: combinedHealth } : {}),
  }
}

/** Exported for testing: the unmodified base catalog. */
export { BASE_CATALOG as connectorBaseCatalog }
