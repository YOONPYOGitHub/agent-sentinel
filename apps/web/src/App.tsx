import { Badge, Button, Input, ProgressBar, Spinner, Tooltip } from '@fluentui/react-components'
import {
  AlertRegular,
  ArrowResetRegular,
  ArrowTrendingRegular,
  BotRegular,
  CheckmarkCircleRegular,
  ChevronRightRegular,
  DataUsageRegular,
  DismissRegular,
  HomeRegular,
  KeyRegular,
  LockClosedRegular,
  MoreHorizontalRegular,
  NavigationRegular,
  PersonRegular,
  PlayRegular,
  PlugConnectedRegular,
  PulseRegular,
  SearchRegular,
  SettingsRegular,
  ShieldCheckmarkRegular,
} from '@fluentui/react-icons'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'

import type { AgentSentinelState, Evidence, Remediation } from '@agent-sentinel/domain'

import { demoApi } from './api'
import { ExposureGraph } from './components/ExposureGraph'

const navigation = [
  { label: 'Overview', icon: HomeRegular, active: true },
  { label: 'Agent estate', icon: BotRegular },
  { label: 'Exposure', icon: ShieldCheckmarkRegular, count: '3' },
  { label: 'Governance', icon: LockClosedRegular },
  { label: 'Observability', icon: PulseRegular },
  { label: 'Optimization', icon: ArrowTrendingRegular },
  { label: 'Lifecycle', icon: ArrowResetRegular },
  { label: 'Trust catalog', icon: CheckmarkCircleRegular },
  { label: 'Connectors', icon: PlugConnectedRegular },
]

const portfolioMetrics = [
  {
    label: 'Managed agents',
    value: '47',
    detail: '+6 this month',
    tone: 'neutral',
    icon: BotRegular,
  },
  {
    label: 'Critical paths',
    value: '3',
    detail: '1 validated',
    tone: 'danger',
    icon: AlertRegular,
  },
  {
    label: 'Sensitive assets reached',
    value: '12',
    detail: '4 highly confidential',
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

type Operation =
  'loading' | 'validating' | 'proposing' | 'approving' | 'executing' | 'resetting' | undefined

function App() {
  const [state, setState] = useState<AgentSentinelState>()
  const [operation, setOperation] = useState<Operation>('loading')
  const [error, setError] = useState<string>()
  const [selectedEvidence, setSelectedEvidence] = useState<Evidence>()
  const [navExpanded, setNavExpanded] = useState(true)
  const evidenceDrawerRef = useRef<HTMLElement>(null)

  const load = useCallback(async () => {
    try {
      setError(undefined)
      setOperation('loading')
      setState(await demoApi.getState())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Agent estate could not be loaded.')
    } finally {
      setOperation(undefined)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (selectedEvidence === undefined) {
      return
    }

    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    evidenceDrawerRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedEvidence(undefined)
      }
    }
    document.addEventListener('keydown', closeOnEscape)

    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      previousFocus?.focus()
    }
  }, [selectedEvidence])

  const trapEvidenceFocus = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') {
      return
    }

    const focusable = event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    const first = focusable.item(0)
    const last = focusable.item(focusable.length - 1)
    if (first === null || last === null) {
      event.preventDefault()
      return
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }, [])

  const run = useCallback(
    async (
      nextOperation: Exclude<Operation, 'loading' | undefined>,
      action: () => Promise<AgentSentinelState>,
    ) => {
      try {
        setError(undefined)
        setOperation(nextOperation)
        setState(await action())
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'The operation could not be completed.')
      } finally {
        setOperation(undefined)
      }
    },
    [],
  )

  const finding = state?.findings[0]
  const remediation = state?.remediations[0]
  const validation = state?.validations[0]
  const pathStatus = finding?.path.status ?? 'theoretical'

  const primaryAction = useMemo(() => {
    if (finding === undefined) {
      return undefined
    }
    if (pathStatus === 'theoretical') {
      return {
        label: 'Run safe validation',
        icon: PlayRegular,
        busy: operation === 'validating',
        onClick: () => run('validating', () => demoApi.validateFinding(finding.id)),
      }
    }
    if (pathStatus === 'validated' && remediation === undefined) {
      return {
        label: 'Build response plan',
        icon: ShieldCheckmarkRegular,
        busy: operation === 'proposing',
        onClick: () => run('proposing', () => demoApi.proposeRemediation(finding.id)),
      }
    }
    if (remediation?.status === 'proposed') {
      return {
        label: 'Approve response',
        icon: PersonRegular,
        busy: operation === 'approving',
        onClick: () =>
          run('approving', () => demoApi.approveRemediation(remediation.id, 'Avery Morgan')),
      }
    }
    if (remediation?.status === 'approved') {
      return {
        label: 'Execute containment',
        icon: LockClosedRegular,
        busy: operation === 'executing',
        onClick: () => run('executing', () => demoApi.executeRemediation(remediation.id)),
      }
    }
    return {
      label: 'Reset demo',
      icon: ArrowResetRegular,
      busy: operation === 'resetting',
      onClick: () => run('resetting', demoApi.reset),
    }
  }, [finding, operation, pathStatus, remediation, run])

  if (operation === 'loading' && state === undefined) {
    return (
      <div className="center-state" role="status">
        <div className="brand-mark brand-mark--large">
          <ShieldCheckmarkRegular />
        </div>
        <Spinner size="large" label="Connecting the agent evidence graph…" />
      </div>
    )
  }

  if (state === undefined || finding === undefined) {
    return (
      <div className="center-state">
        <div className="empty-state">
          <AlertRegular aria-hidden="true" />
          <h1>Agent estate is unavailable</h1>
          <p>{error ?? 'No evidence-backed findings were returned.'}</p>
          <Button appearance="primary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={`app-shell ${navExpanded ? '' : 'app-shell--collapsed'}`}>
      <aside className="side-nav">
        <div className="brand">
          <div className="brand-mark">
            <ShieldCheckmarkRegular />
          </div>
          {navExpanded ? (
            <div>
              <strong>Agent Sentinel</strong>
              <span>Operations & Security</span>
            </div>
          ) : null}
        </div>
        <nav aria-label="Primary navigation">
          {navigation.map((item) => {
            const Icon = item.icon
            return (
              <button
                className={`nav-item ${item.active ? 'nav-item--active' : ''}`}
                key={item.label}
                type="button"
                aria-current={item.active ? 'page' : undefined}
              >
                <Icon aria-hidden="true" />
                {navExpanded ? <span>{item.label}</span> : null}
                {navExpanded && item.count !== undefined ? (
                  <span className="nav-count">{item.count}</span>
                ) : null}
              </button>
            )
          })}
        </nav>
        <div className="side-nav__footer">
          <button className="nav-item" type="button">
            <SettingsRegular aria-hidden="true" />
            {navExpanded ? <span>Settings</span> : null}
          </button>
        </div>
      </aside>

      <header className="top-bar">
        <div className="top-bar__left">
          <Tooltip
            content={navExpanded ? 'Collapse navigation' : 'Expand navigation'}
            relationship="label"
          >
            <Button
              appearance="subtle"
              icon={<NavigationRegular />}
              aria-label={navExpanded ? 'Collapse navigation' : 'Expand navigation'}
              onClick={() => setNavExpanded((value) => !value)}
            />
          </Tooltip>
          <div className="global-search">
            <SearchRegular aria-hidden="true" />
            <Input
              appearance="underline"
              aria-label="Search agents, identities, tools, and evidence"
              placeholder="Search agents, identities, tools, evidence"
            />
            <kbd>⌘ K</kbd>
          </div>
        </div>
        <div className="top-bar__right">
          <button className="scope-selector" type="button">
            <span className="status-dot status-dot--healthy" />
            Contoso AI Lab
            <ChevronRightRegular />
          </button>
          <button className="environment-pill" type="button">
            Demo · Korea Central
          </button>
          <Tooltip content="More actions" relationship="label">
            <Button
              appearance="subtle"
              icon={<MoreHorizontalRegular />}
              aria-label="More actions"
            />
          </Tooltip>
          <div className="avatar" aria-label="Signed in as Avery Morgan">
            AM
          </div>
        </div>
      </header>

      <main className="main-content">
        <section className="page-heading">
          <div>
            <div className="breadcrumb">
              Agent Sentinel <ChevronRightRegular /> Overview
            </div>
            <h1>Agent operations overview</h1>
            <p>
              One evidence-driven view across security, governance, quality, cost, and lifecycle.
            </p>
          </div>
          <div className="page-heading__actions">
            <span className="refresh-status">
              <span className="status-dot status-dot--healthy" />
              Updated 18 sec ago
            </span>
            <Button
              appearance="secondary"
              icon={<ArrowResetRegular />}
              onClick={() => void run('resetting', demoApi.reset)}
              disabled={operation !== undefined}
            >
              Reset
            </Button>
            {primaryAction !== undefined ? (
              <Button
                appearance="primary"
                icon={<primaryAction.icon />}
                disabled={operation !== undefined}
                onClick={() => void primaryAction.onClick()}
              >
                {primaryAction.busy ? 'Working…' : primaryAction.label}
              </Button>
            ) : null}
          </div>
        </section>

        {error !== undefined ? (
          <div className="inline-error" role="alert">
            <AlertRegular />
            <span>{error}</span>
            <button type="button" onClick={() => setError(undefined)} aria-label="Dismiss error">
              <DismissRegular />
            </button>
          </div>
        ) : null}

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
            snapshot={state.snapshot}
            pathStatus={pathStatus}
            onEvidenceSelect={setSelectedEvidence}
          />

          <aside className="finding-panel" aria-label="Critical finding details">
            <div className="finding-panel__header">
              <div>
                <span className="eyebrow">CRITICAL FINDING</span>
                <Badge
                  appearance="filled"
                  color={pathStatus === 'mitigated' ? 'success' : 'danger'}
                >
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

            {validation !== undefined ? (
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
            ) : (
              <div className="validation-card validation-card--pending">
                <PlayRegular />
                <div>
                  <strong>Ready for safe validation</strong>
                  <span>Synthetic data · no production writes · full trace</span>
                </div>
              </div>
            )}

            {remediation !== undefined ? <RemediationCard remediation={remediation} /> : null}

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
                ['Security', 82, '3 critical paths'],
                ['Governance', 91, '4 exceptions'],
                ['Reliability', 97, '99.94% availability'],
                ['Quality', 88, '4.6 / 5 task score'],
                ['Cost efficiency', 76, '6 recommendations'],
                ['Lifecycle', 84, '5 stale versions'],
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
              <Button appearance="subtle" size="small">
                View catalog
              </Button>
            </div>
            <div className="catalog-list">
              {[
                ['Approved MCP servers', '18', '2 expiring reviews', 'safe'],
                ['Verified tools', '64', '98% provenance coverage', 'safe'],
                ['Conditional capabilities', '7', 'Approval required', 'warning'],
                ['Unapproved discoveries', '3', '1 used in production', 'danger'],
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
      </main>

      {selectedEvidence !== undefined ? (
        <div
          className="evidence-backdrop"
          role="presentation"
          onClick={() => setSelectedEvidence(undefined)}
        >
          <aside
            ref={evidenceDrawerRef}
            className="evidence-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="evidence-title"
            tabIndex={-1}
            onKeyDown={trapEvidenceFocus}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="evidence-drawer__header">
              <div>
                <span className="eyebrow">EVIDENCE OBJECT</span>
                <h2 id="evidence-title">{selectedEvidence.source}</h2>
              </div>
              <Button
                appearance="subtle"
                icon={<DismissRegular />}
                aria-label="Close evidence"
                onClick={() => setSelectedEvidence(undefined)}
              />
            </div>
            <Badge
              color={selectedEvidence.freshness === 'stale' ? 'warning' : 'success'}
              appearance="tint"
            >
              {selectedEvidence.freshness} · {Math.round(selectedEvidence.confidence * 100)}%
              confidence
            </Badge>
            <p className="evidence-lead">{selectedEvidence.summary}</p>
            <dl>
              <div>
                <dt>Source object</dt>
                <dd>{selectedEvidence.sourceObjectId}</dd>
              </div>
              <div>
                <dt>Observed</dt>
                <dd>{new Date(selectedEvidence.observedAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>Evidence ID</dt>
                <dd>{selectedEvidence.id}</dd>
              </div>
              <div>
                <dt>Integrity</dt>
                <dd>SHA-256 verified · read only</dd>
              </div>
            </dl>
            <div className="evidence-note">
              <KeyRegular />
              <div>
                <strong>Evidence-first decision</strong>
                <span>
                  This object contributes to the path and risk factors. Missing or stale evidence
                  lowers confidence.
                </span>
              </div>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
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
      {remediation.approvedBy !== undefined ? (
        <div className="approval-line">
          <PersonRegular />
          Approved by {remediation.approvedBy}
        </div>
      ) : null}
    </div>
  )
}

export default App
