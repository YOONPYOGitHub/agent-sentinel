import { useContext } from 'react'

import { EstateContext, type EstateContextValue } from './EstateContext'

export function useEstate(): EstateContextValue {
  return useContext(EstateContext)
}
