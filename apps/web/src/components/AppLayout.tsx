import { Button, Input, Tooltip } from '@fluentui/react-components'
import {
  ArrowResetRegular,
  ArrowTrendingRegular,
  BookmarkRegular,
  BotRegular,
  CheckmarkCircleRegular,
  ChevronRightRegular,
  HomeRegular,
  LockClosedRegular,
  NavigationRegular,
  PersonRegular,
  PlugConnectedRegular,
  PulseRegular,
  QuestionCircleRegular,
  SearchRegular,
  SettingsRegular,
  ShieldCheckmarkRegular,
  TaskListLtrRegular,
} from '@fluentui/react-icons'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'

import { useDemoState } from '../hooks/useDemoState'
import { useAuth } from '../hooks/useAuth'
import { usePreferences } from '../hooks/usePreferences'
import { GlobalSearchDialog } from './GlobalSearchDialog'
import { ReadOnlyBanner } from './ReadOnlyBanner'
import { ShellMenu } from './ShellMenu'

const navigation = [
  { label: 'Overview', icon: HomeRegular, to: '/overview', end: true },
  { label: 'Agent inventory', icon: BotRegular, to: '/agent-inventory', end: false },
  { label: 'Agent catalog', icon: BookmarkRegular, to: '/agent-catalog', end: false },
  { label: 'Exposure', icon: ShieldCheckmarkRegular, to: '/exposure', end: false },
  { label: 'Governance', icon: LockClosedRegular, to: '/governance', end: false },
  { label: 'Work queue', icon: TaskListLtrRegular, to: '/work-queue', end: false },
  { label: 'Observability', icon: PulseRegular, to: '/observability', end: false },
  { label: 'Optimization', icon: ArrowTrendingRegular, to: '/optimization', end: false },
  { label: 'Lifecycle', icon: ArrowResetRegular, to: '/lifecycle', end: false },
  { label: 'Trust catalog', icon: CheckmarkCircleRegular, to: '/trust-catalog', end: false },
  { label: 'Connectors', icon: PlugConnectedRegular, to: '/connectors', end: false },
]

function AuthShellMenu() {
  const { isConfigured, isSignedIn, principal, signIn, signOut, isLoading } = useAuth()
  const initials =
    principal?.displayName
      ?.split(' ')
      .filter((p) => p.length > 0)
      .map((p) => p[0] ?? '')
      .slice(0, 2)
      .join('') ?? ''

  return (
    <ShellMenu
      label="Authentication status"
      trigger={
        <span className={isSignedIn ? 'avatar avatar--signed-in' : 'avatar avatar--unsigned'}>
          {isSignedIn && initials.length > 0 ? (
            <span aria-hidden="true">{initials}</span>
          ) : (
            <PersonRegular />
          )}
        </span>
      }
    >
      <div className="shell-menu__profile">
        <span
          className={
            isSignedIn
              ? 'avatar avatar--large avatar--signed-in'
              : 'avatar avatar--large avatar--unsigned'
          }
        >
          {isSignedIn && initials.length > 0 ? (
            <span aria-hidden="true">{initials}</span>
          ) : (
            <PersonRegular />
          )}
        </span>
        <div>
          {isSignedIn && principal !== null ? (
            <>
              <strong>{principal.displayName ?? principal.preferredUsername ?? 'Signed in'}</strong>
              <span>{principal.roles.join(', ') || 'No roles assigned'}</span>
            </>
          ) : isConfigured ? (
            <>
              <strong>Not signed in</strong>
              <span>Authentication configured - not signed in</span>
            </>
          ) : (
            <>
              <strong>Not signed in</strong>
              <span>Authentication not configured</span>
            </>
          )}
        </div>
      </div>
      {isConfigured && !isSignedIn ? (
        <Button
          appearance="primary"
          size="small"
          disabled={isLoading}
          onClick={() => void signIn()}
        >
          Sign in with Microsoft
        </Button>
      ) : isSignedIn ? (
        <Button appearance="subtle" size="small" onClick={() => void signOut()}>
          Sign out
        </Button>
      ) : (
        <p className="shell-menu__note">
          Microsoft Entra ID is the intended sign-in provider. Entra authentication will establish
          user identity; entitlement connector evidence will personalize catalog access.
        </p>
      )}
      <Link to="/settings">Authentication settings</Link>
    </ShellMenu>
  )
}

export function AppLayout() {
  const [navExpanded, setNavExpanded] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [prefs] = usePreferences()
  const { connectorStatus, state } = useDemoState()
  const liveFoundry = connectorStatus?.mode === 'foundry'
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
    <div
      className={`app-shell ${navExpanded ? '' : 'app-shell--collapsed'} ${
        prefs.density === 'compact' ? 'app-shell--compact' : ''
      }`}
    >
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
                {liveFoundry ? 'Foundry scope' : 'Demo scope'}
                <ChevronRightRegular />
              </span>
            }
          >
            <div className="shell-menu__status">
              <strong>Configured agent scope</strong>
              <span>
                {liveFoundry
                  ? 'Foundry-connected portfolio · active'
                  : 'Synthetic demo scope · active'}
              </span>
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
            label="Help and diagnostics"
            trigger={
              <Tooltip content="Help and diagnostics" relationship="label">
                <span className="shell-icon-trigger" aria-hidden="true">
                  <QuestionCircleRegular />
                </span>
              </Tooltip>
            }
          >
            <Link to="/connectors">Connector management &amp; diagnostics</Link>
            <Link to="/settings">Application settings</Link>
            <div className="shell-menu__status">
              <strong>Keyboard shortcuts</strong>
              <span>Ctrl K — Global search</span>
              <span>Esc — Close dialog or menu</span>
            </div>
            <div className="shell-menu__status shell-menu__status--bordered">
              <strong>Agent Sentinel</strong>
              <span>Operations &amp; Security · Hackathon build</span>
            </div>
          </ShellMenu>
          <AuthShellMenu />
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
