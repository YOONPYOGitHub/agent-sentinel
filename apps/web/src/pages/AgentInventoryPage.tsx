import { Badge, Input, Select } from '@fluentui/react-components'
import { BotRegular, InfoRegular, SearchRegular } from '@fluentui/react-icons'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import type { GraphNode } from '@agent-sentinel/domain'
import { PageHeading } from '../components/PageHeading'
import { getAgentStatus } from '../estate'
import { useDemoState } from '../hooks/useDemoState'

type FilterKey = 'platform' | 'environment' | 'owner' | 'trust'
type Filters = Record<FilterKey, string>

const initialFilters: Filters = {
  platform: 'All',
  environment: 'All',
  owner: 'All',
  trust: 'All',
}
const filterKeys: FilterKey[] = ['platform', 'environment', 'owner', 'trust']

function uniqueAgentValues(agents: GraphNode[], key: FilterKey): string[] {
  const values = agents.map((agent) => {
    if (key === 'platform') return agent.metadata.platform ?? 'Custom'
    if (key === 'owner') return agent.owner ?? 'Unassigned'
    if (key === 'trust') return agent.trust ?? 'Unknown'
    return agent.environment
  })
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function agentValue(agent: GraphNode, key: FilterKey): string {
  if (key === 'platform') return agent.metadata.platform ?? 'Custom'
  if (key === 'owner') return agent.owner ?? 'Unassigned'
  if (key === 'trust') return agent.trust ?? 'Unknown'
  return agent.environment
}

function readinessLabel(trust: string | undefined, statusLabel: string): string {
  if (statusLabel === 'Critical') return 'Needs remediation'
  if (trust === 'conditional') return 'Conditional'
  if (trust === 'trusted') return 'Governance ready'
  return 'Unknown'
}

type ReadinessColor = 'danger' | 'warning' | 'success' | 'informative'

function readinessColor(label: string): ReadinessColor {
  if (label === 'Needs remediation') return 'danger'
  if (label === 'Conditional') return 'warning'
  if (label === 'Governance ready') return 'success'
  return 'informative'
}

export function AgentInventoryPage() {
  const { state, connectorStatus } = useDemoState()
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Filters>(initialFilters)

  const agents = useMemo(
    () => state?.snapshot.nodes.filter((node) => node.kind === 'agent') ?? [],
    [state],
  )
  const options = useMemo(
    () => ({
      platform: uniqueAgentValues(agents, 'platform'),
      environment: uniqueAgentValues(agents, 'environment'),
      owner: uniqueAgentValues(agents, 'owner'),
      trust: uniqueAgentValues(agents, 'trust'),
    }),
    [agents],
  )
  const filteredAgents = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return agents.filter((agent) => {
      const matchesText =
        query.length === 0 ||
        [agent.name, agent.owner, agent.environment, agent.metadata.platform].some(
          (value) => value?.toLocaleLowerCase().includes(query) === true,
        )
      const matchesFilters = filterKeys.every(
        (key) => filters[key] === 'All' || agentValue(agent, key) === filters[key],
      )
      return matchesText && matchesFilters
    })
  }, [agents, filters, search])

  function updateFilter(key: FilterKey, value: string) {
    setFilters((current) => ({ ...current, [key]: value }))
  }

  return (
    <>
      <PageHeading
        section="Agent inventory"
        title="Agent inventory"
        description="Organization-wide inventory of every discovered agent — platform, ownership, trust posture, and governance readiness across all environments."
      />
      {connectorStatus !== undefined && (
        <div className="estate-source-banner" role="note">
          <strong>
            {connectorStatus.source === 'foundry' ? 'Live · Azure AI Foundry' : 'Synthetic · Mock'}
          </strong>{' '}
          &nbsp;|&nbsp;
          <strong>Mode:</strong> {connectorStatus.mode}
          {connectorStatus.projectEndpoint !== undefined && (
            <>
              &nbsp;|&nbsp;<strong>Declared configuration:</strong>{' '}
              {connectorStatus.projectEndpoint}
            </>
          )}
        </div>
      )}
      <div className="inventory-evidence-note" role="note">
        <InfoRegular aria-hidden="true" />
        <span>
          Inventory is bounded by connector coverage.{' '}
          {connectorStatus?.source === 'foundry'
            ? 'Live Foundry data is used where available; gaps reflect connector scope, not agent absence.'
            : 'Synthetic data active — connect Azure AI Foundry to see the live organizational inventory.'}
        </span>
      </div>
      <section className="estate-toolbar" aria-label="Agent filters">
        <div className="estate-search">
          <SearchRegular aria-hidden="true" />
          <Input
            value={search}
            onChange={(_event, data) => setSearch(data.value)}
            aria-label="Filter agents by text"
            placeholder="Filter agents"
          />
        </div>
        {(['platform', 'environment', 'owner', 'trust'] satisfies FilterKey[]).map((key) => (
          <label key={key}>
            {key[0]?.toLocaleUpperCase()}
            {key.slice(1)}
            <Select
              aria-label={`Filter agents by ${key}`}
              value={filters[key]}
              onChange={(event) => updateFilter(key, event.target.value)}
            >
              <option>All</option>
              {options[key].map((option) => (
                <option key={option}>{option}</option>
              ))}
            </Select>
          </label>
        ))}
        <strong aria-live="polite">
          {filteredAgents.length} of {agents.length} agents
        </strong>
      </section>
      <section className="estate-table-card" aria-label="Managed agents">
        {filteredAgents.length === 0 ? (
          <div className="table-empty">
            <BotRegular />
            <h2>No agents match these filters</h2>
            <p>Clear the search or select different filters to see managed agents.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="estate-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Platform / Source</th>
                  <th>Owner</th>
                  <th>Environment</th>
                  <th>Version</th>
                  <th>Trust</th>
                  <th>Status</th>
                  <th>Readiness</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {filteredAgents.map((agent) => {
                  const status = getAgentStatus(agent, state?.findings ?? [])
                  const readiness = readinessLabel(agent.trust, status)
                  return (
                    <tr key={agent.id}>
                      <td>
                        <Link to={`/agent-inventory/${agent.id}`}>
                          <strong>{agent.name}</strong>
                          <span>{agent.description}</span>
                        </Link>
                      </td>
                      <td>{agentValue(agent, 'platform')}</td>
                      <td>{agentValue(agent, 'owner')}</td>
                      <td>{agent.environment}</td>
                      <td>{agent.metadata.version ?? '—'}</td>
                      <td>{agentValue(agent, 'trust')}</td>
                      <td>
                        <Badge
                          appearance="tint"
                          color={
                            status === 'Critical'
                              ? 'danger'
                              : status === 'Review'
                                ? 'warning'
                                : 'success'
                          }
                        >
                          {status}
                        </Badge>
                      </td>
                      <td>
                        <Badge appearance="tint" color={readinessColor(readiness)}>
                          {readiness}
                        </Badge>
                      </td>
                      <td>{agent.evidenceIds.length}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
