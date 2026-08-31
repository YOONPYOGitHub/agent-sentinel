import { FluentProvider, webDarkTheme } from '@fluentui/react-components'
import type { Preview } from '@storybook/react-vite'

import '../src/styles.css'

const preview: Preview = {
  decorators: [
    (Story) => (
      <FluentProvider theme={webDarkTheme}>
        <div className="as-story-canvas">
          <Story />
        </div>
      </FluentProvider>
    ),
  ],
  parameters: {
    a11y: {
      test: 'error',
    },
    backgrounds: {
      default: 'Agent Sentinel',
      values: [{ name: 'Agent Sentinel', value: '#080d16' }],
    },
    controls: {
      expanded: true,
    },
  },
  tags: ['autodocs'],
}

export default preview
