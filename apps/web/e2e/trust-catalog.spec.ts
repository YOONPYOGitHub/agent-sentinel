import { expect, test } from '@playwright/test'

test('trust catalog filters capabilities and opens evidence disclosure', async ({ page }) => {
  await page.goto('/trust-catalog')
  await expect(page.getByRole('heading', { name: 'Agent, MCP, and tool catalog' })).toBeVisible()
  await expect(
    page.getByText('Discovered capabilities, not a marketplace approval system'),
  ).toBeVisible()

  await page.getByRole('combobox', { name: 'Filter catalog by type' }).selectOption('mcp')
  await expect(page.getByRole('heading', { name: 'HR SharePoint MCP' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sales Research Agent' })).not.toBeVisible()

  const mcpCard = page
    .getByRole('heading', { name: 'HR SharePoint MCP' })
    .locator('xpath=ancestor::article')
  await mcpCard.getByRole('button', { name: 'View trust evidence' }).click()
  await expect(page.getByRole('dialog', { name: 'HR SharePoint MCP' })).toBeVisible()
  await expect(page.getByText('Not provided by source').first()).toBeVisible()
  await expect(
    page.locator('.catalog-drawer dd').getByText('Agent Sentinel Trust Catalog'),
  ).toBeVisible()
})
