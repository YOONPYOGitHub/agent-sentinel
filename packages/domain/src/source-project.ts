import { z } from 'zod'

export const SOURCE_PROJECT_ID_MAX_LENGTH = 200
export const sourceProjectIdSchema = z.string().trim().min(1).max(SOURCE_PROJECT_ID_MAX_LENGTH)
export type SourceProjectId = z.infer<typeof sourceProjectIdSchema>
