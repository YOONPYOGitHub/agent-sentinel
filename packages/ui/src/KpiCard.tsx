import type { ReactNode } from 'react'

export type SemanticTone = 'neutral' | 'success' | 'warning' | 'danger' | 'informative'

export interface KpiCardProps {
  label: string
  value: ReactNode
  detail: ReactNode
  tone?: SemanticTone
  icon?: ReactNode
  compact?: boolean
}

export function KpiCard({
  label,
  value,
  detail,
  tone = 'neutral',
  icon,
  compact = false,
}: KpiCardProps) {
  return (
    <article
      className={`as-kpi-card as-kpi-card--${tone}${compact ? ' as-kpi-card--compact' : ''}`}
    >
      {icon === undefined ? null : <span className="as-kpi-card__icon">{icon}</span>}
      <span className="as-kpi-card__label">{label}</span>
      <strong className="as-kpi-card__value">{value}</strong>
      <small className="as-kpi-card__detail">{detail}</small>
    </article>
  )
}
