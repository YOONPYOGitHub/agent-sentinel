import { Button } from '@fluentui/react-components'
import {
  ArrowRightRegular,
  DatabaseRegular,
  KeyRegular,
  LockClosedRegular,
  WeatherMoonRegular,
} from '@fluentui/react-icons'
import { useNavigate } from 'react-router-dom'

import { PageHeading } from '../components/PageHeading'
import { useDemoState } from '../hooks/useDemoState'

export function SettingsPage() {
  const navigate = useNavigate()
  const { connectorStatus, state } = useDemoState()
  const writeEnabled = connectorStatus?.writeEnabled !== false
  const liveFoundry = connectorStatus?.mode === 'foundry'

  return (
    <>
      <PageHeading
        section="Settings"
        title="Application settings"
        description="Review the active scope, data source, security posture, and interface configuration."
        actions={
          <Button
            appearance="primary"
            icon={<ArrowRightRegular />}
            onClick={() => void navigate('/connectors')}
          >
            Manage connectors
          </Button>
        }
      />
      <section className="settings-grid" aria-label="Application configuration">
        <article className="settings-card">
          <DatabaseRegular />
          <div>
            <span>Active scope</span>
            <h2>Configured scope · {liveFoundry ? 'Foundry-connected' : 'synthetic demo'}</h2>
            <p>
              Tenant {state?.snapshot.tenantId ?? 'unavailable'} · Environment{' '}
              {state?.snapshot.environment ?? 'unavailable'}
            </p>
          </div>
        </article>
        <article className="settings-card">
          <KeyRegular />
          <div>
            <span>Data source</span>
            <h2>{connectorStatus?.mode === 'foundry' ? 'Microsoft Foundry' : 'Synthetic demo'}</h2>
            <p>{connectorStatus?.connectorId ?? 'Connector status unavailable'}</p>
          </div>
        </article>
        <article className="settings-card">
          <LockClosedRegular />
          <div>
            <span>Write operations</span>
            <h2>{writeEnabled ? 'Enabled for configured workflow' : 'Read-only'}</h2>
            <p>
              {writeEnabled
                ? 'Impactful actions still require explicit approval.'
                : 'Mutations are blocked by the current connector configuration.'}
            </p>
          </div>
        </article>
        <article className="settings-card">
          <WeatherMoonRegular />
          <div>
            <span>Appearance</span>
            <h2>Dark security workspace</h2>
            <p>Optimized for the primary 1440×900 and 1920×1080 demo experience.</p>
          </div>
        </article>
      </section>
      <section className="settings-note">
        <strong>Configuration is source-controlled.</strong>
        <p>
          The persona is synthetic. The active scope is{' '}
          {liveFoundry
            ? 'the configured Foundry-connected portfolio'
            : 'a deterministic local demo portfolio'}
          . Tenant identifiers, Korea Central deployment, connector permissions, and write
          capabilities are changed through deployment configuration to preserve auditability.
        </p>
      </section>
    </>
  )
}
