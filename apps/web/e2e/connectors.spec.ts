import { expect, test } from '@playwright/test'

test('connectors page renders the management readiness surface', async ({ page }) => {
  await page.goto('/connectors')
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Active connection status' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Connector catalog' })).toBeVisible()
})

test('connectors page shows active connector details', async ({ page }) => {
  await page.goto('/connectors')
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
  // In demo/mock mode the active connector is the mock estate
  await expect(
    page.getByRole('heading', { name: /Mock agent estate|Azure AI Foundry/i }).first(),
  ).toBeVisible()
})

test('connectors page lists expected catalog entries', async ({ page }) => {
  await page.goto('/connectors')
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
  await expect(page.getByRole('article', { name: 'Azure AI Foundry' })).toBeVisible()
  await expect(page.getByRole('article', { name: 'Microsoft Agent 365' })).toBeVisible()
  await expect(
    page.getByRole('article', { name: 'Microsoft Entra Agent ID & Entitlements' }),
  ).toBeVisible()
})

test('Agent 365 shows authorization required, not connected', async ({ page }) => {
  await page.goto('/connectors')
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
  const agent365 = page.getByRole('article', { name: 'Microsoft Agent 365' })
  await expect(agent365).toContainText('Authorization required')
  await expect(agent365).not.toContainText('Connected')
})

test('Entra distinction notice is visible', async ({ page }) => {
  await page.goto('/connectors')
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
  await expect(page.getByRole('note')).toContainText(
    'Entra ID authentication vs. entitlement evidence',
  )
})

test('connector catalog shows scorecard unlock information', async ({ page }) => {
  await page.goto('/connectors')
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
  const foundryCard = page.getByRole('article', { name: 'Azure AI Foundry' })
  await expect(foundryCard).toContainText('Unlocks:')
})

test('help menu links to connector management', async ({ page }) => {
  await page.goto('/overview')
  await page.getByRole('button', { name: 'Help and diagnostics' }).click()
  const connectorLink = page.getByRole('link', { name: /connector management/i })
  await expect(connectorLink).toBeVisible()
  await connectorLink.click()
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
})

test('refresh button reloads connector status', async ({ page }) => {
  await page.goto('/connectors')
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
  await page.getByRole('button', { name: 'Refresh status' }).click()
  // Page should remain functional after refresh
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
})
