import { useContext } from 'react'
import { DemoStateContext, type DemoStateValue } from './DemoStateContext'

export function useDemoState(): DemoStateValue {
  const value = useContext(DemoStateContext)
  if (value === undefined) throw new Error('useDemoState must be used within DemoStateProvider.')
  return value
}
