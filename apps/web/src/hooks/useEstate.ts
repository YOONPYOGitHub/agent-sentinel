import { useContext } from 'react'

import { EstateContext, type EstateContextValue } from './EstateContext'

export function useEstate(): EstateContextValue {
  const value = useContext(EstateContext)
  if (value === undefined) throw new Error('useEstate must be used within EstateProvider.')
  return value
}
