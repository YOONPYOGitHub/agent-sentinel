import { estateIdSchema } from '@agent-sentinel/domain'
import { z } from 'zod'

import { apiFetch } from './auth-fetch'

const estateSchema = z
  .object({
    id: estateIdSchema,
    name: z.string().trim().min(1).max(100),
    tenantId: z.string().trim().min(1).max(128),
    environment: z.string().trim().min(1).max(128),
    isDefault: z.boolean(),
  })
  .strict()

export const authorizedEstatesSchema = z
  .object({
    defaultEstateId: estateIdSchema,
    estates: z.array(estateSchema).max(50),
  })
  .strict()

export type AuthorizedEstate = z.infer<typeof estateSchema>
export type AuthorizedEstates = z.infer<typeof authorizedEstatesSchema>

export const estateApi = {
  async listAuthorized(): Promise<AuthorizedEstates> {
    const response = await apiFetch('/api/estates')
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new Error(`Failed to load authorized estates (${response.status}).`)
    }
    return authorizedEstatesSchema.parse(body)
  },
}
