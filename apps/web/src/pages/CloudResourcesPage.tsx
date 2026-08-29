import { Badge, Button, Input, Select } from '@fluentui/react-components'
import {
  ArrowClockwiseRegular,
  DataUsageRegular,
  InfoRegular,
  SearchRegular,
} from '@fluentui/react-icons'
import { useEffect, useMemo, useState } from 'react'

import type { Evidence, GraphNode } from '@agent-sentinel/domain'

import { EvidenceDrawer } from '../components/EvidenceDrawer'
import { PageHeading } from '../components/PageHeading'
import { useDemoState } from '../hooks/useDemoState'
import { useEvidenceDrawer } from '../hooks/useEvidenceDrawer'

type FilterKey = 'resourceType' | 'resourceGroup' | 'location' | 'subscriptionId'
type Filters = Record<FilterKey, string>

const initialFilters: Filters = {
  resourceType: 'All',
  resourceGroup: 'All',
  location: 'All',
  subscriptionId: 'All',
}

function resourceValue(resource: GraphNode, key: FilterKey): string {
  const metadata = resource.metadata
  if (key === 'resourceType') return metadata.providerResourceType ?? 'Unknown'
  if (key === 'resourceGroup') return metadata.resourceGroup ?? 'Unknown'
  if (key === 'location') return metadata.location ?? 'Global or unspecified'
  return metadata.subscriptionId ?? 'Unknown'
}

function uniqueValues(resources: GraphNode[], key: FilterKey): string[] {
  return [...new Set(resources.map((resource) => resourceValue(resource, key)))].sort(
    (left, right) => left.localeCompare(right),
  )
}

function shortSubscription(value: string): string {
  return value.length > 12 ? `...${value.slice(-12)}` : value
}

function evidenceForResource(
  resource: GraphNode,
  evidenceById: ReadonlyMap<string, Evidence>,
): Evidence | undefined {
  return resource.evidenceIds
    .map((evidenceId) => evidenceById.get(evidenceId))
    .find((evidence) => evidence !== undefined)
}

export function CloudResourcesPage() {
  const { error, load, operation, state } = useDemoState()
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Filters>(initialFilters)
  const { selectedEvidence, setSelectedEvidence, drawerRef, trapFocus } = useEvidenceDrawer()

  const resources = useMemo(
    () =>
      (state?.snapshot.nodes ?? []).filter(
        (node) =>
          node.kind === 'control' && node.metadata.sourceConnector === 'azure-resource-graph',
      ),
    [state?.snapshot.nodes],
  )
  const evidenceById = useMemo(
    () => new Map((state?.snapshot.evidence ?? []).map((evidence) => [evidence.id, evidence])),
    [state?.snapshot.evidence],
  )
  const options = useMemo(
    () => ({
      resourceType: uniqueValues(resources, 'resourceType'),
      resourceGroup: uniqueValues(resources, 'resourceGroup'),
      location: uniqueValues(resources, 'location'),
      subscriptionId: uniqueValues(resources, 'subscriptionId'),
    }),
    [resources],
  )
  const filteredResources = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return resources.filter((resource) => {
      const matchesText =
        query.length === 0 ||
        [
          resource.name,
          resource.metadata.providerResourceId,
          resource.metadata.providerResourceType,
          resource.metadata.resourceGroup,
          resource.metadata.location,
        ].some((value) => value?.toLocaleLowerCase().includes(query) === true)
      const matchesFilters = (Object.keys(initialFilters) as FilterKey[]).every(
        (key) => filters[key] === 'All' || resourceValue(resource, key) === filters[key],
      )
      return matchesText && matchesFilters
    })
  }, [filters, resources, search])

  useEffect(() => {
    setFilters((current) => {
      let changed = false
      const next = { ...current }
      for (const key of Object.keys(initialFilters) as FilterKey[]) {
        if (current[key] !== 'All' && !options[key].includes(current[key])) {
          next[key] = 'All'
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [options])

  function updateFilter(key: FilterKey, value: string) {
    setFilters((current) => ({ ...current, [key]: value }))
  }

  return (
    <>
      <PageHeading
        section="Cloud inventory"
        title="Cloud resources"
        description="Azure AI and supporting resources directly observed through Azure Resource Graph within the connector identity's authorized view."
        actions={
          <Button
            appearance="secondary"
            icon={<ArrowClockwiseRegular />}
            disabled={operation !== undefined}
            onClick={() => void load()}
          >
            Reload snapshot
          </Button>
        }
      />

      <div className="inventory-evidence-note" role="note">
        <InfoRegular aria-hidden="true" />
        <span>
          Resource presence is direct evidence, not agent classification. This view does not infer
          runtime activity, ownership, health, trust, or compliance. Missing resources may reflect
          the connector identity&apos;s RBAC scope.
        </span>
      </div>

      {error !== undefined ? (
        <div className="inventory-evidence-note" role="alert">
          <InfoRegular aria-hidden="true" />
          <span> Snapshot reload failed; showing the last persisted snapshot. {error}</span>
        </div>
      ) : null}

      <section className="estate-toolbar" aria-label="Cloud resource filters">
        <div className="estate-search">
          <SearchRegular aria-hidden="true" />
          <Input
            value={search}
            onChange={(_event, data) => setSearch(data.value)}
            aria-label="Filter cloud resources by text"
            placeholder="Filter cloud resources"
          />
        </div>
        {(
          [
            ['resourceType', 'Resource type'],
            ['resourceGroup', 'Resource group'],
            ['location', 'Location'],
            ['subscriptionId', 'Subscription'],
          ] satisfies Array<[FilterKey, string]>
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <Select
              aria-label={`Filter cloud resources by ${label.toLocaleLowerCase()}`}
              value={filters[key]}
              onChange={(event) => updateFilter(key, event.target.value)}
            >
              <option>All</option>
              {options[key].map((option) => (
                <option key={option} value={option}>
                  {key === 'subscriptionId' ? shortSubscription(option) : option}
                </option>
              ))}
            </Select>
          </label>
        ))}
        <strong aria-live="polite">
          {filteredResources.length} of {resources.length} resources
        </strong>
      </section>

      <section className="estate-table-card" aria-label="Observed cloud resources">
        {filteredResources.length === 0 ? (
          <div className="table-empty">
            <DataUsageRegular aria-hidden="true" />
            <h2>
              {resources.length === 0 ? 'No authorized resources observed' : 'No resources match'}
            </h2>
            <p>
              {resources.length === 0
                ? 'Enable and successfully query Azure Resource Graph, or review the connector identity RBAC scope.'
                : 'Clear the search or select different filters.'}
            </p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="estate-table">
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Type</th>
                  <th>Resource group</th>
                  <th>Location</th>
                  <th>Subscription</th>
                  <th>Observed configuration</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {filteredResources.map((resource) => {
                  const evidence = evidenceForResource(resource, evidenceById)
                  const configuration = [
                    resource.metadata.resourceKind,
                    resource.metadata.skuName,
                    resource.metadata.identityType,
                  ].filter((value): value is string => value !== undefined)
                  return (
                    <tr key={resource.id}>
                      <td>
                        <strong>{resource.name}</strong>
                        <span>{resource.metadata.providerResourceId ?? 'ARM ID unavailable'}</span>
                      </td>
                      <td>{resourceValue(resource, 'resourceType')}</td>
                      <td>{resourceValue(resource, 'resourceGroup')}</td>
                      <td>{resourceValue(resource, 'location')}</td>
                      <td>{shortSubscription(resourceValue(resource, 'subscriptionId'))}</td>
                      <td>
                        {configuration.length > 0 ? configuration.join(' · ') : 'Not projected'}
                      </td>
                      <td>
                        {evidence === undefined ? (
                          <Badge appearance="outline">Unavailable</Badge>
                        ) : (
                          <Button
                            appearance="subtle"
                            size="small"
                            onClick={() => setSelectedEvidence(evidence)}
                          >
                            View evidence
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <EvidenceDrawer
        evidence={selectedEvidence}
        drawerRef={drawerRef}
        onClose={() => setSelectedEvidence(undefined)}
        onKeyDown={trapFocus}
      />
    </>
  )
}
