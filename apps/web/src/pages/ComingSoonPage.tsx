import { ClockRegular } from '@fluentui/react-icons'
import { PageHeading } from '../components/PageHeading'

export function ComingSoonPage({ title }: { title: string }) {
  return (
    <>
      <PageHeading
        section={title}
        title={title}
        description="This operational workspace is planned for a future Agent Sentinel phase."
      />
      <div className="coming-soon">
        <ClockRegular />
        <h2>Coming soon</h2>
        <p>
          The navigation destination is ready, and its evidence-driven workflows will arrive in a
          later phase.
        </p>
      </div>
    </>
  )
}
