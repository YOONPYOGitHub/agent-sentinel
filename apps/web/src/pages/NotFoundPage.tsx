import { SearchRegular } from '@fluentui/react-icons'
import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <div className="detail-not-found">
      <SearchRegular />
      <span className="eyebrow">404</span>
      <h1>Page not found</h1>
      <p>The requested Agent Sentinel page does not exist.</p>
      <Link className="primary-link" to="/">
        Return to overview
      </Link>
    </div>
  )
}
