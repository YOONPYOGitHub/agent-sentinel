import { expect, test } from '@playwright/test'

test('app shell controls are functional and honest', async ({ page }) => {
  await page.goto('/overview')
  await expect(page.getByRole('heading', { name: 'Agent operations overview' })).toBeVisible()

  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: /Find an agent/i })).toBeVisible()
  await page.getByRole('textbox', { name: 'Search Agent Sentinel' }).fill('Sales Research Agent')
  await page.getByRole('link', { name: /^Sales Research Agent agent/i }).click()
  await expect(page.getByRole('heading', { name: 'Sales Research Agent' })).toBeVisible()

  await page.getByRole('button', { name: 'Scope information' }).click()
  await expect(page.getByText(/Synthetic demo scope/i)).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Environment information' }).click()
  await expect(page.getByText(/Environment changes are deployment-controlled/i)).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('link', { name: 'Application settings' }).click()
  await expect(page.getByRole('heading', { name: 'Application settings' })).toBeVisible()

  await page.getByRole('button', { name: 'User menu' }).click()
  await expect(page.getByText('Simulated Agent Security Analyst')).toBeVisible()
})
