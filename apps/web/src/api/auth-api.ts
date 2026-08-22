import { z } from 'zod'

export interface SpaAuthConfig {
  clientId: string
  authority: string
  scopes: string[]
}

export type AuthConfigResponse = { enabled: false } | ({ enabled: true } & SpaAuthConfig)

const authConfigResponseSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    clientId: z.string().min(1),
    authority: z.string().min(1),
    scopes: z.array(z.string().min(1)),
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
      clientId: parsed.clientId,
      authority: parsed.authority,
      scopes: parsed.scopes,
    }
  },
}
