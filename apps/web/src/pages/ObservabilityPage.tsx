import { Badge, Button, ProgressBar } from '@fluentui/react-components'
import {
  ArrowClockwiseRegular,
  CheckmarkCircleRegular,
  ClockRegular,
  DataUsageRegular,
  PlugConnectedRegular,
  PulseRegular,
  SparkleRegular,
  WarningRegular,
} from '@fluentui/react-icons'
import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import type { DriftAnalysisResult, Evidence, EvidenceType } from '@agent-sentinel/domain'

import { PageHeading } from '../components/PageHeading'
import { formatEvidenceTypes } from '../evidence-types'
import { useDemoState } from '../hooks/useDemoState'
import { useAgentDrift } from '../hooks/useAgentDrift'

function formatDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function groupEvidence(evidence: Evidence[]) {
  const sources = new Map<string, Evidence[]>()
  for (const item of evidence) {
    sources.set(item.source, [...(sources.get(item.source) ?? []), item])
  }
  return [...sources.entries()]
    .map(([source, items]) => ({
      source,
      count: items.length,
      latestObservedAt: items
        .map((item) => item.observedAt)
        .sort((left, right) => right.localeCompare(left))[0]!,
      averageConfidence:
        items.reduce((total, item) => total + item.confidence, 0) / Math.max(items.length, 1),
      stale: items.filter((item) => item.freshness === 'stale').length,
      evidenceTypes: [...new Set(items.flatMap((item) => item.evidenceTypes))],
    }))
    .sort((left, right) => right.count - left.count || left.source.localeCompare(right.source))
}

export function ObservabilityPage() {
  const navigate = useNavigate()
  const { clearError, connectorStatus, error, load, operation, state } = useDemoState()
  const snapshotEvidence = state?.snapshot.evidence
  const observedAgents = useMemo(
    () =>
      (state?.snapshot.nodes ?? [])
        .filter((node) => node.kind === 'agent')
        .slice(0, 3)
        .map((node) => ({ id: node.id, name: node.name })),
    [state?.snapshot.nodes],
  )
  const evidence = useMemo(() => snapshotEvidence ?? [], [snapshotEvidence])
  const sourceCoverage = useMemo(() => groupEvidence(evidence), [evidence])
  const evidenceTypeCounts = useMemo(
    () =>
      evidence.reduce(
        (counts, item) => {
          for (const type of item.evidenceTypes) counts[type] += 1
          return counts
        },
        {
          declared_configuration: 0,
          observed_runtime: 0,
          synthetic_validation: 0,
          unknown: 0,
        } satisfies Record<EvidenceType, number>,
      ),
    [evidence],
  )
  const freshness = useMemo(
    () => ({
      live: evidence.filter((item) => item.freshness === 'live').length,
      recent: evidence.filter((item) => item.freshness === 'recent').length,
      stale: evidence.filter((item) => item.freshness === 'stale').length,
    }),
    [evidence],
  )
  const averageConfidence =
    evidence.length > 0
      ? evidence.reduce((total, item) => total + item.confidence, 0) / evidence.length
      : undefined
  const latestObservedAt = evidence
    .map((item) => item.observedAt)
    .sort((left, right) => right.localeCompare(left))[0]
  const validations = state?.validations ?? []
  const latestValidation = validations[0]
  const latestValidationSucceeded = latestValidation?.status === 'validated'
  const latestValidationFailed =
    latestValidation?.status === 'failed' || latestValidation?.status === 'not-reproduced'
  const validationDetail = latestValidationSucceeded
    ? 'Latest finding reproduced with synthetic data'
    : latestValidationFailed
      ? 'Latest validation did not confirm the finding'
      : latestValidation
        ? 'Validation is queued or running'
        : 'No validation run recorded'
  const validationTone = latestValidationSucceeded
    ? 'success'
    : latestValidationFailed
      ? 'warning'
      : 'neutral'

  return (
    <>
      <PageHeading
        section="Observability"
        title="Evidence operations"
        description="Freshness, confidence, source coverage, and safe-validation activity for the current agent estate."
        actions={
          <Button
            appearance="secondary"
            icon={<ArrowClockwiseRegular />}
            disabled={operation !== undefined}
            onClick={() => void load()}
          >
            Refresh evidence
          </Button>
        }
      />

      <section className="observability-boundary">
        <PulseRegular />
        <div>
          <strong>Evidence observability, not runtime APM</strong>
          <span>
            This view reports only evidence the current connectors actually provide. Runtime
            latency, reliability, token, and cost remain insufficient until measured windows meet
            their evidence thresholds.
          </span>
        </div>
      </section>

      {error ? (
        <section className="observability-refresh-warning" role="alert">
          <WarningRegular />
          <div>
            <strong>
              {state ? 'Operational warning; showing last-known evidence' : 'Evidence unavailable'}
            </strong>
            <span>
              {error}
              {state ? ` · Snapshot generated ${formatDateTime(state.snapshot.generatedAt)}` : ''}
            </span>
          </div>
          <Button appearance="subtle" onClick={clearError}>
            Dismiss
          </Button>
        </section>
      ) : null}

      <section className="observability-summary" aria-label="Evidence operations summary">
        <ObservabilityMetric
          icon={DataUsageRegular}
          label="Evidence objects"
          value={String(evidence.length)}
          detail={`${sourceCoverage.length} evidence source systems`}
          tone="neutral"
        />
        <ObservabilityMetric
          icon={CheckmarkCircleRegular}
          label="Average confidence"
          value={
            averageConfidence === undefined
              ? 'Unavailable'
              : `${Math.round(averageConfidence * 100)}%`
          }
          detail={
            averageConfidence === undefined
              ? 'No evidence available'
              : 'Across cited evidence objects'
          }
          tone={averageConfidence === undefined ? 'neutral' : 'success'}
        />
        <ObservabilityMetric
          icon={freshness.stale > 0 ? WarningRegular : ClockRegular}
          label="Stale evidence"
          value={evidence.length === 0 ? 'Unavailable' : String(freshness.stale)}
          detail={
            evidence.length === 0
              ? 'No freshness evidence available'
              : `${freshness.live} live · ${freshness.recent} recent`
          }
          tone={evidence.length === 0 ? 'neutral' : freshness.stale > 0 ? 'warning' : 'success'}
        />
        <ObservabilityMetric
          icon={PulseRegular}
          label="Runtime evidence"
          value={String(evidenceTypeCounts.observed_runtime)}
          detail={`${state?.runtimeEvidence?.status ?? 'status not reported'} · ${evidenceTypeCounts.declared_configuration} declared · ${evidenceTypeCounts.synthetic_validation} synthetic · ${evidenceTypeCounts.unknown} unclassified`}
          tone={
            state?.runtimeEvidence?.status === 'partial' ||
            state?.runtimeEvidence?.status === 'unavailable'
              ? 'warning'
              : evidenceTypeCounts.observed_runtime > 0
                ? 'success'
                : 'neutral'
          }
        />
        <ObservabilityMetric
          icon={CheckmarkCircleRegular}
          label="Manifest runtime claims"
          value={String(state?.manifestRuntimeVerification?.counts.verified ?? 0)}
          detail={
            state?.manifestRuntimeVerification === undefined
              ? 'verification status not reported'
              : `${state.manifestRuntimeVerification.status}${state.manifestRuntimeVerification.reason === undefined ? '' : ` (${state.manifestRuntimeVerification.reason})`} · ${state.manifestRuntimeVerification.counts.noObservation} not observed · ${state.manifestRuntimeVerification.counts.ambiguous} ambiguous · ${state.manifestRuntimeVerification.counts.notCorrelatable} not correlatable`
          }
          tone={
            state?.manifestRuntimeVerification?.status === 'ready'
              ? 'success'
              : state?.manifestRuntimeVerification?.status === 'partial' ||
                  state?.manifestRuntimeVerification?.status === 'unavailable'
                ? 'warning'
                : 'neutral'
          }
        />
        <ObservabilityMetric
          icon={PlugConnectedRegular}
          label="Manifest typed values"
          value={String(state?.manifestConfigurationReconciliation?.counts.valueMatched ?? 0)}
          detail={
            state?.manifestConfigurationReconciliation === undefined
              ? 'reconciliation status not reported'
              : `${state.manifestConfigurationReconciliation.status}${state.manifestConfigurationReconciliation.reason === undefined ? '' : ` (${state.manifestConfigurationReconciliation.reason})`} · ${state.manifestConfigurationReconciliation.counts.matched} objects matched · ${state.manifestConfigurationReconciliation.counts.valueMismatched} values mismatched · ${state.manifestConfigurationReconciliation.counts.valueUnavailable} values unavailable · ${state.manifestConfigurationReconciliation.counts.freeFormUnverified} free-form unverified · ${state.manifestConfigurationReconciliation.counts.ambiguous} ambiguous · ${state.manifestConfigurationReconciliation.counts.notCorrelatable} not correlatable`
          }
          tone={
            state?.manifestConfigurationReconciliation?.status === 'ready'
              ? 'success'
              : state?.manifestConfigurationReconciliation?.status === 'partial' ||
                  state?.manifestConfigurationReconciliation?.status === 'unavailable'
                ? 'warning'
                : 'neutral'
          }
        />
        <ObservabilityMetric
          icon={PulseRegular}
          label="Safe validations"
          value={String(validations.length)}
          detail={validationDetail}
          tone={validationTone}
        />
      </section>

      <section className="observability-grid">
        <article className="observability-card">
          <div className="observability-card__header">
            <div>
              <span className="eyebrow">SOURCE COVERAGE</span>
              <h2>Evidence health by source system</h2>
            </div>
            <Badge appearance="outline">
              {connectorStatus
                ? connectorStatus.mode === 'foundry'
                  ? 'Foundry mode'
                  : 'Mock mode'
                : 'Status unavailable'}
            </Badge>
          </div>
          <div className="evidence-source-list">
            {sourceCoverage.length === 0 ? (
              <div className="observability-empty">
                <DataUsageRegular />
                <strong>No evidence available</strong>
                <span>Connect or refresh a source before assessing freshness and confidence.</span>
              </div>
            ) : (
              sourceCoverage.map((source) => (
                <div key={source.source} className="evidence-source-row">
                  <div>
                    <strong>{source.source}</strong>
                    <span>
                      {source.count} objects · Latest {formatDateTime(source.latestObservedAt)}
                    </span>
                    <small>{formatEvidenceTypes(source.evidenceTypes)}</small>
                  </div>
                  <div>
                    <span>{Math.round(source.averageConfidence * 100)}% confidence</span>
                    <ProgressBar
                      aria-label={`${source.source} confidence ${Math.round(source.averageConfidence * 100)} percent`}
                      value={source.averageConfidence}
                      color={source.stale > 0 ? 'warning' : 'success'}
                      thickness="medium"
                    />
                  </div>
                  <Badge appearance="tint" color={source.stale > 0 ? 'warning' : 'success'}>
                    {source.stale > 0 ? `${source.stale} stale` : 'Current'}
                  </Badge>
                </div>
              ))
            )}
          </div>
        </article>

        <aside className="observability-card observability-activity">
          <div className="observability-card__header">
            <div>
              <span className="eyebrow">ACTIVITY</span>
              <h2>Validation and evidence timeline</h2>
            </div>
          </div>
          <ol>
            {validations.map((validation) => (
              <li key={validation.id}>
                <span
                  className={`timeline-dot ${
                    validation.status === 'validated'
                      ? 'timeline-dot--success'
                      : validation.status === 'failed' || validation.status === 'not-reproduced'
                        ? 'timeline-dot--warning'
                        : ''
                  }`}
                />
                <div>
                  <strong>Safe validation {validation.status}</strong>
                  <span>{formatDateTime(validation.completedAt ?? validation.startedAt)}</span>
                  <small>{validation.trace.at(-1) ?? 'No validation trace available.'}</small>
                </div>
              </li>
            ))}
            {latestObservedAt ? (
              <li>
                <span className="timeline-dot" />
                <div>
                  <strong>Latest evidence observed</strong>
                  <span>{formatDateTime(latestObservedAt)}</span>
                  <small>{evidence.length} evidence objects available to analysts.</small>
                </div>
              </li>
            ) : null}
          </ol>
          <Button appearance="primary" onClick={() => void navigate('/connectors')}>
            Open connector health
          </Button>
        </aside>
      </section>

      <BehaviorDriftSummary agents={observedAgents} mode={connectorStatus?.mode} />
    </>
  )
}

function BehaviorDriftSummary({
  agents,
  mode,
}: {
  agents: Array<{ id: string; name: string }>
  mode: 'mock' | 'foundry' | undefined
}) {
  return (
    <section
      className="observability-card observability-drift"
      aria-labelledby="drift-section-title"
    >
      <div className="observability-card__header">
        <div>
          <span className="eyebrow">BEHAVIOR BASELINE &amp; DRIFT</span>
          <h2 id="drift-section-title">Agent runtime behavior</h2>
        </div>
        <SparkleRegular aria-hidden="true" />
      </div>

      {agents.length === 0 ? (
        <div className="observability-empty">
          <DataUsageRegular aria-hidden="true" />
          <strong>No agents available for drift analysis</strong>
          <span>Agent-bound telemetry appears after authoritative discovery supplies agents.</span>
        </div>
      ) : (
        <>
          {mode === 'mock' ? (
            <div
              className="observability-boundary observability-boundary--synthetic"
              role="note"
              aria-label="Synthetic data notice"
            >
              <SparkleRegular aria-hidden="true" />
              <div>
                <strong>[SYNTHETIC] Mock demonstration only</strong>
                <span>
                  These results use fixed synthetic observations to demonstrate the deterministic
                  drift-analysis engine.
                </span>
              </div>
            </div>
          ) : (
            <div className="observability-boundary" role="status">
              <PulseRegular aria-hidden="true" />
              <div>
                <strong>Live telemetry evaluation</strong>
                <span>
                  Each agent result reports measured, insufficient, invalid, or unavailable state.
                  Missing windows and query failures never appear healthy.
                </span>
              </div>
            </div>
          )}
          <div className="drift-results-grid">
            {agents.map((agent) => (
              <AgentDriftCard key={agent.id} agent={agent} />
            ))}
          </div>
        </>
      )}
    </section>
  )
}

function AgentDriftCard({ agent }: { agent: { id: string; name: string } }) {
  const result = useAgentDrift(agent.id)
  if (result === null) {
    return (
      <article className="drift-card" aria-label={`Drift summary for ${agent.name}`}>
        <div className="drift-card__header">
          <strong>{agent.name}</strong>
          <Badge appearance="outline">Loading or unavailable</Badge>
        </div>
      </article>
    )
  }
  return <DriftAgentCard result={result} agentName={agent.name} />
}

function DriftAgentCard({ result, agentName }: { result: DriftAnalysisResult; agentName: string }) {
  const driftedDimensions = result.dimensions.filter((d) => d.drifted)
  const topSeverity = result.highestSeverity
  const ready = result.status === 'ready'

  return (
    <article
      className={`drift-card drift-card--${
        !ready ? 'neutral' : result.anyDrift ? (topSeverity ?? 'low') : 'healthy'
      }`}
      aria-label={`Drift summary for ${agentName}`}
    >
      <div className="drift-card__header">
        <strong>
          <Link to={`/agent-inventory/${result.agentId}`}>{agentName}</Link>
        </strong>
        <Badge
          appearance="filled"
          color={
            !ready
              ? 'informative'
              : topSeverity === 'critical'
                ? 'danger'
                : topSeverity === 'high'
                  ? 'warning'
                  : topSeverity === 'medium' || topSeverity === 'low'
                    ? 'informative'
                    : 'success'
          }
        >
          {!ready
            ? result.status.replaceAll('-', ' ')
            : result.anyDrift
              ? `Drift: ${topSeverity ?? 'low'}`
              : 'Stable'}
        </Badge>
      </div>
      {result.coverage !== undefined && (
        <p className="muted">
          {result.coverage.baselineSamples} baseline / {result.coverage.observedSamples} observed
          samples &middot; {Math.round(result.coverage.coverageScore * 100)}% metric coverage
        </p>
      )}
      {!ready ? (
        <p className="muted">
          {result.unavailableReason ?? 'Measured telemetry is not sufficient for analysis.'}
        </p>
      ) : driftedDimensions.length > 0 ? (
        <ul className="drift-dimension-list" aria-label="Drifted dimensions">
          {driftedDimensions.map((dim) => (
            <li key={dim.dimension}>
              <Badge
                appearance="tint"
                color={
                  dim.severity === 'critical'
                    ? 'danger'
                    : dim.severity === 'high'
                      ? 'warning'
                      : 'informative'
                }
              >
                {dim.dimension}
              </Badge>
              <span>{dim.explanation}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No drift detected across {result.dimensions.length} dimensions.</p>
      )}
    </article>
  )
}

function ObservabilityMetric({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: typeof PulseRegular
  label: string
  value: string
  detail: string
  tone: 'neutral' | 'success' | 'warning'
}) {
  return (
    <article className={`observability-metric observability-metric--${tone}`}>
      <Icon />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}
