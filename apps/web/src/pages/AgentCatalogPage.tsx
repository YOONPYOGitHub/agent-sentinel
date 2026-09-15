import { Badge, Input, Select } from '@fluentui/react-components'
import { BotRegular, InfoRegular, SearchRegular } from '@fluentui/react-icons'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import type { Evidence, GraphNode } from '@agent-sentinel/domain'
import { PageHeading } from '../components/PageHeading'
import { useAuth } from '../hooks/useAuth'
import { useDemoState } from '../hooks/useDemoState'

type CatalogSource = 'Agent 365' | 'Microsoft Foundry' | 'Other'

interface CatalogItem {
  agent: GraphNode
  source: CatalogSource
  platform: string
  synthetic: boolean
}

function isTrue(value: string | undefined): boolean {
  return value?.toLocaleLowerCase() === 'true'
}

function catalogSource(agent: GraphNode): CatalogSource {
  if (
    agent.metadata['sourceConnector'] === 'agent365-package-catalog' ||
    agent.metadata['inventoryEntityType'] === 'agent-package'
  ) {
    return 'Agent 365'
  }
  if (agent.metadata['platform']?.toLocaleLowerCase().includes('foundry') === true) {
    return 'Microsoft Foundry'
  }
  return 'Other'
}

function catalogPlatform(agent: GraphNode): string {
  return (
    agent.metadata['packagePlatform'] ??
    agent.metadata['platform'] ??
    agent.metadata['sourceConnectorName'] ??
    'Platform not provided'
  )
}

function isSyntheticAgent(agent: GraphNode, evidence: readonly Evidence[]): boolean {
  if (
    isTrue(agent.metadata['synthetic']) ||
    isTrue(agent.metadata['syntheticOnly']) ||
    isTrue(agent.metadata['testOnly']) ||
    agent.metadata['trustAssessmentSourceMode'] === 'synthetic'
  ) {
    return true
  }
  const evidenceIds = new Set(agent.evidenceIds)
  return evidence.some(
    (item) =>
      evidenceIds.has(item.id) &&
      (item.evidenceTypes.includes('synthetic_validation') ||
        item.metadata?.['sourceMode'] === 'synthetic' ||
        isTrue(item.metadata?.['synthetic']) ||
        isTrue(item.metadata?.['testOnly'])),
  )
}

function sourceBoundary(item: CatalogItem): string {
  if (item.source === 'Agent 365') {
    return 'Authoritative package catalog evidence only; entitlement, installation, trust, and runtime use are not established.'
  }
  if (item.source === 'Microsoft Foundry') {
    return item.synthetic
      ? 'Synthetic/test Foundry declared configuration; not production use or observed runtime behavior.'
      : 'Foundry declared configuration; not proof of entitlement, trust, or observed runtime behavior.'
  }
  return 'Discovered catalog evidence; verify source authority and runtime state separately.'
}

export function AgentCatalogPage() {
  const { state } = useDemoState()
  const { isConfigured } = useAuth()
  const [search, setSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [platformFilter, setPlatformFilter] = useState('')

  const items = useMemo(() => {
    if (state === undefined) return []
    return state.snapshot.nodes
      .filter((node) => node.kind === 'agent')
      .map((agent) => ({
        agent,
        source: catalogSource(agent),
        platform: catalogPlatform(agent),
        synthetic: isSyntheticAgent(agent, state.snapshot.evidence),
      }))
      .sort((left, right) => left.agent.name.localeCompare(right.agent.name))
  }, [state])

  const sources = useMemo(() => [...new Set(items.map((item) => item.source))].sort(), [items])
  const platforms = useMemo(() => [...new Set(items.map((item) => item.platform))].sort(), [items])
  const filteredItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return items.filter((item) => {
      const matchesText =
        query.length === 0 ||
        [
          item.agent.name,
          item.agent.description,
          item.agent.owner,
          item.platform,
          item.source,
          item.agent.metadata['publisher'],
        ].some((value) => value?.toLocaleLowerCase().includes(query) === true)
      return (
        matchesText &&
        (sourceFilter.length === 0 || item.source === sourceFilter) &&
        (platformFilter.length === 0 || item.platform === platformFilter)
      )
    })
  }, [items, platformFilter, search, sourceFilter])

  const agent365Count = items.filter((item) => item.source === 'Agent 365').length
  const foundryCount = items.filter((item) => item.source === 'Microsoft Foundry').length
  const syntheticCount = items.filter((item) => item.synthetic).length

  return (
    <>
      <PageHeading
        section="Agent catalog"
        title="Agent assurance catalog"
        description="Organization-wide catalog evidence for authorized operators across connected agent platforms."
      />
      <div className="catalog-boundary" role="note">
        <InfoRegular aria-hidden="true" />
        <div>
          <strong>Catalog evidence is not access or runtime evidence.</strong>
          <span>
            Agent 365 entries are authoritative package records, not proof of entitlement,
            installation, trust, or runtime use. Foundry entries are declared configuration, and
            synthetic or test records remain visibly labeled.
          </span>
        </div>
      </div>
      <section className="catalog-summary" aria-label="Agent catalog summary">
        <CatalogMetric label="Catalog records" value={items.length} detail="All agent nodes" />
        <CatalogMetric
          label="Agent 365 packages"
          value={agent365Count}
          detail="Agent-package records"
        />
        <CatalogMetric
          label="Foundry records"
          value={foundryCount}
          detail="Declared agent configuration"
        />
        <CatalogMetric
          label="Synthetic / test"
          value={syntheticCount}
          detail="Explicitly marked records"
        />
      </section>
      <section className="catalog-toolbar" aria-label="Catalog filters">
        <div className="catalog-search">
          <SearchRegular aria-hidden="true" />
          <Input
            value={search}
            onChange={(_event, data) => setSearch(data.value)}
            aria-label="Search agent catalog"
            placeholder="Search name, description, owner, platform, or publisher"
          />
        </div>
        <label>
          Source
          <Select
            aria-label="Filter by source"
            value={sourceFilter}
            onChange={(_event, data) => setSourceFilter(data.value)}
          >
            <option value="">All sources</option>
            {sources.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </Select>
        </label>
        <label>
          Platform
          <Select
            aria-label="Filter by platform"
            value={platformFilter}
            onChange={(_event, data) => setPlatformFilter(data.value)}
          >
            <option value="">All platforms</option>
            {platforms.map((platform) => (
              <option key={platform} value={platform}>
                {platform}
              </option>
            ))}
          </Select>
        </label>
        <strong aria-live="polite">
          {filteredItems.length} of {items.length} records
        </strong>
      </section>
      {filteredItems.length === 0 ? (
        <div className="catalog-empty">
          <BotRegular aria-hidden="true" />
          <h2>No catalog records match these filters</h2>
          <p>Clear the search or change the source and platform filters.</p>
        </div>
      ) : (
        <div className="catalog-grid" aria-label="Organization agent assurance catalog">
          {filteredItems.map((item) => (
            <article key={item.agent.id} className="catalog-item">
              <div className="catalog-item__header">
                <span className="catalog-item__icon">
                  <BotRegular aria-hidden="true" />
                </span>
                <div>
                  <Badge appearance="tint" color={item.synthetic ? 'warning' : 'informative'}>
                    {item.synthetic
                      ? 'Synthetic / test'
                      : item.source === 'Agent 365'
                        ? 'Package record'
                        : 'Declared record'}
                  </Badge>
                  <h2>
                    <Link to={`/agent-inventory/${item.agent.id}`}>{item.agent.name}</Link>
                  </h2>
                  <span>{item.source}</span>
                </div>
              </div>
              <p>{item.agent.description}</p>
              <dl>
                <div>
                  <dt>Platform</dt>
                  <dd>{item.platform}</dd>
                </div>
                <div>
                  <dt>Environment</dt>
                  <dd>{item.agent.environment}</dd>
                </div>
                <div>
                  <dt>Owner</dt>
                  <dd>{item.agent.owner ?? 'Not provided'}</dd>
                </div>
                <div>
                  <dt>Version</dt>
                  <dd>{item.agent.metadata['version'] || 'Not provided'}</dd>
                </div>
              </dl>
              <div className="catalog-item__entitlement-note">
                <InfoRegular aria-hidden="true" />
                <small>{sourceBoundary(item)}</small>
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="catalog-entra-note" role="note">
        <strong>This is not a replacement agent store.</strong> Publishing, assignment, launch, and
        revocation remain controlled by Agent 365 or the source platform.
        {isConfigured ? (
          <>
            {' '}
            <Link to="/my-agents">My agents</Link> provides the separate personalized view backed
            only by authoritative entitlement evidence.
          </>
        ) : (
          ' Personalized results are unavailable until authentication is configured.'
        )}
      </div>
    </>
  )
}

function CatalogMetric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <article className="catalog-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}
