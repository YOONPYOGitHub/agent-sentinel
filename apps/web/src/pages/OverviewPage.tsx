import { Badge, Button, ProgressBar } from '@fluentui/react-components'
import {
  AlertRegular,
  ArrowResetRegular,
  BotRegular,
  CheckmarkCircleRegular,
  DataUsageRegular,
  DismissRegular,
  LockClosedRegular,
  MoreHorizontalRegular,
  PersonRegular,
  PlayRegular,
  ShieldCheckmarkRegular,
} from '@fluentui/react-icons'
import { useMemo } from 'react'

import type { Remediation } from '@agent-sentinel/domain'

import { demoApi } from '../api'
import { EvidenceDrawer } from '../components/EvidenceDrawer'
import { ExposureGraph } from '../components/ExposureGraph'
import { PageHeading } from '../components/PageHeading'
import { useDemoState } from '../hooks/useDemoState'
import { useEvidenceDrawer } from '../hooks/useEvidenceDrawer'

const portfolioMetrics = [
  {
    label: 'Managed agents',
    value: '3',
    detail: '3 platforms connected',
    tone: 'neutral',
    icon: BotRegular,
  },
  {
    label: 'Critical paths',
    value: '1',
    detail: '1 available to validate',
    tone: 'danger',
    icon: AlertRegular,
  },
  {
    label: 'Sensitive assets reached',
    value: '1',
    detail: 'Customer 360',
    tone: 'warning',
    icon: DataUsageRegular,
  },
  {
    label: 'Governance coverage',
    value: '91%',
    detail: '+4.2% in 30 days',
    tone: 'success',
    icon: ShieldCheckmarkRegular,
  },
]

export function OverviewPage() {
  const { state, connectorStatus, operation, error, clearError, load, run } = useDemoState()
  const writeEnabled = connectorStatus?.writeEnabled !== false
  const { selectedEvidence, setSelectedEvidence, drawerRef, trapFocus } = useEvidenceDrawer()
  const finding = state?.findings[0]
  const remediation = state?.remediations[0]
  const validation = state?.validations[0]
  const pathStatus = finding?.path.status ?? 'theoretical'
  const pathSnapshot = useMemo(() => {
    if (state === undefined || finding === undefined) return undefined

    const nodeIds = new Set(finding.path.nodeIds)
    const edgeIds = new Set(finding.path.edgeIds)
    const nodes = state.snapshot.nodes.filter((node) => nodeIds.has(node.id))
    const edges = state.snapshot.edges.filter((edge) => edgeIds.has(edge.id))
    const evidenceIds = new Set([
      ...nodes.flatMap((node) => node.evidenceIds),
      ...edges.flatMap((edge) => edge.evidenceIds),
    ])

    return {
      ...state.snapshot,
      nodes,
      edges,
      evidence: state.snapshot.evidence.filter((item) => evidenceIds.has(item.id)),
    }
  }, [finding, state])

  const primaryAction = useMemo(() => {
    if (finding === undefined) return undefined
    if (pathStatus === 'theoretical')
      return {
        label: 'Run safe validation',
        icon: PlayRegular,
        busy: operation === 'validating',
        onClick: () => run('validating', () => demoApi.validateFinding(finding.id)),
      }
    if (pathStatus === 'validated' && remediation === undefined)
      return {
        label: 'Build response plan',
        icon: ShieldCheckmarkRegular,
        busy: operation === 'proposing',
        onClick: () => run('proposing', () => demoApi.proposeRemediation(finding.id)),
      }
    if (remediation?.status === 'proposed')
      return {
        label: 'Approve response',
        icon: PersonRegular,
        busy: operation === 'approving',
        onClick: () =>
          run('approving', () => demoApi.approveRemediation(remediation.id, 'Avery Morgan')),
      }
    if (remediation?.status === 'approved')
      return {
        label: 'Execute containment',
        icon: LockClosedRegular,
        busy: operation === 'executing',
        onClick: () => run('executing', () => demoApi.executeRemediation(remediation.id)),
      }
    return {
      label: 'Reset demo',
      icon: ArrowResetRegular,
      busy: operation === 'resetting',
      onClick: () => run('resetting', demoApi.reset),
    }
  }, [finding, operation, pathStatus, remediation, run])

  if (state === undefined || finding === undefined || pathSnapshot === undefined) {
    return (
      <div className="empty-state page-empty">
        <AlertRegular aria-hidden="true" />
        <h1>Agent estate is unavailable</h1>
        <p>{error ?? 'No evidence-backed findings were returned.'}</p>
        <Button appearance="primary" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    )
  }

  return (
    <>
      <PageHeading
        section="Overview"
        title="Agent operations overview"
        description="One evidence-driven view across security, governance, quality, cost, and lifecycle."
        actions={
          <>
            <span className="refresh-status">
              <span className="status-dot status-dot--healthy" />
              Updated 18 sec ago
            </span>
            <Button
              appearance="secondary"
              icon={<ArrowResetRegular />}
              onClick={() => void run('resetting', demoApi.reset)}
              disabled={!writeEnabled || operation !== undefined}
            >
              Reset
            </Button>
            {primaryAction === undefined ? null : (
              <Button
                appearance="primary"
                icon={<primaryAction.icon />}
                disabled={!writeEnabled || operation !== undefined}
                onClick={() => void primaryAction.onClick()}
              >
                {primaryAction.busy ? 'Working…' : primaryAction.label}
              </Button>
            )}
          </>
        }
      />

      {error === undefined ? null : (
        <div className="inline-error" role="alert">
          <AlertRegular />
          <span>{error}</span>
          <button type="button" onClick={clearError} aria-label="Dismiss error">
            <DismissRegular />
          </button>
        </div>
      )}

      <section className="journey-strip" aria-label="Demo workflow">
        {[
          { label: 'Detected', complete: true },
          { label: 'Validated', complete: pathStatus !== 'theoretical' },
          { label: 'Response planned', complete: remediation !== undefined },
          {
            label: 'Approved',
            complete: remediation?.status === 'approved' || remediation?.status === 'completed',
          },
          { label: 'Contained', complete: pathStatus === 'mitigated' },
        ].map((step, index, steps) => (
          <div
            className={`journey-step ${step.complete ? 'journey-step--complete' : ''}`}
            key={step.label}
          >
            <span>{step.complete ? <CheckmarkCircleRegular /> : index + 1}</span>
            <strong>{step.label}</strong>
            {index < steps.length - 1 ? <div className="journey-connector" /> : null}
          </div>
        ))}
      </section>

      <section className="metric-grid" aria-label="Agent estate metrics">
        {portfolioMetrics.map((metric) => {
          const Icon = metric.icon
          return (
            <article className={`metric-card metric-card--${metric.tone}`} key={metric.label}>
              <div className="metric-card__top">
                <span>{metric.label}</span>
                <Icon aria-hidden="true" />
              </div>
              <strong>{metric.value}</strong>
              <span>{metric.detail}</span>
            </article>
          )
        })}
      </section>

      <section className="workspace-grid">
        <ExposureGraph
          snapshot={pathSnapshot}
          pathStatus={pathStatus}
          onEvidenceSelect={setSelectedEvidence}
        />
        <aside className="finding-panel" aria-label="Critical finding details">
          <div className="finding-panel__header">
            <div>
              <span className="eyebrow">CRITICAL FINDING</span>
              <Badge appearance="filled" color={pathStatus === 'mitigated' ? 'success' : 'danger'}>
                {pathStatus === 'mitigated' ? 'Mitigated' : 'Critical'}
              </Badge>
            </div>
            <Button
              appearance="subtle"
              icon={<MoreHorizontalRegular />}
              aria-label="Finding actions"
            />
          </div>
          <h2>{finding.title}</h2>
          <p>{finding.summary}</p>
          <div className="risk-score">
            <div className="risk-score__dial">
              <strong>{pathStatus === 'mitigated' ? 4 : finding.path.riskScore}</strong>
              <span>/ 100</span>
            </div>
            <div>
              <strong>{pathStatus === 'mitigated' ? 'Residual risk' : 'Exposure score'}</strong>
              <span>
                {pathStatus === 'mitigated'
                  ? 'Critical route removed'
                  : 'High confidence · active in last 24h'}
              </span>
            </div>
          </div>
          <div className="factor-list">
            {[
              ['Reachability', finding.path.factors.reachability],
              ['Exploitability', finding.path.factors.exploitability],
              ['Data sensitivity', finding.path.factors.dataSensitivity],
              ['Evidence confidence', finding.path.factors.confidence],
            ].map(([label, value]) => (
              <div className="factor" key={String(label)}>
                <div>
                  <span>{label}</span>
                  <strong>{Math.round(Number(value) * 100)}%</strong>
                </div>
                <ProgressBar
                  value={pathStatus === 'mitigated' ? Number(value) * 0.08 : Number(value)}
                  color={pathStatus === 'mitigated' ? 'success' : 'error'}
                  thickness="medium"
                />
              </div>
            ))}
          </div>
          {validation === undefined ? (
            <div className="validation-card validation-card--pending">
              <PlayRegular />
              <div>
                <strong>Ready for safe validation</strong>
                <span>Synthetic data · no production writes · full trace</span>
              </div>
            </div>
          ) : (
            <div className="validation-card">
              <div className="validation-card__title">
                <CheckmarkCircleRegular />
                <div>
                  <strong>Exploit safely reproduced</strong>
                  <span>Synthetic canary observed at target</span>
                </div>
              </div>
              <ol>
                {validation.trace.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ol>
            </div>
          )}
          {remediation === undefined ? null : <RemediationCard remediation={remediation} />}
          <div className="evidence-summary">
            <div>
              <span>Evidence</span>
              <strong>{finding.path.evidenceIds.length} sources</strong>
            </div>
            <div>
              <span>Owner</span>
              <strong>{finding.owner}</strong>
            </div>
            <div>
              <span>Policy</span>
              <strong>{finding.policyId}</strong>
            </div>
          </div>
        </aside>
      </section>

      <section className="secondary-grid">
        <article className="surface-card">
          <div className="surface-card__header">
            <div>
              <span className="eyebrow">OPERATIONS</span>
              <h2>Estate health</h2>
            </div>
            <Badge appearance="outline">Last 30 days</Badge>
          </div>
          <div className="health-bars">
            {[
              ['Security', 82, '1 critical path'],
              ['Governance', 91, '1 exception'],
              ['Reliability', 97, '99.94% availability'],
              ['Quality', 88, '4.6 / 5 task score'],
              ['Cost efficiency', 76, '2 recommendations'],
              ['Lifecycle', 84, '1 stale version'],
            ].map(([label, value, detail]) => (
              <div className="health-row" key={String(label)}>
                <span>{label}</span>
                <div className="health-track">
                  <i style={{ width: `${String(value)}%` }} />
                </div>
                <strong>{value}%</strong>
                <small>{detail}</small>
              </div>
            ))}
          </div>
        </article>
        <article className="surface-card">
          <div className="surface-card__header">
            <div>
              <span className="eyebrow">TRUST CATALOG</span>
              <h2>Capability posture</h2>
            </div>
            <Badge appearance="outline">Current</Badge>
          </div>
          <div className="catalog-list">
            {[
              ['Approved MCP servers', '2', 'Reviews current', 'safe'],
              ['Verified tools', '4', '100% provenance coverage', 'safe'],
              ['Conditional capabilities', '1', 'Approval required', 'warning'],
              ['Unapproved discoveries', '1', 'Used by Sales Research', 'danger'],
            ].map(([label, value, detail, tone]) => (
              <div className="catalog-row" key={label}>
                <span className={`catalog-dot catalog-dot--${tone}`} />
                <div>
                  <strong>{label}</strong>
                  <span>{detail}</span>
                </div>
                <b>{value}</b>
              </div>
            ))}
          </div>
        </article>
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

function RemediationCard({ remediation }: { remediation: Remediation }) {
  return (
    <div className={`remediation-card remediation-card--${remediation.status}`}>
      <div className="remediation-card__header">
        <LockClosedRegular />
        <div>
          <strong>{remediation.title}</strong>
          <span>{remediation.status.replace('-', ' ')}</span>
        </div>
      </div>
      <p>{remediation.description}</p>
      <div className="remediation-stats">
        <span>
          <b>-{remediation.expectedRiskReduction}</b> risk
        </span>
        <span>
          <b>{remediation.businessDisruption}</b> disruption
        </span>
        <span>
          <b>{remediation.rollbackAvailable ? 'Available' : 'Unavailable'}</b> rollback
        </span>
      </div>
      {remediation.approvedBy === undefined ? null : (
        <div className="approval-line">
          <PersonRegular />
          Approved by {remediation.approvedBy}
        </div>
      )}
    </div>
  )
}
