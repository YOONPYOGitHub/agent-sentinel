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
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { useDemoState } from '../hooks/useDemoState'
import { GlobalSearchDialog } from './GlobalSearchDialog'
import { ReadOnlyBanner } from './ReadOnlyBanner'
import { ShellMenu } from './ShellMenu'

const navigation = [
  { label: 'Overview', icon: HomeRegular, to: '/overview', end: true },
  { label: 'Agent estate', icon: BotRegular, to: '/agent-estate', end: false },
  { label: 'Exposure', icon: ShieldCheckmarkRegular, to: '/exposure', end: false },
  { label: 'Governance', icon: LockClosedRegular, to: '/governance', end: false },
  { label: 'Observability', icon: PulseRegular, to: '/observability', end: false },
  { label: 'Optimization', icon: ArrowTrendingRegular, to: '/optimization', end: false },
  { label: 'Lifecycle', icon: ArrowResetRegular, to: '/lifecycle', end: false },
  { label: 'Trust catalog', icon: CheckmarkCircleRegular, to: '/trust-catalog', end: false },
  { label: 'Connectors', icon: PlugConnectedRegular, to: '/connectors', end: false },
]

export function AppLayout() {
  const [navExpanded, setNavExpanded] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const { connectorStatus, state } = useDemoState()
  const searchTriggerRef = useRef<HTMLDivElement>(null)
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    window.setTimeout(() => searchTriggerRef.current?.querySelector('input')?.focus(), 0)
  }, [])

  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', openSearch)
    return () => window.removeEventListener('keydown', openSearch)
  }, [])

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
          <div ref={searchTriggerRef} className="global-search">
            <SearchRegular aria-hidden="true" />
            <Input
              appearance="underline"
              aria-label="Search agents, identities, tools, and evidence"
              placeholder="Search agents, identities, tools, evidence"
              readOnly
              onClick={() => setSearchOpen(true)}
            />
            <kbd>Ctrl K</kbd>
          </div>
        </div>
        <div className="top-bar__right">
          <ShellMenu
            label="Scope information"
            trigger={
              <span className="scope-selector">
                <span className="status-dot status-dot--healthy" />
                Demo scope
                <ChevronRightRegular />
              </span>
            }
          >
            <div className="shell-menu__status">
              <strong>Contoso AI Lab</strong>
              <span>Synthetic demo scope · active</span>
            </div>
            <div className="shell-menu__meta">
              <span>Tenant</span>
              <b>{state?.snapshot.tenantId ?? 'Unavailable'}</b>
              <span>Environment</span>
              <b>{state?.snapshot.environment ?? 'Unavailable'}</b>
            </div>
            <Link to="/settings">View scope settings</Link>
          </ShellMenu>
          <ShellMenu
            label="Environment information"
            trigger={
              <span className="environment-pill">
                {connectorStatus?.mode === 'foundry' ? 'Foundry' : 'Demo'} · Configured region
              </span>
            }
          >
            <div className="shell-menu__status">
              <strong>
                {connectorStatus?.mode === 'foundry' ? 'Microsoft Foundry' : 'Synthetic demo'}
              </strong>
              <span>
                Korea Central deployment · {connectorStatus?.source ?? 'status unavailable'}
              </span>
            </div>
            <p className="shell-menu__note">
              Environment changes are deployment-controlled and audited.
            </p>
            <Link to="/connectors">Open connector health</Link>
          </ShellMenu>
          <ShellMenu
            label="More actions"
            trigger={
              <Tooltip content="More actions" relationship="label">
                <span className="shell-icon-trigger" aria-hidden="true">
                  <MoreHorizontalRegular />
                </span>
              </Tooltip>
            }
          >
            <Link to="/connectors">Connector diagnostics</Link>
            <Link to="/settings">Application settings</Link>
            <div className="shell-menu__status shell-menu__status--bordered">
              <strong>Agent Sentinel</strong>
              <span>Operations & Security · Hackathon build</span>
            </div>
          </ShellMenu>
          <ShellMenu label="User menu" trigger={<span className="avatar">AM</span>}>
            <div className="shell-menu__profile">
              <span className="avatar avatar--large">AM</span>
              <div>
                <strong>Avery Morgan · demo persona</strong>
                <span>Simulated Agent Security Analyst</span>
              </div>
            </div>
            <Link to="/settings">Profile and preferences</Link>
            <p className="shell-menu__note">
              Authentication status is separate from this synthetic demo identity.
            </p>
          </ShellMenu>
        </div>
      </header>
      <main className="main-content">
        <ReadOnlyBanner writeEnabled={connectorStatus?.writeEnabled} />
        <Outlet />
      </main>
      {state ? <GlobalSearchDialog open={searchOpen} state={state} onClose={closeSearch} /> : null}
    </div>
  )
}
