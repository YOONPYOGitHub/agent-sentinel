import { Badge, Button, ProgressBar, Textarea, Tooltip } from '@fluentui/react-components'
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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import type {
  AgentSentinelState,
  ExposurePage as ExposurePageDto,
  Remediation,
} from '@agent-sentinel/domain'

import { demoApi } from '../api'
import { exposureApi } from '../api/exposure-api'
import { EvidenceDrawer } from '../components/EvidenceDrawer'
import { ExposureGraph } from '../components/ExposureGraph'
import { PageHeading } from '../components/PageHeading'
import { useDemoState } from '../hooks/useDemoState'
import { usePermission, usePermissionMessage } from '../hooks/usePermission'
import { useAuth } from '../hooks/useAuth'
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
  const { principal } = useAuth()
  const writeEnabled = connectorStatus?.writeEnabled !== false
  const liveFoundry = connectorStatus?.mode === 'foundry'

  // Permission hooks ? auth-gated in JWT mode; no-op in disabled mode
  const canValidate = usePermission('validateFinding')
  const canPropose = usePermission('proposeRemediation')
  const canApprove = usePermission('approveRemediation')
  const canExecute = usePermission('executeRemediation')
  const canReset = usePermission('configure')
  const validateMsg = usePermissionMessage('validateFinding')
  const proposeMsg = usePermissionMessage('proposeRemediation')
  const approveMsg = usePermissionMessage('approveRemediation')
  const executeMsg = usePermissionMessage('executeRemediation')
  const resetMsg = usePermissionMessage('configure')
  const { selectedEvidence, setSelectedEvidence, drawerRef, trapFocus } = useEvidenceDrawer()
  const finding = state?.findings[0]
  const [liveExposure, setLiveExposure] = useState<ExposurePageDto>()
  const [liveExposureError, setLiveExposureError] = useState<string>()
  const [liveExposureLoading, setLiveExposureLoading] = useState(false)
  const [approvalReason, setApprovalReason] = useState('')
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

  const loadLiveExposure = useCallback(async () => {
    setLiveExposureLoading(true)
    setLiveExposureError(undefined)
    try {
      const activeFindings = []
      for (const status of ['open', 'validated'] as const) {
        const statusFindings = []
        let page = 1
        let total = Number.POSITIVE_INFINITY
        while (statusFindings.length < total) {
          const result = await exposureApi.list({ status, page, pageSize: 200 })
          statusFindings.push(...result.findings)
          total = result.total
          if (result.findings.length === 0) break
          page += 1
        }
        activeFindings.push(...statusFindings)
      }
      const facets = {
        severity: {} as Record<string, number>,
        status: {} as Record<string, number>,
        policyId: {} as Record<string, number>,
      }
      for (const item of activeFindings) {
        facets.severity[item.severity] = (facets.severity[item.severity] ?? 0) + 1
        facets.status[item.status] = (facets.status[item.status] ?? 0) + 1
        facets.policyId[item.policyId] = (facets.policyId[item.policyId] ?? 0) + 1
      }
      setLiveExposure({
        findings: activeFindings,
        total: activeFindings.length,
        facets,
      })
    } catch (caught: unknown) {
      setLiveExposureError(
        caught instanceof Error ? caught.message : 'Live exposure summary could not be loaded.',
      )
    } finally {
      setLiveExposureLoading(false)
    }
  }, [])

  useEffect(() => {
    if (liveFoundry || finding === undefined) void loadLiveExposure()
  }, [finding, liveFoundry, loadLiveExposure])

  useEffect(() => {
    if (remediation?.status !== 'proposed') setApprovalReason('')
  }, [remediation?.status])

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
          run('approving', () =>
            demoApi.approveRemediation(
              remediation.id,
              principal?.preferredUsername ??
                principal?.displayName ??
                principal?.objectId ??
                principal?.subject ??
                'Local demo operator',
              approvalReason.trim(),
            ),
          ),
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
  }, [approvalReason, finding, operation, pathStatus, principal, remediation, run])

  if (state === undefined) {
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

  if (liveFoundry || finding === undefined || pathSnapshot === undefined) {
    return (
      <LiveEstateOverview
        state={state}
        exposure={liveExposure}
        exposureError={liveExposureError}
        exposureLoading={liveExposureLoading}
        connectorSource={connectorStatus?.source ?? 'unavailable'}
        providerError={error}
        providerLoading={operation !== undefined}
        onRefresh={() => void Promise.all([load(), loadLiveExposure()])}
      />
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
            {resetMsg !== null ? (
              <Tooltip content={resetMsg} relationship="label">
                <span>
                  <Button
                    appearance="secondary"
                    icon={<ArrowResetRegular />}
                    onClick={() => void run('resetting', demoApi.reset)}
                    disabled={!writeEnabled || operation !== undefined || !canReset}
                  >
                    Reset
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Button
                appearance="secondary"
                icon={<ArrowResetRegular />}
                onClick={() => void run('resetting', demoApi.reset)}
                disabled={!writeEnabled || operation !== undefined || !canReset}
              >
                Reset
              </Button>
            )}
            {remediation?.status === 'proposed' ? (
              <Textarea
                aria-label="Approval reason"
                placeholder="State why this response plan is approved"
                value={approvalReason}
                resize="vertical"
                onChange={(_event, data) => setApprovalReason(data.value)}
              />
            ) : null}
            {primaryAction === undefined
              ? null
              : (() => {
                  const cap =
                    primaryAction.label === 'Run safe validation'
                      ? { can: canValidate, msg: validateMsg }
                      : primaryAction.label === 'Build response plan'
                        ? { can: canPropose, msg: proposeMsg }
                        : primaryAction.label === 'Approve response'
                          ? { can: canApprove, msg: approveMsg }
                          : primaryAction.label === 'Execute containment'
                            ? { can: canExecute, msg: executeMsg }
                            : { can: true, msg: null }
                  const btn = (
                    <Button
                      appearance="primary"
                      icon={<primaryAction.icon />}
                      disabled={
                        !writeEnabled ||
                        operation !== undefined ||
                        !cap.can ||
                        (primaryAction.label === 'Approve response' &&
                          approvalReason.trim().length < 10)
                      }
                      onClick={() => void primaryAction.onClick()}
                    >
                      {primaryAction.busy ? 'Working…' : primaryAction.label}
                    </Button>
                  )
                  return cap.msg !== null ? (
                    <Tooltip content={cap.msg} relationship="label">
                      <span>{btn}</span>
                    </Tooltip>
                  ) : (
                    btn
                  )
                })()}
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

function LiveEstateOverview({
  state,
  exposure,
  exposureError,
  exposureLoading,
  connectorSource,
  providerError,
  providerLoading,
  onRefresh,
}: {
  state: AgentSentinelState
  exposure: ExposurePageDto | undefined
  exposureError: string | undefined
  exposureLoading: boolean
  connectorSource: string
  providerError: string | undefined
  providerLoading: boolean
  onRefresh: () => void
}) {
  const agents = state.snapshot.nodes.filter((node) => node.kind === 'agent')
  const evidenceSources = new Set(state.snapshot.evidence.map((item) => item.source))
  const critical = exposure?.findings.filter((item) => item.severity === 'critical').length ?? 0
  const high = exposure?.findings.filter((item) => item.severity === 'high').length ?? 0
  const trusted = agents.filter((agent) => agent.trust === 'trusted').length

  return (
    <>
      <PageHeading
        section="Overview"
        title="Agent operations overview"
        description="Live Foundry inventory, declared-configuration exposure, and evidence posture."
        actions={
          <Button
            appearance="secondary"
            icon={<ArrowResetRegular />}
            disabled={exposureLoading || providerLoading}
            onClick={onRefresh}
          >
            Refresh live posture
          </Button>
        }
      />

      <section className="live-overview-boundary">
        <DataUsageRegular />
        <div>
          <strong>Foundry declared configuration is connected</strong>
          <span>
            Full cross-plane attack paths require Entra identity, data-classification, and MCP
            runtime telemetry. Their absence does not imply safety.
          </span>
        </div>
        <Badge appearance="outline">{connectorSource}</Badge>
      </section>

      {exposureError ? (
        <div className="inline-error" role="alert">
          <AlertRegular />
          <span>{exposureError} · Inventory and evidence remain available.</span>
        </div>
      ) : null}
      {providerError ? (
        <div className="inline-error" role="alert">
          <AlertRegular />
          <span>
            Persisted read-model refresh failed: {providerError} · Showing the last-known snapshot.
          </span>
        </div>
      ) : null}

      <section className="metric-grid" aria-label="Live agent estate metrics">
        {[
          {
            label: 'Discovered agents',
            value: agents.length,
            detail: `${agents.filter((agent) => agent.owner).length} with declared owners`,
            tone: 'neutral',
            icon: BotRegular,
          },
          {
            label: 'Open exposures',
            value: exposure?.total ?? '—',
            detail: exposureLoading
              ? 'Loading live findings'
              : `${critical} critical · ${high} high`,
            tone: critical > 0 ? 'danger' : 'neutral',
            icon: AlertRegular,
          },
          {
            label: 'Evidence objects',
            value: state.snapshot.evidence.length,
            detail: `${evidenceSources.size} source systems`,
            tone: 'success',
            icon: DataUsageRegular,
          },
          {
            label: 'Trusted agents',
            value: trusted,
            detail: `${agents.length - trusted} conditional or untrusted`,
            tone: trusted === agents.length ? 'success' : 'warning',
            icon: ShieldCheckmarkRegular,
          },
        ].map((metric) => {
          const Icon = metric.icon
          return (
            <article className={`metric-card metric-card--${metric.tone}`} key={metric.label}>
              <div className="metric-card__top">
                <span>{metric.label}</span>
                <Icon />
              </div>
              <strong>{metric.value}</strong>
              <span>{metric.detail}</span>
            </article>
          )
        })}
      </section>

      <section className="live-overview-grid">
        <article className="surface-card">
          <div className="surface-card__header">
            <div>
              <span className="eyebrow">EXPOSURE POSTURE</span>
              <h2>Declared-configuration findings</h2>
            </div>
            <Link to="/exposure">Open Exposure</Link>
          </div>
          {exposureLoading && exposure === undefined ? (
            <div className="live-overview-state">Loading live findings…</div>
          ) : exposureError && exposure === undefined ? (
            <div className="live-overview-state live-overview-state--error">
              Active exposure posture is unavailable.
            </div>
          ) : exposure?.findings.length ? (
            <div className="live-finding-list">
              {exposure.findings.slice(0, 5).map((item) => (
                <Link to={`/exposure/${item.id}`} key={item.id}>
                  <Badge
                    appearance="tint"
                    color={item.severity === 'critical' ? 'danger' : 'warning'}
                  >
                    {item.severity}
                  </Badge>
                  <div>
                    <strong>{item.title}</strong>
                    <span>
                      {item.policyId} · Risk {item.riskScore} · {item.validationStatus}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="live-overview-state">
              No active declared-configuration finding was returned.
            </div>
          )}
        </article>

        <article className="surface-card">
          <div className="surface-card__header">
            <div>
              <span className="eyebrow">EVIDENCE COVERAGE</span>
              <h2>Current discovery snapshot</h2>
            </div>
            <Link to="/observability">Open Observability</Link>
          </div>
          <dl className="live-evidence-summary">
            <div>
              <dt>Environment</dt>
              <dd>{state.snapshot.environment}</dd>
            </div>
            <div>
              <dt>Generated</dt>
              <dd>{new Date(state.snapshot.generatedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Graph relationships</dt>
              <dd>{state.snapshot.edges.length}</dd>
            </div>
            <div>
              <dt>Evidence source systems</dt>
              <dd>{evidenceSources.size}</dd>
            </div>
          </dl>
          <p className="live-overview-note">
            Identity privilege, sensitive-data reachability, runtime activity, reliability, quality,
            and cost remain unavailable until their authoritative connectors are added.
          </p>
        </article>
      </section>
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
          <span>
            Approved by {remediation.approvedBy}
            {remediation.approvalReason === undefined
              ? null
              : ` · ${remediation.approvalReason}`}
          </span>
        </div>
      )}
    </div>
  )
}
