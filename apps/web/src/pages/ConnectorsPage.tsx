import { Badge, Button, Spinner } from '@fluentui/react-components'
import {
  AlertRegular,
  ArrowClockwiseRegular,
  BookmarkRegular,
  CheckmarkCircleRegular,
  ClockRegular,
  ErrorCircleRegular,
  InfoRegular,
  LockClosedRegular,
  PlugConnectedRegular,
  PlugDisconnectedRegular,
  SettingsRegular,
  ShieldCheckmarkRegular,
} from '@fluentui/react-icons'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { connectorsApi, type CatalogEntry, type ConnectorsCollection } from '../api/connectors-api'
import { ConnectorSourceManager } from '../components/ConnectorSourceManager'
import { PageHeading } from '../components/PageHeading'

// ??? Capability label map ????????????????????????????????????????????????????

const CAPABILITY_LABELS: Record<string, string> = {
  discovery: 'Discovery',
  identity: 'Identity',
  entitlement: 'Entitlement',
  'runtime-telemetry': 'Runtime telemetry',
  'business-outcomes': 'Business outcomes',
  'security-alerts': 'Security alerts',
  'data-governance': 'Data governance',
  'lifecycle-admin': 'Lifecycle & admin',
  'write-remediation': 'Write / remediation',
}

const SCORECARD_LABELS: Record<string, string> = {
  security: 'Security',
  governance: 'Governance / Compliance',
  lifecycle: 'Lifecycle',
  quality: 'Quality',
  reliability: 'Reliability',
  cost: 'Cost / Efficiency',
}

// ??? Lifecycle state helpers ?????????????????????????????????????????????????

type LifecycleColor = 'success' | 'informative' | 'warning' | 'danger' | 'subtle'

function lifecycleColor(state: CatalogEntry['lifecycleState'] | 'connected'): LifecycleColor {
  switch (state) {
    case 'connected':
      return 'success'
    case 'degraded':
      return 'warning'
    case 'available-to-configure':
      return 'informative'
    case 'authorization-required':
    case 'preview-authorization-required':
      return 'warning'
    case 'planned':
      return 'subtle'
    case 'unavailable':
      return 'danger'
  }
}

function lifecycleLabel(state: CatalogEntry['lifecycleState'] | 'connected'): string {
  switch (state) {
    case 'connected':
      return 'Connected'
    case 'degraded':
      return 'Degraded'
    case 'available-to-configure':
      return 'Available to configure'
    case 'authorization-required':
      return 'Authorization required'
    case 'preview-authorization-required':
      return 'Authorization / preview required'
    case 'planned':
      return 'Planned'
    case 'unavailable':
      return 'Unavailable'
  }
}

function LifecycleIcon({ state }: { state: CatalogEntry['lifecycleState'] | 'connected' }) {
  switch (state) {
    case 'connected':
      return (
        <CheckmarkCircleRegular
          aria-hidden="true"
          className="connector-state-icon connector-state-icon--connected"
        />
      )
    case 'degraded':
      return (
        <AlertRegular
          aria-hidden="true"
          className="connector-state-icon connector-state-icon--auth-required"
        />
      )
    case 'available-to-configure':
      return (
        <PlugConnectedRegular
          aria-hidden="true"
          className="connector-state-icon connector-state-icon--available"
        />
      )
    case 'authorization-required':
    case 'preview-authorization-required':
      return (
        <LockClosedRegular
          aria-hidden="true"
          className="connector-state-icon connector-state-icon--auth-required"
        />
      )
    case 'planned':
      return (
        <ClockRegular
          aria-hidden="true"
          className="connector-state-icon connector-state-icon--planned"
        />
      )
    case 'unavailable':
      return (
        <PlugDisconnectedRegular
          aria-hidden="true"
          className="connector-state-icon connector-state-icon--unavailable"
        />
      )
  }
}

// ??? Active connector panel ???????????????????????????????????????????????????

function ActiveConnectorPanel({
  active,
  health,
}: {
  active: ConnectorsCollection['active']
  health: ConnectorsCollection['health']
}) {
  const isFoundry = active.mode === 'foundry'
  const connected = active.lifecycleState === 'connected'
  const degraded = active.lifecycleState === 'degraded'
  return (
    <div className="connector-card connector-card--active">
      <div className="connector-card__header">
        <PlugConnectedRegular aria-hidden="true" />
        <div>
          <h2>{isFoundry ? 'Azure AI Foundry' : 'Mock agent estate'}</h2>
          <p>
            {degraded
              ? 'Some configured sources are unavailable; complete snapshots are not promoted'
              : !connected
                ? 'Configured source failed its latest runtime connection test'
                : isFoundry
                  ? 'Live discovery from Azure AI Foundry Agent Service'
                  : 'Synthetic seeded estate for demonstration and local development'}
          </p>
        </div>
        <Badge
          color={lifecycleColor(active.lifecycleState)}
          appearance="tint"
          aria-label={`Connection mode: ${active.mode}`}
        >
          {degraded
            ? 'Degraded · partial'
            : connected
              ? active.mode === 'foundry'
                ? 'Connected · Foundry'
                : 'Connected · mock'
              : 'Connection unavailable'}
        </Badge>
      </div>
      <dl className="connector-details">
        <div>
          <dt>Connector ID</dt>
          <dd>{active.id}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{active.source}</dd>
        </div>
        <div>
          <dt>Connection</dt>
          <dd>{lifecycleLabel(active.lifecycleState)}</dd>
        </div>
        <div>
          <dt>Write access</dt>
          <dd>{active.writeEnabled === false ? 'Read-only' : 'Enabled'}</dd>
        </div>
        {active.projectEndpoint !== undefined && (
          <div>
            <dt>Project endpoint</dt>
            <dd className="connector-details__endpoint">{active.projectEndpoint}</dd>
          </div>
        )}
      </dl>
      {health !== undefined ? (
        <dl className="connector-details" aria-label="Configured source health">
          {health.sources.map((source) => (
            <div key={source.id}>
              <dt>{source.name}</dt>
              <dd>
                {source.readiness}
                {source.reason ? ` · ${source.reason}` : ''}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  )
}

// ??? Catalog entry card ???????????????????????????????????????????????????????

function CatalogCard({ entry }: { entry: CatalogEntry }) {
  const isConfigurable =
    entry.settingsPath !== undefined &&
    (entry.lifecycleState === 'available-to-configure' || entry.lifecycleState === 'connected')
  const isPlanned = entry.lifecycleState === 'planned'
  const isAuthRequired =
    entry.lifecycleState === 'authorization-required' ||
    entry.lifecycleState === 'preview-authorization-required'

  return (
    <article
      className={`catalog-connector-card catalog-connector-card--${entry.lifecycleState}`}
      aria-label={entry.name}
    >
      <div className="catalog-connector-card__header">
        <div className="catalog-connector-card__title-row">
          <LifecycleIcon state={entry.lifecycleState} />
          <h3>{entry.name}</h3>
          {entry.sourceOfTruth && (
            <span className="connector-source-of-truth" title="Authoritative source of truth">
              <BookmarkRegular aria-hidden="true" />
              <span className="visually-hidden">Authoritative</span>
            </span>
          )}
        </div>
        <Badge color={lifecycleColor(entry.lifecycleState)} appearance="tint" size="small">
          {lifecycleLabel(entry.lifecycleState)}
        </Badge>
      </div>

      <p className="catalog-connector-card__description">{entry.description}</p>

      {entry.capabilities.length > 0 && (
        <div className="catalog-connector-card__capabilities" aria-label="Capabilities">
          {entry.capabilities.map((cap) => (
            <span key={cap} className="capability-chip">
              {CAPABILITY_LABELS[cap] ?? cap}
            </span>
          ))}
        </div>
      )}

      {entry.unlocksScorecard !== undefined && entry.unlocksScorecard.length > 0 && (
        <div className="catalog-connector-card__unlocks" aria-label="Unlocks scorecard dimensions">
          <span className="connector-unlocks-label">
            <ShieldCheckmarkRegular aria-hidden="true" />
            Unlocks:
          </span>
          {entry.unlocksScorecard.map((dim) => (
            <span key={dim} className="connector-unlock-chip">
              {SCORECARD_LABELS[dim] ?? dim}
            </span>
          ))}
        </div>
      )}

      {entry.prerequisiteNote !== undefined && (
        <div className="catalog-connector-card__prereq">
          <InfoRegular aria-hidden="true" />
          <p>{entry.prerequisiteNote}</p>
        </div>
      )}

      <div className="catalog-connector-card__footer">
        {entry.ownershipModel === 'consumes' && (
          <span className="connector-ownership-badge">Consumes evidence</span>
        )}
        {entry.sourceOfTruth && (
          <span className="connector-authority-badge">Authoritative source</span>
        )}
        {isConfigurable && entry.settingsPath !== undefined ? (
          <Link to={entry.settingsPath} className="connector-settings-link">
            <SettingsRegular aria-hidden="true" />
            Configure in Settings
          </Link>
        ) : isAuthRequired ? (
          <span className="connector-auth-notice">
            <LockClosedRegular aria-hidden="true" />
            Authorization &amp; API availability required
          </span>
        ) : isPlanned ? (
          <span className="connector-planned-notice">
            <ClockRegular aria-hidden="true" />
            Planned - not yet available
          </span>
        ) : null}
      </div>
    </article>
  )
}

// ??? Page ?????????????????????????????????????????????????????????????????????

export function ConnectorsPage() {
  const [collection, setCollection] = useState<ConnectorsCollection>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      setCollection(await connectorsApi.listConnectors())
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Connector status could not be read.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => void load(), [load])

  const hasConnected = collection?.catalog.some((e) => e.lifecycleState === 'connected') ?? false
  const hasDegraded = collection?.catalog.some((e) => e.lifecycleState === 'degraded') ?? false
  const hasAvailable =
    collection?.catalog.some((e) => e.lifecycleState === 'available-to-configure') ?? false
  const hasPlanned = collection?.catalog.some((e) => e.lifecycleState === 'planned') ?? false

  return (
    <div className="page">
      <PageHeading
        section="Connectors"
        title="Data connectors"
        description="Review discovery sources, evidence coverage, and readiness for approved agent data paths. Only implemented and verified connectors are shown as connected."
        actions={
          <Button
            appearance="secondary"
            icon={<ArrowClockwiseRegular />}
            onClick={() => void load()}
            disabled={loading}
          >
            Refresh status
          </Button>
        }
      />

      {loading && collection === undefined ? (
        <div className="connector-state" role="status">
          <Spinner size="medium" />
          <span>Loading connector status...</span>
        </div>
      ) : error !== undefined ? (
        <div className="connector-state connector-state--error" role="alert">
          <ErrorCircleRegular aria-hidden="true" />
          <div>
            <strong>Status unavailable</strong>
            <span>{error}</span>
          </div>
          <Button appearance="primary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : collection === undefined ? null : (
        <>
          <section aria-label="Active connection status" className="connectors-section">
            <h2 className="connectors-section__heading">
              <PlugConnectedRegular aria-hidden="true" />
              Active connection
            </h2>
            <ActiveConnectorPanel active={collection.active} health={collection.health} />
          </section>

          <ConnectorSourceManager />

          <section aria-label="Connector catalog" className="connectors-section">
            <div className="connectors-catalog-header">
              <h2 className="connectors-section__heading">
                <PlugConnectedRegular aria-hidden="true" />
                Connector catalog
              </h2>
              <div className="connectors-legend" aria-label="Status legend">
                {hasConnected && (
                  <span className="legend-item legend-item--connected">
                    <CheckmarkCircleRegular aria-hidden="true" />
                    Connected
                  </span>
                )}
                {hasDegraded && (
                  <span className="legend-item legend-item--auth">
                    <AlertRegular aria-hidden="true" />
                    Degraded
                  </span>
                )}
                {hasAvailable && (
                  <span className="legend-item legend-item--available">
                    <PlugConnectedRegular aria-hidden="true" />
                    Available to configure
                  </span>
                )}
                <span className="legend-item legend-item--auth">
                  <LockClosedRegular aria-hidden="true" />
                  Authorization required
                </span>
                {hasPlanned && (
                  <span className="legend-item legend-item--planned">
                    <ClockRegular aria-hidden="true" />
                    Planned
                  </span>
                )}
              </div>
            </div>

            <div className="connectors-entra-notice" role="note">
              <AlertRegular aria-hidden="true" />
              <p>
                <strong>Entra ID authentication vs. entitlement evidence:</strong> Microsoft Entra
                ID is used for Agent Sentinel user sign-in. The &ldquo;Microsoft Entra Agent ID
                &amp; Entitlements&rdquo; connector below is a <em>separate</em> data path that
                reads agent service principals and OAuth entitlement assignments to enrich exposure
                and governance evidence - it is not the same as user authentication.
              </p>
            </div>

            <div className="connectors-catalog-grid" aria-label="Connector catalog">
              {collection.catalog.map((entry) => (
                <CatalogCard key={entry.id} entry={entry} />
              ))}
            </div>

            <p className="connectors-catalog-note">
              Connectors marked <strong>Authoritative source</strong>{' '}
              <BookmarkRegular aria-hidden="true" className="inline-icon" />
              serve as the system of record for their stated evidence domain. Connectors marked{' '}
              <strong>Unlocks</strong> expand which scorecard dimensions Agent Sentinel can populate
              with live evidence.
            </p>
          </section>
        </>
      )}
    </div>
  )
}
