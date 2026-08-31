import { ClockRegular } from '@fluentui/react-icons'

export type Freshness = 'live' | 'recent' | 'stale' | 'unknown'

export interface DataFreshnessIndicatorProps {
  freshness: Freshness
  observedAt?: string | undefined
}

function observedTime(value: string | undefined): { label: string; dateTime?: string } {
  if (value === undefined) return { label: 'Observation time unavailable' }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? { label: 'Observation time invalid' }
    : { label: parsed.toLocaleString(), dateTime: parsed.toISOString() }
}

export function DataFreshnessIndicator({ freshness, observedAt }: DataFreshnessIndicatorProps) {
  const time = observedTime(observedAt)
  return (
    <span className={`as-freshness as-freshness--${freshness}`}>
      <ClockRegular aria-hidden="true" />
      <span>{freshness}</span>
      {time.dateTime === undefined ? (
        <span>{time.label}</span>
      ) : (
        <time dateTime={time.dateTime}>{time.label}</time>
      )}
    </span>
  )
}
