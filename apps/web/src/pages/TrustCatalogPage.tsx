import { Badge, Button, Input, Select } from '@fluentui/react-components'
import {
  BotRegular,
  CloudRegular,
  DismissRegular,
  SearchRegular,
  ShieldCheckmarkRegular,
  WrenchRegular,
} from '@fluentui/react-icons'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { Link } from 'react-router-dom'

import type { AgentSentinelState, GraphNode, NodeKind } from '@agent-sentinel/domain'

import { PageHeading } from '../components/PageHeading'
import { useDemoState } from '../hooks/useDemoState'

type CatalogKind = Extract<NodeKind, 'agent' | 'mcp' | 'tool'>
type CatalogTrust = NonNullable<GraphNode['trust']> | 'unknown'

interface CatalogItem {
  node: GraphNode
  kind: CatalogKind
  trust: CatalogTrust
  catalogStatus: string
  publisher: string
  protocol: string
  evidenceSources: string[]
  averageConfidence: number
  freshness: string
  dependentAgents: GraphNode[]
  knownFindings: number
}

function findDependentAgents(nodeId: string, state: AgentSentinelState): GraphNode[] {
  const nodeById = new Map(state.snapshot.nodes.map((node) => [node.id, node]))
  const agents = new Map<string, GraphNode>()
  const visited = new Set([nodeId])
  const queue = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    for (const edge of state.snapshot.edges.filter(
      (candidate) => candidate.active && candidate.to === current,
    )) {
      if (visited.has(edge.from)) continue
      visited.add(edge.from)
      const parent = nodeById.get(edge.from)
      if (parent?.kind === 'agent') agents.set(parent.id, parent)
      queue.push(edge.from)
    }
  }
  return [...agents.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function catalogStatus(node: GraphNode): string {
  return node.metadata.catalog ?? 'Not provided by source'
}

function buildCatalog(state: AgentSentinelState): CatalogItem[] {
  const evidenceById = new Map(state.snapshot.evidence.map((item) => [item.id, item]))
  return state.snapshot.nodes
    .filter(
      (node): node is GraphNode & { kind: CatalogKind } =>
        node.kind === 'agent' || node.kind === 'mcp' || node.kind === 'tool',
    )
    .map((node) => {
      const trust: CatalogTrust = node.trust ?? 'unknown'
      const evidence = node.evidenceIds
        .map((id) => evidenceById.get(id))
        .filter((item): item is NonNullable<typeof item> => item !== undefined)
      return {
        node,
        kind: node.kind,
        trust,
        catalogStatus: catalogStatus(node),
        publisher: node.metadata.publisher ?? 'Not provided by source',
        protocol: node.metadata.protocol ?? 'Not provided by source',
        evidenceSources: [...new Set(evidence.map((item) => item.source))],
        averageConfidence:
          evidence.length > 0
            ? evidence.reduce((total, item) => total + item.confidence, 0) / evidence.length
            : 0,
        freshness: evidence.some((item) => item.freshness === 'stale')
          ? 'stale'
          : evidence.some((item) => item.freshness === 'live')
            ? 'live'
            : evidence.length > 0
              ? 'recent'
              : 'unavailable',
        dependentAgents: findDependentAgents(node.id, state),
        knownFindings: state.findings.filter((finding) => finding.path.nodeIds.includes(node.id))
          .length,
      }
    })
    .sort((left, right) => left.node.name.localeCompare(right.node.name))
}

function iconFor(kind: CatalogKind) {
  if (kind === 'agent') return BotRegular
  if (kind === 'mcp') return CloudRegular
  return WrenchRegular
}

export function TrustCatalogPage() {
  const { state } = useDemoState()
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<CatalogKind | ''>('')
  const [trust, setTrust] = useState<CatalogTrust | ''>('')
  const [selectedId, setSelectedId] = useState<string>()
  const drawerRef = useRef<HTMLElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const catalog = useMemo(() => (state ? buildCatalog(state) : []), [state])
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return catalog.filter((item) => {
      if (kind && item.kind !== kind) return false
      if (trust && item.trust !== trust) return false
      if (!normalized) return true
      return [
        item.node.name,
        item.node.description,
        item.node.owner,
        item.node.environment,
        item.node.metadata.endpoint,
        item.node.metadata.permission,
        item.publisher,
        item.protocol,
        item.catalogStatus,
        ...item.evidenceSources,
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()
        .includes(normalized)
    })
  }, [catalog, kind, query, trust])
  const selected = catalog.find((item) => item.node.id === selectedId)
  const counts = {
    approved: catalog.filter((item) => item.catalogStatus === 'Approved').length,
    review: catalog.filter(
      (item) => item.trust === 'conditional' || item.catalogStatus === 'Review required',
    ).length,
    untrusted: catalog.filter((item) => item.trust === 'untrusted').length,
  }

  function openDrawer(nodeId: string, trigger: HTMLElement) {
    previousFocus.current = trigger
    setSelectedId(nodeId)
  }

  const closeDrawer = useCallback(() => {
    setSelectedId(undefined)
    window.setTimeout(() => previousFocus.current?.focus(), 0)
  }, [])

  function trapDrawerFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') return
    const focusable = event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    const first = focusable.item(0)
    const last = focusable.item(focusable.length - 1)
    if (!first || !last) {
      event.preventDefault()
    } else if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === event.currentTarget)
    ) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  useEffect(() => {
    if (!selected) return
    drawerRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawer()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [closeDrawer, selected])

  return (
    <>
      <PageHeading
        section="Trust catalog"
        title="Agent, MCP, and tool catalog"
        description="Evidence-backed trust, ownership, provenance, permissions, and dependencies from the current estate graph."
      />

      <section className="catalog-boundary">
        <ShieldCheckmarkRegular />
        <div>
          <strong>Discovered capabilities, not a marketplace approval system</strong>
          <span>
            Catalog status is shown only when supplied by source evidence. Missing publisher,
            protocol, or review metadata remains explicitly unavailable.
          </span>
        </div>
      </section>

      <section className="catalog-summary" aria-label="Trust catalog summary">
        <CatalogMetric
          label="Catalog items"
          value={catalog.length}
          detail="Agents, MCP servers, and tools"
        />
        <CatalogMetric
          label="Source approved"
          value={counts.approved}
          detail="Explicit catalog approval metadata"
        />
        <CatalogMetric
          label="Need review"
          value={counts.review}
          detail="Conditional trust or review state"
        />
        <CatalogMetric
          label="Untrusted"
          value={counts.untrusted}
          detail="Evidence-backed untrusted discovery"
        />
      </section>

      <div className="catalog-toolbar">
        <div className="catalog-search">
          <SearchRegular />
          <Input
            appearance="underline"
            aria-label="Search trust catalog"
            placeholder="Search capabilities, owners, permissions, and sources"
            value={query}
            onChange={(_event, data) => setQuery(data.value)}
          />
        </div>
        <label>
          <span>Type</span>
          <Select
            aria-label="Filter catalog by type"
            value={kind}
            onChange={(_event, data) => setKind((data.value as CatalogKind) || '')}
          >
            <option value="">All</option>
            <option value="agent">Agents</option>
            <option value="mcp">MCP servers</option>
            <option value="tool">Tools</option>
          </Select>
        </label>
        <label>
          <span>Trust</span>
          <Select
            aria-label="Filter catalog by trust"
            value={trust}
            onChange={(_event, data) => setTrust((data.value as CatalogTrust) || '')}
          >
            <option value="">All</option>
            <option value="trusted">Trusted</option>
            <option value="conditional">Conditional</option>
            <option value="untrusted">Untrusted</option>
            <option value="unknown">Unknown</option>
          </Select>
        </label>
        <strong>{filtered.length} items</strong>
      </div>

      {filtered.length === 0 ? (
        <div className="catalog-empty">
          <SearchRegular />
          <h2>No catalog items found</h2>
          <p>No discovered capability matches the current search and filters.</p>
        </div>
      ) : (
        <section className="catalog-grid" aria-label="Trust catalog items">
          {filtered.map((item) => {
            const Icon = iconFor(item.kind)
            return (
              <article className="catalog-item" key={item.node.id}>
                <div className="catalog-item__header">
                  <span className={`catalog-item__icon catalog-item__icon--${item.kind}`}>
                    <Icon />
                  </span>
                  <div>
                    <span>{item.kind}</span>
                    <h2>{item.node.name}</h2>
                  </div>
                  <Badge
                    appearance="tint"
                    color={
                      item.trust === 'trusted'
                        ? 'success'
                        : item.trust === 'untrusted'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {item.trust}
                  </Badge>
                </div>
                <p>{item.node.description}</p>
                <dl>
                  <div>
                    <dt>Owner</dt>
                    <dd>{item.node.owner ?? 'Not provided by source'}</dd>
                  </div>
                  <div>
                    <dt>Catalog</dt>
                    <dd>{item.catalogStatus}</dd>
                  </div>
                  <div>
                    <dt>Dependents</dt>
                    <dd>{item.dependentAgents.length} agents</dd>
                  </div>
                  <div>
                    <dt>Evidence</dt>
                    <dd>
                      {item.node.evidenceIds.length} objects ·{' '}
                      {Math.round(item.averageConfidence * 100)}%
                    </dd>
                  </div>
                </dl>
                <Button
                  appearance="secondary"
                  onClick={(event) => openDrawer(item.node.id, event.currentTarget)}
                >
                  View trust evidence
                </Button>
              </article>
            )
          })}
        </section>
      )}

      {selected ? (
        <div className="catalog-drawer-backdrop" role="presentation" onMouseDown={closeDrawer}>
          <aside
            ref={drawerRef}
            className="catalog-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="catalog-drawer-title"
            tabIndex={-1}
            onKeyDown={trapDrawerFocus}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="catalog-drawer__header">
              <div>
                <span className="eyebrow">{selected.kind.toUpperCase()} TRUST EVIDENCE</span>
                <h2 id="catalog-drawer-title">{selected.node.name}</h2>
              </div>
              <Button
                appearance="subtle"
                icon={<DismissRegular />}
                aria-label="Close trust evidence"
                onClick={closeDrawer}
              />
            </div>
            <p>{selected.node.description}</p>
            <dl>
              <CatalogDetail label="Trust assessment" value={selected.trust} />
              <CatalogDetail label="Catalog status" value={selected.catalogStatus} />
              <CatalogDetail label="Publisher" value={selected.publisher} />
              <CatalogDetail label="Protocol" value={selected.protocol} />
              <CatalogDetail
                label="Owner"
                value={selected.node.owner ?? 'Not provided by source'}
              />
              <CatalogDetail label="Environment" value={selected.node.environment} />
              <CatalogDetail
                label="Endpoint"
                value={selected.node.metadata.endpoint ?? 'Not provided by source'}
              />
              <CatalogDetail
                label="Permission"
                value={selected.node.metadata.permission ?? 'Not provided by source'}
              />
              <CatalogDetail label="Evidence freshness" value={selected.freshness} />
              <CatalogDetail
                label="Evidence sources"
                value={selected.evidenceSources.join(', ') || 'No evidence source available'}
              />
              <CatalogDetail label="Known findings" value={String(selected.knownFindings)} />
            </dl>
            <section>
              <h3>Dependent agents</h3>
              {selected.dependentAgents.length === 0 ? (
                <p>No dependent agent relationship is present in the current graph.</p>
              ) : (
                <ul>
                  {selected.dependentAgents.map((agent) => (
                    <li key={agent.id}>
                      <Link to={`/agent-estate/${agent.id}`}>{agent.name}</Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      ) : null}
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

function CatalogDetail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
