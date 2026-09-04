import { createContext } from 'react'

import type { AuthorizedEstate } from '../api/estate-api'

export interface EstateContextValue {
  estates: readonly AuthorizedEstate[]
  selectedEstateId: string | undefined
  isLoading: boolean
  error: string | undefined
  selectEstate: (estateId: string) => void
}

export const EstateContext = createContext<EstateContextValue>({
  estates: [],
  selectedEstateId: undefined,
  isLoading: true,
  error: undefined,
  selectEstate: () => undefined,
})
