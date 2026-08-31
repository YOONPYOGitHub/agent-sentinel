import type { Meta, StoryObj } from '@storybook/react-vite'

import { StatusBadge } from './StatusBadge.js'

const meta = {
  title: 'Status/StatusBadge',
  component: StatusBadge,
  args: { status: 'ready' },
} satisfies Meta<typeof StatusBadge>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = {}
export const Degraded: Story = { args: { status: 'degraded' } }
export const Unknown: Story = { args: { status: 'unknown' } }
export const Denied: Story = { args: { status: 'denied' } }
export const Synthetic: Story = { args: { status: 'synthetic', label: 'Synthetic evidence' } }
