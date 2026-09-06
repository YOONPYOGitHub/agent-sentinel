import { Button, Spinner } from '@fluentui/react-components'
import { AlertRegular, ShieldCheckmarkRegular } from '@fluentui/react-icons'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'

import { AppLayout } from './components/AppLayout'
import { EstateSelector } from './components/EstateSelector'
import { AuthProvider } from './hooks/AuthProvider'
import { DemoStateProvider } from './hooks/DemoStateProvider'
import { EstateProvider } from './hooks/EstateProvider'
import { useAuth } from './hooks/useAuth'
import { useDemoState } from './hooks/useDemoState'
import { useEstate } from './hooks/useEstate'
import { usePreferences } from './hooks/usePreferences'
import { AgentCatalogPage } from './pages/AgentCatalogPage'
import { AgentDetailPage } from './pages/AgentDetailPage'
import { AgentInventoryPage } from './pages/AgentInventoryPage'
import { CloudResourcesPage } from './pages/CloudResourcesPage'
import { ConnectorsPage } from './pages/ConnectorsPage'
import { ExposureDetailPage } from './pages/ExposureDetailPage'
import { ExposurePage } from './pages/ExposurePage'
import { GovernancePage } from './pages/GovernancePage'
import { LifecyclePage } from './pages/LifecyclePage'
import { NotFoundPage } from './pages/NotFoundPage'
import { ObservabilityPage } from './pages/ObservabilityPage'
import { OptimizationPage } from './pages/OptimizationPage'
import { OverviewPage } from './pages/OverviewPage'
import { SettingsPage } from './pages/SettingsPage'
import { TrustCatalogPage } from './pages/TrustCatalogPage'
import { WorkQueuePage } from './pages/WorkQueuePage'

function AgentEstateDetailRedirect() {
  const { agentId } = useParams()
  return <Navigate to={`/agent-inventory/${agentId ?? ''}`} replace />
}

function DefaultRedirect() {
  const [prefs] = usePreferences()
  return <Navigate to={prefs.landingPage} replace />
}

function RoutedApplication() {
  const { error, load, operation, state } = useDemoState()

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

  if (state === undefined) {
    return (
      <div className="center-state">
        <div className="empty-state" role="alert">
          <AlertRegular aria-hidden="true" />
          <h1>Agent estate is unavailable</h1>
          <p>{error ?? 'No estate snapshot was returned.'}</p>
          <EstateSelector />
          <Button appearance="primary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<DefaultRedirect />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="agent-inventory" element={<AgentInventoryPage />} />
        <Route path="agent-inventory/:agentId" element={<AgentDetailPage />} />
        <Route path="cloud-resources" element={<CloudResourcesPage />} />
        <Route path="agent-estate" element={<Navigate to="/agent-inventory" replace />} />
        <Route path="agent-estate/:agentId" element={<AgentEstateDetailRedirect />} />
        <Route path="agent-catalog" element={<AgentCatalogPage />} />
        <Route path="exposure" element={<ExposurePage />} />
        <Route path="exposure/:findingId" element={<ExposureDetailPage />} />
        <Route path="governance" element={<GovernancePage />} />
        <Route path="work-queue" element={<WorkQueuePage />} />
        <Route path="observability" element={<ObservabilityPage />} />
        <Route path="optimization" element={<OptimizationPage />} />
        <Route path="lifecycle" element={<LifecyclePage />} />
        <Route path="trust-catalog" element={<TrustCatalogPage />} />
        <Route path="connectors" element={<ConnectorsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}

function App() {
  return (
    <AuthProvider>
      <AuthenticatedApplication />
    </AuthProvider>
  )
}

export function AuthenticatedApplication() {
  const { authError, isConfigured, isLoading, isSignedIn, signIn } = useAuth()

  if (isLoading) {
    return (
      <div className="center-state" role="status">
        <div className="brand-mark brand-mark--large">
          <ShieldCheckmarkRegular />
        </div>
        <Spinner size="large" label="Checking authentication configuration..." />
      </div>
    )
  }

  if (authError !== null) {
    return (
      <div className="center-state">
        <div className="empty-state" role="alert">
          <AlertRegular aria-hidden="true" />
          <h1>Authentication is unavailable</h1>
          <p>{authError}</p>
        </div>
      </div>
    )
  }

  if (isConfigured && !isSignedIn) {
    return (
      <div className="center-state">
        <div className="empty-state">
          <ShieldCheckmarkRegular aria-hidden="true" />
          <h1>Sign in to Agent Sentinel</h1>
          <p>Use your Microsoft work account to access governed agent evidence.</p>
          <Button appearance="primary" onClick={() => void signIn()}>
            Sign in with Microsoft
          </Button>
        </div>
      </div>
    )
  }

  return (
    <EstateProvider>
      <EstateApplication />
    </EstateProvider>
  )
}

function EstateApplication() {
  const { isConfigured, signIn, signOut } = useAuth()
  const { reload, state } = useEstate()

  if (state.status === 'loading') {
    return (
      <div className="center-state" role="status">
        <div className="brand-mark brand-mark--large">
          <ShieldCheckmarkRegular />
        </div>
        <Spinner size="large" label="Loading authorized estates..." />
      </div>
    )
  }
  if (state.status === 'empty') {
    return (
      <EstateFailure
        title="No authorized estates"
        message="Your account is authenticated but is not authorized for an Agent Sentinel estate."
        {...(isConfigured
          ? {
              action: {
                label: 'Sign out and switch account',
                run: () => void signOut(),
              },
            }
          : {})}
      />
    )
  }
  if (state.status === 'unauthorized') {
    return (
      <EstateFailure
        title="Authentication required"
        message={state.message}
        action={{
          label: isConfigured ? 'Sign in again' : 'Try again',
          run: () => {
            void (async () => {
              if (isConfigured) {
                const result = await signIn()
                if (result.status !== 'success') return
              }
              await reload()
            })()
          },
        }}
      />
    )
  }
  if (state.status === 'forbidden') {
    return (
      <EstateFailure
        title="Estate access denied"
        message={state.message}
        {...(isConfigured
          ? {
              action: {
                label: 'Sign out and switch account',
                run: () => void signOut(),
              },
            }
          : {})}
      />
    )
  }
  if (state.status === 'unavailable') {
    return (
      <EstateFailure
        title="Estate service unavailable"
        message={state.message}
        action={{ label: 'Try again', run: () => void reload() }}
      />
    )
  }

  return (
    <DemoStateProvider>
      <RoutedApplication />
    </DemoStateProvider>
  )
}

function EstateFailure({
  title,
  message,
  action,
}: {
  title: string
  message: string
  action?: {
    label: string
    run: () => void
  }
}) {
  return (
    <div className="center-state">
      <div className="empty-state" role="alert">
        <AlertRegular aria-hidden="true" />
        <h1>{title}</h1>
        <p>{message}</p>
        {action === undefined ? null : (
          <Button appearance="primary" onClick={action.run}>
            {action.label}
          </Button>
        )}
      </div>
    </div>
  )
}

export default App
