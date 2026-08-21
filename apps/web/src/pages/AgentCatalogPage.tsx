import { Badge, Input, Select } from '@fluentui/react-components'
import { BotRegular, InfoRegular, LockClosedRegular, SearchRegular } from '@fluentui/react-icons'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import type { GraphNode } from '@agent-sentinel/domain'
import { PageHeading } from '../components/PageHeading'
import { useDemoState } from '../hooks/useDemoState'

type AvailabilityLabel = 'Entitlement unknown' | 'Restricted'

interface CatalogAvailability {
  label: AvailabilityLabel
  color: 'success' | 'informative' | 'danger' | 'warning'
  description: string
}

function deriveAvailability(agent: GraphNode): CatalogAvailability {
  const status = agent.metadata.status
  if (status === 'Development') {
    return {
      label: 'Restricted',
      color: 'danger',
      description: 'Not available — agent is in development and not published for employee use.',
    }
  }
  if (status === 'Published') {
    return {
      label: 'Entitlement unknown',
      color: 'informative',
      description:
        'Agent is published but individual access cannot be determined without Entra ID integration.',
    }
  }
  return {
    label: 'Entitlement unknown',
    color: 'informative',
    description: 'Access status cannot be determined — Entra ID connector is not configured.',
  }
}

export function AgentCatalogPage() {
  const { state } = useDemoState()
  const [search, setSearch] = useState('')
  const [availabilityFilter, setAvailabilityFilter] = useState('All')

  const agents = useMemo(
    () => state?.snapshot.nodes.filter((node) => node.kind === 'agent') ?? [],
    [state],
  )

  const catalogItems = useMemo(
    () =>
      agents.map((agent) => ({
        agent,
        availability: deriveAvailability(agent),
      })),
    [agents],
  )

  const filteredItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return catalogItems.filter(({ agent, availability }) => {
      const matchesText =
        query.length === 0 ||
        [agent.name, agent.description, agent.owner, agent.metadata.platform].some(
          (value) => value?.toLocaleLowerCase().includes(query) === true,
        )
      const matchesAvailability =
        availabilityFilter === 'All' || availability.label === availabilityFilter
      return matchesText && matchesAvailability
    })
  }, [catalogItems, search, availabilityFilter])

  return (
    <>
      <PageHeading
        section="Agent catalog"
        title="Agent assurance catalog"
        description="Employee-facing assurance overlay for discoverable agents. Agent 365 or the publishing platform remains the authoritative store and access control plane."
      />
      <div className="catalog-boundary" role="note">
        <div>
          <InfoRegular aria-hidden="true" />
          <span>
            <strong>Entra ID not connected.</strong> Individual access entitlements cannot be
            determined until Microsoft Entra ID is configured. Availability shown here reflects
            agent publication evidence, not your personal access rights. Entra group and license
            entitlement evidence will personalize this view after connector integration.
          </span>
        </div>
      </div>
      <section className="catalog-toolbar" aria-label="Catalog filters">
        <div className="catalog-search">
          <SearchRegular aria-hidden="true" />
          <Input
            value={search}
            onChange={(_event, data) => setSearch(data.value)}
            aria-label="Search agent catalog"
            placeholder="Search agents by name, description, or owner"
          />
        </div>
        <label>
          Availability
          <Select
            aria-label="Filter by availability"
            value={availabilityFilter}
            onChange={(event) => setAvailabilityFilter(event.target.value)}
          >
            <option>All</option>
            <option>Entitlement unknown</option>
            <option>Restricted</option>
          </Select>
        </label>
        <strong aria-live="polite">
          {filteredItems.length} of {catalogItems.length} agents
        </strong>
      </section>
      {filteredItems.length === 0 ? (
        <div className="catalog-empty">
          <BotRegular aria-hidden="true" />
          <h2>No agents match these filters</h2>
          <p>Clear the search or change the availability filter to browse the catalog.</p>
        </div>
      ) : (
        <div className="catalog-grid" aria-label="Governed agent catalog">
          {filteredItems.map(({ agent, availability }) => (
            <article key={agent.id} className="catalog-item">
              <div className="catalog-item__header">
                <span className="catalog-item__icon">
                  <BotRegular aria-hidden="true" />
                </span>
                <div>
                  <Badge appearance="tint" color={availability.color}>
                    {availability.label}
                  </Badge>
                  <h2>
                    <Link to={`/agent-inventory/${agent.id}`}>{agent.name}</Link>
                  </h2>
                  <span>{agent.metadata.platform ?? 'Unknown platform'}</span>
                </div>
              </div>
              <p>{agent.description}</p>
              <dl>
                <div>
                  <dt>Owner</dt>
                  <dd>{agent.owner ?? 'Unassigned'}</dd>
                </div>
                <div>
                  <dt>Environment</dt>
                  <dd>{agent.environment}</dd>
                </div>
                {agent.metadata.version !== undefined && (
                  <div>
                    <dt>Version</dt>
                    <dd>{agent.metadata.version}</dd>
                  </div>
                )}
              </dl>
              <div className="catalog-item__entitlement-note">
                <LockClosedRegular aria-hidden="true" />
                <small>{availability.description}</small>
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="catalog-entra-note" role="note">
        <strong>This is not a replacement agent store.</strong> Agent 365 or the source platform
        remains authoritative for publishing, assignment, and launch. Configure identity and
        entitlement evidence in <Link to="/connectors">Connectors</Link> to personalize this
        assurance view.
      </div>
    </>
  )
}
