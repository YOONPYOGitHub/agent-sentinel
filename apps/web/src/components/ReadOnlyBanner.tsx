import { MessageBar, MessageBarBody } from '@fluentui/react-components'
import { LockClosedRegular } from '@fluentui/react-icons'
import type { WriteCapability } from '../api'

export function ReadOnlyBanner({ writeEnabled }: WriteCapability) {
  if (writeEnabled !== false) return null

  return (
    <MessageBar icon={<LockClosedRegular />} intent="warning">
      <MessageBarBody>
        Write operations are blocked by deployment policy. Read-only mode active. Mutation actions
        (reset, validate, approve, execute) are unavailable.
      </MessageBarBody>
    </MessageBar>
  )
}
