import type { AgentSentinelState, ExposurePage } from '@agent-sentinel/domain'

export function overviewPortfolioMetrics(state: AgentSentinelState) {
  const agents = state.snapshot.nodes.filter((node) => node.kind === 'agent')
  const activeFindings = state.findings.filter((item) => item.path.status !== 'mitigated')
  const activeNodeIds = new Set(activeFindings.flatMap((item) => item.path.nodeIds))
  const linkedDataAssets = state.snapshot.nodes.filter(
    (node) => node.kind === 'data' && activeNodeIds.has(node.id),
  )
  const sensitiveAssets = linkedDataAssets.filter(
    (node) => node.sensitivity !== undefined && node.sensitivity !== 'public',
  )
  const publicAssets = linkedDataAssets.filter((node) => node.sensitivity === 'public')
  const unclassifiedAssets = linkedDataAssets.filter((node) => node.sensitivity === undefined)
  const platforms = new Set(
    agents.map((agent) => agent.metadata.platform).filter((value) => value !== undefined),
  )
  const ownedAgents = agents.filter((agent) => agent.owner !== undefined)
  return [
    {
      label: 'Managed agents',
      value: agents.length,
      detail: `${platforms.size} declared platforms`,
      tone: 'neutral',
      icon: 'agents',
    },
    {
      label: 'Critical modeled paths',
      value: activeFindings.filter((item) => item.severity === 'critical').length,
      detail: `${activeFindings.length} active paths`,
      tone: activeFindings.some((item) => item.severity === 'critical') ? 'danger' : 'neutral',
      icon: 'paths',
    },
    {
      label: 'Sensitive assets modeled',
      value: sensitiveAssets.length,
      detail:
        linkedDataAssets.length === 0
          ? 'No data assets on active modeled paths'
          : `${sensitiveAssets.length} explicitly non-public · ${unclassifiedAssets.length} unclassified · ${publicAssets.length} public`,
      tone: sensitiveAssets.length > 0 ? 'warning' : 'neutral',
      icon: 'data',
    },
    {
      label: 'Owned agents',
      value: ownedAgents.length,
      detail: `${agents.length - ownedAgents.length} without a declared owner`,
      tone: ownedAgents.length === agents.length ? 'success' : 'warning',
      icon: 'owners',
    },
  ] as const
}

export function overviewEstateHealth(state: AgentSentinelState) {
  const agents = state.snapshot.nodes.filter((node) => node.kind === 'agent')
  const activeFindings = state.findings.filter((item) => item.path.status !== 'mitigated')
  const governanceAttention = agents.filter(
    (agent) => agent.owner === undefined || agent.trust !== 'trusted',
  ).length
  return [
    {
      label: 'Security',
      status: activeFindings.some((item) => item.severity === 'critical')
        ? 'Critical'
        : activeFindings.length > 0
          ? 'Attention'
          : 'Healthy',
      coverage: 'derived',
      detail: `${activeFindings.length} active evidence-backed path${activeFindings.length === 1 ? '' : 's'}`,
    },
    {
      label: 'Governance',
      status: governanceAttention > 0 ? 'Attention' : 'Healthy',
      coverage: 'derived',
      detail: `${governanceAttention} agent${governanceAttention === 1 ? '' : 's'} missing trusted ownership posture`,
    },
    {
      label: 'Reliability',
      status: 'Unknown',
      coverage: 'unknown',
      detail: 'Agent-level runtime windows are not aggregated into an estate posture',
    },
    {
      label: 'Quality',
      status: 'Unknown',
      coverage: 'unknown',
      detail: 'No evaluation connector is configured',
    },
    {
      label: 'Cost efficiency',
      status: 'Unknown',
      coverage: 'unknown',
      detail: 'Complete measured-cost populations are unavailable',
    },
    {
      label: 'Lifecycle',
      status: 'Unknown',
      coverage: 'unknown',
      detail: 'No estate-level lifecycle aggregation contract is defined',
    },
  ] as const
}

export function overviewCapabilityPosture(state: AgentSentinelState) {
  const capabilities = state.snapshot.nodes.filter(
    (node) => node.kind === 'mcp' || node.kind === 'tool',
  )
  const count = (kind: 'mcp' | 'tool' | undefined, trust: string) =>
    capabilities.filter(
      (node) => (kind === undefined || node.kind === kind) && node.trust === trust,
    ).length
  return [
    [
      'Trusted MCP servers',
      count('mcp', 'trusted'),
      'Declared trusted in current snapshot',
      'safe',
    ],
    ['Trusted tools', count('tool', 'trusted'), 'Declared trusted in current snapshot', 'safe'],
    [
      'Conditional capabilities',
      count(undefined, 'conditional'),
      'Additional review required',
      'warning',
    ],
    [
      'Untrusted discoveries',
      count(undefined, 'untrusted'),
      'Untrusted in current snapshot',
      'danger',
    ],
  ] as const
}

export function overviewEntraIdentityCount(state: AgentSentinelState): number {
  const entraPlatforms = new Set(['Microsoft Entra ID', 'Microsoft Entra Agent ID preview'])
  return state.snapshot.nodes.filter(
    (node) => node.kind === 'identity' && entraPlatforms.has(node.metadata.platform ?? ''),
  ).length
}

export function overviewExposureMetric(
  exposure: ExposurePage | undefined,
  error: string | undefined,
  loading: boolean,
) {
  const state = overviewExposureDisplayState(exposure, error, loading)
  if (state === 'loading' || state === 'unloaded') {
    return {
      value: '—',
      detail: state === 'loading' ? 'Loading live findings' : 'Exposure findings not loaded',
      tone: 'neutral',
    } as const
  }
  if (state === 'unavailable') {
    return { value: '—', detail: 'Exposure counts unavailable', tone: 'warning' } as const
  }
  if (exposure === undefined) {
    if (loading) {
      return { value: '—', detail: 'Loading live findings', tone: 'neutral' } as const
    }
    if (error !== undefined) {
      return { value: '—', detail: 'Exposure counts unavailable', tone: 'warning' } as const
    }
    return { value: '—', detail: 'Exposure findings not loaded', tone: 'neutral' } as const
  }
  const critical = exposure.findings.filter((item) => item.severity === 'critical').length
  const high = exposure.findings.filter((item) => item.severity === 'high').length
  const prefix =
    state === 'refreshing' ? 'Refreshing · last-known · ' : state === 'stale' ? 'Last-known · ' : ''
  return {
    value: exposure.total,
    detail: `${prefix}${critical} critical · ${high} high`,
    tone:
      state === 'refreshing' || state === 'stale' ? 'warning' : critical > 0 ? 'danger' : 'neutral',
  } as const
}

export type OverviewExposureDisplayState =
  'unloaded' | 'loading' | 'unavailable' | 'loaded' | 'refreshing' | 'stale'

export function overviewExposureDisplayState(
  exposure: ExposurePage | undefined,
  error: string | undefined,
  loading: boolean,
): OverviewExposureDisplayState {
  if (exposure === undefined) {
    if (loading) return 'loading'
    return error === undefined ? 'unloaded' : 'unavailable'
  }
  if (loading) return 'refreshing'
  return error === undefined ? 'loaded' : 'stale'
}

export function overviewSnapshotPresentation(
  providerError: string | undefined,
  providerLoading: boolean,
) {
  if (providerLoading) {
    return { heading: 'Refreshing discovery snapshot', badge: 'Refreshing last-known' } as const
  }
  if (providerError !== undefined) {
    return { heading: 'Last-known discovery snapshot', badge: 'Refresh failed' } as const
  }
  return { heading: 'Current discovery snapshot', badge: 'Current' } as const
}
