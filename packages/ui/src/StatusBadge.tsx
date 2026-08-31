import { Badge } from '@fluentui/react-components'

export type StatusKind =
  'ready' | 'healthy' | 'degraded' | 'unavailable' | 'unknown' | 'denied' | 'synthetic'

export interface StatusBadgeProps {
  status: StatusKind
  label?: string
}

const colorByStatus = {
  ready: 'success',
  healthy: 'success',
  degraded: 'warning',
  unavailable: 'danger',
  unknown: 'subtle',
  denied: 'danger',
  synthetic: 'informative',
} as const

export function StatusBadge({ status, label }: StatusBadgeProps) {
  return (
    <Badge appearance="tint" color={colorByStatus[status]}>
      {label ?? status.replaceAll('-', ' ')}
    </Badge>
  )
}
