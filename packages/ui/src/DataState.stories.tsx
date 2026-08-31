import { Button } from '@fluentui/react-components'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { DataState } from './DataState.js'

const meta = {
  title: 'States/DataState',
  component: DataState,
  args: {
    variant: 'loading',
    title: 'Loading evidence',
    description: 'Querying configured source systems.',
  },
} satisfies Meta<typeof DataState>

export default meta
type Story = StoryObj<typeof meta>

export const Loading: Story = {}
export const Empty: Story = {
  args: {
    variant: 'empty',
    title: 'No findings',
    description: 'No findings match the current evidence-backed filters.',
  },
}
export const Degraded: Story = {
  args: {
    variant: 'degraded',
    title: 'Partial connector coverage',
    description: 'One source is unavailable. No mock fallback was used.',
  },
}
export const Denied: Story = {
  args: {
    variant: 'denied',
    title: 'Access denied',
    description: 'Your current role cannot access this evidence.',
  },
}
export const Error: Story = {
  args: {
    variant: 'error',
    title: 'Evidence unavailable',
    description: 'The source query failed without exposing provider details.',
    action: <Button>Retry</Button>,
  },
}
