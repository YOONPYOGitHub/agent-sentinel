import {
  employeeAgentCatalogResponseSchema,
  type EmployeeAgentCatalogResponse,
} from '@agent-sentinel/domain'

import { apiFetch } from './auth-fetch'

export class EmployeeCatalogApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'EmployeeCatalogApiError'
  }
}

export const employeeCatalogApi = {
  async get(signal?: AbortSignal): Promise<EmployeeAgentCatalogResponse> {
    let response: Response
    try {
      response = await apiFetch(
        '/api/employee/agent-catalog',
        signal === undefined ? undefined : { signal },
      )
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      throw new EmployeeCatalogApiError('Employee catalog could not be loaded.')
    }
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new EmployeeCatalogApiError(
        `Employee catalog request failed with status ${response.status}.`,
        response.status,
      )
    }
    const parsed = employeeAgentCatalogResponseSchema.safeParse(body)
    if (!parsed.success) {
      throw new EmployeeCatalogApiError('Employee catalog response was invalid.', response.status)
    }
    return parsed.data
  },
}
