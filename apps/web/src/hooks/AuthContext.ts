import { createContext } from 'react'
import type { SpaAuthConfig } from '../api/auth-api'

export const SENTINEL_CAPABILITIES = [
  'read',
  'validateFinding',
  'generateAdvisory',
  'proposeRemediation',
  'approveRemediation',
  'executeRemediation',
  'configure',
] as const

export type SentinelCapability = (typeof SENTINEL_CAPABILITIES)[number]

/** Sanitized principal from /api/auth/me; safe to render in the UI. */
export interface WebAuthPrincipal {
  subject: string
  objectId?: string
  tenantId: string
  displayName?: string
  preferredUsername?: string
  roles: string[]
  capabilities: SentinelCapability[]
}

export interface AuthContextValue {
  /** True when /api/auth/config returned enabled=true and MSAL is ready. */
  isConfigured: boolean
  /** Public SPA auth config (no secrets). Null when not configured. */
  spaConfig: SpaAuthConfig | null
  /** True while auth config is loading or MSAL is initializing. */
  isLoading: boolean
  /** True when a user is currently signed in. */
  isSignedIn: boolean
  /** Sanitized principal from /api/auth/me. Null when not signed in. */
  principal: WebAuthPrincipal | null
  /** Non-null when auth initialization or sign-in/out failed. */
  authError: string | null
  /** Initiate sign-in (noop when not configured). */
  signIn: () => Promise<void>
  /** Initiate sign-out (noop when not configured). */
  signOut: () => Promise<void>
  /** Acquire an API access token. Returns null when not signed in or not configured. */
  getAccessToken: () => Promise<string | null>
}

export const AuthContext = createContext<AuthContextValue>({
  isConfigured: false,
  spaConfig: null,
  isLoading: true,
  isSignedIn: false,
  principal: null,
  authError: null,
  signIn: () => Promise.resolve(),
  signOut: () => Promise.resolve(),
  getAccessToken: () => Promise.resolve(null),
})
