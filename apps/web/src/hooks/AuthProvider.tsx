import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AccountInfo, IPublicClientApplication, SilentRequest } from '@azure/msal-browser'
import { authApi } from '../api/auth-api'
import { setTokenProvider } from '../api/auth-fetch'
import { AuthContext, type WebAuthPrincipal, type SentinelCapability } from './AuthContext'
import type { SpaAuthConfig } from '../api/auth-api'
import { SENTINEL_CAPABILITIES } from './AuthContext'

const meResponseSchema = {
  parse(value: unknown): WebAuthPrincipal {
    if (typeof value !== 'object' || value === null)
      throw new Error('Invalid /api/auth/me response')
    const v = value as Record<string, unknown>
    const subject = typeof v['subject'] === 'string' ? v['subject'] : ''
    const tenantId = typeof v['tenantId'] === 'string' ? v['tenantId'] : ''
    const objectId = typeof v['objectId'] === 'string' ? v['objectId'] : undefined
    const displayName = typeof v['displayName'] === 'string' ? v['displayName'] : undefined
    const preferredUsername =
      typeof v['preferredUsername'] === 'string' ? v['preferredUsername'] : undefined
    const roles = Array.isArray(v['roles'])
      ? v['roles'].filter((r): r is string => typeof r === 'string')
      : []
    const capabilities = Array.isArray(v['capabilities'])
      ? v['capabilities'].filter(
          (c): c is SentinelCapability =>
            typeof c === 'string' && (SENTINEL_CAPABILITIES as readonly string[]).includes(c),
        )
      : []
    if (subject.length === 0 || tenantId.length === 0) {
      throw new Error('Invalid /api/auth/me principal identity')
    }
    return {
      subject,
      tenantId,
      ...(objectId !== undefined ? { objectId } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(preferredUsername !== undefined ? { preferredUsername } : {}),
      roles,
      capabilities,
    }
  },
}

async function fetchPrincipal(token: string): Promise<WebAuthPrincipal> {
  const response = await fetch('/api/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new Error(
      (typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof body.message === 'string'
        ? body.message
        : undefined) ?? `Failed to load user profile (${response.status}).`,
    )
  }
  return meResponseSchema.parse(body)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isLoading, setIsLoading] = useState(true)
  const [isConfigured, setIsConfigured] = useState(false)
  const [spaConfig, setSpaConfig] = useState<SpaAuthConfig | null>(null)
  const [isSignedIn, setIsSignedIn] = useState(false)
  const [principal, setPrincipal] = useState<WebAuthPrincipal | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const msalRef = useRef<IPublicClientApplication | null>(null)
  const accountRef = useRef<AccountInfo | null>(null)
  const configuredScopes = useRef<string[]>([])

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const msal = msalRef.current
    const account = accountRef.current
    if (msal === null || account === null) return null
    const scopes = configuredScopes.current
    const request: SilentRequest = { account, scopes }
    try {
      const result = await msal.acquireTokenSilent(request)
      return result.accessToken
    } catch {
      return null
    }
  }, [])

  const signIn = useCallback(async () => {
    const msal = msalRef.current
    if (msal === null) return
    setAuthError(null)
    try {
      const result = await msal.loginPopup({ scopes: configuredScopes.current })
      accountRef.current = result.account
      const p = await fetchPrincipal(result.accessToken)
      setPrincipal(p)
      setTokenProvider(getAccessToken)
      setIsSignedIn(true)
    } catch (err: unknown) {
      accountRef.current = null
      setPrincipal(null)
      setIsSignedIn(false)
      setTokenProvider(undefined)
      const message = err instanceof Error ? err.message : 'Sign-in failed.'
      // User cancellation is not an authentication failure.
      if (
        !message.toLowerCase().includes('user_cancelled') &&
        !message.toLowerCase().includes('user cancelled')
      ) {
        setAuthError(message)
      }
    }
  }, [getAccessToken])

  const signOut = useCallback(async () => {
    const msal = msalRef.current
    const account = accountRef.current
    if (msal === null) return
    try {
      await msal.logoutPopup(account !== null ? { account } : undefined)
    } finally {
      accountRef.current = null
      setIsSignedIn(false)
      setPrincipal(null)
      setTokenProvider(undefined)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function init() {
      setTokenProvider(undefined)
      try {
        const config = await authApi.getConfig()
        if (cancelled) return

        if (!config.enabled) {
          setIsConfigured(false)
          setSpaConfig(null)
          setIsLoading(false)
          return
        }

        const { PublicClientApplication, BrowserCacheLocation } =
          await import('@azure/msal-browser')
        if (cancelled) return

        const spa: SpaAuthConfig = {
          clientId: config.clientId,
          authority: config.authority,
          scopes: config.scopes,
        }
        configuredScopes.current = config.scopes

        const msal = new PublicClientApplication({
          auth: {
            clientId: spa.clientId,
            authority: spa.authority,
            redirectUri: window.location.origin,
          },
          cache: { cacheLocation: BrowserCacheLocation.SessionStorage },
        })

        await msal.initialize()
        if (cancelled) return

        msalRef.current = msal
        setSpaConfig(spa)
        setIsConfigured(true)

        // Check if already signed in
        const accounts = msal.getAllAccounts()
        if (accounts.length > 0 && accounts[0] !== undefined) {
          accountRef.current = accounts[0]
          try {
            const silentResult = await msal.acquireTokenSilent({
              account: accounts[0],
              scopes: spa.scopes,
            })
            if (!cancelled) {
              setIsSignedIn(true)
              setTokenProvider(getAccessToken)
              const p = await fetchPrincipal(silentResult.accessToken)
              if (!cancelled) setPrincipal(p)
            }
          } catch {
            // Silent token acquisition failed; user needs to sign in again
            accountRef.current = null
            setPrincipal(null)
            setIsSignedIn(false)
            setTokenProvider(undefined)
          }
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setAuthError(err instanceof Error ? err.message : 'Authentication initialization failed.')
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void init()
    return () => {
      cancelled = true
      setTokenProvider(undefined)
    }
  }, [getAccessToken])

  // Update the token provider whenever sign-in state changes
  useEffect(() => {
    if (isSignedIn) {
      setTokenProvider(getAccessToken)
    } else {
      setTokenProvider(undefined)
    }
  }, [isSignedIn, getAccessToken])

  const value = useMemo(
    () => ({
      isConfigured,
      spaConfig,
      isLoading,
      isSignedIn,
      principal,
      authError,
      signIn,
      signOut,
      getAccessToken,
    }),
    [
      isConfigured,
      spaConfig,
      isLoading,
      isSignedIn,
      principal,
      authError,
      signIn,
      signOut,
      getAccessToken,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
