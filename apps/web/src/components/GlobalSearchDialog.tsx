import { Input } from '@fluentui/react-components'
import {
  BotRegular,
  DataUsageRegular,
  DismissRegular,
  KeyRegular,
  LockClosedRegular,
  PlugConnectedRegular,
  SearchRegular,
  ShieldCheckmarkRegular,
  WrenchRegular,
} from '@fluentui/react-icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import type { AgentSentinelState, GraphNode, NodeKind } from '@agent-sentinel/domain'

interface SearchResult {
  id: string
  label: string
  detail: string
  type: string
  to: string
  kind?: NodeKind
}

const destinations: SearchResult[] = [
  {
    id: 'page-overview',
    label: 'Overview',
    detail: 'Agent operations summary',
    type: 'Page',
    to: '/overview',
  },
  {
    id: 'page-inventory',
    label: 'Agent inventory',
    detail: 'Inventory, ownership, and governance readiness',
    type: 'Page',
    to: '/agent-inventory',
  },
  {
    id: 'page-agent-catalog',
    label: 'Agent assurance catalog',
    detail: 'Employee-facing risk and evidence overlay',
    type: 'Page',
    to: '/agent-catalog',
  },
  {
    id: 'page-exposure',
    label: 'Exposure',
    detail: 'Findings and attack paths',
    type: 'Page',
    to: '/exposure',
  },
  {
    id: 'page-governance',
    label: 'Governance',
    detail: 'Policy posture and evidence',
    type: 'Page',
    to: '/governance',
  },
  {
    id: 'page-connectors',
    label: 'Connectors',
    detail: 'Connector health and coverage',
    type: 'Page',
    to: '/connectors',
  },
  {
    id: 'page-settings',
    label: 'Settings',
    detail: 'Current application configuration',
    type: 'Page',
    to: '/settings',
  },
]

function iconFor(result: SearchResult) {
  if (result.type === 'Page') {
    if (result.to === '/exposure') return ShieldCheckmarkRegular
    if (result.to === '/governance') return LockClosedRegular
    if (result.to === '/connectors') return PlugConnectedRegular
    return SearchRegular
  }
  if (result.kind === 'agent') return BotRegular
  if (result.kind === 'identity') return KeyRegular
  if (result.kind === 'data') return DataUsageRegular
  return WrenchRegular
}

function parentAgent(node: GraphNode, state: AgentSentinelState): GraphNode | undefined {
  if (node.kind === 'agent') return node
  const visited = new Set([node.id])
  const queue = [node.id]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    for (const edge of state.snapshot.edges.filter((candidate) => candidate.to === current)) {
      if (visited.has(edge.from)) continue
      visited.add(edge.from)
      const parent = state.snapshot.nodes.find((candidate) => candidate.id === edge.from)
      if (parent?.kind === 'agent') return parent
      queue.push(edge.from)
    }
  }
  return undefined
}

function searchableAssets(state: AgentSentinelState): SearchResult[] {
  const assets = state.snapshot.nodes.map((node) => {
    const agent = parentAgent(node, state)
    return {
      id: `asset-${node.id}`,
      label: node.name,
      detail: `${node.kind} · ${node.owner ?? node.environment}`,
      type: node.kind,
      kind: node.kind,
      to: agent ? `/agent-inventory/${agent.id}` : '/agent-inventory',
    }
  })
  const evidence = state.snapshot.evidence.map((item) => {
    const linkedNode = state.snapshot.nodes.find((node) => node.evidenceIds.includes(item.id))
    const agent = linkedNode ? parentAgent(linkedNode, state) : undefined
    return {
      id: `evidence-${item.id}`,
      label: item.source,
      detail: `${item.summary} · ${Math.round(item.confidence * 100)}% confidence`,
      type: 'Evidence',
      to: agent ? `/agent-inventory/${agent.id}` : '/agent-inventory',
    }
  })
  return [...assets, ...evidence]
}

export function GlobalSearchDialog({
  open,
  state,
  onClose,
}: {
  open: boolean
  state: AgentSentinelState
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const containFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable || focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable.item(0)
      const last = focusable.item(focusable.length - 1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', containFocus)
    return () => document.removeEventListener('keydown', containFocus)
  }, [onClose, open])

  const results = useMemo(() => {
    const candidates = [...destinations, ...searchableAssets(state)]
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return candidates.slice(0, 8)
    return candidates
      .filter((result) =>
        `${result.label} ${result.detail} ${result.type}`.toLocaleLowerCase().includes(normalized),
      )
      .slice(0, 12)
  }, [query, state])

  if (!open) return null

  return (
    <div className="search-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="global-search-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="search-dialog__header">
          <div>
            <span className="eyebrow">GLOBAL SEARCH</span>
            <h2 id="global-search-title">Find an agent, capability, or workspace</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close search">
            <DismissRegular />
          </button>
        </div>
        <Input
          autoFocus
          size="large"
          contentBefore={<SearchRegular />}
          aria-label="Search Agent Sentinel"
          placeholder="Search agents, identities, tools, evidence, and pages"
          value={query}
          onChange={(_event, data) => setQuery(data.value)}
        />
        <div className="search-results" role="list">
          {results.length === 0 ? (
            <div className="search-results__empty">
              <strong>No results found</strong>
              <span>Try an agent name, owner, capability, or workspace.</span>
            </div>
          ) : (
            results.map((result) => {
              const Icon = iconFor(result)
              return (
                <div key={result.id} role="listitem">
                  <Link to={result.to} onClick={onClose}>
                    <span className="search-result__icon">
                      <Icon />
                    </span>
                    <span>
                      <strong>{result.label}</strong>
                      <small>{result.detail}</small>
                    </span>
                    <em>{result.type}</em>
                  </Link>
                </div>
              )
            })
          )}
        </div>
        <footer>
          <span>
            <kbd>Esc</kbd> close
          </span>
          <span>{results.length} results</span>
        </footer>
      </section>
    </div>
  )
}
