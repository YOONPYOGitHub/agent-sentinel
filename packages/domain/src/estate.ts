import { z } from 'zod'

export const estateIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

export const estateContextSchema = z
  .object({
    id: estateIdSchema,
    tenantId: z.string().trim().min(1).max(128),
    environment: z.string().trim().min(1).max(128),
  })
  .strict()

export type EstateContext = z.infer<typeof estateContextSchema>
