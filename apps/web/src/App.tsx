import { Button, Spinner } from '@fluentui/react-components'
import { AlertRegular, ShieldCheckmarkRegular } from '@fluentui/react-icons'
import { Navigate, Route, Routes } from 'react-router-dom'

import { AppLayout } from './components/AppLayout'
import { DemoStateProvider } from './hooks/DemoStateProvider'
import { useDemoState } from './hooks/useDemoState'
import { AgentDetailPage } from './pages/AgentDetailPage'
import { ConnectorsPage } from './pages/ConnectorsPage'
import { EstatePage } from './pages/EstatePage'
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
        <Route index element={<Navigate to="/overview" replace />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="agent-estate" element={<EstatePage />} />
        <Route path="agent-estate/:agentId" element={<AgentDetailPage />} />
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
    <DemoStateProvider>
      <RoutedApplication />
    </DemoStateProvider>
  )
}

export default App
