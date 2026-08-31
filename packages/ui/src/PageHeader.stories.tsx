import { Button } from '@fluentui/react-components'
import { ArrowClockwiseRegular } from '@fluentui/react-icons'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { PageHeader } from './PageHeader.js'

const meta = {
  title: 'Navigation/PageHeader',
  component: PageHeader,
  args: {
    section: 'Observability',
    title: 'Evidence operations',
    description:
      'Freshness, confidence, source coverage, and validation activity for the current estate.',
  },
} satisfies Meta<typeof PageHeader>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const WithCommand: Story = {
  args: {
    actions: (
      <Button appearance="secondary" icon={<ArrowClockwiseRegular />}>
        Refresh evidence
      </Button>
    ),
  },
}
