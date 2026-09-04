import { createContext } from 'react'

import type { AuthorizedEstate } from '../api/estate-api'

export type EstateState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'unauthorized'; message: string }
  | { status: 'forbidden'; message: string }
  | { status: 'unavailable'; message: string }
  | {
      status: 'ready'
      estates: readonly AuthorizedEstate[]
      selectedEstate: AuthorizedEstate
    }

export interface EstateContextValue {
  state: EstateState
  reload: () => Promise<void>
  selectEstate: (estateId: string) => void
}

export const EstateContext = createContext<EstateContextValue | undefined>(undefined)
