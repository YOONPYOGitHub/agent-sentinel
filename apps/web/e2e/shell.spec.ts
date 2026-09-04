import { expect, test } from '@playwright/test'

test('app shell controls are functional and honest', async ({ page }) => {
  await page.goto('/overview')
  await expect(page.getByRole('heading', { name: 'Agent operations overview' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Active estate' })).toHaveCount(0)

  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: /Find an agent/i })).toBeVisible()
  await page.getByRole('textbox', { name: 'Search Agent Sentinel' }).fill('Sales Research Agent')
  await page.getByRole('link', { name: /^Sales Research Agent agent/i }).click()
  await expect(page.getByRole('heading', { name: 'Sales Research Agent' })).toBeVisible()

  await page.getByRole('button', { name: 'Scope information' }).click()
  await expect(page.getByText(/Foundry-connected portfolio|Synthetic demo scope/i)).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Environment information' }).click()
  await expect(page.getByText(/Environment changes are deployment-controlled/i)).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Help and diagnostics' }).click()
  await page.getByRole('link', { name: 'Application settings' }).click()
  await expect(page.getByRole('heading', { name: 'Application settings' })).toBeVisible()

  await page.getByRole('button', { name: 'Authentication status' }).click()
  await expect(page.getByText(/Entra authentication will establish user identity/i)).toBeVisible()
})

test('estate switching scopes requests and can recover to the default estate', async ({ page }) => {
  const estateHeaders: string[] = []
  page.on('request', (request) => {
    const estateId = request.headers()['x-agent-sentinel-estate-id']
    if (estateId !== undefined) estateHeaders.push(estateId)
  })
  await page.route('**/api/estates', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        defaultEstateId: 'default',
        estates: [
          {
            id: 'default',
            name: 'Default estate',
            tenantId: 'default-tenant',
            environment: 'validation',
            isDefault: true,
          },
          {
            id: 'research',
            name: 'Research estate',
            tenantId: 'research-tenant',
            environment: 'research',
            isDefault: false,
          },
        ],
      }),
    })
  })

  await page.goto('/overview')
  await expect(page.getByRole('heading', { name: 'Agent operations overview' })).toBeVisible()
  const selector = page.getByRole('combobox', { name: 'Active estate' })
  await expect(selector).toHaveValue('default')

  await selector.selectOption('research')

  await expect(page.getByRole('heading', { name: 'Agent estate is unavailable' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Active estate' })).toHaveValue('research')
  await expect
    .poll(() => estateHeaders.includes('research'), {
      message: 'an estate-scoped API request should carry the selected opaque estate ID',
    })
    .toBe(true)
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('agent-sentinel.estate-id')))
    .toBe('research')

  await page.getByRole('combobox', { name: 'Active estate' }).selectOption('default')

  await expect(page.getByRole('heading', { name: 'Agent operations overview' })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('agent-sentinel.estate-id')))
    .toBe('default')
})
