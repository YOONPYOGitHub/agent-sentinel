import type { SentinelCapability } from './AuthContext'
import { useAuth } from './useAuth'

/**
 * Returns true if the current user has the given capability.
 * Always returns true when authentication is disabled (mode=disabled/mock),
 * so existing demo behavior is preserved.
 */
export function usePermission(capability: SentinelCapability): boolean {
  const { isConfigured, isLoading, isSignedIn, principal } = useAuth()
  if (isLoading) return false
  // Auth not configured ? no restriction (preserve demo behavior)
  if (!isConfigured) return true
  // Configured but not signed in ? no permission
  if (!isSignedIn || principal === null) return false
  return principal.capabilities.includes(capability)
}

/**
 * Returns a human-readable explanation of why the action is unavailable.
 * Returns null when the user has the required capability.
 */
export function usePermissionMessage(capability: SentinelCapability): string | null {
  const { isConfigured, isLoading, isSignedIn, principal } = useAuth()
  if (isLoading) return 'Checking authentication status.'
  if (!isConfigured) return null
  if (!isSignedIn || principal === null) return 'Sign in to perform this action.'
  if (!principal.capabilities.includes(capability)) {
    const roleNames: Record<SentinelCapability, string> = {
      read: 'Viewer',
      validateFinding: 'Analyst',
      generateAdvisory: 'Analyst',
      proposeRemediation: 'Analyst',
      approveRemediation: 'Approver',
      executeRemediation: 'Administrator',
      configure: 'Administrator',
    }
    return `Requires the ${roleNames[capability]} role.`
  }
  return null
}
