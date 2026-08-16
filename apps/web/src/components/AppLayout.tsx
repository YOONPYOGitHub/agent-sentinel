import { Button, Input, Tooltip } from '@fluentui/react-components'
import {
  ArrowResetRegular,
  ArrowTrendingRegular,
  BotRegular,
  CheckmarkCircleRegular,
  ChevronRightRegular,
  HomeRegular,
  LockClosedRegular,
  MoreHorizontalRegular,
  NavigationRegular,
  PlugConnectedRegular,
  PulseRegular,
  SearchRegular,
  SettingsRegular,
  ShieldCheckmarkRegular,
} from '@fluentui/react-icons'
import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useDemoState } from '../hooks/useDemoState'
import { ReadOnlyBanner } from './ReadOnlyBanner'

const navigation = [
  { label: 'Overview', icon: HomeRegular, to: '/overview', end: true },
  { label: 'Agent estate', icon: BotRegular, to: '/agent-estate', end: false },
  { label: 'Exposure', icon: ShieldCheckmarkRegular, to: '/exposure', count: '1', end: false },
  { label: 'Governance', icon: LockClosedRegular, to: '/governance', end: false },
  { label: 'Observability', icon: PulseRegular, to: '/observability', end: false },
  { label: 'Optimization', icon: ArrowTrendingRegular, to: '/optimization', end: false },
  { label: 'Lifecycle', icon: ArrowResetRegular, to: '/lifecycle', end: false },
  { label: 'Trust catalog', icon: CheckmarkCircleRegular, to: '/trust-catalog', end: false },
  { label: 'Connectors', icon: PlugConnectedRegular, to: '/connectors', end: false },
]

export function AppLayout() {
  const [navExpanded, setNavExpanded] = useState(true)
  const { connectorStatus } = useDemoState()

  return (
    <div className={`app-shell ${navExpanded ? '' : 'app-shell--collapsed'}`}>
      <aside className="side-nav">
        <NavLink className="brand" to="/overview" aria-label="Agent Sentinel overview">
          <div className="brand-mark">
            <ShieldCheckmarkRegular />
          </div>
          {navExpanded ? (
            <div>
              <strong>Agent Sentinel</strong>
              <span>Operations & Security</span>
            </div>
          ) : null}
        </NavLink>
        <nav aria-label="Primary navigation">
          {navigation.map((item) => {
            const Icon = item.icon
            return (
              <NavLink
                className={({ isActive }) => `nav-item ${isActive ? 'nav-item--active' : ''}`}
                key={item.label}
                to={item.to}
                end={item.end}
                aria-label={item.label}
              >
                <Icon aria-hidden="true" />
                {navExpanded ? <span>{item.label}</span> : null}
                {navExpanded && item.count !== undefined ? (
                  <span className="nav-count">{item.count}</span>
                ) : null}
              </NavLink>
            )
          })}
        </nav>
        <div className="side-nav__footer">
          <NavLink
            className={({ isActive }) => `nav-item ${isActive ? 'nav-item--active' : ''}`}
            to="/settings"
            aria-label="Settings"
          >
            <SettingsRegular aria-hidden="true" />
            {navExpanded ? <span>Settings</span> : null}
          </NavLink>
        </div>
      </aside>
      <header className="top-bar">
        <div className="top-bar__left">
          <Tooltip
            content={navExpanded ? 'Collapse navigation' : 'Expand navigation'}
            relationship="label"
          >
            <Button
              appearance="subtle"
              icon={<NavigationRegular />}
              aria-label={navExpanded ? 'Collapse navigation' : 'Expand navigation'}
              onClick={() => setNavExpanded((value) => !value)}
            />
          </Tooltip>
          <div className="global-search">
            <SearchRegular aria-hidden="true" />
            <Input
              appearance="underline"
              aria-label="Search agents, identities, tools, and evidence"
              placeholder="Search agents, identities, tools, evidence"
            />
            <kbd>⌘ K</kbd>
          </div>
        </div>
        <div className="top-bar__right">
          <button className="scope-selector" type="button">
            <span className="status-dot status-dot--healthy" />
            Contoso AI Lab
            <ChevronRightRegular />
          </button>
          <button className="environment-pill" type="button">
            Demo · Korea Central
          </button>
          <Tooltip content="More actions" relationship="label">
            <Button
              appearance="subtle"
              icon={<MoreHorizontalRegular />}
              aria-label="More actions"
            />
          </Tooltip>
          <div className="avatar" aria-label="Signed in as Avery Morgan">
            AM
          </div>
        </div>
      </header>
      <main className="main-content">
        <ReadOnlyBanner writeEnabled={connectorStatus?.writeEnabled} />
        <Outlet />
      </main>
    </div>
  )
}
