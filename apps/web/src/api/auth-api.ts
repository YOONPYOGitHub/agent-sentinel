import { z } from 'zod'

export interface SpaAuthConfig {
  tenantId: string
  clientId: string
  authority: string
  scopes: string[]
  redirectUri: string
  postLogoutRedirectUri: string
}

export type AuthConfigResponse = { enabled: false } | ({ enabled: true } & SpaAuthConfig)

const authConfigResponseSchema = z.discriminatedUnion('enabled', [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    tenantId: z.string().uuid(),
    clientId: z.string().uuid(),
    authority: z.url(),
    scopes: z.array(z.string().min(1)).min(1),
    redirectUri: z.url(),
    postLogoutRedirectUri: z.url(),
  }),
])

export const authApi = {
  async getConfig(): Promise<AuthConfigResponse> {
    const response = await fetch('/api/auth/config')
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new Error(`Authentication configuration could not be loaded (${response.status}).`)
    }
    const parsed = authConfigResponseSchema.parse(body)
    if (!parsed.enabled) return { enabled: false }
    return {
      enabled: true,
      tenantId: parsed.tenantId,
      clientId: parsed.clientId,
      authority: parsed.authority,
      scopes: parsed.scopes,
      redirectUri: parsed.redirectUri,
      postLogoutRedirectUri: parsed.postLogoutRedirectUri,
    }
  },
}
