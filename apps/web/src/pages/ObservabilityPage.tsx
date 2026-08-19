import { Badge, Button, ProgressBar } from '@fluentui/react-components'
import {
  ArrowClockwiseRegular,
  CheckmarkCircleRegular,
  ClockRegular,
  DataUsageRegular,
  PulseRegular,
  WarningRegular,
} from '@fluentui/react-icons'
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'

import type { Evidence } from '@agent-sentinel/domain'

import { PageHeading } from '../components/PageHeading'
import { useDemoState } from '../hooks/useDemoState'

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
    }))
    .sort((left, right) => right.count - left.count || left.source.localeCompare(right.source))
}

export function ObservabilityPage() {
  const navigate = useNavigate()
  const { clearError, connectorStatus, error, load, operation, state } = useDemoState()
  const snapshotEvidence = state?.snapshot.evidence
  const evidence = useMemo(() => snapshotEvidence ?? [], [snapshotEvidence])
  const sourceCoverage = useMemo(() => groupEvidence(evidence), [evidence])
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
            Runtime latency, reliability, token, and cost telemetry are not yet connected. This view
            reports only evidence the current connectors actually provide.
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
    </>
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
