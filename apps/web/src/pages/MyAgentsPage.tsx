import { Badge, Button, Input, Spinner } from '@fluentui/react-components'
import {
  BotRegular,
  InfoRegular,
  LockClosedRegular,
  SearchRegular,
  ShieldCheckmarkRegular,
} from '@fluentui/react-icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'

import type { EmployeeAgentCatalogResponse } from '@agent-sentinel/domain'
import { EmployeeCatalogApiError, employeeCatalogApi } from '../api/employee-catalog-api'
import { EstateSelector } from '../components/EstateSelector'
import { PageHeading } from '../components/PageHeading'
import { useAuth } from '../hooks/useAuth'

function failureCopy(
  result: Extract<EmployeeAgentCatalogResponse, { status: 'unknown' | 'unavailable' }>,
) {
  if (result.status === 'unavailable') {
    return {
      title: 'My agents is unavailable',
      description:
        'Authoritative employee entitlement evidence is not available. No personalized agent results are shown.',
    }
  }
  return {
    title: 'Agent access cannot be confirmed',
    description:
      'Entitlement evidence is missing, stale, ambiguous, synthetic, non-authoritative, or unsupported. My agents fails closed and shows no agents.',
  }
}

export function MyAgentsPage() {
  const { isConfigured, isLoading: authLoading, isSignedIn, signIn } = useAuth()
  const [result, setResult] = useState<EmployeeAgentCatalogResponse>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!isConfigured || !isSignedIn) return
      setLoading(true)
      setError(undefined)
      try {
        setResult(await employeeCatalogApi.get(signal))
      } catch (caught: unknown) {
        if (signal?.aborted === true) return
        setResult(undefined)
        setError(
          caught instanceof EmployeeCatalogApiError
            ? caught.message
            : 'My agents could not be loaded.',
        )
      } finally {
        if (signal?.aborted !== true) setLoading(false)
      }
    },
    [isConfigured, isSignedIn],
  )

  useEffect(() => {
    if (!isConfigured || !isSignedIn) return
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [isConfigured, isSignedIn, load])

  const filteredAgents = useMemo(() => {
    const catalogAgents =
      result?.status === 'available' || result?.status === 'mock' ? result.agents : []
    const query = search.trim().toLocaleLowerCase()
    if (query.length === 0) return catalogAgents
    return catalogAgents.filter((agent) =>
      [agent.name, agent.description, agent.platform].some(
        (value) => value?.toLocaleLowerCase().includes(query) === true,
      ),
    )
  }, [result, search])

  if (authLoading) {
    return (
      <div className="center-state" role="status">
        <Spinner label="Checking authentication configuration..." />
      </div>
    )
  }
  if (!isConfigured) return <Navigate to="/agent-catalog" replace />

  return (
    <div className="employee-catalog-shell">
      <header className="employee-catalog-shell__header">
        <Link to="/my-agents" className="brand" aria-label="Agent Sentinel My agents">
          <span className="brand-mark">
            <ShieldCheckmarkRegular />
          </span>
          <span>
            <strong>Agent Sentinel</strong>
            <small>My agents</small>
          </span>
        </Link>
        <EstateSelector />
      </header>
      <main className="employee-catalog-shell__content">
        <PageHeading
          section="My agents"
          title="Agents available to you"
          description="A personalized assurance view based only on authoritative employee entitlement evidence. Agent 365 or the publishing platform remains the access-control authority."
        />

        {!isSignedIn ? (
          <div className="catalog-empty" role="status">
            <LockClosedRegular aria-hidden="true" />
            <h2>Sign in to view My agents</h2>
            <p>Microsoft sign-in is required before personalized entitlements can be checked.</p>
            <Button appearance="primary" onClick={() => void signIn()}>
              Sign in with Microsoft
            </Button>
          </div>
        ) : loading ? (
          <div className="catalog-empty" role="status">
            <Spinner label="Checking authoritative agent entitlements..." />
          </div>
        ) : error !== undefined ? (
          <div className="catalog-empty" role="alert">
            <LockClosedRegular aria-hidden="true" />
            <h2>My agents is unavailable</h2>
            <p>{error} No personalized agent results are shown.</p>
            <Button appearance="primary" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : result?.status === 'unknown' || result?.status === 'unavailable' ? (
          <div className="catalog-empty" role="status">
            <LockClosedRegular aria-hidden="true" />
            <h2>{failureCopy(result).title}</h2>
            <p>{failureCopy(result).description}</p>
          </div>
        ) : result?.status === 'denied' ? (
          <div className="catalog-empty" role="status">
            <LockClosedRegular aria-hidden="true" />
            <h2>No agents are available to you</h2>
            <p>The authoritative access source returned no agent entitlements for this account.</p>
          </div>
        ) : result === undefined ? null : (
          <>
            <div className="catalog-boundary" role="note">
              <InfoRegular aria-hidden="true" />
              <div>
                {result.status === 'mock' ? (
                  <>
                    <strong>Synthetic catalog preview.</strong>
                    <span>
                      These deterministic fixtures demonstrate the employee experience and are not
                      evidence of access.
                    </span>
                  </>
                ) : (
                  <>
                    <strong>Authoritative entitlement match.</strong>
                    <span>
                      Only agents supported by exact evidence for your verified Entra object ID are
                      included.
                    </span>
                  </>
                )}
              </div>
            </div>
            <section className="catalog-toolbar" aria-label="My agents filters">
              <div className="catalog-search">
                <SearchRegular aria-hidden="true" />
                <Input
                  value={search}
                  onChange={(_event, data) => setSearch(data.value)}
                  aria-label="Search available agents"
                  placeholder="Search your available agents"
                />
              </div>
              <strong aria-live="polite">
                {filteredAgents.length} available {filteredAgents.length === 1 ? 'agent' : 'agents'}
              </strong>
            </section>
            {filteredAgents.length === 0 ? (
              <div className="catalog-empty">
                <BotRegular aria-hidden="true" />
                <h2>No available agents match your search</h2>
                <p>Clear the search to see the agents already returned for your account.</p>
              </div>
            ) : (
              <div className="catalog-grid" aria-label="Personalized My agents catalog">
                {filteredAgents.map((agent) => (
                  <article key={agent.id} className="catalog-item">
                    <div className="catalog-item__header">
                      <span className="catalog-item__icon">
                        <BotRegular aria-hidden="true" />
                      </span>
                      <div>
                        <Badge
                          appearance="tint"
                          color={result.status === 'mock' ? 'warning' : 'success'}
                        >
                          {result.status === 'mock' ? 'Synthetic preview' : 'Available to you'}
                        </Badge>
                        <h2>{agent.name}</h2>
                        <span>{agent.platform ?? 'Publishing platform'}</span>
                      </div>
                    </div>
                    <p>{agent.description}</p>
                    {agent.version === undefined ? null : (
                      <dl>
                        <div>
                          <dt>Version</dt>
                          <dd>{agent.version}</dd>
                        </div>
                      </dl>
                    )}
                    <div className="catalog-item__entitlement-note">
                      <LockClosedRegular aria-hidden="true" />
                      <small>
                        {result.status === 'mock'
                          ? 'Preview only; confirm access in Agent 365 or the publishing platform.'
                          : 'Access is enforced by Agent 365 or the publishing platform.'}
                      </small>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}

        <div className="catalog-entra-note" role="note">
          <strong>This is not a replacement agent store.</strong> Publishing, assignment, launch,
          and revocation remain controlled by Agent 365 or the source publishing platform.{' '}
          <Link to="/agent-catalog">View the organization-wide assurance catalog.</Link>
        </div>
      </main>
    </div>
  )
}
