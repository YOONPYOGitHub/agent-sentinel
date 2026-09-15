import {
  assessDemoReadiness,
  type ConnectorsCollectionResponse,
  type DemoReadinessAssessment,
  type DemoReadinessCategory,
} from '@agent-sentinel/connector-sdk/demo-readiness'
import type { AgentSentinelState, ConnectorSourceReadModel } from '@agent-sentinel/domain'
import {
  AlertRegular,
  ArrowClockwiseRegular,
  CheckmarkCircleRegular,
  ClockRegular,
  DataUsageRegular,
  PulseRegular,
  WarningRegular,
} from '@fluentui/react-icons'
import { Button } from '@fluentui/react-components'
import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { connectorsApi, connectorSourcesApi } from '../api/connectors-api'
import { PageHeading } from '../components/PageHeading'
import { useDemoState } from '../hooks/useDemoState'

export interface ReleaseReadinessPageProps {
  readonly state: AgentSentinelState
  readonly connectors?: ConnectorsCollectionResponse | undefined
  readonly connectorSources?: readonly ConnectorSourceReadModel[] | undefined
  readonly loading: boolean
  readonly error?: string | undefined
  readonly onRefresh: () => void
}

function label(status: DemoReadinessAssessment['status']): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function formatDate(value: string | undefined): string {
  if (value === undefined) return 'Not observed'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

function StatusIcon({ status }: { status: DemoReadinessAssessment['status'] }) {
  if (status === 'ready') return <CheckmarkCircleRegular aria-hidden="true" />
  if (status === 'partial') return <ClockRegular aria-hidden="true" />
  if (status === 'blocked') return <WarningRegular aria-hidden="true" />
  return <AlertRegular aria-hidden="true" />
}

function ReadinessCard({
  title,
  category,
  children,
}: {
  title: string
  category: DemoReadinessCategory
  children: ReactNode
}) {
  return (
    <article className={`demo-readiness-card demo-readiness-card--${category.status}`}>
      <header>
        <StatusIcon status={category.status} />
        <div>
          <span>{label(category.status)}</span>
          <h2>{title}</h2>
        </div>
      </header>
      <p>{category.summary}</p>
      <dl>{children}</dl>
      <small>Last observed: {formatDate(category.observedAt)}</small>
    </article>
  )
}

export function ReleaseReadinessPage({
  state,
  connectors,
  connectorSources,
  loading,
  error,
  onRefresh,
}: ReleaseReadinessPageProps) {
  const assessment =
    connectors === undefined || connectorSources === undefined
      ? undefined
      : assessDemoReadiness({ state, connectors, connectorSources })

  return (
    <>
      <PageHeading
        section="Operations"
        title="Release readiness"
        description="Read-only verification of persisted Agent 365, exact identity correlation, runtime telemetry, and deployment evidence required for release review."
        actions={
          <Button
            appearance="secondary"
            icon={<ArrowClockwiseRegular />}
            disabled={loading}
            onClick={onRefresh}
          >
            Refresh readiness
          </Button>
        }
      />
      <section className="demo-readiness-alert" role="note">
        <AlertRegular aria-hidden="true" />
        <div>
          <strong>
            Operational evidence informs release review; it does not approve a release.
          </strong>
          <span>
            A Ready result means the automated evidence gates passed. Required human review and
            release approval remain separate.
          </span>
        </div>
      </section>

      {error !== undefined ? (
        <section className="demo-readiness-alert" role="alert">
          <WarningRegular aria-hidden="true" />
          <div>
            <strong>Readiness evidence unavailable</strong>
            <span>{error}</span>
          </div>
        </section>
      ) : null}

      {assessment === undefined ? (
        <section className="demo-readiness-alert" role="status" aria-busy={loading}>
          <PulseRegular aria-hidden="true" />
          <div>
            <strong>{loading ? 'Loading readiness evidence' : 'Readiness is unavailable'}</strong>
            <span>
              No mock success fallback is used. Refresh to retrieve current connector evidence.
            </span>
          </div>
        </section>
      ) : (
        <>
          <section
            className={`demo-readiness-overall demo-readiness-overall--${assessment.status}`}
            aria-label="Overall release readiness"
          >
            <StatusIcon status={assessment.status} />
            <div>
              <span>Overall status</span>
              <h2>{label(assessment.status)}</h2>
              <p>{assessment.summary}</p>
              <small>Current snapshot: {formatDate(assessment.observedAt)}</small>
            </div>
          </section>

          <section className="demo-readiness-grid" aria-label="Release readiness categories">
            <ReadinessCard title="Agent 365 package catalog" category={assessment.agent365}>
              <dt>Catalog status</dt>
              <dd>{assessment.agent365.catalogStatus ?? 'Unavailable'}</dd>
              <dt>Packages observed</dt>
              <dd>{assessment.agent365.packageEvidenceCount}</dd>
              <dt>Agent / extension</dt>
              <dd>
                {assessment.agent365.agentPackageCount} /{' '}
                {assessment.agent365.extensionPackageCount}
              </dd>
              <dt>Provider pages / records</dt>
              <dd>
                {assessment.agent365.pages ?? 'unknown'} /{' '}
                {assessment.agent365.records ?? 'unknown'}
              </dd>
              <dt>Live source status</dt>
              <dd>{assessment.agent365.liveSourceStatusCount}</dd>
            </ReadinessCard>

            <ReadinessCard title="Connector runtime binding" category={assessment.connectorBinding}>
              <dt>Deployment managed</dt>
              <dd>{assessment.connectorBinding.deploymentManaged ? 'Yes' : 'No'}</dd>
              <dt>Runtime binding</dt>
              <dd>{assessment.connectorBinding.bindingSourceId ?? 'Unavailable'}</dd>
              <dt>Credential</dt>
              <dd>{assessment.connectorBinding.credentialMode ?? 'Unavailable'}</dd>
              <dt>Managed identity ID</dt>
              <dd>{assessment.connectorBinding.managedIdentityClientId}</dd>
              <dt>Source test status</dt>
              <dd>{assessment.connectorBinding.testStatus ?? 'Unavailable'}</dd>
            </ReadinessCard>

            <ReadinessCard title="Exact RUNS_AS" category={assessment.runsAs}>
              <dt>Exact edges</dt>
              <dd>{assessment.runsAs.exactEdgeCount}</dd>
              <dt>Unmatched / ambiguous</dt>
              <dd>
                {assessment.runsAs.unmatched} / {assessment.runsAs.ambiguous}
              </dd>
              <dt>Missing provider IDs</dt>
              <dd>{assessment.runsAs.unmatchedReasons['missing-authoritative-identifier'] ?? 0}</dd>
              <dt>Non-exact edges</dt>
              <dd>{assessment.runsAs.nonExactEdgeCount}</dd>
            </ReadinessCard>

            <ReadinessCard title="OpenTelemetry runtime" category={assessment.otel}>
              <dt>Runtime status</dt>
              <dd>{assessment.otel.runtimeStatus}</dd>
              <dt>Complete sources</dt>
              <dd>
                {assessment.otel.completeSourceCount} / {assessment.otel.sourceCount}
              </dd>
              <dt>Accepted records</dt>
              <dd>{assessment.otel.acceptedRecordCount}</dd>
              <dt>Live invocations</dt>
              <dd>{assessment.otel.liveInvocationCount}</dd>
              <dt>Trace/span + token/cost</dt>
              <dd>
                {assessment.otel.traceSpanProvenanceCount} /{' '}
                {assessment.otel.tokenCostProvenanceCount}
              </dd>
            </ReadinessCard>
          </section>

          {assessment.requirements.length > 0 ? (
            <section className="demo-readiness-requirements">
              <div>
                <DataUsageRegular aria-hidden="true" />
                <h2>Requirements before release review</h2>
              </div>
              <ul>
                {assessment.requirements.map((requirement) => (
                  <li key={requirement}>{requirement}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </>
  )
}

export function ReleaseReadinessPageRoute() {
  const { load: reloadState, state } = useDemoState()
  const [connectors, setConnectors] = useState<ConnectorsCollectionResponse>()
  const [connectorSources, setConnectorSources] = useState<readonly ConnectorSourceReadModel[]>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const load = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const [nextConnectors, sourcePage] = await Promise.all([
        connectorsApi.listConnectors(),
        connectorSourcesApi.list(),
      ])
      setConnectors(nextConnectors)
      setConnectorSources(sourcePage.items)
    } catch (caught) {
      setConnectors(undefined)
      setConnectorSources(undefined)
      setError(caught instanceof Error ? caught.message : 'Readiness evidence could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  if (state === undefined) return null
  return (
    <ReleaseReadinessPage
      state={state}
      connectors={connectors}
      connectorSources={connectorSources}
      loading={loading}
      error={error}
      onRefresh={() => {
        void Promise.all([reloadState(), load()])
      }}
    />
  )
}

export type DemoReadinessPageProps = ReleaseReadinessPageProps
export const DemoReadinessPage = ReleaseReadinessPage
export const DemoReadinessPageRoute = ReleaseReadinessPageRoute
