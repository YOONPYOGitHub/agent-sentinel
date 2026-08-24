import { Badge, Button } from '@fluentui/react-components'
import {
  ArrowLeftRegular,
  BotRegular,
  KeyRegular,
  LinkRegular,
  ShieldCheckmarkRegular,
} from '@fluentui/react-icons'
import { Link, useParams } from 'react-router-dom'

import type { DriftAnalysisResult, EstateSnapshot, GraphEdge } from '@agent-sentinel/domain'

import { EvidenceDrawer } from '../components/EvidenceDrawer'
import { PageHeading } from '../components/PageHeading'
import { useDemoState } from '../hooks/useDemoState'
import { useAgentDrift } from '../hooks/useAgentDrift'
import { useExposures } from '../hooks/useExposures'
import { useEvidenceDrawer } from '../hooks/useEvidenceDrawer'
import { buildAgentScorecard, type ScorecardPosture } from '../scorecard'

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
  const liveExposures = useExposures(agentId)
  const agentDrift = useAgentDrift(agentId ?? '')
  const agent = state?.snapshot.nodes.find((node) => node.kind === 'agent' && node.id === agentId)

  if (agent === undefined || state === undefined) {
    return (
      <div className="detail-not-found">
        <BotRegular />
        <h1>Agent not found</h1>
        <p>The requested agent is not part of this estate snapshot.</p>
        <Link className="primary-link" to="/agent-inventory">
          Return to agent inventory
        </Link>
      </div>
    )
  }

  const agentExposures = Array.isArray(liveExposures)
    ? liveExposures.filter(
        (f) => (f.status === 'open' || f.status === 'validated') && f.affectedAgentId === agent.id,
      )
    : []
  const liveHeaderStatus: 'Critical' | 'Attention' | 'Healthy' | 'Unknown' = !Array.isArray(
    liveExposures,
  )
    ? 'Unknown'
    : agentExposures.some((f) => f.severity === 'critical')
      ? 'Critical'
      : agentExposures.length > 0
        ? 'Attention'
        : 'Healthy'
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
  const liveFindings = Array.isArray(liveExposures)
    ? liveExposures.filter((f) => f.affectedAgentId === agent.id)
    : liveExposures
  const scorecard = buildAgentScorecard(agent, state, liveExposures)

  return (
    <>
      <Link className="back-link" to="/agent-inventory">
        <ArrowLeftRegular />
        Agent inventory
      </Link>
      <PageHeading
        section="Agent inventory / Detail"
        title={agent.name}
        description={agent.description}
        actions={
          <Badge
            appearance="filled"
            color={
              liveHeaderStatus === 'Critical'
                ? 'danger'
                : liveHeaderStatus === 'Attention'
                  ? 'warning'
                  : liveHeaderStatus === 'Healthy'
                    ? 'success'
                    : 'informative'
            }
          >
            {liveHeaderStatus}
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
                    {item.source.includes('Azure AI Foundry Agent Service')
                      ? 'Declared configuration · '
                      : 'Observed evidence · '}
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
          {!Array.isArray(liveFindings) ? (
            <p className="muted">
              {liveFindings === 'loading'
                ? 'Loading exposure data…'
                : 'Exposure data could not be loaded. Check connector health.'}
            </p>
          ) : liveFindings.length === 0 ? (
            <div className="healthy-empty">
              <ShieldCheckmarkRegular />
              <div>
                <strong>No active findings</strong>
                <span>No live exposures are linked to this agent.</span>
              </div>
            </div>
          ) : (
            <ul className="finding-list">
              {liveFindings.map((finding) => (
                <li key={finding.id}>
                  <Badge color={finding.severity === 'critical' ? 'danger' : 'warning'}>
                    {finding.severity}
                  </Badge>
                  <div>
                    <strong>{finding.title}</strong>
                    <span>{finding.summary}</span>
                    <small>
                      {finding.policyId} · risk {finding.riskScore}/100
                    </small>
                    <Link to={`/exposure/${finding.id}`}>View finding detail</Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className="surface-card agent-scorecard" aria-labelledby="agent-scorecard-title">
        <div className="agent-scorecard__header">
          <div>
            <span className="eyebrow">EVIDENCE-BASED ASSURANCE</span>
            <h2 id="agent-scorecard-title">Assurance scorecard</h2>
          </div>
          <p>
            Evidence-derived posture only. This scorecard does not calculate or imply an assurance
            score.
          </p>
        </div>
        <div className="agent-scorecard__notice" role="note">
          Agent Sentinel correlates cross-product evidence. Microsoft Agent 365 remains
          authoritative for registry and admin decisions.
        </div>
        <div className="agent-scorecard__grid">
          {scorecard.dimensions.map((dimension) => {
            const headingId = `scorecard-${dimension.id}-title`
            return (
              <article
                className={`scorecard-card scorecard-card--${dimension.posture}`}
                aria-labelledby={headingId}
                key={dimension.id}
              >
                <div className="scorecard-card__heading">
                  <h3 id={headingId}>{dimension.label}</h3>
                  <Badge
                    appearance="outline"
                    className={`scorecard-badge scorecard-badge--${dimension.posture}`}
                  >
                    {postureLabel(dimension.posture)}
                  </Badge>
                </div>
                <Badge
                  appearance="tint"
                  className={`scorecard-coverage scorecard-coverage--${dimension.coverage}`}
                  aria-label={`Coverage ${dimension.coverage}`}
                >
                  Coverage: {dimension.coverage}
                </Badge>
                <p>{dimension.explanation}</p>
                {dimension.findingIds.length > 0 ? (
                  <ul
                    className="scorecard-card__findings"
                    aria-label={`Linked ${dimension.label} findings`}
                  >
                    {dimension.findingIds.map((findingId) => {
                      const exposure = Array.isArray(liveExposures)
                        ? liveExposures.find((item) => item.id === findingId)
                        : undefined
                      return (
                        <li key={findingId}>
                          <Link to={`/exposure/${findingId}`}>
                            {exposure?.title ?? findingId}
                            {exposure ? ` - finding risk score ${exposure.riskScore}/100` : ''}
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
                {dimension.missingConnector ? (
                  <span className="scorecard-card__connector">
                    Missing connector: {dimension.missingConnector}
                  </span>
                ) : null}
              </article>
            )
          })}
        </div>
      </section>
      <AgentDriftSection drift={agentDrift} />
      <EvidenceDrawer
        evidence={selectedEvidence}
        drawerRef={drawerRef}
        onKeyDown={trapFocus}
        onClose={() => setSelectedEvidence(undefined)}
      />
    </>
  )
}

function AgentDriftSection({ drift }: { drift: DriftAnalysisResult | null }) {
  if (drift === null) return null

  const isSynthetic = drift.source === 'mock-synthetic'
  const isUnavailable = drift.source === 'azure-monitor-otel' && drift.status !== 'ready'

  return (
    <section className="surface-card agent-drift-section" aria-labelledby="agent-drift-title">
      <h2 id="agent-drift-title">Runtime behavior drift</h2>
      {isSynthetic && (
        <div className="drift-badge drift-badge--synthetic" role="note">
          [SYNTHETIC] Mock demonstration — no live telemetry connected
        </div>
      )}
      {isUnavailable ? (
        <p className="muted">
          Telemetry not connected.{' '}
          {drift.unavailableReason ?? 'Connect the Azure Monitor & OpenTelemetry connector.'}
        </p>
      ) : (
        <>
          <p className="muted">
            Status: <strong>{drift.status}</strong>
            {drift.coverage !== undefined &&
              ` · ${drift.coverage.baselineSamples} baseline / ${drift.coverage.observedSamples} observed samples`}
          </p>
          {drift.anyDrift ? (
            <ul className="drift-dimension-list" aria-label="Drifted dimensions">
              {drift.dimensions
                .filter((d) => d.drifted)
                .map((d) => (
                  <li key={d.dimension}>
                    <strong>{d.dimension}</strong> — {d.explanation}
                    {d.severity !== undefined && (
                      <>
                        {' '}
                        (severity: <strong>{d.severity}</strong>)
                      </>
                    )}
                  </li>
                ))}
            </ul>
          ) : (
            <p className="muted">No behavioral drift detected in this window.</p>
          )}
        </>
      )}
    </section>
  )
}

function postureLabel(posture: ScorecardPosture): string {
  return posture.charAt(0).toUpperCase() + posture.slice(1)
}
