import { DataUsageRegular } from '@fluentui/react-icons'
import type { Meta, StoryObj } from '@storybook/react-vite'

import { KpiCard } from './KpiCard.js'

const meta = {
  title: 'Metrics/KpiCard',
  component: KpiCard,
  args: {
    label: 'Evidence objects',
    value: '539',
    detail: '9 authoritative source systems',
    icon: <DataUsageRegular />,
  },
} satisfies Meta<typeof KpiCard>

export default meta
type Story = StoryObj<typeof meta>

export const Neutral: Story = {}
export const Healthy: Story = { args: { tone: 'success', value: '100%' } }
export const Degraded: Story = {
  args: { tone: 'warning', value: 'Partial', detail: '2 source systems unavailable' },
}
export const Critical: Story = {
  args: { tone: 'danger', value: '3', detail: 'Critical findings require review' },
}
