import { FluentProvider, webDarkTheme } from '@fluentui/react-components'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'

import App from './App'
import './styles.css'

const container = document.getElementById('root')

if (container === null) {
  throw new Error('Agent Sentinel root element was not found.')
}

createRoot(container).render(
  <StrictMode>
    <FluentProvider theme={webDarkTheme}>
      <App />
    </FluentProvider>
  </StrictMode>,
)
