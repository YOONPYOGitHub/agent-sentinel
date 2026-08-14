import { ChevronRightRegular } from '@fluentui/react-icons'
import type { ReactNode } from 'react'

interface PageHeadingProps {
  section: string
  title: string
  description: string
  actions?: ReactNode
}

export function PageHeading({ section, title, description, actions }: PageHeadingProps) {
  return (
    <section className="page-heading">
      <div>
        <div className="breadcrumb">
          Agent Sentinel <ChevronRightRegular /> {section}
        </div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions === undefined ? null : <div className="page-heading__actions">{actions}</div>}
    </section>
  )
}
