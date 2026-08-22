import { Button, Spinner } from '@fluentui/react-components'
import { AlertRegular, ShieldCheckmarkRegular } from '@fluentui/react-icons'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'

import { AppLayout } from './components/AppLayout'
import { DemoStateProvider } from './hooks/DemoStateProvider'
import { AuthProvider } from './hooks/AuthProvider'
import { useAuth } from './hooks/useAuth'
import { useDemoState } from './hooks/useDemoState'
import { usePreferences } from './hooks/usePreferences'
import { AgentCatalogPage } from './pages/AgentCatalogPage'
import { AgentDetailPage } from './pages/AgentDetailPage'
import { AgentInventoryPage } from './pages/AgentInventoryPage'
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
        <div className="empty-state">
          <AlertRegular aria-hidden="true" />
          <h1>Agent estate is unavailable</h1>
          <p>{error ?? 'No estate snapshot was returned.'}</p>
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
        <Route path="agent-estate" element={<Navigate to="/agent-inventory" replace />} />
        <Route path="agent-estate/:agentId" element={<AgentEstateDetailRedirect />} />
        <Route path="agent-catalog" element={<AgentCatalogPage />} />
        <Route path="exposure" element={<ExposurePage />} />
        <Route path="exposure/:findingId" element={<ExposureDetailPage />} />
        <Route path="governance" element={<GovernancePage />} />
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
    <DemoStateProvider>
      <RoutedApplication />
    </DemoStateProvider>
  )
}

export default App
