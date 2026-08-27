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
      'Requires FOUNDRY_PROJECT_ENDPOINT, FOUNDRY_TENANT_ID, and FOUNDRY_ENVIRONMENT. Uses DefaultAzureCredential (az login or managed identity).',
    unlocksScorecard: ['security', 'governance', 'lifecycle'],
  },
  {
    id: 'm365-agent-registry',
    name: 'Microsoft Agent 365',
    description:
      'Authoritative registry and administration source for agents governed through Microsoft Agent 365. Agent Sentinel consumes its records rather than recreating registry operations.',
    lifecycleState: 'authorization-required',
    capabilities: ['discovery', 'lifecycle-admin'],
    sourceOfTruth: true,
    ownershipModel: 'consumes',
    prerequisiteNote:
      'The product is generally available, but this connector is not implemented. It requires a supported management API, tenant admin authorization, and permission review before connection.',
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
      'Implemented read-only foundation. Requires ENTRA_CONNECTOR_TENANT_ID, ENTRA_CONNECTOR_ENVIRONMENT, DefaultAzureCredential, and tenant-admin consent for Application.Read.All. AgentIdentity.Read.All is separate and required only when the explicitly preview-gated beta enrichment is enabled. This is independent of user sign-in.',
    unlocksScorecard: ['security', 'governance'],
  },
  {
    id: 'copilot-studio',
    name: 'Microsoft Copilot Studio',
    description:
      'Discovers agents built and published in Microsoft Copilot Studio, including topic flows, connected data sources, and published channels.',
    lifecycleState: 'planned',
    capabilities: ['discovery'],
    sourceOfTruth: true,
    ownershipModel: 'consumes',
    prerequisiteNote:
      'Requires Power Platform environment access and Copilot Studio admin permissions. Agent inventory is read-only; no write operations are supported.',
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
      'Requires AZURE_MONITOR_WORKSPACE_ID, AZURE_MONITOR_TENANT_ID, and AZURE_MONITOR_ENVIRONMENT. ' +
      'Uses DefaultAzureCredential with read-only Log Analytics query permission. Instrumented agent request spans must emit the documented OTel attributes.',
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
    connectorHealth?: ConnectorHealthReport
  },
): ConnectorsCollectionResponse {
  const connectionOk = opts.connectionOk !== false
  const foundryLifecycle =
    mode === 'foundry' && !connectionOk ? 'unavailable' : foundryStateForMode(mode)
  const entraHealth = opts.connectorHealth?.sources.find(
    (source) => source.id === 'microsoft-entra-service-principals',
  )
  const catalog: CatalogConnectorEntry[] = BASE_CATALOG.map((entry) => {
    if (entry.id === 'azure-ai-foundry') {
      return { ...entry, lifecycleState: foundryLifecycle }
    }
    if (entry.id === 'entra-agent-id' && entraHealth?.enabled === true) {
      return {
        ...entry,
        lifecycleState: entraHealth.readiness === 'ready' ? 'connected' : 'unavailable',
      }
    }
    if (entry.id === 'azure-monitor-otel' && opts.runtimeTelemetryConfigured === true) {
      return { ...entry, lifecycleState: 'connected' }
    }
    return { ...entry }
  })

  return {
    active: {
      id: opts.connectorId,
      mode,
      source: mode,
      lifecycleState: connectionOk ? 'connected' : 'unavailable',
      ...(opts.writeEnabled !== undefined ? { writeEnabled: opts.writeEnabled } : {}),
      ...(opts.projectEndpoint !== undefined ? { projectEndpoint: opts.projectEndpoint } : {}),
    },
    catalog,
    ...(opts.connectorHealth ? { health: opts.connectorHealth } : {}),
  }
}

/** Exported for testing: the unmodified base catalog. */
export { BASE_CATALOG as connectorBaseCatalog }
