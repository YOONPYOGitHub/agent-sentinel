import { ChevronRightRegular } from '@fluentui/react-icons'
import type { ReactNode } from 'react'

export interface PageHeaderProps {
  section: string
  title: string
  description: string
  actions?: ReactNode
  productName?: string
}

export function PageHeader({
  section,
  title,
  description,
  actions,
  productName = 'Agent Sentinel',
}: PageHeaderProps) {
  return (
    <section className="page-heading">
      <div>
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <span>{productName}</span>
          <ChevronRightRegular aria-hidden="true" />
          <span aria-current="page">{section}</span>
        </nav>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions === undefined ? null : <div className="page-heading__actions">{actions}</div>}
    </section>
  )
}
