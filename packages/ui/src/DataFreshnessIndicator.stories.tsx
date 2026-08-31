import type { Meta, StoryObj } from '@storybook/react-vite'

import { DataFreshnessIndicator } from './DataFreshnessIndicator.js'

const meta = {
  title: 'Evidence/DataFreshnessIndicator',
  component: DataFreshnessIndicator,
  args: {
    freshness: 'live',
    observedAt: '2026-08-31T01:00:00.000Z',
  },
} satisfies Meta<typeof DataFreshnessIndicator>

export default meta
type Story = StoryObj<typeof meta>

export const Live: Story = {}
export const Recent: Story = { args: { freshness: 'recent' } }
export const Stale: Story = { args: { freshness: 'stale' } }
export const Unknown: Story = { args: { freshness: 'unknown', observedAt: undefined } }
