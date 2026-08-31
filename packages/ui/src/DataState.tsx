import {
  AlertRegular,
  ErrorCircleRegular,
  LockClosedRegular,
  SearchRegular,
  SpinnerIosRegular,
} from '@fluentui/react-icons'
import type { ReactNode } from 'react'

export type DataStateVariant = 'loading' | 'empty' | 'degraded' | 'denied' | 'error'

export interface DataStateProps {
  variant: DataStateVariant
  title: string
  description: string
  action?: ReactNode
}

const icons = {
  loading: SpinnerIosRegular,
  empty: SearchRegular,
  degraded: AlertRegular,
  denied: LockClosedRegular,
  error: ErrorCircleRegular,
} as const

export function DataState({ variant, title, description, action }: DataStateProps) {
  const Icon = icons[variant]
  const role = variant === 'error' || variant === 'denied' ? 'alert' : 'status'
  return (
    <section className={`as-data-state as-data-state--${variant}`} role={role}>
      <Icon aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      {action === undefined ? null : <div className="as-data-state__action">{action}</div>}
    </section>
  )
}
