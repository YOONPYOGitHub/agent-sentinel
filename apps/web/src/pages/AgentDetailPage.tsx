import { Badge, Button } from '@fluentui/react-components'
import {
  ArrowLeftRegular,
  BotRegular,
  KeyRegular,
  LinkRegular,
  ShieldCheckmarkRegular,
} from '@fluentui/react-icons'
import { Link, useParams } from 'react-router-dom'

import type { EstateSnapshot, GraphEdge } from '@agent-sentinel/domain'

import { EvidenceDrawer } from '../components/EvidenceDrawer'
import { PageHeading } from '../components/PageHeading'
import { getAgentStatus } from '../estate'
import { useDemoState } from '../hooks/useDemoState'
import { useEvidenceDrawer } from '../hooks/useEvidenceDrawer'

function dependencyEdges(snapshot: EstateSnapshot, agentId: string): GraphEdge[] {
  const visited = new Set([agentId])
  const relationships: GraphEdge[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const edge of snapshot.edges) {
      if (visited.has(edge.from) && !relationships.some((item) => item.id === edge.id)) {
        relationships.push(edge)
        if (!visited.has(edge.to)) {
          visited.add(edge.to)
          changed = true
        }
      }
    }
  }
  return relationships
}

export function AgentDetailPage() {
  const { agentId } = useParams()
  const { state } = useDemoState()
  const { selectedEvidence, setSelectedEvidence, drawerRef, trapFocus } = useEvidenceDrawer()
  const agent = state?.snapshot.nodes.find((node) => node.kind === 'agent' && node.id === agentId)

  if (agent === undefined || state === undefined) {
    return (
      <div className="detail-not-found">
        <BotRegular />
        <h1>Agent not found</h1>
        <p>The requested agent is not part of this estate snapshot.</p>
        <Link className="primary-link" to="/agent-estate">
          Return to agent estate
        </Link>
      </div>
    )
  }

  const status = getAgentStatus(agent, state.findings)
  const relationships = dependencyEdges(state.snapshot, agent.id)
  const dependencyIds = new Set(relationships.flatMap((edge) => [edge.from, edge.to]))
  const dependencies = state.snapshot.nodes.filter(
    (node) => node.id !== agent.id && dependencyIds.has(node.id),
  )
  const identity = dependencies.find((node) => node.kind === 'identity')
  const evidenceIds = new Set([
    ...agent.evidenceIds,
    ...dependencies.flatMap((node) => node.evidenceIds),
    ...relationships.flatMap((edge) => edge.evidenceIds),
  ])
  const evidence = state.snapshot.evidence.filter((item) => evidenceIds.has(item.id))
  const findings = state.findings.filter((finding) => finding.path.nodeIds.includes(agent.id))

  return (
    <>
      <Link className="back-link" to="/agent-estate">
        <ArrowLeftRegular />
        Agent estate
      </Link>
      <PageHeading
        section="Agent estate / Detail"
        title={agent.name}
        description={agent.description}
        actions={
          <Badge
            appearance="filled"
            color={status === 'Critical' ? 'danger' : status === 'Review' ? 'warning' : 'success'}
          >
            {status}
          </Badge>
        }
      />
      <section className="detail-summary" aria-label="Agent profile">
        <article>
          <span>Identity</span>
          <strong>{identity?.name ?? 'Not observed'}</strong>
        </article>
        <article>
          <span>Platform</span>
          <strong>{agent.metadata.platform ?? 'Custom'}</strong>
        </article>
        <article>
          <span>Version</span>
          <strong>{agent.metadata.version ?? 'Current'}</strong>
        </article>
        <article>
          <span>Deployment status</span>
          <strong>{agent.metadata.status ?? 'Unknown'}</strong>
        </article>
        <article>
          <span>Owner</span>
          <strong>{agent.owner ?? 'Unassigned'}</strong>
        </article>
        <article>
          <span>Environment</span>
          <strong>{agent.environment}</strong>
        </article>
        <article>
          <span>Trust</span>
          <strong>{agent.trust ?? 'Unknown'}</strong>
        </article>
      </section>
      <div className="detail-grid">
        <section className="surface-card detail-section">
          <div className="surface-card__header">
            <div>
              <span className="eyebrow">EVIDENCE GRAPH</span>
              <h2>Dependencies and relationships</h2>
            </div>
            <LinkRegular />
          </div>
          <ul className="relationship-list">
            {relationships.map((edge) => {
              const peer = state.snapshot.nodes.find((node) => node.id === edge.to)
              return (
                <li key={edge.id}>
                  <div>
                    <Badge appearance="outline">{edge.relationship.replaceAll('_', ' ')}</Badge>
                    <strong>{peer?.name ?? edge.to}</strong>
                    <span>
                      {peer?.kind ?? 'dependency'} · {edge.active ? 'Active' : 'Disabled'} ·{' '}
                      {edge.evidenceIds.length} evidence source
                      {edge.evidenceIds.length === 1 ? '' : 's'}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
        <section className="surface-card detail-section">
          <div className="surface-card__header">
            <div>
              <span className="eyebrow">PROVENANCE</span>
              <h2>Evidence and coverage</h2>
            </div>
            <KeyRegular />
          </div>
          <p className="muted">
            {evidence.length} evidence objects cover {relationships.length} observed relationships.
          </p>
          <ul className="detail-evidence-list">
            {evidence.map((item) => (
              <li key={item.id}>
                <Button appearance="transparent" onClick={() => setSelectedEvidence(item)}>
                  <strong>{item.source}</strong>
                  <span>{item.summary}</span>
                  <small>
                    {item.freshness} · {Math.round(item.confidence * 100)}% confidence
                  </small>
                </Button>
              </li>
            ))}
          </ul>
        </section>
        <section className="surface-card detail-section detail-findings">
          <div className="surface-card__header">
            <div>
              <span className="eyebrow">POLICY</span>
              <h2>Finding linkage</h2>
            </div>
            <ShieldCheckmarkRegular />
          </div>
          {findings.length === 0 ? (
            <div className="healthy-empty">
              <ShieldCheckmarkRegular />
              <div>
                <strong>No active findings</strong>
                <span>Current evidence does not place this agent on a policy finding path.</span>
              </div>
            </div>
          ) : (
            <ul className="finding-list">
              {findings.map((finding) => (
                <li key={finding.id}>
                  <Badge color={finding.path.status === 'mitigated' ? 'success' : 'danger'}>
                    {finding.path.status}
                  </Badge>
                  <div>
                    <strong>{finding.title}</strong>
                    <span>{finding.summary}</span>
                    <small>
                      {finding.policyId} · risk {finding.path.riskScore}/100
                    </small>
                    <Link to="/overview">View finding in overview</Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <EvidenceDrawer
        evidence={selectedEvidence}
        drawerRef={drawerRef}
        onKeyDown={trapFocus}
        onClose={() => setSelectedEvidence(undefined)}
      />
    </>
  )
}
