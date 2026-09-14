import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AccountInfo, IPublicClientApplication, SilentRequest } from '@azure/msal-browser'
import { z } from 'zod'
import { authApi } from '../api/auth-api'
import { setTokenProvider } from '../api/auth-fetch'
import {
  AuthContext,
  SENTINEL_CAPABILITIES,
  SENTINEL_ROLES,
  type SignInResult,
  type WebAuthPrincipal,
} from './AuthContext'
import type { SpaAuthConfig } from '../api/auth-api'

const uniqueValues = <T,>(values: readonly T[]): boolean => new Set(values).size === values.length

const meResponseSchema = z.strictObject({
  subject: z.string().min(1),
  objectId: z.string().min(1).optional(),
  tenantId: z.string().min(1),
  displayName: z.string().min(1).optional(),
  preferredUsername: z.string().min(1).optional(),
  roles: z.array(z.enum(SENTINEL_ROLES)).max(SENTINEL_ROLES.length).refine(uniqueValues),
  capabilities: z
    .array(z.enum(SENTINEL_CAPABILITIES))
    .max(SENTINEL_CAPABILITIES.length)
    .refine(uniqueValues),
})

function parsePrincipal(value: unknown): WebAuthPrincipal {
  const parsed = meResponseSchema.parse(value)
  return {
    subject: parsed.subject,
    tenantId: parsed.tenantId,
    ...(parsed.objectId === undefined ? {} : { objectId: parsed.objectId }),
    ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
    ...(parsed.preferredUsername === undefined
      ? {}
      : { preferredUsername: parsed.preferredUsername }),
    roles: parsed.roles,
    capabilities: parsed.capabilities,
  }
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
  return parsePrincipal(body)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Sign-in failed.'
}

function isUserCancellation(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
  const errorCode =
    typeof error === 'object' &&
    error !== null &&
    'errorCode' in error &&
    typeof error.errorCode === 'string'
      ? error.errorCode.toLowerCase()
      : ''
  return (
    message.includes('user_cancelled') ||
    message.includes('user cancelled') ||
    errorCode.includes('user_cancelled')
  )
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

  const clearFailedAccount = useCallback(
    async (msal: IPublicClientApplication, account: AccountInfo | null): Promise<string | null> => {
      accountRef.current = null
      setPrincipal(null)
      setIsSignedIn(false)
      setTokenProvider(undefined)
      if (account === null) return null
      try {
        await msal.clearCache({ account })
        const accountStillCached = msal
          .getAllAccounts()
          .some((candidate) => candidate.homeAccountId === account.homeAccountId)
        if (accountStillCached) {
          return 'The cached Microsoft session could not be cleared. Use account switching to recover.'
        }
        return null
      } catch (error: unknown) {
        return `The cached Microsoft session could not be cleared: ${errorMessage(error)}`
      }
    },
    [],
  )

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const msal = msalRef.current
    const account = accountRef.current
    if (msal === null || account === null) return null
    const scopes = configuredScopes.current
    const request: SilentRequest = { account, scopes }
    const result = await msal.acquireTokenSilent(request)
    return result.accessToken
  }, [])

  const signIn = useCallback(async (): Promise<SignInResult> => {
    const msal = msalRef.current
    if (msal === null) {
      return {
        status: 'failure',
        reason: 'unavailable',
        message: 'Authentication is not ready.',
      }
    }
    setAuthError(null)
    let stage: 'popup' | 'token' | 'principal' = 'popup'
    try {
      const result = await msal.loginPopup({
        scopes: configuredScopes.current,
        prompt: 'select_account',
      })
      if (result.account === null) throw new Error('Sign-in did not return an account.')
      accountRef.current = result.account
      stage = 'token'
      const token =
        result.accessToken.length > 0
          ? result.accessToken
          : (
              await msal.acquireTokenSilent({
                account: result.account,
                scopes: configuredScopes.current,
              })
            ).accessToken
      if (token.length === 0) throw new Error('Sign-in did not return an access token.')
      stage = 'principal'
      const p = await fetchPrincipal(token)
      setPrincipal(p)
      setTokenProvider(getAccessToken)
      setIsSignedIn(true)
      return { status: 'success' }
    } catch (err: unknown) {
      const cancelled = stage === 'popup' && isUserCancellation(err)
      const message = cancelled ? 'Sign-in was cancelled.' : errorMessage(err)
      const cleanupError = await clearFailedAccount(msal, accountRef.current)
      const recoveryMessage = cleanupError === null ? message : `${message} ${cleanupError}`
      setAuthError(recoveryMessage)
      return {
        status: 'failure',
        reason: cancelled ? 'cancelled' : stage,
        message: recoveryMessage,
      }
    }
  }, [clearFailedAccount, getAccessToken])

  const signOut = useCallback(async () => {
    const msal = msalRef.current
    const account = accountRef.current
    if (msal === null) return
    try {
      await msal.logoutRedirect({
        ...(account !== null ? { account } : {}),
        ...(spaConfig !== null ? { postLogoutRedirectUri: spaConfig.postLogoutRedirectUri } : {}),
      })
    } finally {
      accountRef.current = null
      setIsSignedIn(false)
      setPrincipal(null)
      setTokenProvider(undefined)
    }
  }, [spaConfig])

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
          tenantId: config.tenantId,
          clientId: config.clientId,
          authority: config.authority,
          scopes: config.scopes,
          redirectUri: config.redirectUri,
          postLogoutRedirectUri: config.postLogoutRedirectUri,
        }
        const expectedRedirectUri = `${window.location.origin}/auth-redirect.html`
        const expectedPostLogoutRedirectUri = `${window.location.origin}/`
        if (
          spa.redirectUri !== expectedRedirectUri ||
          spa.postLogoutRedirectUri !== expectedPostLogoutRedirectUri
        ) {
          throw new Error(
            'Authentication redirect configuration does not match the exact application callback and logout URLs.',
          )
        }
        configuredScopes.current = config.scopes

        const msal = new PublicClientApplication({
          auth: {
            clientId: spa.clientId,
            authority: spa.authority,
            redirectUri: spa.redirectUri,
            postLogoutRedirectUri: spa.postLogoutRedirectUri,
          },
          cache: { cacheLocation: BrowserCacheLocation.SessionStorage },
        })

        await msal.initialize()
        if (cancelled) return

        await msal.handleRedirectPromise()
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
              const p = await fetchPrincipal(silentResult.accessToken)
              if (!cancelled) {
                setPrincipal(p)
                setTokenProvider(getAccessToken)
                setIsSignedIn(true)
              }
            }
          } catch {
            if (!cancelled) {
              const message = 'The previous session could not be restored. Sign in again.'
              const cleanupError = await clearFailedAccount(msal, accounts[0])
              if (!cancelled) {
                setAuthError(cleanupError === null ? message : `${message} ${cleanupError}`)
              }
            }
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
  }, [clearFailedAccount, getAccessToken])

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
