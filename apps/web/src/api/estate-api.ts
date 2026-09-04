import { estateIdSchema } from '@agent-sentinel/domain'
import { z } from 'zod'

import { apiFetch } from './auth-fetch'

export const authorizedEstateSchema = z
  .object({
    id: estateIdSchema,
    name: z.string().trim().min(1).max(100),
    tenantId: z.string().trim().min(1).max(128),
    environment: z.string().trim().min(1).max(128),
    isDefault: z.boolean(),
  })
  .strict()

export const estatesResponseSchema = z
  .object({
    defaultEstateId: estateIdSchema,
    estates: z.array(authorizedEstateSchema).max(50),
  })
  .strict()
  .superRefine(({ estates }, context) => {
    const ids = new Set<string>()
    estates.forEach((estate, index) => {
      if (ids.has(estate.id)) {
        context.addIssue({
          code: 'custom',
          path: ['estates', index, 'id'],
          message: `Duplicate estate ID: ${estate.id}`,
        })
      }
      ids.add(estate.id)
    })
  })

export type AuthorizedEstate = z.infer<typeof authorizedEstateSchema>
export type EstatesResponse = z.infer<typeof estatesResponseSchema>
export type EstateApiErrorKind = 'unauthorized' | 'forbidden' | 'unavailable'

export class EstateApiError extends Error {
  readonly kind: EstateApiErrorKind
  readonly status: number | undefined

  constructor(kind: EstateApiErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'EstateApiError'
    this.kind = kind
    this.status = status
  }
}

function responseMessage(value: unknown): string | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string'
    ? value.message
    : undefined
}

function errorKind(status: number): EstateApiErrorKind {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  return 'unavailable'
}

export const estateApi = {
  async list(signal?: AbortSignal): Promise<EstatesResponse> {
    let response: Response
    try {
      response = await apiFetch('/api/estates', signal === undefined ? undefined : { signal })
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      throw new EstateApiError(
        'unavailable',
        error instanceof Error ? error.message : 'Authorized estates could not be loaded.',
      )
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const kind = errorKind(response.status)
      throw new EstateApiError(
        kind,
        responseMessage(body) ??
          `Authorized estates request failed with status ${response.status}.`,
        response.status,
      )
    }
    const parsed = estatesResponseSchema.safeParse(body)
    if (!parsed.success) {
      throw new EstateApiError(
        'unavailable',
        `Authorized estates response was invalid: ${z.prettifyError(parsed.error)}`,
        response.status,
      )
    }
    return parsed.data
  },
}
