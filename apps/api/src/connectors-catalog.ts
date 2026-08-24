import type {
  CatalogConnectorEntry,
  ConnectorsCollectionResponse,
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
      'Provides authoritative agent identity principals and entitlement evidence from Microsoft Entra ID. This is separate from the Entra sign-in used for Agent Sentinel users.',
    lifecycleState: 'planned',
    capabilities: ['identity', 'entitlement'],
    sourceOfTruth: true,
    ownershipModel: 'consumes',
    prerequisiteNote:
      'Agent Sentinel uses Microsoft Entra ID for user sign-in authentication. This connector is separate: it reads agent service principals and entitlement assignments to enrich exposure and governance evidence.',
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
      'Ingests agent runtime telemetry via OpenTelemetry-compatible traces and Azure Monitor logs. ' +
      'When connected, it unlocks the deterministic behavior-baseline and drift-analysis engine ' +
      '(already implemented) and replaces synthetic mock observations with real per-agent telemetry. ' +
      'Until connected, quality/reliability/cost/drift remain unknown and no synthetic data is shown in live mode.',
    lifecycleState: 'planned',
    capabilities: ['runtime-telemetry'],
    sourceOfTruth: true,
    ownershipModel: 'consumes',
    prerequisiteNote:
      'Requires Azure Monitor workspace and OTEL_EXPORTER_OTLP_ENDPOINT or Application Insights connection string. ' +
      'Agent instrumentation must emit OTel spans. The behavior-baseline engine is ready; ' +
      'only the ingestion pipeline from OTel spans to ObservationWindow objects is absent.',
    unlocksScorecard: ['quality', 'reliability', 'cost'],
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
  },
): ConnectorsCollectionResponse {
  const connectionOk = opts.connectionOk !== false
  const foundryLifecycle =
    mode === 'foundry' && !connectionOk ? 'unavailable' : foundryStateForMode(mode)
  const catalog: CatalogConnectorEntry[] = BASE_CATALOG.map((entry) => {
    if (entry.id === 'azure-ai-foundry') {
      return { ...entry, lifecycleState: foundryLifecycle }
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
  }
}

/** Exported for testing: the unmodified base catalog. */
export { BASE_CATALOG as connectorBaseCatalog }
