import { expect, test } from '@playwright/test'

test('contains a validated attack path and preserves the business workflow', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Agent operations overview' })).toBeVisible()

  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(page.getByText('Theoretical exposure')).toBeVisible()

  await page.getByRole('button', { name: 'Run safe validation' }).click()
  await expect(page.getByText('Validated exploit')).toBeVisible()
  await expect(page.getByText('Exploit safely reproduced')).toBeVisible()

  await page.getByRole('button', { name: 'Build response plan' }).click()
  await expect(page.getByText('Block unapproved MCP egress')).toBeVisible()

  await page.getByRole('button', { name: 'Approve response' }).click()
  await expect(page.getByText('Approved by Avery Morgan')).toBeVisible()

  await page.getByRole('button', { name: 'Execute containment' }).click()
  await expect(page.getByText('Exposure removed')).toBeVisible()
  await expect(page.getByText('Residual risk')).toBeVisible()
  await expect(page.getByText('Critical route removed')).toBeVisible()
  await expect(page.getByTestId('graph-node-agent')).toContainText('Sales Research Agent')
})

test('opens evidence from the exposure graph', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await page.getByTestId('graph-node-agent').click()

  await expect(page.getByRole('dialog', { name: 'Microsoft Copilot Studio' })).toBeVisible()
  await expect(page.getByText('Published agent manifest and configured identity.')).toBeVisible()
  await expect(page.getByRole('dialog')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
})
