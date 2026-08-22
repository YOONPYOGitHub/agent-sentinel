import { Button, Select } from '@fluentui/react-components'
import {
  ArrowRightRegular,
  DatabaseRegular,
  KeyRegular,
  LockClosedRegular,
  PersonRegular,
  SettingsRegular,
} from '@fluentui/react-icons'
import { useNavigate } from 'react-router-dom'

import { PageHeading } from '../components/PageHeading'
import { useAuth } from '../hooks/useAuth'
import { useDemoState } from '../hooks/useDemoState'
import { isLandingPage, usePreferences } from '../hooks/usePreferences'

export function SettingsPage() {
  const navigate = useNavigate()
  const { connectorStatus, state } = useDemoState()
  const [preferences, updatePreferences] = usePreferences()
  const { isConfigured, isSignedIn, principal, signIn, signOut, isLoading: authLoading } = useAuth()
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

      <section className="settings-prefs" aria-labelledby="interface-preferences-heading">
        <div className="settings-prefs-header" id="interface-preferences-heading">
          <SettingsRegular aria-hidden="true" />
          <strong>Interface preferences</strong>
        </div>
        <div className="settings-prefs-grid">
          <article className="settings-pref-card">
            <h3>Default landing page</h3>
            <label>
              <span>Page shown when opening Agent Sentinel</span>
              <Select
                aria-label="Default landing page"
                value={preferences.landingPage}
                onChange={(event) => {
                  if (isLandingPage(event.target.value)) {
                    updatePreferences({ landingPage: event.target.value })
                  }
                }}
              >
                <option value="/overview">Overview</option>
                <option value="/agent-inventory">Agent inventory</option>
                <option value="/exposure">Exposure</option>
                <option value="/governance">Governance</option>
              </Select>
            </label>
          </article>
          <article className="settings-pref-card">
            <h3>Display density</h3>
            <label>
              <span>Workspace spacing and table row height</span>
              <Select
                aria-label="Display density"
                value={preferences.density}
                onChange={(event) =>
                  updatePreferences({ density: event.target.value as 'comfortable' | 'compact' })
                }
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </Select>
            </label>
          </article>
        </div>
      </section>

      <div className="settings-section-header">
        <DatabaseRegular aria-hidden="true" />
        <strong>Deployment configuration</strong>
      </div>
      <section className="settings-grid" aria-label="Deployment configuration">
        <article className="settings-card">
          <DatabaseRegular />
          <div>
            <span>Active scope</span>
            <span className="settings-readonly-badge">Read only</span>
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
            <span className="settings-readonly-badge">Read only</span>
            <h2>{connectorStatus?.mode === 'foundry' ? 'Microsoft Foundry' : 'Synthetic demo'}</h2>
            <p>{connectorStatus?.connectorId ?? 'Connector status unavailable'}</p>
          </div>
        </article>
        <article className="settings-card">
          <LockClosedRegular />
          <div>
            <span>Write operations</span>
            <span className="settings-readonly-badge">Read only</span>
            <h2>{writeEnabled ? 'Enabled for configured workflow' : 'Read-only'}</h2>
            <p>
              {writeEnabled
                ? 'Impactful actions still require explicit approval.'
                : 'Mutations are blocked by the current connector configuration.'}
            </p>
          </div>
        </article>
      </section>

      <div className="settings-section-header">
        <PersonRegular aria-hidden="true" />
        <strong>Authentication</strong>
      </div>
      <section className="settings-auth-card" aria-label="Authentication">
        <PersonRegular aria-hidden="true" />
        <div>
          {isSignedIn && principal !== null ? (
            <>
              <span className="settings-readonly-badge settings-readonly-badge--active">
                Signed in
              </span>
              <h2>
                {principal.displayName ?? principal.preferredUsername ?? 'Authenticated user'}
              </h2>
              <p>
                Roles: {principal.roles.join(', ') || 'None assigned'} ? Tenant {principal.tenantId}
              </p>
              <Button appearance="subtle" size="small" onClick={() => void signOut()}>
                Sign out
              </Button>
            </>
          ) : isConfigured ? (
            <>
              <span className="settings-readonly-badge">Not signed in</span>
              <h2>Authentication configured ? not signed in</h2>
              <p>
                Microsoft Entra ID is configured. Sign in to enable role-based access controls and
                personalized catalog access.
              </p>
              <Button
                appearance="primary"
                size="small"
                disabled={authLoading}
                onClick={() => void signIn()}
              >
                Sign in with Microsoft
              </Button>
            </>
          ) : (
            <>
              <span className="settings-readonly-badge">Not signed in</span>
              <h2>Authentication not configured</h2>
              <p>
                Microsoft Entra ID is the intended identity provider. Configure it to enable
                sign-in, group entitlements, and personalized agent catalog access.
              </p>
            </>
          )}
        </div>
      </section>

      <section className="settings-note">
        <strong>Configuration is source-controlled.</strong>
        <p>
          The active scope is{' '}
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
