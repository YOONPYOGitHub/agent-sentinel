import { Button, Spinner } from '@fluentui/react-components'
import { AlertRegular, ShieldCheckmarkRegular } from '@fluentui/react-icons'
import { Navigate, Route, Routes } from 'react-router-dom'

import { AppLayout } from './components/AppLayout'
import { DemoStateProvider } from './hooks/DemoStateProvider'
import { useDemoState } from './hooks/useDemoState'
import { AgentDetailPage } from './pages/AgentDetailPage'
import { ComingSoonPage } from './pages/ComingSoonPage'
import { ConnectorsPage } from './pages/ConnectorsPage'
import { EstatePage } from './pages/EstatePage'
import { ExposureDetailPage } from './pages/ExposureDetailPage'
import { ExposurePage } from './pages/ExposurePage'
import { NotFoundPage } from './pages/NotFoundPage'
import { OverviewPage } from './pages/OverviewPage'
import { SettingsPage } from './pages/SettingsPage'

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
        <Route path="governance" element={<ComingSoonPage title="Governance" />} />
        <Route path="observability" element={<ComingSoonPage title="Observability" />} />
        <Route path="optimization" element={<ComingSoonPage title="Optimization" />} />
        <Route path="lifecycle" element={<ComingSoonPage title="Lifecycle" />} />
        <Route path="trust-catalog" element={<ComingSoonPage title="Trust catalog" />} />
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
